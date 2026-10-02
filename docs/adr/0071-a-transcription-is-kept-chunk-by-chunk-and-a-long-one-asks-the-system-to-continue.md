---
status: accepted
date: 2026-10-02
---

# A transcription is kept chunk by chunk, and a long one asks the system to continue

## Context

On the phone, a note recorded with the microphone is transcribed after the
recording stops: the audio is cut into 30-second transcription chunks (ten
minutes for a decoded import, ADR-0026), sent one after another, each with the
text of the earlier ones as context. A meeting is dozens of chunks and several
minutes of work, and the user locks the phone or switches app in the middle of
it.

Reported on 2026-10-02: "when the screen locks or I switch app, the
transcription stops and starts again from zero". Four causes stacked up:

1. **Nothing survived the loop.** Each chunk's text lived in a local vector.
   Any retry (the resume sweep, the Resume button) cleared the scratch
   directory and started at chunk zero, paying for every chunk again. The
   multi-source turn path kept its turns, but the phone never takes it.
2. **The automatic resume never ran.** `list_notes_stuck_in_processing`
   filtered on `notes.deleted_at`, a column `notes` has never had. The query
   failed every time and its `?` aborted the whole note sweep, from the day
   ADR-0018 introduced it until this change. A note only ever came back when
   the user pressed Resume.
3. **A suspension read as a provider failure.** iOS freezes the process
   mid-request and can reclaim the loopback socket. What comes back on resume
   is a 502 or a broken body, which the transient-retry rules rightly do not
   retry in the foreground, so the note was marked failed.
4. **The process had about thirty seconds.** `beginBackgroundTask` is the only
   lever the pipeline held, the audio session ends with the recording, and the
   `BGProcessingTask` handler reported completion as soon as the sweep returned,
   giving its window back while the restarted transcription was on its first
   chunk. On Android the microphone foreground service ends with the
   recording too.

## Decision

**Every finished chunk is written down before the next one starts, and a long
transcription asks the system to keep running.**

- A `transcription_chunks` row (migration 037) records each chunk's outcome,
  text or silent, keyed by audio artifact and chunk index, under a fingerprint
  of the cut: prepared-audio size, chunk ceiling, chunk count, transcription
  model and language. A run that finds rows for the same cut replays them
  through the same bookkeeping as fresh chunks, so the context each later chunk
  receives and the transcript the run returns are identical to an uninterrupted
  run. Rows of a different cut are dropped. The rows are cleared once the note
  is ready, so a deliberate re-run of a finished note transcribes afresh. The
  loop moved into `domain/transcription_checkpoint.rs`, a child of
  `processing`.
- The sweep's query is fixed, and its selection
  (`note_processing::notes_to_resume`) also skips notes waiting in the
  processing queue, so a second sweep cannot queue a note twice. Only notes
  changed within the last day come back by themselves: since the sweep never
  ran, a phone can hold notes stuck for months, and resuming them all on the
  first launch would bill transcriptions the user walked away from. Older
  notes keep their Resume button.
- A lifecycle epoch moves on iOS's did-enter-background and on `Resumed`. A
  request that fails after the epoch moved is asked again, at most twice,
  without counting against the transient attempts. The same failure with no
  move in between is believed (ADR-0012's classification is unchanged).
- Once a transcription is known to span more than one chunk, the pipeline calls
  `ios_background::continue_note`:
  - on **iOS 26** it submits a `BGContinuedProcessingTask`, the task Apple made
    for user-started work, with the strategy that fails rather than queues. It
    keeps the process running with the screen locked and shows the note's
    progress, mirrored every second because Apple expires a task that looks
    stalled;
  - on **Android** it starts `ProcessingService`, a `dataSync` foreground
    service with a progress notification.

  Both only keep the process alive. The work stays in the pipeline's own task,
  behind its row and its chunks, so an expiration, the system's or the user's,
  pauses the note rather than losing it. A one-chunk recording fits in the
  grace window and does not get a system activity on the lock screen.
- The `BGProcessingTask` handler now waits for the work it restarted before
  completing, and completes exactly once.
- A note that finishes after a resume posts the same "is ready" notification
  as one that finished on the first run.

The user-visible promise of ADR-0018 now holds for notes: locking the phone
costs time, never a chunk already transcribed and never a credit twice.

## Consequences

- A long transcription started in the foreground on iOS 26 finishes with the
  phone in a pocket, and the lock screen shows how far it has got. On older iOS
  it continues in the grace window and the opportunistic `BGProcessingTask`
  windows, then resumes on return at its first unfinished chunk.
- The progress DTO gains `resumed`, so the screen can say "Picking up at part 7
  of 20" instead of appearing to do six chunks in a second.
- Chunk rows of a recording that is never retried stay until the note is
  deleted (cascade). They are a few kilobytes of text.
- Android needs the `dataSync` foreground-service type declared in the Play
  Console, and Android 15 caps that type's daily runtime. When the cap or the
  background-start rule refuses the service, the note falls back to the saved
  chunks and the sweep.
- Every BGTaskScheduler identifier the Rust side registers is pinned to the
  Info.plist and `project.yml` by `tests/background_identifiers.rs`, because a
  mismatch fails silently on the phone.

## Alternatives considered

**Silent-audio keepalive.** Still rejected, for ADR-0018's reasons. The
continued-processing task is the sanctioned version of the same outcome, with
the user able to see and stop it.

**Persist the chunks on the existing `transcripts` turn rows.** The unique
index `(recording_session_id, source, turn_index)` would have accepted them,
but turn rows are read as the conversation: passages, chapters, the long-form
summary and the transcript view would all have seen 30-second slices as turns.
Chunks are scaffolding, so they get their own table and are deleted on success.

**Transcribe the chunks concurrently so there is less to lose.** It shortens
the exposure without removing it, and it changes the context each chunk is
given. It is a separate decision, still waiting on the measurement the
processing-progress work asked for.

**Submit the continued task for every note.** A ten-second note would flash a
system activity on the lock screen for work the grace window covers. The task
starts only once there is more than one chunk to transcribe.
