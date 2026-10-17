# ADR-0117: A list runs what it feeds once per item

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md),
[ADR-0115](0115-an-unchanged-step-is-reused-never-bought-twice.md) and
[ADR-0116](0116-a-block-runs-as-its-steps.md). No migration.

## Context

A workflow makes one of everything: ten album covers are ten copies of the
same steps, wired by hand. ComfyUI has lists: a node can output several
items, and a node downstream runs once per item unless its input is
declared to take the whole list (`INPUT_IS_LIST`), in which case it gets
every item at once.

The engine is again what must not move: durable rows keyed by step
(ADR-0021), the step cache (ADR-0115), prices before the run, and gates. A
step that loops inside the engine would need a nested form of each.

## Decision

1. **Lists are put in place before the run**, like blocks (`lists.ts`): a
   text list's lines become text steps (`list#0`, `list#1`...), a picture
   list's pictures become asset steps, and a split text keeps its step and
   gains one item step per line it may hold. What is validated, priced,
   cached, frozen with the run and run is the graph with its lists in place.
2. **An input either gathers or copies.** An input marked `gathers` (an
   assembly's clips and sound lanes, a shot's references, an edit's images,
   a gate's candidates, a template's values) receives every item, in order.
   A list on any other input copies the step once per item (`step#0`...),
   and so on down. Two lists of different lengths copy to the longer; the
   shorter repeats its last item, as ComfyUI does. A step fed an empty list
   has nothing to run on and is left out.
3. **A split text is cut during the run, so it declares a maximum** (at most
   20, as any list). It is put in place at that many lines and priced for
   them; a line that does not arrive is not made, with a note saying which,
   and neither is anything that needed it, while a step whose input gathers
   runs with the lines that came. Fewer lines cost less than the quote, never
   more.
4. **On the canvas a list is one step.** Copies and items lift onto the step
   they came from (`lift.ts`): its state is theirs together, its price their
   sum, and it shows what each made, in order.

## Consequences

- Every item is a durable row of its own: a run interrupted after three of
  ten covers resumes at the fourth, and each cover is a cached step.
- No Rust change: rows are created at the start of the run for every step
  of the frozen graph, items included, so updating them is enough. The
  upsert the plan foresaw is unnecessary because lists are put in place at
  their maximum.
- A gate fed a list on its candidates input gathers them (approve one of the
  items). A gate copied per item, fed a list elsewhere, holds once per item;
  the canvas approves them one after the other.
- Lists inside productions are out of scope: the film compiler does not
  produce them.

## Alternatives rejected

- **A list as a value the engine loops over.** Resume, cache, gates and
  prices would each need a per-item form, and a production would run
  differently from a canvas.
- **Copying every multi input as ComfyUI does by default.** A prompt input
  takes several texts by joining them; joining ten ideas into one prompt is
  never what a list of ideas means. Which inputs gather is stated per input.
- **Sizing a split text after it runs.** The price would be unknown until
  the money is spent; a stated maximum keeps the quote honest.
