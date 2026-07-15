---
status: accepted
date: 2026-07-15
---

# Autonomous film-run supervision: a deterministic server-side guardian, not an in-app opus agent

> **Spans two repos.** The user-visible surface is Sub Rosa (a chat/status view
> in the Film studio), but the load-bearing implementation is **server-side in
> Videomaker** (`~/Documents/Codage/Bots/Videomaker`,
> `src/videomaker/api/routers/runs.py`, `src/videomaker/bootstrap.py`). Videomaker
> has no ADR practice of its own, so this decision is recorded here alongside its
> parent, [ADR-0010](0010-videomaker-film-production.md).

## Addendum — 2026-07-15 (accepted; phase 1 shipped, rest deferred)

The approach was accepted, and the highest-ROI piece shipped. **Phase 1's
run-driver hardening is live** (Videomaker commit `ac1dec8`, deployed): the
Venice client marks a per-tenant "transient upstream error" when it raises
`QuotaExhausted` (402 prepaid-rail flap) or `ProviderCapacityExhausted` (503
capacity), and `_drive_run` backs off and retries the same phase (15s→120s cap,
~30 min budget) instead of counting such an empty turn toward `_STALL_LIMIT` —
so a run rides out a multi-minute Carpe Diem window instead of dying. Genuine
no-progress still fails as before; exhausting the transient budget fails with
an actionable "POST a new run to resume."

**The rest is deferred, deliberately.** The Sub Rosa payment-rail work
(v1.10.0–v1.12.0: the Payment panel, the rail switch, the proactive
switch prompt) removed the *dominant* cause of the failures this ADR set out to
survive — the 402 storms were rail-routing (an empty prepaid rail while credits
sat unused), now visible and one-click-fixable in the app. What remains for the
guardian (a watchdog that resumes `interrupted` runs after a gateway restart,
the escalation/notification layer, conversational control) addresses a mostly
dev-time artifact (concurrent VPS deploys) plus rarer transient 503s. Revisit —
build the watchdog-resume next — only if films start failing in steady-state
operation. The money-safety invariants below remain binding for any such work.

An autonomous film run (`POST /api/projects/{slug}/runs`) can stall on transient
infrastructure faults that have nothing to do with the film, the app, the model,
or the user's balance. When it does, the run **dies and does not self-recover** —
someone must re-`POST` a new run (the driver is state-based, so it resumes from
the last saved phase without re-paying). During the 2026-07-14/15 "Rosa - Spot"
incident this recovery was performed **by hand ~18 times over ~4 hours** to get
one 60-second film out. This ADR decides how to automate that recovery.

The decision, in three parts:

1. **The supervisor is deterministic code, server-side** — a watchdog that
   detects stalled/interrupted autonomous runs and re-drives them under strict
   caps. It is **not** an LLM agent, and it does **not** live in the Sub Rosa app.
2. **Harden the run driver's transient-fault handling first**, so the supervisor
   is a safety net for the genuinely un-catchable cases (gateway restarts), not a
   crutch for a driver that gives up too easily.
3. **A thin communication layer** (cheap model, reusing the existing
   notifications/SSE seam) explains what the supervisor did and escalates the
   decisions it must not make itself. The Sub Rosa chat surface is a **view** onto
   this, reusing the existing `june_films` MCP tools — not a new per-project agent.

## Context — what actually breaks (observed, not hypothesized)

Three transient failure modes were observed on a single autonomous run, none of
them "intelligent":

- **`503 INSUFFICIENT_PROVIDER_CAPACITY`** on `claude-opus-4-8` — the Carpe Diem
  marketplace momentarily had no provider with capacity for that model.
- **`402 PAYMENT_REQUIRED` "Payment rail cannot cover this request"** despite a
  healthy balance (10 USDC / 1000 credits available) — the Carpe Diem prepaid
  rail flaps in windows of ~10-20 minutes, hitting the ~0.86 USDC image requests
  of the `asset_pack` phase hardest.
