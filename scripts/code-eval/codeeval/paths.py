"""Where the bench keeps things."""

from __future__ import annotations

import os
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent.parent
TASKS_DIR = BENCH_DIR / "tasks"
RESULTS_DIR = BENCH_DIR / "results"
REPO_ROOT = BENCH_DIR.parent.parent


def cache_dir() -> Path:
    """The bench's cache, outside the repository: clones, environments,
    working copies and raw logs. `SUBROSA_CODE_EVAL_CACHE` overrides it."""
    override = os.environ.get("SUBROSA_CODE_EVAL_CACHE")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Caches" / "subrosa-code-eval"


def work_dir(suite: str, task_id: str) -> Path:
    """The working copy the agent edits for one task. Always the same path for
    a task: SWE-bench environments are installed in editable mode there."""
    return cache_dir() / "work" / suite / task_id


def logs_dir(run_name: str) -> Path:
    return cache_dir() / "logs" / run_name
