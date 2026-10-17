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