- **Gateway restart** — a concurrent deploy to the shared VPS restarts
  `videomaker-api`; the run driver runs inside that process, so it is cancelled
  mid-flight.

How these surface in the driver (`runs.py::_drive_run`):

- A `402`/`503` makes an agent turn produce **zero structural progress**. The
  driver's stall guard (`_STALL_LIMIT = 5`, `runs.py:41`) counts consecutive
  no-progress turns via a `_progress_fingerprint` diff and, at 5, ends the run:
  `failed — "no progress from state '<state>' after 5 empty turns"`
  (`runs.py:231`). The stall guard **cannot tell a transient upstream fault from
  a genuine dead-end** — both look like an empty turn.
- The upstream retry that *does* exist is inside the Venice client
  (`venice/client.py`, `max_retries`, exponential backoff **0.5s–8s**). Five
  retries over seconds cannot survive a 20-minute rail outage, so the run fails
  regardless.
- A gateway restart raises `asyncio.CancelledError`, caught as
  `interrupted — "gateway shutdown — POST a new run to resume"` (`runs.py:287`).

The gap: Videomaker **already has a watchdog** —
`bootstrap.py::bootstrap_runnable_daemons` (run every 2 min by
`videomaker-bootstrap.timer`) respawns dead **production daemons** when the queue
has work. It does **not** resume the **run driver** (the pre-production,
gateway-hosted autonomous loop). That is exactly the hole filled by hand.

What manual recovery actually required (and, crucially, did *not*):

- Deterministic steps: detect terminal/interrupted state → probe Carpe Diem
  health (recent `PAYMENT_REQUIRED` count + gateway `active` + a cheap
  `/v1/image/generate/queue` probe) → re-`POST /runs` when healthy → exponential
  backoff during bad windows → **stop** on real decisions.
- Judgment/communication (the only places reasoning helped): explaining the
  situation in plain language, and deciding "transient vs terminal".

Once Carpe Diem held a healthy window, `claude-opus-4-8` drove
concept → bible → assets → shotlist → storyboard → production → `final.mp4`
(65s, video+audio) with **zero** trouble. The blocker was upstream
infrastructure, not the pipeline or the model.

## Decision

### 1. A deterministic server-side guardian (extend the existing watchdog)

Add run-driver resumption to the existing watchdog seam (extend
`bootstrap_runnable_daemons`, or a sibling `videomaker-guardian` timer). Every
tick, for each project with an autonomous run in a recoverable terminal state:

- **`interrupted`** (gateway restart) → resume unconditionally once the gateway
  is back.
- **`failed` with a *transient* detail** (`"no progress …"` / an upstream
  `402`/`503` signature) → resume **only when Carpe Diem is healthy**
  (health-gated).
- **`failed` with a *terminal* detail** (content-policy, invalid brief, genuine
  `QuotaExhausted`/DIEM-exhausted), **`awaiting_confirmation`**, **`paused_gate`**
  → **never auto-resume**; escalate to the user.

With, as hard invariants:

- **Health gate** before any resume: no recent `PAYMENT_REQUIRED`/capacity errors
  *and* a positive cheap probe. The guardian's own probes must be cheap and rare,
  because probing a broken rail with opus would *worsen the very outage it is
  recovering from*.
- **Exponential backoff** with jitter across resume attempts; no tight looping.
- **Per-project circuit breaker**: caps on `max_resumes`, `max_wall_clock`, and
  `max_guardian_initiated_spend`. When any is hit → stop and escalate. (The
  manual recovery burned 12 resumes in one bad window before I added a cap — a
  guardian without a breaker does the same, forever.)
- **Idempotency**: never spawn a second concurrent run for a project; never
  re-trigger production for a project already in production. Reuse the existing
  one-active-run-per-project rule and idempotency-key discipline.
