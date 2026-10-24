"""Sub Rosa tasks: small merged pull requests of this repository.

The working copy is the merge's first parent, exported with `git archive`
(no history: the fix is not one `git log` away) and committed as a single
commit, plus `node_modules` for a TypeScript task. The check applies the
tests the pull request added and runs them with the project's runner
(vitest, or `cargo test --test <file>` with the bench's own target folder);
the exit code decides.

The agent works under Sub Rosa's write jail, which does not grant `~/.cargo`
or the bench's target folder: in a Rust task it can edit and read but not
build. That is the product's posture today (hermes-code-surface.md), and the
report says so rather than hiding it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .swe import PrepareError, patch_files

TEST_TIMEOUT_S = 3600


def load_tasks() -> list[dict]:
    path = paths.TASKS_DIR / "subrosa.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())["tasks"]


def task_dir(task_id: str) -> Path:
    return paths.cache_dir() / "subrosa" / task_id


def pristine_dir(task_id: str) -> Path:
    return task_dir(task_id) / "pristine"


def status_path(task_id: str) -> Path:
    return task_dir(task_id) / "status.json"


def cargo_target() -> Path:
    return paths.cache_dir() / "cargo-target"


def read_status(task_id: str) -> dict | None:
    try:
        return json.loads(status_path(task_id).read_text())
    except (OSError, ValueError):
        return None


def _run(cmd, cwd=None, env=None, timeout=3600, stdin=None):
    return subprocess.run(
        cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, check=False, input=stdin
    )


def _must(cmd, cwd=None, env=None, timeout=3600):
    proc = _run(cmd, cwd=cwd, env=env, timeout=timeout)
    if proc.returncode != 0:
        raise PrepareError(f"`{' '.join(cmd[:4])}` exited {proc.returncode}: {(proc.stdout + proc.stderr)[-1500:]}")
    return proc


def _commit_all(work: Path) -> None:
    _must(["git", "init", "--quiet", "-b", "main"], cwd=work)
    _must(["git", "add", "-A", "."], cwd=work)
    _must(
        ["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "--quiet", "--no-verify", "-m", "base"],
        cwd=work,
    )


def _build(task: dict) -> None:
    pristine = pristine_dir(task["id"])
    shutil.rmtree(pristine, ignore_errors=True)
    pristine.mkdir(parents=True)
    archive = subprocess.run(
        ["git", "-C", str(paths.REPO_ROOT), "archive", "--format=tar", task["base"]],
        capture_output=True,
        check=False,
    )
    if archive.returncode != 0:
        raise PrepareError(f"git archive {task['base'][:10]}: {archive.stderr.decode()[-400:]}")
    subprocess.run(["tar", "-x", "-C", str(pristine)], input=archive.stdout, check=True)
    _commit_all(pristine)
    if task["kind"] == "ts":
        _must(["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--silent"], cwd=pristine, timeout=1800)
    else:
        # tauri-build checks every externalBin exists (the CI stages the
        # same placeholder); nothing in the tests runs it.
        conf = pristine / "src-tauri" / "tauri.conf.json"
        if conf.exists() and "externalBin" in conf.read_text():
            host = _must(["rustc", "-vV"]).stdout
            triple = next(line.split(": ")[1] for line in host.splitlines() if line.startswith("host: "))
            (pristine / "src-tauri" / "binaries").mkdir(exist_ok=True)
            (pristine / "src-tauri" / "binaries" / f"june-api-{triple}").touch()


def reset_workdir(task: dict) -> Path:
    work = paths.work_dir("subrosa", task["id"])
    if not pristine_dir(task["id"]).exists():
        raise PrepareError(f"{task['id']} is not prepared")
    shutil.rmtree(work, ignore_errors=True)
    work.parent.mkdir(parents=True, exist_ok=True)
    _must(["cp", "-cR", str(pristine_dir(task["id"])), str(work)])
    return work


def _apply(work: Path, patch: str) -> None:
    if not patch.strip():
        return
    with tempfile.NamedTemporaryFile("w", suffix=".diff", delete=False) as handle:
        handle.write(patch)
    try:
        proc = _run(["git", "apply", "--whitespace=nowarn", handle.name], cwd=work)
        if proc.returncode != 0:
            raise PrepareError(f"patch did not apply: {(proc.stdout + proc.stderr)[-800:]}")
    finally:
        os.unlink(handle.name)


def test_command(task: dict) -> list[str]:
    if task["kind"] == "ts":
        return ["pnpm", "exec", "vitest", "run", *task["tests"]]
    return ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", *task["cargo_test"]]


def run_tests(task: dict, work: Path, log_path: Path | None = None) -> dict:
    started = time.time()
    for name in patch_files(task["test_patch"]):
        if _run(["git", "cat-file", "-e", f"HEAD:{name}"], cwd=work).returncode == 0:
            _run(["git", "checkout", "HEAD", "--", name], cwd=work)
        else:
            (work / name).unlink(missing_ok=True)
    try:
        _apply(work, task["test_patch"])
    except PrepareError as error:
        return {"resolved": False, "error": str(error), "test_s": 0.0}
    env = dict(os.environ)
    env["CARGO_TARGET_DIR"] = str(cargo_target())
    env["CARGO_INCREMENTAL"] = "0"
    env["CI"] = "1"
    try:
        proc = _run(test_command(task), cwd=work, env=env, timeout=TEST_TIMEOUT_S)
        log, code = proc.stdout + "\n" + proc.stderr, proc.returncode
    except subprocess.TimeoutExpired:
        log, code = "tests timed out", -1
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(log)
    result = {"resolved": code == 0, "exit_code": code, "test_s": round(time.time() - started, 1)}
    if code == -1:
        result["error"] = "tests timed out"
    return result


def prepare(task: dict, force: bool = False) -> dict:
    existing = read_status(task["id"])
    if existing and not force and not existing.get("reason", "").startswith("environment:"):
        return existing
    started = time.time()
    try:
        _build(task)
        status = validate(task)
        status["state"] = "ok" if status.pop("ok") else "excluded"
    except (PrepareError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        status = {"state": "excluded", "reason": f"environment: {error}"[:2000]}
    status["prepared_s"] = round(time.time() - started, 1)
    status_path(task["id"]).parent.mkdir(parents=True, exist_ok=True)
    status_path(task["id"]).write_text(json.dumps(status, indent=2))
    return status


def validate(task: dict) -> dict:
    """The added tests must fail at the base and pass with the real fix."""
    logs = task_dir(task["id"]) / "validation"
    before = run_tests(task, reset_workdir(task), logs / "base.log")
    work = reset_workdir(task)
    _apply(work, task["gold_patch"])
    after = run_tests(task, work, logs / "gold.log")
    reset_workdir(task)
    if not after["resolved"]:
        return {"ok": False, "reason": "the merged fix does not pass its tests here", "gold_test_s": after["test_s"]}
    if before["resolved"]:
        return {"ok": False, "reason": "the added tests already pass at the base"}
    return {"ok": True, "gold_test_s": after["test_s"], "base_test_s": before["test_s"]}


@dataclass
class SubrosaTask:
    task: dict
    suite: str = "subrosa"

    @property
    def id(self) -> str:
        return self.task["id"]

    def prompt(self, work: Path) -> str:
        if self.task["kind"] == "ts":
            how = (
                "Dependencies are installed (`node_modules`); you can run tests with "
                "`pnpm exec vitest run <file>`."
            )
        else:
            how = "The Rust code may not be buildable from your sandbox: read it carefully instead."
        return (
            "You are working in a checkout of the Sub Rosa repository (a Tauri app: React in "
            "`src/`, Rust in `src-tauri/`).\n\n"
            f"{self.task['prompt']}\n\n"
            f"Make the change in the source code. Hidden tests will check it. {how} When the "
            "change is done, stop."
        )

    def prepare(self) -> Path:
        status = read_status(self.id)
        if not status or status.get("state") != "ok":
            status = prepare(self.task)
        if status.get("state") != "ok":
            raise PrepareError(status.get("reason", "not prepared"))
        return reset_workdir(self.task)

    def verify(self, work: Path, log_path: Path) -> dict:
        return run_tests(self.task, work, log_path)
