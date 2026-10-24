# /// script
# requires-python = ">=3.12"
# ///
"""The bench's report (ADR-0122), as markdown, from one or more results files.

    uv run scripts/code-eval/report.py scripts/code-eval/results/*.jsonl

Per engine and model: pass@1 per suite and overall (each (task, pass) is one
attempt; pass@1 is the share resolved), total cost and cost per resolved
task, the share of modifications that failed, the median duration, tokens,
and the fuzzy-match strategies seen. Then the gap between passes: the P0
gate asks two passes to land within 3 points of each other.

Only tasks scored in every pass of a group enter the pass-to-pass gap, so an
unfinished second pass does not fake one.
"""

from __future__ import annotations

import argparse
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codeeval import results  # noqa: E402

GATE_POINTS = 3.0
SUITE_ORDER = ("swe", "term", "subrosa")


def scored(records: list[dict]) -> list[dict]:
    """Attempts the bench could score: a bench error is not an attempt."""
    return [r for r in records if not r.get("bench_error") and r.get("resolved") is not None]


def pct(part: float, whole: float) -> str:
    return "n/a" if whole == 0 else f"{100 * part / whole:.1f} %"


def money(value: float | None) -> str:
    return "n/a" if value is None else f"${value:.2f}"


def summarize(records: list[dict]) -> dict:
    attempts = scored(records)
    resolved = sum(1 for r in attempts if r["resolved"])
    costs = [r["cost_usd"] for r in attempts if r.get("cost_usd") is not None]
    total_cost = sum(costs) if costs else None
    edits = [r for r in attempts if r.get("edits") is not None]
    edit_total = sum(r["edits"] for r in edits)
    edit_failed = sum(r.get("edit_failures") or 0 for r in edits)
    durations = [r["duration_s"] for r in attempts if r.get("duration_s") is not None]
    strategies: Counter = Counter()
    for r in attempts:
        strategies.update(r.get("fuzzy_strategies") or {})
    by_suite = {}
    for suite in SUITE_ORDER:
        rows = [r for r in attempts if r.get("suite") == suite]
        if rows:
            by_suite[suite] = (sum(1 for r in rows if r["resolved"]), len(rows))
    return {
        "attempts": len(attempts),
        "resolved": resolved,
        "bench_errors": len(records) - len(attempts),
        "by_suite": by_suite,
        "total_cost": total_cost,
        "cost_per_resolved": (total_cost / resolved) if (total_cost is not None and resolved) else None,
        "edits": edit_total if edits else None,
        "edit_failures": edit_failed if edits else None,
        "median_s": statistics.median(durations) if durations else None,
        "input_tokens": sum(r.get("input_tokens") or 0 for r in attempts),
        "output_tokens": sum(r.get("output_tokens") or 0 for r in attempts),
        "strategies": dict(strategies),
    }


def pass_gap(records: list[dict]) -> dict:
    """pass@1 of each pass over the tasks every pass scored, and the spread."""
    attempts = scored(records)
    by_pass: dict[int, dict[str, bool]] = defaultdict(dict)
    for r in attempts:
        by_pass[r["pass"]][r["task"]] = bool(r["resolved"])
    passes = sorted(by_pass)
    if len(passes) < 2:
        return {"passes": passes, "common": 0, "scores": {}, "gap": None}
    common = set.intersection(*(set(by_pass[p]) for p in passes))
    if not common:
        return {"passes": passes, "common": 0, "scores": {}, "gap": None}
    scores = {p: 100 * sum(by_pass[p][t] for t in common) / len(common) for p in passes}
    return {
        "passes": passes,
        "common": len(common),
        "scores": scores,
        "gap": max(scores.values()) - min(scores.values()),
    }


def render(records: list[dict]) -> str:
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in records:
        groups[(r.get("engine") or "?", r.get("model") or "?")].append(r)
    lines = ["# Code bench report", ""]
    if not groups:
        return "\n".join(lines + ["No results."]) + "\n"
    header = "| Engine | Model | " + " | ".join(f"pass@1 {s}" for s in SUITE_ORDER)
    header += " | pass@1 all | Attempts | Cost | Per resolved | Edit failures | Median time | Tokens in/out |"
    lines += [header, "|" + "---|" * (header.count("|") - 1)]
    summaries = {}
    for (engine, model), rows in sorted(groups.items()):
        s = summarize(rows)
        summaries[(engine, model)] = s
        suites = []
        for suite in SUITE_ORDER:
            if suite in s["by_suite"]:
                ok, n = s["by_suite"][suite]
                suites.append(f"{pct(ok, n)} ({ok}/{n})")
            else:
                suites.append("n/a")
        edits = (
            "not observed"
            if s["edits"] is None
            else f"{pct(s['edit_failures'], s['edits'])} ({s['edit_failures']}/{s['edits']})"
        )
        median = "n/a" if s["median_s"] is None else f"{s['median_s'] / 60:.1f} min"
        lines.append(
            f"| {engine} | {model} | "
            + " | ".join(suites)
            + f" | {pct(s['resolved'], s['attempts'])} | {s['attempts']}"
            + (f" (+{s['bench_errors']} bench errors)" if s["bench_errors"] else "")
            + f" | {money(s['total_cost'])} | {money(s['cost_per_resolved'])} | {edits} | {median}"
            + f" | {s['input_tokens']:,} / {s['output_tokens']:,} |"
        )
    lines += ["", "## Pass to pass (P0 gate: within 3 points)", ""]
    lines += ["| Engine | Model | Tasks in every pass | pass@1 per pass | Gap | Gate |", "|---|---|---|---|---|---|"]
    for (engine, model), rows in sorted(groups.items()):
        gap = pass_gap(rows)
        if gap["gap"] is None:
            lines.append(f"| {engine} | {model} | {gap['common']} | {len(gap['passes'])} pass(es) | n/a | needs two passes |")
            continue
        per = ", ".join(f"#{p}: {v:.1f} %" for p, v in sorted(gap["scores"].items()))
        verdict = "within" if gap["gap"] <= GATE_POINTS else "OUT"
        lines.append(f"| {engine} | {model} | {gap['common']} | {per} | {gap['gap']:.1f} pts | {verdict} |")
    lines += ["", "## Fuzzy-match strategies", ""]
    for (engine, model), s in sorted(summaries.items()):
        if s["strategies"]:
            seen = ", ".join(f"{k}: {v}" for k, v in sorted(s["strategies"].items(), key=lambda kv: -kv[1]))
        else:
            seen = "not observable (Hermes v0.19 drops it; the P1 subrosa_code plugin reports it)"
        lines.append(f"- {engine} / {model}: {seen}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, help="write the markdown here too")
    args = parser.parse_args(argv)
    records = [r for path in args.files for r in results.read(path)]
    text = render(records)
    print(text, end="")
    if args.out:
        args.out.write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