- **Least privilege**: the guardian calls the **API** with a scoped token — never
  the human-operator path used during the incident (root SSH + direct DB writes +
  a forged PAT). That method was a privileged hack; the product must not need it.
- **Kill switch**: per-project and global (mirroring
  `VIDEOMAKER_PHASE_GATES=0`).
- **Completion means *quality*, not a state flag.** A film reaching `state=done`
  with a `final.mp4` is **not** proof of success. On "Rosa - Spot", shots **S02
  and S08 failed to render** (`Engine 'seedance' durations allowed in rtv:
  (4,5,8,10,12,15); got 6`/`got 7` — the shotlist assigned 6s and 7s, values in
  the [4,15] range but not in Seedance's discrete set) and the cut shipped their
  storyboard keyframes as **still images**. The queue read `6/8 done` — i.e. **2
  permanently failed** — yet the film finalized and the manual monitor (and I)
  reported "film ready". The guardian must **verify per-shot render success**
  (`queue.status='failed'` count, still-fallback detection), not just `done/total`
  or `final_mp4` existence, and must **flag a degraded film** (shots shipped as
  stills) as an escalation, never a silent success.

### 2. Harden the run driver first (so the guardian is a safety net)

Before adding the guardian, make `_drive_run` survive transient upstream faults
itself:

- Classify the upstream error behind an empty turn. A turn that produced nothing
  **because** of a retryable `402`/`503` must **not** increment the stall counter
  the same way a genuine dead-end does; back off (seconds→minutes) and retry the
  same phase instead of burning toward `_STALL_LIMIT`.
- This alone would have carried the run through most of the ~10-20 min Carpe Diem
  windows without any external supervisor. The guardian then only handles what
  the driver genuinely cannot: the gateway being restarted out from under it.

### 3. Communication + escalation (thin, cheap, reused)

- When the guardian resumes, gives up, or hits an escalation state, it composes a
  **plain-language** status + a proposed action and emits it on the existing
  **notifications/SSE** seam (`kind:"run"` events, webhooks). A **cheap model**
  suffices for "still rendering, 6/8 shots"; reserve any stronger model for
  genuinely ambiguous judgment.
- The Sub Rosa **chat surface reuses the existing `june_films` MCP** (12 tools:
  status/run/gates/produce/board/…) so the in-app agent can already answer
  "where's my film?" and relay user instructions ("raise the budget to X",
  "switch the set to sonnet", "retry now", "cancel"). No new per-project opus
  agent is introduced.

## Money-safety invariants (non-negotiable)

Videomaker's entire spend model is **explicit, confirmed** money (idempotency
keys, the `/produce` `409` cost-confirmation handshake, `budget_ceiling_diem` as a
hard cap, and human phase gates per
`project_phase_gates_design`). An autonomous resumer must not erode that:

- **Never exceed the user's `budget_ceiling_diem`; never raise it.**
- **Never auto-confirm a production quote above the run's `max_cost_diem`.** That
  stays a human decision, exactly like the storyboard phase gate. A run that hits
  `awaiting_confirmation` escalates — it is never "unblocked" by spending more.
- **Bounded, auditable spend**: every guardian action is recorded in a per-project
  **guardian ledger** (what, when, why, cost delta) so the user can trust and
  audit it.
- **Transient-vs-terminal, and when in doubt, escalate** — never retry a
  content-policy rejection or a genuine out-of-credits; that is money thrown at a
  doomed run.
