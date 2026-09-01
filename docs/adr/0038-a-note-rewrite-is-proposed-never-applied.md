# 38. A note rewrite is proposed, never applied

Date: 2026-09-01

## Status

Accepted

## Context

The note editor can now write what a notebook application writes: heading
levels, nested and ordered lists, checkboxes, quotes, code, links, highlight
(ADR-0037 and the writing surface built on it). The remaining half of the ask
was the model: select a paragraph and have it corrected, reformulated,
shortened, developed, reorganised or translated, without leaving the note.

Three properties of *this* app make that less obvious than it sounds.

A note here is frequently the **only record of a meeting**. It is produced from
a transcript, and the transcript is gone from the user's attention the moment
the note exists. A model that smooths a half-remembered figure into a confident
one has done damage that no undo notices, because nobody re-reads the sentence
they asked to be corrected.

A note also **contains other people's text**: transcripts of anyone who spoke,
podcasts and conference talks imported wholesale (ADR-0026), and anything the
user pasted. So the material a rewrite operates on is not trusted input.

And the app runs on a phone, where ADR-0018 says background work is a durable
row and never a live task.

## Decision

**The model returns a revision. The user applies it, or nothing happens.**

### Nothing is written without a gesture

`src-tauri/src/note_ai/` returns replacement text. It does not touch the
document, and it does not touch the database. The editor puts the text in front
of the user, who accepts it or discards it.

This is not a new rule; it is `crate::actions`' rule, which already governs
everything the assistant proposes: *"Nothing executes without an explicit
gesture… the card in the reply is a button, never a receipt. There is no
auto-apply, no undo-only flow, and no action that runs because a model was
confident."* A rewrite replaces a paragraph the user wrote, which is exactly
the case that rule exists for.

The corollary is the split the writing surface uses: **what replaces text you
wrote is reviewed first; what adds text you did not write is inserted, because
undo is enough.**

### It is fork-side, and nothing is added to `june-api/`

The passes go to `/v1/chat/completions` through the sidecar, the seam
`agent_lite`, memory extraction and `longform` already use. The prompts live in
`note_ai/prompts.rs` with their own `NOTE_AI_PROMPT_VERSION`.

The reasoning is ADR-0027's, unchanged: every line the fork writes into
`june-api/` is a line `upstream-sync.yml` re-merges forever, and upstream has
no rewrite feature that would want this endpoint.

### It is transient, and that is deliberate against ADR-0018

This is the decision most likely to look like an oversight later, so it is
recorded as a decision.

ADR-0018 says anything that can outlast a foreground session writes a row
first, because iOS freezes the webview and suspends the process. A rewrite does
not write a row, does not appear in `background::sweep`, and dies with the
screen.

Durability there protects **work a person cannot recreate**: a recording, an
import mid-transcription, a chapter map that cost a dozen model calls. A
rewrite is none of those. It is a click the user is watching, it costs one call
to redo, and resurrecting it would be *wrong*: a revision of a paragraph,
re-applied three hours later to a paragraph the user has edited since, is a
silent corruption of exactly the kind ADR-0035 and ADR-0018 exist to prevent.

Whether a run is live is therefore an in-process question — a cancellation set
keyed by request id — which is the same shape as `domain::processing`'s
`ACTIVE_NOTES` and agent-lite's `TurnClaim`, and for the same reason: a
database cannot tell "running" from "the process died".

### It streams, and it can be stopped

Reorganising the note of a two-hour meeting is twenty seconds of work. A panel
that shows nothing for twenty seconds is a panel people stop using, so deltas
are emitted on `june://note-rewrite` as they arrive. Cancelling drops the
response, which closes the connection, so a run the user abandoned stops
costing money rather than finishing into a void.

Cancellation is a `Notify` the run *selects on*, not a flag it polls between
chunks. A polled flag is only read when the provider sends something, and a
stalled stream is precisely when a person reaches for the stop button — the
one case the simple version would not handle.

### The selection is data, and the blast radius is one paragraph

The passage arrives between `<selection>` delimiters, and every prompt says
that what is inside them is material to rewrite rather than a request to obey.
That is a mitigation, not a guarantee — no prompt is.

What makes it sufficient is the shape of the rest: the model is asked for
**text, never a tool call**; the text lands in a **bounded range**; and it
**cannot land at all without a click**. The worst a hostile note can achieve is
a bad rewrite that the user declines. There is no path from the note's contents
to the filesystem, the database, or another request.

### Only one kind may change the structure

`Restructure` is allowed to reorganise; every other kind is told to keep the
markdown structure it was handed, down to the checkbox states. `Correct` is
told, in as many words, that a clumsy but correct sentence stays clumsy. The
test suite asserts that the structure exemption appears in exactly one prompt,
because the failure mode of a rewrite feature is not that it refuses — it is
that it quietly rewrites more than it was asked to.

## Consequences

- **The bound is characters, not bytes.** 24 000, counted in characters so a
  French or Japanese note is not cut a third early, and well under the desktop
  sidecar's 512 KB request cap.
- **One run per request id.** The same registry that carries the stop handle
  refuses a second rewrite under a live id, so a double-tap cannot start two
  paid runs whose replies race into the same panel.
- **The output budget follows the passage** rather than reserving the ceiling
  for a one-line correction, with a floor generous enough for `expand` and for
  a translation into a wordier language.
- **Every kind is a Rust enum**, so adding one is an arm in `task_instruction`
  and a case in the test that walks all of them, rather than a string that
  silently falls through.
- **A fence around the whole reply is stripped**, but only the unmistakable
  case: a passage that genuinely is a code block keeps its fence.
- **A rewrite that returns nothing is an error**, not an empty replacement.
  Replacing a paragraph with nothing is the one outcome the user cannot have
  intended.
- **`note_rewrite` and `cancel_note_rewrite` are shared commands** and are in
  both `generate_handler!` lists, enforced by `tests/shared_commands.rs`.
- **The prompts are the product here.** They carry a version so a revision made
  by an older one can be told apart, and they are the thing to change when a
  rewrite disappoints — not the plumbing around them.
