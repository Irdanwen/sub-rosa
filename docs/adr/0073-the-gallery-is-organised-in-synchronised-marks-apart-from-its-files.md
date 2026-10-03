---
status: accepted
date: 2026-10-03
---

# The gallery is organised in synchronised marks, apart from its files

## Context

The phone's Studio gallery is getting folders, favourites and a way to hide a
file, chosen by long-press and multi-select. The person asked for these to be
the same on every device signed in to their account.

What the gallery already knows about a file lives in two places.
`studio_artifact_metadata` holds what produced it (prompt, model, chain
parent, measures) and stays on the device. `account_studio_files` holds the
file's synchronised record, written when the file is queued for upload. Three
questions had real alternatives.

1. Where does organisation live?
2. What is it keyed by?
3. What does deleting a file do on the other devices?

## Decision

1. **Two new tables, synchronised like any other.** `studio_collections` (a
   named group, routed as a `folder`) and `studio_marks` (one row per file
   with something to say: its collection, favourite and hidden, routed as an
   `artifact`), both registered in `account::sync`'s table list. The generic
   triggers journal them, the generic `apply` upserts them, and a deletion is
   a tombstone handled by ADR-0072. A mark that says nothing is deleted
   rather than kept, so an un-favourited, unfiled file travels nothing.
2. **A mark is keyed by the UUID stem of the gallery file name.** The sync
   service accepts only UUID object ids, and the stem is what
   `account/studio.rs` already uses to identify a file across devices: a
   received file is written as `<stem>.<ext>`. Files without a UUID stem
   never synchronise, so they cannot be marked either.
3. **Deleting a gallery file deletes it everywhere.** The local delete now
   also removes its `account_studio_files` row (and any pending upload). The
   tombstone tells the other devices to remove their copy, as every other
   synchronised deletion already does. Until now a file deleted on the phone
   stayed on the Mac for good. The confirmation says so.

## Alternatives rejected

- **Extra columns on `account_studio_files`.** It describes the file as
  uploaded and is written once by the upload lane. Mixing a person's
  frequent choices into it would re-send the file record on every star.
- **Organisation inside `studio_artifact_metadata`.** It is keyed by the file
  name, carries up to 256 KB of provenance, and does not travel. Making it
  travel would ship every prompt and measure with each change of folder.
- **A `folder_id` column.** `account::sync::apply` treats any `folder_id` as
  a dependency on the notes' `folders` table and would park every mark until
  a note folder of that id arrived. The column is `collection_id`.
- **Hidden as encrypted or locked storage.** Hiding keeps a file out of the
  gallery's views and search; it is not a vault. Claiming more would be a
  promise the storage does not keep.

## Consequences

- A mark can arrive before the collection it names. The gallery then shows
  the file outside any collection until the collection arrives.
- Two devices changing the same file's marks at once produce a sibling
  revision like any other object; there is nothing to merge by hand beyond
  three fields.
- Deleting a collection never deletes files: their marks lose the
  collection, and those left with nothing to say are removed.
