---
status: accepted
date: 2026-08-13
---

# Workflow runs are durable rows stitched by the webview

## Context

The Studio workflow canvas can now describe a whole production: reference
assets fanned out to scenes, shots chained through handoff frames, a generated
score, and an assemble node that cuts the result into one film. A production
like that spends real credits over many minutes — and until now its run lived
entirely in a webview promise chain. Closing the app, or iOS freezing the
webview, killed the run; the individual renders survived (they are `media_jobs`
rows, [ADR-0018](0018-ios-background-work-is-durable-rows.md)), but nothing
remembered which run they belonged to or what came next. `FORK_NOTES` carried
this as the one standing exception to ADR-0018.

Two facts constrain any fix.

**Two node types cannot leave the webview.** `lastFrame` reads stills out of a
clip with the webview's video decoder, and `assemble` records a canvas plus a
mixed AudioContext through MediaRecorder in real time. Both exist *because* of
a prior decision: no ffmpeg to bundle, notarize, or license (see the header of
`src/lib/studio/assemble.ts`). A fully Rust-side orchestrator would have to
re-decide that, or grow a second implementation of frame extraction and
assembly.

**The long waits are already durable.** Video and music renders take minutes;
everything else in a run (chat, TTS, sync image calls, gallery and note reads)
takes seconds. The minutes-long parts already have exactly the machinery a run
needs — Rust-side polling that survives suspension, delivery into the gallery,
notifications, `resume_all` on every launch.

## Decision

A workflow run is **durable rows** (`workflow_runs` + one row per node,
migration 012), and the webview is its **executor, never its record**:

- The run row — with the graph frozen as launched and the confirmed per-node
  costs — is written before the first node does anything. Every node
  transition is persisted before the work it describes.
- Video and music nodes do not poll in the webview. They queue upstream once,
  hand the id to the existing `media_jobs` runner (tagged `source =
  "workflow"` so the Studio surfaces leave those rows alone), and record the
  job id on their node row. Rust polls, downloads, and notifies whether or not
  a webview exists.
- A finished node persists a *dehydrated* output: artifact references and
  small payloads, never large media bytes. A resume replays those through the
  engine's `completed` cache, re-attaches to pending render jobs by id, and
  executes only what is left. Resuming never re-buys a finished or in-flight
  render.
- Runs that finish (or fail) notify the user; interrupted runs surface as a
  resume banner on both shells. Dismissing an interrupted run first files any
  render its jobs already delivered.

## Alternatives considered

**A full Rust orchestrator** (port every node executor, ffmpeg for frames and
assembly). Rejected: it re-litigates the no-ffmpeg decision, duplicates five
node executors that finish in seconds anyway, and buys background progress
only for steps that never needed it. The steps that do need it already have it
through `media_jobs`.

**Keep the run in the webview, only persist a journal.** Rejected: on iOS the
webview freeze makes "the run continues while backgrounded" impossible by
construction (ADR-0018); a journal without durable render jobs still loses the
minutes-long waits.

**Videomaker-style server orchestration** ([ADR-0010](0010-videomaker-film-production.md)).
Rejected for this surface: workflows are the local, hands-on production tool;
their execution must not depend on a remote service. The two remain
complementary.

## Consequences

- A production survives app restarts and iOS suspensions; what was paid for is
  what is kept. The cost of the design is that stitching between renders waits
  for a foreground session — an interrupted run resumes when the user returns,
  rather than completing unattended. That is the same contract every other
  background feature in the app honors (ADR-0018), now without an exception.
- Cheap, fast nodes (chat, TTS, sync image) run at-least-once: a kill between
  their completion and the row write re-runs them on resume. The expensive
  nodes are exactly-once by job id. This asymmetry is deliberate — idempotence
  is bought where it costs money.
- `media_jobs` rows now carry a `source`; surfaces that ingest jobs must skip
  rows another owner is waiting on. New shared commands (`workflow_run_*`)
  exist in both `generate_handler!` lists.

## Addendum (2026-08-13): approval gates ride the same rows

A `gate` node pauses a run for the user's decision. This is not a new
mechanism — it is the durable-run design paying off: a held run is simply a
run whose row says `awaiting_gate` and whose gate nodes persisted `awaiting`.
The pause survives anything, the user is notified ("Your production is
waiting on you"), and approving is a resume with per-gate approvals.

Take selection deliberately reuses the graph instead of growing fan-out
machinery: alternative takes are *separate nodes* wired into one gate, and
the approval picks which candidate passes through (untouched, parent links
included). The alternative — a `takes` count on the video node with variant
outputs — was rejected: it would give `NodeOutput` a multiplicity every
consumer must understand, while "several nodes into a gate" is visible on the
canvas, priced by the cost model per take, and needs no new engine concepts.
Approvals are per run and never stored in the workflow: a saved graph cannot
carry a pre-approval, so every production stops at every gate.
