---
status: accepted
date: 2026-10-07
---

# Desktop chat controls ride the runtime's own seams

## Context

Work package P1-WP2 of the parity plan (ADR-0078) gives the desktop chat four
everyday controls: a reasoning effort, Regenerate after a good reply, a real
Edit of a sent message, and Archive. The desktop chat runs on the pinned Hermes
runtime (v2026.7.20), which is upstream code this repo does not own, behind a
provider proxy in `hermes_bridge.rs` that every Hermes process of a mode shares.

A live gateway (the installed runtime, driven by a script against a fake
provider) and the pinned sources settled what the runtime really does, as
opposed to what our typed wrappers assumed:

- `_supports_reasoning_extra_body()` returns false for any loopback provider,
  so Hermes never sends a reasoning field to the proxy, whatever
  `session.create`'s `reasoning_effort` says. The proxy sees no session id.
- The model string given to `session.create`, or to `config.set` with
  `key: "model"`, reaches the provider verbatim on every request of that
  session. `config.set` is the per-session switch; `command.dispatch` reads
  only `name`/`arg` and answered our `command: "/model …"` with 4018, so the
  live model switch of ADR-0013 never took.
- `/undo N` (command.dispatch `name: "undo"`) soft-deletes the last N user
  turns on disk, reloads the session and answers the text of the earliest one.
  `/retry` trims only the in-memory history, so the stored transcript keeps the
  old reply and the question twice.
- `session.branch` must be given the runtime session id (the stored id answers
  4001), ignores `from_message_id`, copies the whole history, starts the fork
  on the profile's default model, and answers the fork's runtime id and its
  parent's stored id, never the fork's stored id.
- `session_folders`, where the phone archives a chat in the shared "Archive"
  folder, was never synchronised, and it keys a desktop chat by its Hermes
  session id while the phone keys the same conversation by its task id.

## Decision

1. **Reasoning effort is a model alias.** The desktop hands Hermes
   `<model-id>@reasoning-effort=<low|medium|high>` (session.create and
   config.set). The proxy strips the suffix and sets the flat
   `reasoning_effort` field before the sidecar (`provider_proxy.rs`), so the
   egress ledger, the price table, the cache statistics and june-api only ever
   see the real id. The control is offered only when the catalog entry carries
   `supportsReasoningEffort`; the choice is kept per model on the device.
   Every surface that reads a model back from Hermes (session list, usage,
   prices, names) strips the alias. The suffix is long on purpose: Hermes
   auto-corrects a `/model` value at least 90% similar to a listed id.
2. **The live model switch is `config.set … --session`** on the runtime id.
3. **Regenerate and Edit are `/undo` followed by a new turn.** Editing the last
   message rewinds it in place. Editing an earlier one forks the session,
   rewinds the fork to just before the message, puts the fork back on its
   source's model, finds the fork's stored id among the source's children, and
   sends there: the original conversation stays as it was. "Branch from here"
   uses the same sequence, keeping the chosen exchange.
4. **Archive is membership of the shared "Archive" folder, synchronised.** A new
   synchronised mirror, `account_session_folders` (kind `folder`, migration
   043), carries each membership under the conversation's task id when the
   device has one for the Hermes session, and the store answers a membership
   under both ids. Any folder named "Archive" counts, so two devices that each
   created one still agree.

## Alternatives rejected

- **A process-wide effort setting read by the proxy.** Simple and invisible to
  Hermes, but one process serves every chat of a mode, so changing the effort
  in one chat would change it in all of them mid-turn.
- **Patching the pinned runtime's reasoning gate.** It would make every Hermes
  upgrade a merge, and the gate's `reasoning` object is not the flat field the
  provider reads first.
- **`/retry` for Regenerate.** It leaves the stored transcript wrong (above).
- **A separate archive flag table.** The phone already archives through the
  folder; a second notion of archived would disagree with it on every device.

## Consequences

- A chat's model string in Hermes' own store can carry the alias; nothing in
  the app may read a model from Hermes without `stripReasoningEffortAlias`.
- Hermes' own `max`/`ultra` tiers stay unexposed; the proxy forwards any level
  Carpe Diem accepts, so a later frontend can offer more without a new shell.
- Hermes inserts a system line in the history at each model switch, and the
  config.set reply carries a "not found in this endpoint's listing" note for an
  alias. Both are harmless and expected.
- A fork shows its source's model only once the switch is acknowledged; if it
  fails, the fork answers on the default model.
- Regenerating a question that carried images resends its text only.
- An archive made on a desktop chat that was never mirrored into a conversation
  (never opened while an account was bound) travels under its Hermes id, which
  no other device knows. Like `studio_marks` (ADR-0073), the new synchronised
  table is unknown to older app versions, which refuse the page that holds it
  until they update.

## Addendum 2026-10-07: Regenerate resends the pictures

The consequence "a question that carried images resends its text only" was
offered as a disabled button, and it did not have to be. The stored question
names every picture the send path attached: the attachment block lists each
upload by its path in the workspace, and an image mention by its absolute
path, and the files stay where they were copied. Regenerate now reads them
back from the stored text (`questionImages`), checks each one can still be
read before it rewinds anything, and sends them through the composer's own
attach step. The Hermes bridge resolves a relative path against the
workspace, which is what such a path means. Regenerate stays disabled only
for a picture the text does not name (the notice Hermes writes when it could
not see one), and refuses with a reason when a named file was deleted since.
