# /// script
# requires-python = ">=3.12"
# ///
"""Prepare and validate the bench's tasks (ADR-0122), without any paid call.

For each task: build its working copy and environment under the cache, then
check it is fair here: unsolved at the start, solved by the real fix (the
SWE-bench gold patch, the merged pull request, the reference solution).
Prints one line per task and exits 1 if any task fails validation.

    uv run scripts/code-eval/prepare.py --suite all --jobs 3
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codeeval import subrosa, swe, tasks  # noqa: E402
from codeeval.term import TermTask  # noqa: E402


def check(task) -> tuple[str, dict]:
    if isinstance(task, swe.SweTask):
        return task.id, swe.prepare(task.instance)
    if isinstance(task, subrosa.SubrosaTask):
        return task.id, subrosa.prepare(task.task)
    if isinstance(task, TermTask):
        status = task.validate()
        return task.id, {"state": "ok" if status.pop("ok") else "excluded", **status}
    raise TypeError(task)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--suite", default="all")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    selected = tasks.load(args.suite)
    bad = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for task_id, status in pool.map(check, selected):
            ok = status["state"] == "ok"
            bad += not ok
            reason = "" if ok else f": {status.get('reason', '')[:300]}"
            print(f"{'ok ' if ok else 'BAD'} {task_id}{reason}", flush=True)
    print(f"{len(selected) - bad} of {len(selected)} tasks ready", flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
