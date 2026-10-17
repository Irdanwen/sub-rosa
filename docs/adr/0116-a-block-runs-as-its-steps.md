# ADR-0116: A block runs as its steps

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md),
[ADR-0075](0075-a-comfyui-workflow-is-translated-never-executed.md) and
[ADR-0115](0115-an-unchanged-step-is-reused-never-bought-twice.md).
No migration.

## Context

A workflow of thirty steps is read as one flat sheet: nothing says that six
of them are "the opening shot", and the same six cannot be reused in the
next workflow without copying each step and its wires. ComfyUI answers
with subgraphs: a set of nodes shown as one node, with its own inputs,
outputs and promoted widgets, defined once in the workflow
(`definitions.subgraphs`) and opened with a breadcrumb.

The engine here is the place that must not move. Runs are durable rows keyed
by node id (ADR-0021), the step cache keys a step by what it asks, not by
where it sits (ADR-0115), the validator, the price model and the partial run
all read one graph of nodes with one output each, and film productions
compile into the same engine (ADR-0030). A second kind of node that "runs a
graph" would reach into every one of them.

## Decision

1. **A block is defined once in the workflow** (`Workflow.blocks`): its steps,
   its wires, its inputs (each an inner step's input port), its outputs (each
   an inner step's result) and the settings it promotes. A block step is an
   instance of one (`type: "block"`, `params.blockId`). Editing the block
   edits every instance; each instance keeps its own values for what the
   block promotes (`params.settings`, keyed `step:setting`; a promoted model
   brings its direction with it).
2. **The engine never sees a block.** `flatten.ts` puts each block step's
   steps in its place before anything is validated, priced, looked up in the
   step cache or run. A flat step's id is its path (`instance/inner`), so two
   instances never collide, and ids are no part of a step's signature: a step
   reused before it went into a block is reused after.
3. **What happened is lifted back onto the block step** (`lift.ts`): running
   while any of its steps runs, failed when one fails, its price the sum of
   theirs, "Free" when every paid one is reused, their problems on it, and
   the result of its first output shown on it. "Run this step" on a block
   runs its steps.
4. **Several outputs live in the editor only.** A block can give several
   results; an edge leaving one says which (`sourcePort`). `flatten.ts`
   resolves it to the inner step, so the engine keeps one output per node.
5. **A run freezes both graphs.** The flat graph is the run's definition, as
   resume needs; the written one rides in its `extra.written`, so reopening a
   run shows the blocks the person drew, not their steps.
6. **Blocks travel with their steps.** The store, the exported file, undo and
   the clipboard carry the definitions a graph uses; a pasted block step
   brings its block. A block may hold blocks, four deep; one that holds
   itself is refused with the reason on the step.

## Consequences

- No engine, validator, cost, cache or Rust change: blocks are an editor
  construct with a pure translation into what already runs.
- A block step shows its steps' state and price without new plumbing, but a
  block's own step-by-step progress is only visible as one figure; opening a
  block to see inside is the next step (E2b).
- Edge order into a multi port follows the outer wires first, then the
  block's own. A block that feeds a port from inside and outside at once
  reads in that order.

## Alternatives rejected

- **An engine node that runs a sub-workflow.** Durable rows, resume, the step
  cache and gates would each need a nested form, and a production would run
  differently from a canvas.
- **React Flow parent nodes** (`parentId`, steps drawn inside a group). That
  is a frame (ADR-0075 addendum), not a reusable unit: it does not hide the
  steps or give the set its own ports.
- **Referencing a library block by id.** An edit in the library would change
  every workflow that uses it, including ones mid-run. Blocks are copied in
  by value; the library copy can be offered as an update later.

## Addendum 2026-10-17: a block is changed from inside it

"Open block" on a block step shows its steps on the canvas, with a
breadcrumb back to the workflow and the warning that a change applies to
every step that uses the block. Three rules keep that level honest:

- **Entered through one instance.** The level is a path of block steps
  (`outer/inner`); the steps inside show *that* instance's results, prices
  and problems. `lift.ts` became one view per level (`viewAt(flat, path)`):
  each flat step belongs to one step at the level shown, a plain step
  answering for itself and a block step for all of its own.
- **Always the whole workflow.** What is saved, validated, priced, kept for
  undo and run is the workflow; the level's steps are written back into
  their block as they are edited (`composeRoot`, `withLevel`). Run and "Run
  this step" work from inside a block as from the top.
- **Its face is edited there.** The block's name, which inner inputs it
  takes, which inner results it gives and which settings it shows are
  chosen from inside it (`BlockPanel`). Taking away an input or a result
  takes off the wires that used it on every instance, wherever it stands
  (`replaceBlock`); a wire never dangles silently.

## Addendum 2026-10-17: blocks kept in the library

"Save to the library", from inside a block, keeps it as a library row of its
own (`studio_workflows`, `origin: "block"`, no migration): its steps, the
blocks inside it and its face (`extra.face`). The library page lists these
blocks apart from workflows, and the step search offers them under
"Blocks" (not to finish a dragged connection: which input it should land
on is the person's call).

A library block comes into a workflow **by value** (`library-blocks.ts`):
a copy with its own id, remembering the row and the version it came from
(`source`). The same saved version again reuses that copy; a newer one is a
new copy beside it. Saving a copy again updates the row it came from.
Changing or deleting the library row never changes a workflow that already
holds a copy, which is the reason given above for refusing references.
