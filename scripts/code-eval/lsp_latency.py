"""Time Hermes' diagnostics after an edit, under Sub Rosa's jail (ADR-0125).

This file is the probe half of a free, local measurement. The other half is
the Rust harness, which writes what the app writes (the real Seatbelt
profile, the runtime's toolchain environment, the `lsp:` key of
`config.yaml`), runs the real preinstall, then runs this file with the pinned
runtime's own Python inside `sandbox-exec`:

    cd src-tauri && cargo test --lib --features code-cli \\
        lsp_latency_under_the_jail -- --ignored --nocapture

Options of the harness, through the environment: `SUBROSA_LSP_ITERATIONS`
(default 20), `SUBROSA_LSP_LANGS` (default `ts7,ts,py,rs`),
`SUBROSA_LSP_RUST_ANALYZER` (a rust-analyzer binary to use when the machine
has none; never needed by the app), `SUBROSA_LSP_OUT` (where the JSON summary
goes), `SUBROSA_HERMES_RUNTIME` (the installed runtime folder).

What the probe does, per language: a small git repository in the granted
folder, then N pairs of edits through `ShellFileOperations.write_file` (the
code path of Hermes' `write_file` and `patch` tools), one that introduces a
type error and one that fixes it. Each edit is timed three ways: the
baseline snapshot before the write, the wait for fresh diagnostics after it
(the "delay between an edit and its diagnostics" of the P1 gate), and the
whole call. The first edit of a language is reported apart: it pays for the
server's cold start.

No model is called and nothing is paid for: the language servers run on this
machine.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

CASES = {
    # TypeScript 7 in the project: the app's launcher runs `tsc --lsp`.
    "ts7": {
        "files": {
            "package.json": '{"name": "probe-ts7", "private": true}\n',
            "tsconfig.json": '{"compilerOptions": {"strict": true, "noEmit": true}, "include": ["src"]}\n',
            "src/value.ts": "export const value: number = 1;\n",
        },
        "edit": "src/value.ts",
        "broken": 'export const value: number = "one";\n',
        "fixed": "export const value: number = 1;\n",
        "typescript7": True,
    },
    # No TypeScript in the project: typescript-language-server with the
    # TypeScript 6 the preinstall puts beside it.
    "ts": {
        "files": {
            "package.json": '{"name": "probe-ts", "private": true}\n',
            "tsconfig.json": '{"compilerOptions": {"strict": true, "noEmit": true}, "include": ["src"]}\n',
            "src/value.ts": "export const value: number = 1;\n",
        },
        "edit": "src/value.ts",
        "broken": 'export const value: number = "one";\n',
        "fixed": "export const value: number = 1;\n",
    },
    "py": {
        "files": {
            "pyproject.toml": '[project]\nname = "probe"\nversion = "0.0.0"\n',
            "probe/__init__.py": "",
            "probe/value.py": "def value() -> int:\n    return 1\n",
        },
        "edit": "probe/value.py",
        "broken": 'def value() -> int:\n    return "one"\n',
        "fixed": "def value() -> int:\n    return 1\n",
    },
    "rs": {
        "files": {
            "Cargo.toml": '[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n',
            "src/lib.rs": "pub fn value() -> u32 {\n    1\n}\n",
        },
        "edit": "src/lib.rs",
        "broken": 'pub fn value() -> u32 {\n    "one"\n}\n',
        "fixed": "pub fn value() -> u32 {\n    1\n}\n",
    },
}


def percentile(samples: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile, so a p95 is a value that was measured."""
    if not samples:
        return None
    ordered = sorted(samples)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def make_repo(root: Path, case: dict, typescript7: str | None) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for relative, text in case["files"].items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if case.get("typescript7"):
        if not typescript7:
            raise SystemExit("ts7 needs --typescript7 (a TypeScript 7 package folder)")
        modules = root / "node_modules"
        (modules / ".bin").mkdir(parents=True, exist_ok=True)
        link = modules / "typescript"
        if not link.exists():
            link.symlink_to(Path(typescript7).resolve())
        tsc = modules / ".bin" / "tsc"
        if not tsc.exists():
            tsc.symlink_to("../typescript/bin/tsc")
    if not (root / ".git").exists():
        subprocess.run(["git", "init", "-q", str(root)], check=True)