- **The ceiling is a boundary the *user* moves, and the app must let them.**
  "Rosa - Spot" finished at ~46.6 DIEM spent against a **40 DIEM ceiling** — over
  budget, because pre-production + asset image generation + the resume ordeal
  consumed the cap that the 2-DIEM video quote fit "under" at production time. The
  spend guard (`project_total_spent` vs `budget_ceiling_diem`,
  `projects.py:1066`) then **rejects any reshoot** of the failed shots. The
  guardian never raises the ceiling itself — but an over-ceiling condition is a
  first-class **escalation with a concrete action** ("raise the ceiling to X to
  reshoot S02/S08"), and Sub Rosa must expose a control to raise
  `budget_ceiling_diem` on an existing project (the API already supports it via
  the settings/`_persist_autonomy` path; the app only sets it at creation today).

## Alternatives considered

- **The literal proposal — an opus LLM agent, per project, hosted in the app.**
  Rejected on three grounds. (a) *Wrong tool*: supervision is a state machine, not
  reasoning; an LLM is non-deterministic and can make wrong *money* decisions.
  (b) *Wrong place*: production is server-side and long (45+ min); the app closes
  and the laptop sleeps, so a client-hosted supervisor misses the moments it must
  act. (c) *Self-defeating cost*: running the guardian on opus consumes the same
  capacity and prepaid rail that are already failing — it would amplify the outage
  it exists to survive, and multiply cost per-project across all tenants.
- **Do nothing (keep manual recovery).** Rejected: it does not scale past a
  hands-on operator, and the failure is routine enough (a full day of Carpe Diem
  flapping) to recur.
- **Fix only upstream (wait for Carpe Diem to stabilize).** Necessary but not
  sufficient: gateway restarts and future upstream blips are outside our control;
  a bounded local safety net is warranted.
- **Guardian without hardening the driver.** Rejected as the primary fix: it
  papers over a driver that gives up after ~30s of retries, turning a one-line
  resilience fix into a standing autonomous subsystem.

## Consequences

**Positive**

- Autonomous films survive Carpe Diem's intermittent faults and gateway restarts
  without a human babysitter, within explicit spend bounds.
- Most of the value ships as a **small, deterministic** extension of an existing
  watchdog plus a driver-retry tweak — no new agent, no new always-on service in
  the client.
- The user keeps a conversational view and control, reusing `june_films`.

**Negative / risks**

- A new autonomous loop that can spend money is inherently sensitive; the
  circuit breaker, caps, kill switch, and guardian ledger are **load-bearing**,
  not optional. Getting transient-vs-terminal classification wrong wastes money
  (over-retry) or abandons recoverable runs (under-retry).
- The health signal (recent `402` count, cheap probe) is heuristic; a bad signal
  causes over- or under-eager resumes. It must fail safe (treat "unknown" as
  "unhealthy → back off").

## Scope / phasing

1. **Driver hardening + watchdog resume** (highest ROI, mostly deterministic):
   classify transient upstream faults in `_drive_run`; extend the watchdog to
   resume `interrupted`/transient-`failed` autonomous runs, health-gated, with
   caps and the guardian ledger.
2. **Escalation + plain-language notices** on the states the guardian must not
   decide (budget confirmation, content-policy, persistent failure).
3. **Conversational control in-app**, reusing `june_films` — only if warranted
   after (1) and (2).

## References

- Parent: [ADR-0010](0010-videomaker-film-production.md) (film production via
  Videomaker Studio).
- Run driver + failure modes: Videomaker `src/videomaker/api/routers/runs.py`
  (`_drive_run`, `_STALL_LIMIT=5`, `MAX_RUN_TURNS=40`, the
  `interrupted`/`awaiting_confirmation`/`paused_gate` transitions).
- Existing watchdog (resumes daemons, not runs):
  `src/videomaker/bootstrap.py::bootstrap_runnable_daemons` +
  `videomaker-bootstrap.timer`.
- Upstream retry (seconds-scale): `src/videomaker/venice/client.py` (`max_retries`,
  exp backoff 0.5s–8s).
- Money model: `budget_ceiling_diem` hard cap, the `/produce` `409` handshake,
  idempotency keys, and human phase gates (Videomaker memory
  `project_phase_gates_design`; the ungated/autonomous storyboard auto-approve
  fix of 2026-07-14).
- Fork chat/agent surface already present: the `june_films` MCP
  (`src-tauri/src/hermes/june_films_mcp.py`) and agent-lite.
