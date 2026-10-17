# ADR-0118: Workflows travel as definitions, never as runs

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0049](0049-accounts-synchronise-ciphertext-without-hosting-inference.md),
[ADR-0075](0075-a-comfyui-workflow-is-translated-never-executed.md),
[ADR-0108](0108-a-later-deletion-wins-and-what-it-took-can-be-restored.md),
[ADR-0115](0115-an-unchanged-step-is-reused-never-bought-twice.md) and
[ADR-0116](0116-a-block-runs-as-its-steps.md). No migration.

## Context

The Studio's workflows lived only on the device that drew them: the account
section of `account/README.md` listed them among what does not travel. A
person who draws a workflow on the laptop and opens the desktop app at home
found an empty library, and blocks published to the library (ADR-0116, rows
of `studio_workflows` with origin `block`) stayed behind with them.

What sits around a workflow is of three sorts. Its definition (graph, name,
description, origin, format) is something a person wrote. Its runs, their
step rows and the step cache (ADR-0115) are things a device did, and
ADR-0049 is explicit that received execution state is history, never an
instruction to pay again. Its card picture is a gallery file chosen on this
device. Its versions (migration 081) are a local undo history.

## Decision

1. **`studio_workflows` joins the sync registry** (`sync_tables.rs`) under
   the `settings` routing kind, with its definition columns only: `id`,
   `name`, `description`, `definition`, `format_version`, `origin`,
   `created_at`, `updated_at`. `cover_artifact_id` stays local, and so do
   `workflow_runs`, `workflow_run_nodes`, `workflow_node_cache` and
   `studio_workflow_versions`. A received workflow can be run only by a
   person, through the same cost confirmation as one drawn here.
2. **One object per workflow, named by its UUID.** Every workflow is created
   under `crypto.randomUUID()`; the trigger keeps back any row whose id is
   not a lowercase UUID rather than queue something the service would
   refuse. Blocks travel as the rows they are.
3. **A received row is checked like a local save** (`account/studio_workflows.rs`):
   a graph that is not a JSON object, a missing date or a format below 1 is
   refused (parked as `sync_format_invalid`, like any malformed row); the
   name and description are cut to the local bounds; an unknown origin
   becomes `mine`. The graph's own shape stays the webview's.
4. **A newer format is never cut down.** A device whose
   `WORKFLOW_FILE_VERSION` is lower opens a received workflow read-only and
   never saves it (`readOnly` in `store.ts`), so it cannot write a smaller
   copy over a newer device's work. An app from before this decision does
   not know the table and parks those revisions without applying them.
5. **Saves fold before they leave.** The editor saves 300 ms after each
   change; the outbox trigger rewrites the object's last unsent snapshot in
   place, so a drag is one revision, not dozens. A definition whose
   ciphertext exceeds the one-MiB operation limit is isolated as
   `sync_object_too_large`, and a smaller save replaces it.
6. **Libraries bound before this decision send what they hold.** The table
   is inventoried at every enable for objects never sent nor received, as
   `saved_items` is (ADR-0088).
7. **The library and the canvas follow arrivals.** On every sync event the
   webview reads the table again. The table is the record, except for a
   workflow this device is still writing, whose save is newer. Copies are
   compared by content, never by date, because two devices' clocks do not
   agree. The open canvas then shows what arrived, unless it holds an edit
   made since its last save (that edit is the newest thing anyone did, and
   its save follows), and never while a run is live (the arrival waits for
   the run to end). A workflow deleted elsewhere opens the next one.

## Consequences

- Concurrent edits to one workflow on two devices leave a conflict card
  for review, as any settings object does; the card shows the workflow's
  name. There is no field-level merge of graphs.
- A workflow's card has no picture on a device that received it until a
  picture is chosen there.
- Deletion follows ADR-0108: a newer deletion removes the workflow
  everywhere; the "Recently deleted" list covers notes and memories only.
- Runs started on one device show nowhere else. Reopening a received
  workflow shows no past results until it runs there.

## Alternatives rejected

- **Sync runs and the step cache too.** A received run would invite a
  resume of paid work on a device that never started it, and a cached
  step points at a gallery file that may not have arrived. Both stay local.
- **Rewrite older ids to UUIDs.** Every workflow is already created under
  one; rewriting would break the runs and versions that name the old id.
  The trigger guard covers the case without touching local rows.
- **Merge two graphs edited concurrently.** Nodes, edges, frames and blocks
  cross-reference one another; a line-level merge like the note body's
  would produce graphs that do not validate. A person chooses.
- **Decide what the canvas shows by `updated_at`.** Each device stamps its
  own clock; a laptop an hour ahead would win every comparison.