def instrument():
    """Times the two LSP calls `write_file` makes, without changing them."""
    from agent.lsp.manager import LSPService

    timings: dict[str, float] = {}
    original_baseline = LSPService.snapshot_baseline
    original_diagnostics = LSPService.get_diagnostics_sync

    def snapshot_baseline(self, file_path):
        started = time.perf_counter()
        try:
            return original_baseline(self, file_path)
        finally:
            timings["baseline"] = time.perf_counter() - started

    def get_diagnostics_sync(self, file_path, **kwargs):
        started = time.perf_counter()
        try:
            return original_diagnostics(self, file_path, **kwargs)
        finally:
            timings["diagnostics"] = time.perf_counter() - started

    LSPService.snapshot_baseline = snapshot_baseline
    LSPService.get_diagnostics_sync = get_diagnostics_sync
    return timings


def measure(lang: str, root: Path, iterations: int, timings: dict) -> dict:
    from tools.environments.local import LocalEnvironment
    from tools.file_operations import ShellFileOperations

    case = CASES[lang]
    target = str(root / case["edit"])
    ops = ShellFileOperations(LocalEnvironment(cwd=str(root), timeout=60))
    samples = []
    for index in range(iterations):
        for content, expect_error in ((case["broken"], True), (case["fixed"], False)):
            timings.clear()
            started = time.perf_counter()
            result = ops.write_file(target, content)
            total = time.perf_counter() - started
            block = getattr(result, "lsp_diagnostics", None) or ""
            samples.append(
                {
                    "lang": lang,
                    "index": index,
                    "expect_error": expect_error,
                    "got_error": bool(block),
                    "baseline_s": timings.get("baseline"),
                    "diagnostics_s": timings.get("diagnostics"),
                    "total_s": total,
                    "error": getattr(result, "error", None),
                    "excerpt": block[:240],
                }
            )
    return summarize(lang, samples)


def summarize(lang: str, samples: list[dict]) -> dict:
    first, warm = samples[0], samples[1:]
    delays = [s["diagnostics_s"] for s in warm if s["diagnostics_s"] is not None]
    totals = [s["total_s"] for s in warm]
    baselines = [s["baseline_s"] for s in warm if s["baseline_s"] is not None]
    right = sum(1 for s in samples if s["got_error"] == s["expect_error"])
    return {
        "lang": lang,
        "edits": len(samples),
        "lsp_ran": sum(1 for s in samples if s["diagnostics_s"] is not None),
        "correct": right,
        "first_edit_total_s": first["total_s"],
        "first_edit_baseline_s": first["baseline_s"],
        "first_edit_diagnostics_s": first["diagnostics_s"],
        "diagnostics_p50_s": percentile(delays, 0.50),
        "diagnostics_p95_s": percentile(delays, 0.95),
        "diagnostics_max_s": max(delays) if delays else None,
        "baseline_p50_s": percentile(baselines, 0.50),
        "baseline_p95_s": percentile(baselines, 0.95),
        "baseline_over_4s": sum(1 for b in baselines if b > 4.0),
        "edit_total_p50_s": percentile(totals, 0.50),
        "edit_total_p95_s": percentile(totals, 0.95),
        "mean_diagnostics_s": statistics.fmean(delays) if delays else None,
        "first_excerpt": next((s["excerpt"] for s in samples if s["excerpt"]), ""),
        "wrong": [
            {k: s[k] for k in ("index", "expect_error", "got_error", "error")}
            for s in samples
            if s["got_error"] != s["expect_error"]
        ][:5],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--langs", default="ts7,ts,py,rs")
    parser.add_argument("--typescript7")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    timings = instrument()
    summaries = []
    for lang in [item.strip() for item in args.langs.split(",") if item.strip()]:
        if lang not in CASES:
            raise SystemExit(f"unknown language {lang!r}; pick from {sorted(CASES)}")
        root = (args.work / f"probe-{lang}").resolve()
        make_repo(root, CASES[lang], args.typescript7)
        # Each repository is its own cwd, as a run in that folder would be.
        os.chdir(root)
        summaries.append(measure(lang, root, args.iterations, timings))
        print(json.dumps(summaries[-1]), flush=True)
    args.out.write_text(json.dumps(summaries, indent=2) + "\n")
    try:
        from agent.lsp import shutdown_service

        shutdown_service()
    except Exception as error:  # noqa: BLE001
        print(f"language servers not shut down cleanly: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
