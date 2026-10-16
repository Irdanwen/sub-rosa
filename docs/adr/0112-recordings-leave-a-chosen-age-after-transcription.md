# ADR-0112: Recordings leave a chosen age after transcription, everywhere

Date: 2026-10-13. Status: accepted. Builds on
[ADR-0110](0110-the-account-keeps-inside-its-quota-and-text-never-waits-for-files.md).

## Context

After ADR-0110 the reported account was syncing again, and its recordings
were still three quarters of its 5 GiB. The person asked why they are kept
at all: once a note is transcribed, its audio is only needed to check a
passage, to transcribe again, or as a record.

The app already offered Settings › Storage › "Remove the audio of notes
transcribed more than N days ago". It deleted the file on this device only:
the account kept its copy, and every other device kept its own and could
send it again. It freed nothing where the room was short.

The person chose: recordings go seven days after transcription, on every
device and in the account, existing ones included.

## Decision

1. **A choice that follows the account.** `account_preferences` is one row
   under a fixed id (`recording_retention::PREFERENCES_ID`), synchronised like
   any object (kind `settings`). `audio_retention_days` is 7, 30, 90, 180 or
   365, or null to keep recordings. Made on one device, it applies on all.
   An app from before this table parks the row and goes on (ADR-0108).
2. **Every device applies the same rule** to what it holds: an artifact older
   than the age, on a note that reached `ready`, with a transcript of its own,
   not purged already (the existing `purgeable_recordings`). It deletes its
   file, takes the account's copy out (`account::forget_recording`: manifest,
   upload and compact copy under way), and marks the artifact purged. A
   device that never fetched the file has nothing to delete and still takes
   the account's copy out. The tombstone's chunks are released a day later
   like any deleted file's (ADR-0110).
3. **Nothing purged is sent again.** The upload lane and compaction leave
   alone an artifact marked purged; a device that has not purged yet does
   not send a recording whose manifest another device removed
   (`account_manifest_waits`).
4. **It runs on its own once chosen**, at most once an hour (the sync driver
   and the background sweep), and at once when the choice is made.
5. **Choosing an age that deletes recordings now asks first**, saying how
   many and how much. Going back to "Never" stops future deletions; it does
   not bring anything back.
6. The manual "Remove" of Settings › Storage is replaced by the choice: one
   rule, never two.

## Consequences

- The transcript, the note's text and the timeline's durations stay; the
  note can no longer play its audio or be transcribed again.
- The choice is made on the desktop (Settings › Storage) and reaches the
  phones through the account. A phone with no account keeps its recordings.
- ADR-0110 rejected eviction by age because the app would decide; here the
  person does, once, for the account.
