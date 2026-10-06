---
status: accepted
date: 2026-10-06
---

# A ComfyUI workflow is translated, never executed

## Context

People find ready-made recipes as ComfyUI workflow files (JSON graphs of
nodes and links, in a UI format with positions and widget values, and an API
format keyed by node id). They asked to import those files into the Studio's
workflows and use them, and for a library of workflows with pictures.

Two facts shaped the answer. Most ComfyUI graphs load and sample a model on
the person's own graphics card (checkpoints, samplers, VAEs, LoRAs,
ControlNets); Sub Rosa runs no model locally, every model it calls is hosted
behind Carpe Diem. And the Studio's workflows lived in the webview's local
storage, thirty at most, with no version, shown in a drop-down.

Three questions had real alternatives.

1. Run ComfyUI graphs (embed or call a ComfyUI runtime), or translate them
   into native workflows?
2. What happens to the nodes that do not translate?
3. Where does the library live, and what picture does a card show?

## Decision

1. **Translate, never execute.** `src/lib/studio/workflow/comfy/` reads both
   file formats and maps what a hosted model can do onto native nodes:
   loaders become asset nodes, prompt nodes text inputs, savers outputs, and
   the partner nodes that already call a hosted image or video model become
   image, image edit or video nodes whose model is picked from the live
   catalog by the words the node and its model widget share with a model id.
   Ports follow the link's kind and the model's direction (an image into an
   image-to-video model is its opening frame). A local diffusion chain (a
   sampler fed by prompt encoders) is rebuilt as one hosted image node with
   the same positive and negative prompts.
2. **Nothing is dropped in silence.** The importer returns a report:
   translated, adjusted (a model, a frame or a resolution the chosen model
   does not offer, the seed), left out with the reason, and the files the
   graph names but does not carry. The person reads it before anything is
   saved, and a graph where nothing makes anything is refused. A missing
   file becomes an asset node to fill from the gallery, which the validator
   already asks for. A file's notes become the workflow's description.
3. **The library is a SQLite table** (`studio_workflows`, migration 040),
   with the graph as JSON and its format version, read through a synchronous
   cache so the editor keeps its calls; local storage is moved into it once.
   Sub Rosa's own export is a versioned file (`format: subrosa-workflow`);
   a newer version is refused rather than misread. **A card's picture is the
   workflow's last real result**, recorded when a run finishes: free, and
   true to what it makes. Without one, the card sketches the graph's steps.
   A picture made by a model is offered on request, priced, and kept hidden
   in the gallery; the built-in templates ship with one made once.

## Consequences

- No ComfyUI runtime, Python or GPU dependency enters the app, and no
  graph the person did not review runs or costs anything.
- A ComfyUI graph that is mostly local (inpainting with masks, ControlNet
  poses, upscaler models) imports as its hosted core plus a list of what was
  left out, or not at all. That is the honest answer for a hosted-only app.
- The mapping is a table and a few heuristics. A new partner node with an
  unfamiliar name lands in "left out" until the table learns it; the report
  says which.
- Imported workflows are ordinary workflows from then on: edited, priced,
  gated and resumed like any other (ADR-0021, ADR-0022).

## Alternatives rejected

- **Bundling or calling a ComfyUI server.** It would make the app a local
  GPU runtime, the opposite of the hosted boundary, and most people have no
  such server.
- **Importing every node as an opaque passthrough.** A node the engine
  cannot run is a failure deferred to the moment money is spent.
- **Generated pictures by default.** Each would cost credits, and a picture
  imagined for a workflow says less about it than its own result.
