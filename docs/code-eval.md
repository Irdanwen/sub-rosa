# The code bench

The code bench measures Sub Rosa's code runs on fixed tasks, so that every
gate of the Code plan is a number rather than an impression
([ADR-0122](adr/0122-the-code-plan-is-measured-on-a-local-bench.md)). It lives
in `scripts/code-eval/`: Python 3.12 scripts run by `uv`, no dependency in
`package.json`, no CI job (a pass costs money).

**Every `run.py` invocation spends Carpe Diem credits** on the key it finds
(`SUBROSA_DEV_API_KEY`, else the app's keychain item). Preparing, validating
and reporting spend nothing.

## The tasks (60, plus the 20 of the gate)

| Suite | Count | Where | What decides |
|---|---|---|---|
| `swe` | 40 | `tasks/swe/<instance_id>.json`, exclusions in `tasks/swe-excluded.json` | the instance's FAIL_TO_PASS and PASS_TO_PASS tests, graded like the SWE-bench harness |
| `term` | 10 | `tasks/term/<name>/` (`task.json`, `start/`, `setup.sh`, `verify.sh`, `solution.sh`) | `verify.sh`'s exit code |
| `subrosa` | 10 | `tasks/subrosa.json` | the tests the merged pull request added, run by vitest or `cargo test` |
| `gate20` | 20 | `tasks/gate20.json` (ids from the three suites) | as above |

- **SWE-bench Verified**, without Docker: only repositories that install in a
  local `uv` environment (Django, SymPy, pytest, pylint, Requests 2.9+,
  Sphinx, xarray, Flask, seaborn), difficulty under an hour, picked in a hash
  order of their ids until each repository's quota is met. Each instance
  is validated here before it is kept: its tests fail at the base and the
  gold patch passes them. `freeze_swe.py` downloads the dataset and writes
  the selection.
- **Terminal tasks** are written for this bench: a Makefile, a config
  migration, a search, a shell script, a log, a CSV, a lost git commit, an
  import cycle, a SQL query, a batch rename. Each ships a reference solution
  used only to validate it.
- **Sub Rosa tasks** come from small merged pull requests (seven TypeScript,
  three Rust, one of them with a migration). The base is the merge's first
  parent, the request is the pull request rewritten as an ask, the check is
  its added tests. `freeze_subrosa.py` writes them from git.

## Running it

From the repository root. The CLI must be built first (once per change of
the Rust code):

```sh
export CARGO_TARGET_DIR=~/Library/Caches/subrosa-target CARGO_INCREMENTAL=0
(cd src-tauri && cargo build --features code-cli --bin subrosa-code)

uv run scripts/code-eval/prepare.py --suite all --jobs 3      # free; the first time takes hours
uv run scripts/code-eval/run.py --suite gate20 --model kimi-k2-7-code \
    --passes 2 --engine subrosa --budget-per-task 0.50 --max-total-usd 20
uv run scripts/code-eval/run.py --suite gate20 --model kimi-k2-7-code \
    --passes 2 --engine mini-swe-agent --budget-per-task 0.50 --max-total-usd 20
uv run scripts/code-eval/report.py scripts/code-eval/results/*.jsonl
```

| Option | Meaning |
|---|---|
| `--suite` | `all`, `swe`, `term`, `subrosa` or `gate20` |
| `--model` | a Carpe Diem model id, as `/v1/models` lists it |
| `--passes N` | how many times each task runs; two for the P0 gate |
| `--engine` | `subrosa` (`subrosa-code run --mode build`) or `mini-swe-agent` |
| `--budget-per-task` | dollars; the run's own budget, enforced by the engine |
| `--max-total-usd` | no new task starts once the results file has spent this |
| `--jobs` | tasks in parallel (default 2); each Sub Rosa job has its own data folder |
| `--timeout-per-task` | seconds (default 2400), then the run is stopped |
| `--task` | only these ids (repeatable) |
| `--out` | the results file; default `results/<date>-<model>[-<engine>].jsonl` |

**Resuming:** run the same command again. Every (task, pass) already in
`--out` is skipped; a line the bench itself broke (`bench_error`) is retried.

**Where things go:** the repository holds tasks and results only. Clones,
`uv` environments, working copies, per-job data folders and raw logs (each
run's `events.jsonl`, stderr and check log) are in
`~/Library/Caches/subrosa-code-eval/` (`SUBROSA_CODE_EVAL_CACHE` to move it).
About 20 GB as `du` counts it once everything is prepared (the working
copies are APFS clones of the snapshots, so the disk holds less): Python
environments, Sub Rosa checkouts with `node_modules`, and the Rust target
folder of the Rust tasks.

**Unit tests** (fake engine, fake results, no network):
`uv run --with pytest pytest scripts/code-eval/tests`.

## The two engines

- **subrosa**: `subrosa-code run` (docs/code-cli.md) with the task's request
  on stdin, in build mode, under the macOS write jail. Cost and tokens are
  the last `usage` line; modifications are `tool.completed` lines of kind
  `edit`, failed ones are `ok: false`.
- **mini-swe-agent** (MIT, version pinned in `codeeval/engines.py`), installed
  by `uv` in the cache: its stock prompts and agent, the same model through
  `https://carpe-diem.xyz/api/operator/v1`, the cost read from the same
  operator metering (`usage.carpe_cost_usdc_micro`), every command under a
  Seatbelt profile like Sub Rosa's. It edits through bash, so its
  modification counts stay "not observed".

The fuzzy-match strategy of each modification is not observable yet: Hermes
v0.19 computes it and drops it (docs/hermes-code-surface.md, section 1). The
field is recorded as null and the report says so; the P1 `subrosa_code`
plugin recomputes it at `pre_tool_call` and the column fills by itself.

## Reading the report

- **pass@1** per suite and overall: the share of attempts resolved, each
  (task, pass) being one attempt. Bench errors are left out and counted
  apart.
- **Cost** is the total spent; **per resolved** divides it by the resolved
  attempts, the number to compare between models.
- **Edit failures**: failed modifications over all modifications.
- **Median time**: from the clean copy to the end of the check.
- **Pass to pass**: pass@1 of each pass on the tasks every pass scored, and
  the spread. The P0 gate asks it to be within **3 points** for glm-5.2,
  kimi-k2-7-code and claude-sonnet-5-5.

## What a pass costs

**Measured** on the validation pass of 2026-10-24 (kimi-k2-7-code, Sub Rosa
engine, one task per suite, `--budget-per-task 0.18`; results and report in
`scripts/code-eval/results/2026-10-24-kimi-k2-7-code-validation.*`):

| Task | Resolved | Cost | Input tokens (cached) | Output | Tool calls | Edits (failed) | Time |
|---|---|---|---|---|---|---|---|
| pallets__flask-5014 | yes | $0.181 | 1.99 M (1.89 M) | 12 k | 120 | 1 (0) | 9.2 min |
| term-fix-makefile | no | $0.181 | 1.78 M (1.64 M) | 17 k | 113 | 47 (2) | 7.5 min |
| subrosa-446-v2v-duration | no | $0.181 | 2.19 M (2.13 M) | 8 k | 91 | 0 (0) | 4.9 min |

All three ran into the $0.18 budget. The flask fix was made early, then the
agent kept verifying; the Makefile was fixed, but the agent also changed
`greet.h` to test the dependency, which the task forbids; the Sub Rosa task
was still reading the code. About 95 % of the input is cached, and the
system prompt and tool schemas (about 11 k tokens) are re-read on every
completion. So **give a task at least $0.50 with this model**: at $0.18 the
budget, not the model, decides most outcomes.

From list prices (dollars per million tokens, `/pricing` of 2026-10-23) and
the token profile above (about 2 M input, 95 % cached, 15 k output per task):

| Model | Input | Cached input | Output | Per task, at that profile |
|---|---|---|---|---|
| kimi-k2-7-code | 0.32 | 0.07 | 1.51 | about $0.18 (measured) |
| z-ai-glm-5-3 (the GLM 5 line: check the id in `/v1/models`) | 0.76 | 0.14 | 2.38 | about $0.38 |
| claude-sonnet-5-5 | 0.86 | 0.04 | 4.32 | about $0.23, plus cache writes |

A task that runs to a $0.50 budget costs $0.50. Two passes of `gate20` with
three models and both engines is 240 attempts: plan **$60 to $120**, and
always pass `--max-total-usd`.

## Changing the bench

The tasks are frozen: a change of a task changes every score after it.
Re-freeze only with a reason recorded in an addendum to ADR-0122, and keep
old results with the task set they were scored on (git history).
