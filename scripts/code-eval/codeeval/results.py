"""The results file: one JSON line per (task, pass), appended as each lands.

A pass interrupted half way is resumed by running the same command again:
the (task, pass) pairs already in the file are skipped. A line whose run
broke on the bench's side (`bench_error`) is not a result and is retried.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

RESULT_FIELDS = (
    "task",
    "suite",
    "pass",
    "engine",
    "model",
    "resolved",
    "cost_usd",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "duration_s",
    "agent_s",
    "test_s",
    "edits",
    "edit_failures",
    "tool_calls",
    "tool_failures",
    "fuzzy_strategies",
    "status",
    "exit_code",
    "bench_error",
    "started_at",
)

_lock = threading.Lock()


def read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def done_keys(path: Path) -> set[tuple[str, int]]:
    return {(r["task"], r["pass"]) for r in read(path) if not r.get("bench_error")}


def append(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({k: record.get(k) for k in RESULT_FIELDS} | {k: v for k, v in record.items() if k not in RESULT_FIELDS})
    with _lock, path.open("a") as handle:
        handle.write(line + "\n")
