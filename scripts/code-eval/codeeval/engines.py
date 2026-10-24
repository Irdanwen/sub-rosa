"""The engines the bench drives: Sub Rosa's `subrosa-code run`, and the
mini-swe-agent reference column. Both get the same prompt, the same working
copy, the same model through the same Carpe Diem key, and the same budget.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import metrics, paths

KEYCHAIN_SERVICE = "xyz.carpediem.subrosa.carpe-diem"
DEFAULT_BASE_URL = "https://carpe-diem.xyz/api/operator/v1"
MINI_SWE_AGENT_VERSION = "2.4.6"
MINI_MARKER = "2.4.6-mcp"


def carpe_diem_key() -> str:
    """The `cdm_` key: `SUBROSA_DEV_API_KEY`, else the app's keychain item.
    Read once by the runner and handed to each engine in its environment, so
    no engine ever waits on a keychain prompt."""
    key = os.environ.get("SUBROSA_DEV_API_KEY", "").strip()
    if key:
        return key
    proc = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "api-key", "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    key = proc.stdout.strip()
    if not key.startswith("cdm_"):
        raise SystemExit("No Carpe Diem key: set SUBROSA_DEV_API_KEY or store one in Sub Rosa.")
    return key


def target_dir() -> Path:
    return Path(os.environ.get("CARGO_TARGET_DIR", Path.home() / "Library" / "Caches" / "subrosa-target"))


def subrosa_binary() -> Path:
    explicit = os.environ.get("SUBROSA_CODE_BIN")
    if explicit:
        return Path(explicit)
    return target_dir() / "debug" / "subrosa-code"


def app_data_dir() -> Path:
    """The debug build's data folder, where the app installed the runtime."""
    return Path.home() / "Library" / "Application Support" / "xyz.carpediem.subrosa-dev"


def job_data_dir(slot: int) -> Path:
    """One data folder per parallel job: the CLI takes one run at a time per
    data folder (`run.lock`). Each shares the app's installed runtime through
    a symlink and keeps its own CLI state and Hermes home."""
    folder = paths.cache_dir() / "data" / f"job-{slot}"
    folder.mkdir(parents=True, exist_ok=True)
    runtime = folder / "hermes-runtime"
    if not runtime.exists():
        runtime.symlink_to(app_data_dir() / "hermes-runtime", target_is_directory=True)
    return folder


def _stop(proc: subprocess.Popen) -> None:
    """SIGTERM first: the CLI ends the turn cleanly and reaps its runtime."""
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class SubrosaEngine:
    name = "subrosa"

    def __init__(self, model: str, budget_usd: float, timeout_s: int, key: str):
        self.model = model
        self.budget_usd = budget_usd
        self.timeout_s = timeout_s
        self.key = key
        self.binary = subrosa_binary()
        if not self.binary.exists():
            raise SystemExit(
                f"{self.binary} is missing: cargo build --features code-cli --bin subrosa-code "
                "(in src-tauri), or set SUBROSA_CODE_BIN."
            )

    def run(self, prompt: str, work: Path, logs: Path, slot: int) -> dict:
        logs.mkdir(parents=True, exist_ok=True)
        events_path = logs / "events.jsonl"
        env = dict(os.environ)
        env["SUBROSA_DEV_API_KEY"] = self.key
        june = target_dir() / "debug" / "june"
        if june.exists() and "SUBROSA_JUNE_API_BIN" not in env:
            env["SUBROSA_JUNE_API_BIN"] = str(june)
        cmd = [
            str(self.binary),
            "run",
            "--dir",
            str(work),
            "--model",
            self.model,
            "--mode",
            "build",
            "--budget",
            f"{self.budget_usd:.4f}",
            "--data-dir",
            str(job_data_dir(slot)),
            "--prompt-file",
            "-",
        ]
        started = time.time()
        with events_path.open("w") as out, (logs / "stderr.log").open("w") as err:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=out, stderr=err, env=env, text=True)
            proc.stdin.write(prompt)
            proc.stdin.close()
            try:
                proc.wait(timeout=self.timeout_s)
                timed_out = False
            except subprocess.TimeoutExpired:
                _stop(proc)
                timed_out = True
        summary = metrics.summarize(metrics.read_events(events_path))
        summary["exit_code"] = proc.returncode
        summary["agent_s"] = round(time.time() - started, 1)
        if timed_out:
            summary["status"] = "timeout"
        return summary


