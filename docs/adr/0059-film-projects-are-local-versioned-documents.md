---
status: accepted
date: 2026-09-21
---

# Film projects are local versioned documents over gallery artifacts

## Context

A reading and its workflow run capture a production, but neither is the film the
person continues editing. The former is model output, the latter is execution
history. Using either as the editing surface made it difficult to change one
shot, compare takes, organise files, or retain a cut independently of a new run.
The gallery's bounded browser index could also lose names and provenance while
the actual files still existed.

## Decision

A **film project** owns the editable script, ordered shots with stable ids,
project settings, copies of bible entries, media references, production links
and a montage document. It lives in the existing native SQLite database as a
versioned JSON document, not in browser storage. This extends ADR-0030 with an editing document while keeping its decision that
a production compiles into the existing workflow engine. The shot list reader,
compiler and workflow execution records remain in use.

The native store validates `schemaVersion: 1` and a bounded document envelope.
It deliberately preserves fields it does not interpret: a phone that cannot edit
the desktop montage must not erase it. Each save compares the expected revision
in one SQL statement and increments it on success. A stale writer receives a
conflict instead of silently replacing another window's edits. Creating an
existing id also conflicts. Document limits are eight MiB and project names are
at most 200 characters.

Gallery metadata has its own local table keyed by artifact id: display title,
project memberships and generation provenance. Media bytes stay in the gallery.
Neither a rename nor a project membership change moves or duplicates a file.
Paths are resolved from the current disk listing, not retained as durable media
identity. An omitted provenance value on a metadata save preserves the prior
value. Old metadata and recoverable films can be imported with deterministic ids;
repeat imports do not overwrite existing projects.

**A project bible is a copy, not a subscription.** Importing a global identity
retains its origin id and references, then edits the project-owned copy. Changing
it must not change another film or the global bible. ADR-0032's global identities
remain useful and retain their existing lifetime. Their project copies give a
particular film a stable interpretation without duplicating reference files.

Shot settings and chosen takes are mutable editing decisions. Submitted
production graphs are snapshots. Editing a project never submits work or changes
a completed generation; making a new take is explicit. Montage clips reference
the selected artifact id, so choosing another take does not silently replace an
already-edited clip. Background generations continue to follow ADR-0018.

## Trade-offs and boundaries

Normalised shot and timeline tables would enforce more detailed constraints in
SQLite, but each editor extension would become a database migration shared with
mobile. A bounded, versioned document preserves that information at the cost of
whole-document saves and application-level editor validation. Revision checks
make that trade-off safe against silent concurrent replacement, without inventing
an automatic merge for creative edits.

These tables are local. Adding them does not add an account-sync contract or a
new inference service. Unknown or missing gallery references remain visible as
missing references rather than being reassigned to another file. Archive and
cloud portability must not be claimed without explicit integration and tests.
