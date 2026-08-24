---
status: accepted
date: 2026-08-24
---

# A production compiles into a workflow; it has no runtime of its own

## Context

A shot list needs to become a film. Every part of that is something the Studio
already does: render a clip, take a handoff frame from one and start the next
on it, generate a line of speech, generate a score, cut the result together.

The obvious shape is a producer: something that walks the shot list, calls the
media layer, tracks what finished, retries what failed, prices the whole thing
up front, and resumes after a crash. It is obvious, it is a week's work, and it
is the third executor in this app.

Because the canvas already has one, and it is not a small one. A workflow run
is durable rows re-driven across restarts and iOS suspensions
([ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md)):
long renders ride Rust's job pollers and land in the gallery whether or not a
webview exists, finished nodes replay from cached outputs so a resume never
re-buys anything, costs are estimated before the run and confirmed by the user,
approval gates hold a production without failing it, and the whole thing
renders as guided Flows on the phone for free.

## Decision

**A shot list compiles into a `Workflow` and is run by the engine that already
exists.** `src/lib/studio/workflow/compile.ts` is a pure function from shots to
a graph. It has no executor, no scheduler, no persistence and no cost model of
its own.

The test that matters is one line: the compiled graph passes
`validateWorkflow`. If the canvas will not run it, that is a bug in the
compiler, not a run to attempt.

Two things belong to the compiler, and only two.

**Routing.** The model that read the script returned a motion class and who is
in the shot. It never saw the catalogue, so it never picks a video model, a
duration or an aspect ratio: the compiler resolves those, recognising families
by what the catalogue says they *take* rather than by their name (the ids were
renamed under us between two releases), and clamping to what each one publishes
([ADR-0022](0022-model-inputs-follow-published-constraints.md)). A shot that
carries on from the previous one is chained through a handoff frame - that
wins over holding a face, because starting from the actual frame is what makes
the seam invisible.

**Refusal.** A graph that would spend more than the ceiling the user set is not
built. The confirmation handshake is for deciding; it is not for catching a
production that was never affordable.

## Consequences

- Everything a production needs was written once, for the canvas.
- A compiled film is editable, because it is an ordinary workflow. The user can
  change a prompt, swap a model, add a gate, and run it - which is a better
  answer than any set of options a producer would have exposed.
- The compiler can be re-run for free with a different ceiling, a different
  aspect or without a score, until the figure is one the user accepts. Nothing
  is spent to find out.
- The engine's limits are the production's limits. Stitching between renders
  needs a foreground session; that is stated in
  [ADR-0029](0029-film-production-is-local.md) and not worked around here.
