# /// script
# requires-python = ">=3.12"
# dependencies = ["pyarrow>=17"]
# ///
"""Freeze the SWE-bench Verified part of the bench (ADR-0122).

Downloads SWE-bench Verified from Hugging Face, keeps the instances whose
repository and version can be installed in a local `uv` environment (the
table in `codeeval/swe.py`) and whose difficulty is under an hour, orders
them by a hash of their id (a stable, unbiased order), then prepares and
validates candidates repository by repository until each quota is filled.
Writes one JSON file per kept instance under `tasks/swe/`, and every
candidate that was tried and left out, with its reason, in
`tasks/swe-excluded.json`.

    uv run scripts/code-eval/freeze_swe.py            # the 40 of the bench
    uv run scripts/code-eval/freeze_swe.py --jobs 4

Re-running keeps what is already validated (statuses live in the cache).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codeeval import paths, swe  # noqa: E402
from codeeval.fmt import biome_format  # noqa: E402

DATASET_URL = (
    "https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/resolve/main/"
    "data/test-00000-of-00001.parquet"
)
FIELDS = (
    "instance_id",
    "repo",
    "version",
    "base_commit",
    "environment_setup_commit",
    "difficulty",
    "problem_statement",
    "patch",
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
)
# The repositories kept and how many instances each brings: the shape of
# SWE-bench Lite where it can run here (Django and SymPy dominate, as there).
QUOTAS = {
    "sympy/sympy": 9,
    "pytest-dev/pytest": 4,
    "pylint-dev/pylint": 3,
    "psf/requests": 2,
    "sphinx-doc/sphinx": 3,
    "pydata/xarray": 2,
    "pallets/flask": 1,
    "mwaskom/seaborn": 1,
    # Last: it takes whatever the others could not fill, up to TOTAL.
    "django/django": 15,
}
TOTAL = 40
FILL_REPO = "django/django"
DIFFICULTIES = ("<15 min fix", "15 min - 1 hour")


def download() -> list[dict]:
    import pyarrow.parquet as pq

    target = paths.cache_dir() / "dl" / "verified.parquet"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(DATASET_URL, target)
    rows = pq.read_table(target).to_pylist()
    for row in rows:
        for key in ("FAIL_TO_PASS", "PASS_TO_PASS"):
            if isinstance(row[key], str):
                row[key] = json.loads(row[key])
    return rows


def order_key(instance_id: str) -> str:
    return hashlib.sha256(instance_id.encode()).hexdigest()


def candidates(rows: list[dict]) -> dict[str, list[dict]]:
    by_repo: dict[str, list[dict]] = {repo: [] for repo in QUOTAS}
    for row in rows:
        if row["repo"] not in QUOTAS or row["difficulty"] not in DIFFICULTIES:
            continue
        if not swe.supported(row["repo"], row["version"]):
            continue
        by_repo[row["repo"]].append({key: row[key] for key in FIELDS})
    for items in by_repo.values():
        items.sort(key=lambda r: order_key(r["instance_id"]))
    return by_repo


def fill(repo: str, items: list[dict], quota: int, jobs: int) -> tuple[list[dict], list[dict]]:
    """Validates candidates in order, a batch at a time, until `quota` pass."""
    kept, excluded = [], []
    index = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        while len(kept) < quota and index < len(items):
            batch = items[index : index + max(1, min(jobs, quota - len(kept)))]
            index += len(batch)
            for item, status in zip(batch, pool.map(swe.prepare, batch), strict=True):
                if status["state"] == "ok" and len(kept) < quota:
                    kept.append(item)
                    print(f"  kept {item['instance_id']}", flush=True)
                elif status["state"] != "ok":
                    excluded.append({"instance_id": item["instance_id"], "reason": status["reason"]})
                    print(f"  excluded {item['instance_id']}: {status['reason'][:160]}", flush=True)
    if len(kept) < quota:
        print(f"  {repo}: only {len(kept)} of {quota}", flush=True)
    return kept, excluded


def write(kept: list[dict], excluded: list[dict]) -> None:
    out = paths.TASKS_DIR / "swe"
    out.mkdir(parents=True, exist_ok=True)
    keep_ids = {item["instance_id"] for item in kept}
    for stale in out.glob("*.json"):
        if stale.stem not in keep_ids:
            stale.unlink()
    for item in kept:
        record = {**item, "source": "princeton-nlp/SWE-bench_Verified"}
        (out / f"{item['instance_id']}.json").write_text(json.dumps(record, indent=2) + "\n")
    excluded.sort(key=lambda e: e["instance_id"])
    (paths.TASKS_DIR / "swe-excluded.json").write_text(
        json.dumps({"excluded": excluded}, indent=2) + "\n"
    )
    biome_format([out, paths.TASKS_DIR / "swe-excluded.json"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--repo", action="append", help="only these repositories")
    args = parser.parse_args()
    rows = download()
    by_repo = candidates(rows)
    kept_all, excluded_all = [], []
    # Keep what an earlier freeze wrote for repositories not re-run.
    previous = {p.stem: json.loads(p.read_text()) for p in (paths.TASKS_DIR / "swe").glob("*.json")}
    previous_excluded = []
    excluded_file = paths.TASKS_DIR / "swe-excluded.json"
    if excluded_file.exists():
        previous_excluded = json.loads(excluded_file.read_text())["excluded"]
    for repo, quota in QUOTAS.items():
        if args.repo and repo not in args.repo:
            kept_all += [r for r in previous.values() if r["repo"] == repo]
            excluded_all += [e for e in previous_excluded if e["instance_id"].startswith(repo.replace("/", "__"))]
            continue
        if repo == FILL_REPO:
            quota = max(quota, TOTAL - len(kept_all))
        print(f"{repo}: {len(by_repo[repo])} candidates, quota {quota}", flush=True)
        kept, excluded = fill(repo, by_repo[repo], quota, args.jobs)
        kept_all += kept
        excluded_all += excluded
    for record in kept_all:
        record.pop("source", None)
    write(kept_all, excluded_all)
    print(f"{len(kept_all)} instances kept, {len(excluded_all)} excluded", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
