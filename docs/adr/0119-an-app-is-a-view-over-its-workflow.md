# ADR-0119: An app is a view over its workflow

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md),
[ADR-0075](0075-a-comfyui-workflow-is-translated-never-executed.md),
[ADR-0116](0116-a-block-runs-as-its-steps.md) and
[ADR-0118](0118-workflows-travel-as-definitions-never-as-runs.md). No migration.

## Context

A workflow is a graph, and a graph is the wrong surface for most of the
people who would use one: someone who wants an album cover needs one box for
the album and a button, not twelve steps and their wires. ComfyUI answers
this with an "app mode" that exposes a few widgets of a graph as a form.

Two shapes were possible: an app as a second object (its own steps, copied
from a workflow), or an app as a way of showing a workflow.

## Decision

1. **An app is a view, stored with its workflow** (`Workflow.app`, written
   into the stored definition next to the graph, `app.ts`): the settings a
   person fills in (`fields`: a step and one of its settings, an optional
   label), the steps whose results they get (`outputs`), their order, and
   one sentence of intro. There is no second graph. Filling a field in edits
   that step's setting; running the app is running the workflow, through the
   same price, cost confirmation, spend ceiling, cache and durable run.
2. **Built in three steps, from a suggestion**: what a person fills in (a
   step's settings the chosen model has, never one taken from a connection,
   never the canvas's plumbing such as a zone), what they get (steps that
   make something), in what order. A workflow with no app starts from its
   words, its pictures and its outputs; nothing is kept until the person
   keeps it, and removing the app leaves the graph as it was.
3. **A workflow that is an app opens as one**; the toolbar switches between
   the graph and the app at any time. The app shows the workflow's top
   level: switching to it leaves a block the canvas was inside.
4. **It travels with the workflow**: synced (ADR-0118), exported in the
   workflow file with its fields pointing at the imported steps' new ids,
   copied with a template the same way. An app this version cannot read is
   kept untouched for the version that wrote it.
5. **On the phone, apps are the only workflow surface.** The phone never
   draws the canvas (removed 2026-09-22): the Studio gets an "Apps" segment
   listing the workflows that are apps, each opening as its form. What the
   phone cannot finish alone (an assembly, which needs the desktop app open,
   ADR-0021) is said before the run, not discovered after it.
6. **Shipped templates may be apps**: ten of the fifteen are, and their cards
   say so.

## Consequences

- An app's field disappears from the form when its step or setting is gone
  (deleted on the canvas, closed by a model change); the builder lets the
  person see and fix that.
- Two people can share one workflow as an app without either reading the
  graph; the graph is still one switch away.
- No separate versioning: an app's change is a workflow's change, saved,
  versioned (F1) and synced with it.

## Alternatives rejected

- **An app as its own object** copying the graph: two graphs drift, the
  cache and run history split, and a fix to the workflow would not reach its
  app.
- **Expose every setting of every step**: the point of an app is the few
  that matter; the canvas is there for the rest.
- **The canvas on the phone, simplified**: tried and removed in September
  (unusable at phone size); a form is what a phone does well.
