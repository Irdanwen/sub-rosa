# ADR-0120: The assistant proposes workflows, and never runs them

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0038](0038-a-note-rewrite-is-proposed-never-applied.md),
[ADR-0075](0075-a-comfyui-workflow-is-translated-never-executed.md),
[ADR-0118](0118-workflows-travel-as-definitions-never-as-runs.md) and
[ADR-0119](0119-an-app-is-a-view-over-its-workflow.md). No migration.

## Context

The Studio's assistant could prepare a film (the bible, the shot list,
`june_studio`) but could not touch a workflow: it could neither say what the
person's workflows do nor draw one for them. ComfyUI's newer editor has an
assistant that edits the graph on the canvas. Workflows spend money when they
run, and a person's workflow is work they did.

## Decision

1. **One tool, `workflows`, with four actions**, in the desktop MCP
   (`june_studio_mcp.py`) and in the phone's agent-lite through the same
   action table (`studio_actions.rs`, `workflow_actions.rs`): `list`, `read`,
   `steps` and `propose`. Custom assistants do not get it unless granted.
2. **`steps` answers from the schema itself**: `step-catalog.json`, written
   from the webview's schema and kept equal to it by a test, is embedded by
   the native side. A proposal is checked against it: a step type or an input
   that does not exist is refused with the reason, before anything is saved.
3. **A proposal is a draft of its own** (origin `assistant`), never a change
   to a workflow the person has: to change one, the assistant proposes a new
   one named after it. The draft waits in the library under "Proposed by the
   assistant", opens read-only with a choice, Keep (it becomes the person's,
   to change and run) or Discard, the rule ADR-0038 set for a note's rewrite.
   An open Studio hears of it at once (`subrosa://workflow-proposed`).
4. **The assistant never runs a workflow.** Running stays a person's gesture
   that passes the price, the confirmation and the spend ceiling. A proposal
   may carry an app (ADR-0119), so a workflow meant to be reused with other
   words or pictures opens as a form.

## Consequences

- Drafts travel like workflows (ADR-0118); a device from before this
  decision reads one as an ordinary workflow, which is the safe side.
- Discarded drafts are deleted, not archived: the conversation that made
  one still holds what was proposed.
- The step catalog is a second place the schema shows; the test is what
  keeps it honest.

## Alternatives rejected

- **The assistant edits the open canvas.** A graph has no line-level undo a
  person can review like a paragraph, and a change to wiring can change what
  a run spends; a draft beside the original is reviewable as a whole.
- **Let the assistant run what it drew.** The price would be decided by a
  model; the cost confirmation exists so that a person sees it first.
- **Describe the steps in the tool's description.** Several thousand tokens
  in every turn of every conversation; `steps` costs nothing until read.
