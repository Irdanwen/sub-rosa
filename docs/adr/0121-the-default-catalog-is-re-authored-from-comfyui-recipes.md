# ADR-0121: The default catalog is re-authored from ComfyUI's recipes, never imported

Date: 2026-10-18. Status: accepted. Builds on
[ADR-0075](0075-a-comfyui-workflow-is-translated-never-executed.md),
[ADR-0117](0117-a-list-runs-what-it-feeds-once-per-item.md) and
[ADR-0119](0119-an-app-is-a-view-over-its-workflow.md). No migration.

## Context

The Studio shipped fifteen templates. ComfyUI's official gallery
(comfy.org/workflows, the `Comfy-Org/workflow_templates` repository, MIT)
holds about seven hundred, ranked by use, a third of them built on hosted
"partner" models: product shots, a character relit or seen from every angle,
a storyboard turned into a film, a clip extended, a talking photo. Those are
recipes people already reach for, and most of them run on models Carpe Diem
publishes. The importer (ADR-0075) can already read the files.

The obvious way to grow the catalog is to ship those files and translate them
when they are opened. A corpus of 49 of them, translated in a test against the
day's catalog (`src/test/fixtures/comfy-corpus/`), showed what that would ship:
batches, stitches, regex and size helpers left out (238 nodes over the corpus),
a model chosen by words, English-only labels and prompts, no app form, and ids
that drift with ComfyUI's releases.

## Decision

1. **A template is written by hand, natively**, in
   `src/lib/studio/workflow/templates/` (one file per kind of work), from a
   ComfyUI recipe read in the corpus: its own prompts, its labels through
   `t()` in the six languages, an app form where a person only brings a text
   or a picture (ADR-0119), lists where the recipe repeats a step
   (ADR-0117), and default models that `resolveTemplateModels` re-pins to the
   day's catalog. The recipe it comes from is cited in a comment.
2. **No ComfyUI file, prompt or thumbnail ships as a template.** A prompt
   reused word for word would carry the MIT notice; we write our own instead,
   because the prompts are the product. Every cover is made once by Sub Rosa,
   in the same style as the others, never a ComfyUI thumbnail (third-party
   model outputs, some showing contributors' sample photos).
3. **A recipe is taken when** it runs on models Carpe Diem publishes today
   (no local model, no LoRA, no ControlNet, no 3D), people use it (the
   gallery's `usage`), it fills a gap in the catalog rather than repeating a
   template, and it fits what Sub Rosa is for: making pictures, products,
   films and sound. One that needs a capability the catalog lacks is taken
   only once that capability is verified on a real run, never shipped half
   working.
4. **The importer is measured on the same corpus.** Its report is a frozen
   file; a change to the importer shows as a diff of it. The catalog and the
   importer improve together, but neither depends on the other.
5. **The catalog is one list**, each template with its kind of work
   (`CATALOG` in `templates/index.ts`). The library and the phone show only
   the kinds some template belongs to. Tests check invariants (a unique id, a
   kind, a cover, an app over steps the template has), not a count.

## Consequences

- The catalog grows by a few dozen templates over several pull requests, each
  with its covers (about 12 credits each) and its six languages.
- A ComfyUI recipe that changes upstream does not change a template: someone
  re-reads it and decides.
- The number of templates and apps quoted elsewhere (the parity matrix,
  ADR-0119) is updated by addendum when the catalog changes, not rewritten.

## Alternatives considered

- **Ship the ComfyUI files and translate them on open.** Rejected for the
  losses above, and because a template that reads in English only and opens
  with steps left out is a worse first impression than no template.
- **Translate once at build time and freeze the result.** Rejected: the
  output still needs a person to fix the dropped steps, write the app form and
  translate it, at which point it is a hand-written template with extra
  machinery.
- **Link to the ComfyUI gallery from the library.** Rejected: it shows
  workflows Sub Rosa cannot run (refused hub, parity matrix).