def mini_python() -> Path:
    """mini-swe-agent (MIT), installed once in the cache with uv."""
    venv = paths.cache_dir() / "tools" / "mini-swe-agent"
    python = venv / "bin" / "python"
    marker = venv / f".installed-{MINI_MARKER}"
    if not marker.exists():
        subprocess.run(["uv", "venv", "--quiet", "--clear", "--python", "3.12", str(venv)], check=True)
        subprocess.run(
            # litellm imports `mcp` whenever tools are passed, without
            # depending on it (litellm 1.106): installed beside it.
            ["uv", "pip", "install", "--quiet", "--python", str(python), f"mini-swe-agent=={MINI_SWE_AGENT_VERSION}", "mcp"],
            check=True,
        )
        marker.touch()
    return python


class MiniSweAgentEngine:
    name = "mini-swe-agent"

    def __init__(self, model: str, budget_usd: float, timeout_s: int, key: str):
        self.model = model
        self.budget_usd = budget_usd
        self.timeout_s = timeout_s
        self.key = key
        self.python = mini_python()

    def run(self, prompt: str, work: Path, logs: Path, slot: int) -> dict:
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "prompt.txt").write_text(prompt)
        summary_path = logs / "summary.json"
        summary_path.unlink(missing_ok=True)
        env = dict(os.environ)
        env["CARPE_DIEM_API_KEY"] = self.key
        env["MSWEA_SILENT_STARTUP"] = "1"
        env["MSWEA_COST_TRACKING"] = "ignore_errors"
        # Its global config folder holds a .env of its own: keep it out.
        env["MSWEA_GLOBAL_CONFIG_DIR"] = str(paths.cache_dir() / "tools" / "mini-config")
        cmd = [
            str(self.python),
            "-I",
            str(Path(__file__).with_name("mini_driver.py")),
            "--model",
            self.model,
            "--base-url",
            os.environ.get("CARPE_DIEM_BASE_URL", DEFAULT_BASE_URL),
            "--workdir",
            str(work),
            "--prompt-file",
            str(logs / "prompt.txt"),
            "--budget",
            str(self.budget_usd),
            "--trajectory",
            str(logs / "trajectory.json"),
            "--summary",
            str(summary_path),
        ]
        started = time.time()
        with (logs / "stdout.log").open("w") as out, (logs / "stderr.log").open("w") as err:
            proc = subprocess.Popen(cmd, stdout=out, stderr=err, env=env, text=True)
            try:
                proc.wait(timeout=self.timeout_s)
                timed_out = False
            except subprocess.TimeoutExpired:
                _stop(proc)
                timed_out = True
        try:
            summary = json.loads(summary_path.read_text())
        except (OSError, ValueError):
            summary = {"status": "no_finish"}
        summary["exit_code"] = proc.returncode
        summary["agent_s"] = round(time.time() - started, 1)
        if timed_out:
            summary["status"] = "timeout"
        return summary


ENGINES = {"subrosa": SubrosaEngine, "mini-swe-agent": MiniSweAgentEngine}


def make(name: str, model: str, budget_usd: float, timeout_s: int, key: str):
    try:
        cls = ENGINES[name]
    except KeyError:
        print(f"unknown engine {name!r}", file=sys.stderr)
        raise SystemExit(2) from None
    return cls(model, budget_usd, timeout_s, key)


def cleanup_job_dirs() -> None:
    shutil.rmtree(paths.cache_dir() / "data", ignore_errors=True)
