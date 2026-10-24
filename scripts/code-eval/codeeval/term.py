"""Terminal tasks, in the spirit of Terminal-Bench, written for this bench.

A task is a folder under `tasks/term/<name>/`:

- `task.json`: `id`, `prompt`, `timeout_s`;
- `start/` (optional): files copied into the working copy;
- `setup.sh` (optional): run in the working copy after the copy, to build
  what is awkward to commit (a nested git repository, a database, 400 logs);
- `verify.sh`: run in the working copy after the agent; exit code 0 = solved;
- `solution.sh`: a reference solution, used only to validate the task.

The working copy is committed as one commit after setup, so a check can ask
`git diff` whether the agent touched what it was told to leave alone. The
checks and solutions stay in the repository, outside the working copy.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .swe import PrepareError

VERIFY_TIMEOUT_S = 300


def task_dirs() -> list[Path]:
    root = paths.TASKS_DIR / "term"
    return sorted(p for p in root.iterdir() if (p / "task.json").exists()) if root.exists() else []


def _sh(script: Path, cwd: Path, timeout: int = VERIFY_TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/bin/sh", str(script)], cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
    )


@dataclass
class TermTask:
    folder: Path
    suite: str = "term"

    @property
    def spec(self) -> dict:
        return json.loads((self.folder / "task.json").read_text())

    @property
    def id(self) -> str:
        return self.spec["id"]

    def prompt(self, work: Path) -> str:
        return f"{self.spec['prompt']}\n\nWork in the current folder. When the task is done, stop."

    def prepare(self) -> Path:
        work = paths.work_dir("term", self.id)
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        start = self.folder / "start"
        if start.exists():
            shutil.copytree(start, work, dirs_exist_ok=True, symlinks=True)
        setup = self.folder / "setup.sh"
        if setup.exists():
            proc = _sh(setup, work, timeout=600)
            if proc.returncode != 0:
                raise PrepareError(f"setup failed: {(proc.stdout + proc.stderr)[-600:]}")
        for cmd in (
            ["git", "init", "--quiet", "-b", "main"],
            ["git", "add", "-A", "."],
            ["git", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "--quiet", "--no-verify", "-m", "start"],
        ):
            proc = subprocess.run(cmd, cwd=work, capture_output=True, text=True, check=False)
            if proc.returncode != 0:
                raise PrepareError(f"{' '.join(cmd[:2])}: {proc.stderr[-400:]}")
        return work

    def verify(self, work: Path, log_path: Path) -> dict:
        started = time.time()
        try:
            proc = _sh(self.folder / "verify.sh", work)
            log, code = proc.stdout + proc.stderr, proc.returncode
        except subprocess.TimeoutExpired:
            log, code = "verify timed out", -1
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(log)
        return {"resolved": code == 0, "exit_code": code, "test_s": round(time.time() - started, 1)}

    def validate(self) -> dict:
        """Unsolved at the start, solved by the reference solution."""
        logs = paths.cache_dir() / "term" / self.id
        work = self.prepare()
        before = self.verify(work, logs / "start.log")
        work = self.prepare()
        proc = _sh(self.folder / "solution.sh", work)
        if proc.returncode != 0:
            return {"ok": False, "reason": f"solution failed: {(proc.stdout + proc.stderr)[-400:]}"}
        after = self.verify(work, logs / "solution.log")
        self.prepare()
        if before["resolved"]:
            return {"ok": False, "reason": "already solved at the start"}
        if not after["resolved"]:
            return {"ok": False, "reason": "the reference solution does not pass: " + (logs / "solution.log").read_text()[-400:]}
        return {"ok": True}


def load_tasks() -> list[TermTask]:
    return [TermTask(folder) for folder in task_dirs()]
