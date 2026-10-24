"""What one run says about itself, read from its `CodeEvent` lines (ADR-0123).

- cost and tokens: the last `usage` line (cumulative, the operator's
  metering), else `run.finished.cost_usd`;
- edits: `tool.completed` lines of kind `edit`; an edit failure is one with
  `ok: false`;
- the fuzzy-match strategy of each edit: `detail.edit.strategy`. Hermes
  v0.19 computes it and drops it (docs/hermes-code-surface.md, section 1),
  so it is null today; the P1 `subrosa_code` plugin recomputes it at
  `pre_tool_call` and the adapter will carry it. The bench counts what
  arrives and says "not observable" while nothing does.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


def read_events(path: Path) -> list[dict]:
    events = []
    if not path.exists():
        return events
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and "type" in event:
            events.append(event)
    return events


def summarize(events: list[dict]) -> dict:
    usage = None
    finished = None
    edits = 0
    edit_failures = 0
    tool_calls = 0
    tool_failures = 0
    strategies: Counter = Counter()
    errors = []
    for event in events:
        kind = event["type"]
        if kind == "usage":
            usage = event
        elif kind == "run.finished":
            finished = event
        elif kind == "tool.completed":
            tool_calls += 1
            if not event.get("ok", True):
                tool_failures += 1
            if event.get("kind") == "edit":
                edits += 1
                if not event.get("ok", True):
                    edit_failures += 1
                strategy = ((event.get("detail") or {}).get("edit") or {}).get("strategy")
                if strategy:
                    strategies[strategy] += 1
        elif kind == "error":
            errors.append(event.get("message", "")[:300])
    cost = None
    if usage and usage.get("cost_usd") is not None:
        cost = usage["cost_usd"]
    if finished and finished.get("cost_usd") is not None:
        cost = max(cost or 0.0, finished["cost_usd"])
    return {
        "status": finished.get("status") if finished else "no_finish",
        "reason": (finished or {}).get("reason"),
        "cost_usd": cost,
        "input_tokens": usage.get("input_tokens") if usage else None,
        "output_tokens": usage.get("output_tokens") if usage else None,
        "cached_tokens": usage.get("cached_tokens") if usage else None,
        "tool_calls": tool_calls,
        "tool_failures": tool_failures,
        "edits": edits,
        "edit_failures": edit_failures,
        # None, not {}: "the engine did not say" differs from "no edit".
        "fuzzy_strategies": dict(strategies) if strategies else None,
        "errors": errors[:5],
    }
