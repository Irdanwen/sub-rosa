"""The bench's task sets and the fixed `gate20` subset."""

from __future__ import annotations

import json

from . import paths, subrosa, swe, term

SUITES = ("swe", "term", "subrosa")


def load_swe() -> list[swe.SweTask]:
    folder = paths.TASKS_DIR / "swe"
    files = sorted(folder.glob("*.json")) if folder.exists() else []
    out = []
    for path in files:
        instance = json.loads(path.read_text())
        out.append(swe.SweTask(instance))
    return out


def load_suite(name: str) -> list:
    if name == "swe":
        return load_swe()
    if name == "term":
        return term.load_tasks()
    if name == "subrosa":
        return [subrosa.SubrosaTask(t) for t in subrosa.load_tasks()]
    raise ValueError(f"unknown suite {name!r}")


def gate20_ids() -> list[str]:
    return json.loads((paths.TASKS_DIR / "gate20.json").read_text())["tasks"]


def load(selection: str) -> list:
    """`all`, one suite, or `gate20`, in a stable order (suite, then id)."""
    if selection == "all":
        return [task for suite in SUITES for task in load_suite(suite)]
    if selection in SUITES:
        return load_suite(selection)
    if selection == "gate20":
        wanted = gate20_ids()
        everything = {task.id: task for suite in SUITES for task in load_suite(suite)}
        missing = [i for i in wanted if i not in everything]
        if missing:
            raise ValueError(f"gate20 names tasks that do not exist: {missing}")
        return [everything[i] for i in wanted]
    raise ValueError(f"unknown suite {selection!r}")
