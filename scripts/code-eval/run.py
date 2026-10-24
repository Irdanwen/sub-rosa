# /// script
# requires-python = ">=3.12"
# ///
"""Run the code bench (ADR-0122): one engine, one model, N passes.

For each task: a clean working copy, the engine on it with the task's
request (Sub Rosa's `subrosa-code run` in build mode, or mini-swe-agent),
then the task's hidden check. One JSON line per (task, pass) in `--out`.

    uv run scripts/code-eval/run.py --suite gate20 --model kimi-k2-7-code \\
        --passes 2 --engine subrosa --budget-per-task 0.50

THIS SPENDS MONEY on the Carpe Diem key. `--max-total-usd` stops starting
new tasks once the results file reaches that total. Re-running the same
command resumes: tasks already scored in `--out` are skipped.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import queue
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codeeval import engines, paths, results, tasks  # noqa: E402


def default_out(model: str, engine: str) -> Path:
    stamp = dt.date.today().isoformat()
    suffix = "" if engine == "subrosa" else f"-{engine}"
    return paths.RESULTS_DIR / f"{stamp}-{model}{suffix}.jsonl"


class TaskLock:
    """One run of a task at a time on this machine: its working copy has a
    fixed path (SWE-bench environments are installed in editable mode)."""

    def __init__(self, task_id: str):
        folder = paths.cache_dir() / "locks"
        folder.mkdir(parents=True, exist_ok=True)
        self.handle = (folder / f"{task_id}.lock").open("w")

    def __enter__(self):
        fcntl.flock(self.handle, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


def run_one(task, pass_index: int, engine, run_name: str, slot: int) -> dict:
    record = {
        "task": task.id,
        "suite": task.suite,
        "pass": pass_index,
        "engine": engine.name,
        "model": engine.model,
        "started_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }
    logs = paths.logs_dir(run_name) / task.id / f"pass-{pass_index}"
    started = time.time()
    with TaskLock(task.id):
        try:
            work = task.prepare()
        except Exception as error:  # noqa: BLE001 - recorded, then retried on resume
            record["bench_error"] = f"prepare: {error}"[:1000]
            return record
        try:
            summary = engine.run(task.prompt(work), work, logs, slot)
        except Exception:  # noqa: BLE001
            record["bench_error"] = "engine: " + traceback.format_exc()[-1000:]
            return record
        record.update(summary)
        try:
            check = task.verify(work, logs / "check.log")
        except Exception:  # noqa: BLE001
            record["bench_error"] = "check: " + traceback.format_exc()[-1000:]
            return record
    record["resolved"] = bool(check.get("resolved"))
    record["test_s"] = check.get("test_s")
    record["check"] = {k: v for k, v in check.items() if k not in ("resolved", "test_s")}
    record["duration_s"] = round(time.time() - started, 1)
    record["logs"] = str(logs.relative_to(paths.cache_dir()))  # committed: no home folder
    return record


def spent(path: Path) -> float:
    return sum(r.get("cost_usd") or 0.0 for r in results.read(path))


def main(argv: list[str] | None = None, engine_factory=engines.make) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--suite", default="gate20", help="all, swe, term, subrosa or gate20")
    parser.add_argument("--model", required=True)
    parser.add_argument("--passes", type=int, default=1)
    parser.add_argument("--engine", default="subrosa", choices=sorted(engines.ENGINES))
    parser.add_argument("--budget-per-task", type=float, default=1.0, help="dollars")
    parser.add_argument("--max-total-usd", type=float, default=None)
    parser.add_argument("--timeout-per-task", type=int, default=2400, help="seconds")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--task", action="append", help="only these task ids")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    selected = tasks.load(args.suite)
    if args.task:
        selected = [t for t in selected if t.id in set(args.task)]
    out = args.out or default_out(args.model, args.engine)
    run_name = out.stem
    key = engines.carpe_diem_key()
    engine = engine_factory(args.engine, args.model, args.budget_per_task, args.timeout_per_task, key)
    slots: queue.Queue[int] = queue.Queue()
    for slot in range(args.jobs):
        slots.put(slot)

    def work(item):
        task, pass_index = item
        if args.max_total_usd is not None and spent(out) >= args.max_total_usd:
            return None
        slot = slots.get()
        try:
            record = run_one(task, pass_index, engine, run_name, slot)
        finally:
            slots.put(slot)
        results.append(out, record)
        verdict = "error" if record.get("bench_error") else ("PASS" if record.get("resolved") else "fail")
        cost = record.get("cost_usd")
        print(
            f"[pass {pass_index}] {task.id}: {verdict}"
            + (f" ${cost:.4f}" if cost is not None else "")
            + (f" ({record['bench_error'][:200]})" if record.get("bench_error") else ""),
            flush=True,
        )
        return record

    for pass_index in range(1, args.passes + 1):
        done = results.done_keys(out)
        todo = [(t, pass_index) for t in selected if (t.id, pass_index) not in done]
        print(f"pass {pass_index}: {len(todo)} to run, {len(selected) - len(todo)} already scored", flush=True)
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            list(pool.map(work, todo))
    print(f"results: {out}  (spent ${spent(out):.4f})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
