# ADR-0110: The account keeps inside its quota, and text never waits for files

Date: 2026-10-12. Status: accepted. Builds on
[ADR-0049](0049-accounts-synchronise-ciphertext-without-hosting-inference.md),
[ADR-0072](0072-a-clean-remote-deletion-is-applied-not-reviewed.md),
[ADR-0108](0108-a-later-deletion-wins-and-what-it-took-can-be-restored.md) and
[ADR-0109](0109-changes-arrive-by-waiting-not-polling.md).

## Context

Reported on 2026-10-12: nothing synchronised any more between an account's
four devices. Measured, not guessed:

- The account sat **62 bytes under its 5 GiB quota** (`accounts.used_bytes`
  5 368 709 058). Every revision costs its ciphertext and 256 bytes, so the
  last one the service took was on 2026-10-06 at 15:38. A Mac's egress ledger
  held 68 865 refusals (`413 quota_exceeded`) since 2026-10-05, one every five
  seconds, shown to the person as the generic `account_request_failed`.
- **Text was 0.5 % of it.** 3.51 GB were live recordings, 1.22 GB Studio
  files, 0.53 GB chunks no manifest named any more, 25 MB the journal.
- Five causes, none of them the person's doing:
  1. **Nothing ever gave room back.** The blob route took `GET` and `PUT`
     only. A deleted file, an abandoned upload, a replaced manifest: their
     bytes stayed billed for good.
  2. **Every chunk went up a third larger than its contents**: the JSON text
     envelope (`{"v":1,"nonce","ciphertext"}`, base64) was used for files too.
  3. **Recordings went up as recorded**: WAV at 48 kHz, about 345 MB an
     hour, where transcription reads 16 kHz mono.
  4. **Files and the journal shared one bucket with no reserve**: a recording
     could take the last bytes and leave a note unable to leave.
  5. **A refusal stopped the pass.** Before 1.90 the push came first and a
     refused one stopped the pull too; in 1.90 it still stopped the file lane
     and the "last synced" mark. Nothing on screen named the cause, and the
     device asked again every tick.

A higher quota was rejected by the person: the account must work inside
5 GiB.

## Decision

1. **The journal has room of its own.** Files stop at
   `account_quota_bytes - journal_reserve_bytes` (256 MiB by default,
   rendered by `bootstrap.py`), refused as `413 storage_files_full`; the
   journal keeps the whole quota and `quota_exceeded`. A full account still
   takes notes, conversations and memories until files have been released.

2. **A refusal for room is not a failed pass.** Both codes become
   `account_storage_full`. The pass still receives, fetches, releases and
   compacts; sending waits for room (`push_held`, `files_held`, ten minutes
   or until a release frees bytes) instead of asking every tick, and the tick
   does not count what waits as work. The person reads "Your account storage
   is full. Your changes are safe on this device and will sync once space is
   freed."

3. **Room is given back, and only what nothing names.** The service gains
   `DELETE /api/v1/blobs/{id}` (409 if a share holds the chunk, an id waiting
   for the drain cannot be written again) and `GET /api/v1/blobs` (by page or
   by name, with age and share). The client releases from a durable queue,
   checking each chunk against everything it still names just before it goes:
   live manifests, uploads and compactions under way, and the unanswered cards
   (which "keep this version" would bring back). Candidates come from:
   - **the journal's deletions**: a file manifest whose head is a tombstone,
     a day after the deletion. Read from the journal, not from this device's
     actions, so a deletion an older app made is released too. Restoring a
     note never brings its recordings back (ADR-0108), so a released file is
     not one a restore needed;
   - **the sweep**: a chunk no manifest names, older than seven days, never
     shared. It runs once a day, at once when the account is full or above
     90 %, and only on a device that has applied every file revision it was
     handed.

4. **Files are stored compact.** Once every app on the account reads it, a
   recording leaves as a **16 kHz mono WAV**, the very audio transcription
   reads, about a third of the original; the original stays on the device
   that recorded it. Every new chunk is sealed in a **binary envelope**
   `[2][nonce 12][ciphertext and tag]`, a quarter smaller. Files already in
   the account are sent again in that form by a device that holds them, and
   the first form is released like a deleted file's. A device that holds a
   Studio file already fetches nothing for its new manifest.

5. **Nothing is written that an app on the account cannot read.** Each native
   app announces its version (`X-Subrosa-Version`, noted on the device, listed
   by `/api/v1/devices`). Compaction, the binary envelope and the sweep wait
   until every device that is not revoked and was seen in the last thirty days
   announces 1.91.0 or later; the account panel names the ones it waits for. A
   browser is left out: the site is published with every release, and it
   reads both envelopes.

6. **Two devices never compact one file twice.** The copy that replaces a
   manifest has an id derived from it (UUID v5), and so do its chunks: the
   second device to send chunk zero finds it taken (409), sets the file aside
   for eight days and releases nothing of the other's. A copy abandoned by a
   device that vanished is outlived by the sweep.

7. **A manifest never names chunks the service lost.** Before a file manifest
   leaves, its chunks are asked for by name; missing ones hold it back
   (`sync_chunks_missing`) and are sent again from this device's copy, each
   checked against the digest the manifest carries. This is what makes the
   sweep safe against another device's manifest that waited longer than a
   week.

8. **The person sees and decides.** Settings shows the account's room, what
   fills it, the largest files, what waits for space and what is being made
   smaller, and lets a device keep its new recordings or Studio files to
   itself. Deleting a file is the way to give room back; the app never evicts
   a file on its own.

## Consequences

- On the reported account, the files already deleted in the journal hold an
  estimated 200 chunks (0.2 to 0.3 GB, read from the service's revision
  sizes). They are released on the first pass of an updated device, without
  waiting for the others, and the journal needs only a few kilobytes to leave.
  The sweep of the remaining unnamed chunks (about 0.3 GB) and compaction wait
  until the four devices run 1.91; compaction then brings about 4.7 GB of live
  files to about 1.4 GB.
- A recording on another device is 16 kHz: right for listening to speech and
  identical to what transcription uses, not for music. The device that
  recorded keeps its original. FLAC would halve the copy again and was left
  out for now: a new encoder on four targets for a second factor of two.
- The service still keeps every revision of the journal (25 MB here after
  three weeks). Compacting history is a later decision.
- A device on an older version holds compaction back for thirty days unless
  it is updated or revoked; the panel says which one.

## Rejected

- **Raising the quota.** The person's call: the account must fit 5 GiB.
- **Eviction by age.** Silently removing old recordings from the account
  would take data a person did not choose to give up.
- **Server-side garbage collection.** The service cannot read the manifests
  that say which chunks are live; only a device can.
- **"Remove from the account, keep on this device" per file.** Other devices
  holding a downloaded copy and no manifest would send it again; the
  semantics need a synced marker of their own. Deleting the file, and a
  per-device switch for new files, cover the need without one.
