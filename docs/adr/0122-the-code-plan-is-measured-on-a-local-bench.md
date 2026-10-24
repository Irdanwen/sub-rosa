# ADR-0122: The code plan is measured on a local bench before anything is built

Date: 2026-10-24. Status: accepted. Lot C0.1 of the Code plan. Builds on
[ADR-0123](0123-code-events-are-one-neutral-contract-with-two-adapters.md)
(the `CodeEvent` lines and the headless `subrosa-code run` the bench drives).
No migration.

## Context

The Code plan proposes some forty changes to how Sub Rosa does code work:
configuration of what Hermes already has, ports from other harnesses, new
Rust shared by every engine. Each is justified by a claim ("this guard
matters", "this prompt format suits this model family"), and most of the
claims come from other projects measured on other models. Without a number
of our own, every gate of the plan would be read from impressions, and an
improvement that hurts on Carpe Diem's models would ship anyway.

The obvious instrument is the official SWE-bench harness. It runs each
instance in its own Docker image. This Mac has no Docker, and the bench must
run where the product runs: on the person's Mac, through the real write jail,
the real sidecar and the real operator metering.

## Decision

1. **A bench of 60 fixed tasks in `scripts/code-eval/`, versioned in the
   repository, run locally.** 40 SWE-bench Verified instances, 10 terminal
   tasks written for it, 10 tasks taken from merged Sub Rosa pull requests.
   A fixed subset of 20 (`gate20`), mixing the three, is the instrument of
   every later gate. Python 3.12 through `uv`, nothing added to
   `package.json`, **no CI job**: a pass spends real credits and is launched
   by a person, with `--max-total-usd`.
2. **SWE-bench without Docker, restricted to what installs in `uv`.** An
   instance qualifies when its repository and version have an environment
   in `codeeval/swe.py` (transcribed from the harness's specifications:
   Python version, pinned packages, requirements, test command), which keeps
   Django, SymPy, pytest, pylint, Requests 2.9+, Sphinx, xarray, Flask and
   seaborn, and leaves out whatever needs a system package manager or a
   compiled scientific stack (astropy, matplotlib, scikit-learn). Each
   instance is built once in the cache (`~/Library/Caches/subrosa-code-eval/`):
   the base commit fetched shallow, installed in editable mode at a fixed
   path, then given a fresh one-commit history so the fix cannot be read from
   the future, and snapshotted. It is **kept only after validation here**:
   its tests fail at the base and the gold patch makes every FAIL_TO_PASS
   and PASS_TO_PASS test pass. Grading follows the harness (test files the
   test patch touches are reset, the test patch applied, the directives and
   log parsers of the harness). Candidates are taken in a hash order of
   their ids, so the selection is not hand-picked; every candidate that was
   tried and left out is listed with its reason in `tasks/swe-excluded.json`.
3. **Two engines, the same conditions.** Sub Rosa's engine is
   `subrosa-code run --mode build`, unchanged, under the write jail. The
   reference column is mini-swe-agent (MIT), stock prompts and agent, the
   same model, the same key, the same per-task budget, its cost read from
   the same operator metering, and its commands under a Seatbelt profile
   shaped like Sub Rosa's jail. The reference tells whether our harness helps
   or hurts a given model.
4. **What is measured.** pass@1 per suite and overall; cost (the operator's
   metering, never a token estimate) in total and per resolved task; tokens;
   modifications and failed modifications; duration; and the fuzzy-match
   strategy of each modification. That last one is **recorded as null**:
   Hermes v0.19 computes it and drops it (docs/hermes-code-surface.md,
   section 1); the P1 `subrosa_code` plugin will recompute it, and the field
   fills without a bench change. The P0 gate is two passes within 3 points.
5. **Results are append-only JSON lines**, one per (task, pass), resumable:
   a pass interrupted is finished by running the same command again. Raw
   logs stay in the cache; the repository keeps tasks and results.

## What the freeze and the first pass found

- **40 SWE instances kept, 11 tried and excluded**, all listed with their
  reason: six xarray instances whose gold patch fails here (their tests want
  `cftime` or `bottleneck`, which the harness's conda environment has and
  the pinned pip list does not), two Sphinx instances (Graphviz missing, and
  HTML that a newer Pygments renders differently), two pylint instances
  whose `test_self.py` behaves differently outside the harness's image, and
  one pylint version that does not build. Requests before 2.9 is not a candidate:
  its tests call the live httpbin.org. Django, SymPy, pytest, Flask and
  seaborn validated without a single exclusion. pylint gave two instances
  instead of three, and Django filled the gap (16).
- **All 10 Sub Rosa tasks and all 10 terminal tasks validated** (unsolved at
  the base, solved by the real fix).
- **The paid validation pass** (kimi-k2-7-code, Sub Rosa engine, one task per
  suite, $0.18 each, 54.2 credits in all, the balance read before and after)
  resolved the SWE task and failed the two others; all three reached their
  budget, at about 2 million input tokens each, 95 % cached. The budget,
  rather than the model, decided most of it: real passes give a task at
  least $0.50 (docs/code-eval.md). The pass also showed what the bench is
  for: the agent kept verifying a fix it had already made, and broke a "do
  not change" rule while testing.

## Consequences

- Every later gate in the plan names `gate20` and a model; "it feels better"
  is no longer an argument.
- The bench is not comparable with published SWE-bench scores: a subset,
  another environment, our own budget and timeout. It compares our harness
  with itself over time and with the reference column, on the same tasks.
- A Rust Sub Rosa task cannot be built by the agent: the jail grants neither
  `~/.cargo` nor the bench's target folder. That is the product's posture
  today; the score shows its cost, and the plan's P1 decides about it.
- Validating a new SWE instance or a Rust task costs builds and time (hours
  for the whole set the first time), never credits.
- The checks and reference solutions sit in the repository, readable by an
  agent that goes looking. The same holds for the public SWE-bench dataset;
  a run that reads them is visible in its events.
- Gate tasks are fixed. Re-freezing is a decision recorded as an addendum,
  with old results kept beside the task set they were scored on.

## Alternatives rejected

- **The official harness through a remote Docker host** (the VPS or the NUC):
  measures a Linux container, not the jail, the sidecar and the metering of
  the person's Mac, and ships every task's code to a server.
- **Terminal-Bench's own tasks**: they assume Docker too; ten tasks written
  for this bench keep the shape (a request, a start state, a check whose
  exit code decides) without it.
- **A CI job**: every pass spends money and the runners have no key; a gate
  is run on purpose by a person.
- **Scoring cost from token counts and list prices**: the operator's metering
  is what the person pays, including cache discounts; both engines read it.
