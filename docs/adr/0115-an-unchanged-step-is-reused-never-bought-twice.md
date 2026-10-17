# ADR-0115: An unchanged step is reused, never bought twice

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md),
[ADR-0030](0030-a-production-compiles-into-a-workflow.md) and
[ADR-0114](0114-a-refused-render-is-queued-again-and-a-settling-one-is-heard.md).
Migration 079.

## Context

Every "Run workflow" on the canvas started from an empty slate: changing the
prompt of the last step of a five-step graph re-bought the four steps above
it. Resume (ADR-0021) only reuses inside one run. ComfyUI's engine answers
this with an output cache keyed by each node's *input signature*
(`comfy_execution/caching.py`): the node's class, its constant inputs and the
signatures of its ancestors, with node ids left out, so an unchanged node is
never executed again and a moved or duplicated branch keeps its results.

Three things make that idea different here. Every step costs money, so a
wrong reuse is cheaper than a wrong purchase, but a silent reuse when the
person wanted a new picture is a real failure too. The models are not
deterministic, and only images take a seed (video models refuse one). And
film productions already decide what is made through their own take
signature (`projects.ts`, ADR-0030), with a "make this shot again" that a
global cache would quietly answer with the old take.

## Decision

1. **A paid step is cached by what it was asked.** Just before a step would
   spend, the engine takes its *runtime signature*: SHA-256 over its type,
   schema version, settings (without its name, position or bookkeeping), its
   model's catalog entry (id, media type, constraints, not its price), and
   the digests of what arrived on each port, in edge order (a gallery file by
   its id, a text or an inline frame by its own digest). A hit is answered
   from the cache before the budget check: nothing is spent. Paid steps and
   the cut (`assemble`, slow) are cached; free steps and a gate's judge are
   not.
2. **The canvas can say what will be reused.** A *static signature* is taken
   from the graph alone (a Merkle tree: settings, take counter and the
   static signatures of the inputs) and stored beside each entry. Before a
   run, the canvas asks which static signatures are known, and promises a
   step free only when every paid step above it is reused too. Those steps
   read "Free" on the node, cost nothing in the bill, and ask no quote.
3. **A new result is one click, or always.** "Make a new one next run" raises
   the step's take counter, which is part of both signatures, so the step and
   everything it feeds miss once. "New result every run" skips the lookup for
   that step for good. Both are visible on the node, where ComfyUI puts its
   "control after generate".
4. **The cache is an option of the runner, and only the canvas passes it.**
   Film productions keep their take signature and their redo. The cache is
   local, never synchronised: its rows point at gallery files, which travel
   by their own lane.
5. **Rows are references, never bytes.** An entry holds the gallery id (or a
   chat step's text), capped at 256 KB; a frame read out of a clip is not
   kept. A hit whose file has left the gallery is forgotten and the step
   runs. The table keeps the 5,000 most recently used entries.

## Consequences

- Editing the end of a graph re-buys only the end. A second identical run
  costs nothing.
- A step's answer can be reused across workflows: the signature does not
  name the workflow it was made in.
- A chat step is cached like any other. A person who wants a new answer says
  so with the take counter or the switch.
- The prediction can be wrong in one direction only: a step promised free
  whose file was deleted since runs and is priced at run time by the budget
  check, like any paid step.

## Alternatives rejected

- **Keying on node ids.** Moving, duplicating or importing a branch would
  throw its results away.
- **A seed on every step.** Video models refuse one, and a seed promises
  reproducibility the providers do not give; the take counter says what the
  person means without it.
- **Caching productions too.** It would silently answer a production's
  "make this shot again" with the old take.
