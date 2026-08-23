---
status: accepted
date: 2026-08-23
---

# Imported media is decoded in-process, never by a bundled ffmpeg

## Context

`import_audio_note` has always advertised more than it can deliver. It
accepts `wav, m4a, mp3, aac, mp4, flac, ogg`, but only WAV reaches the real
pipeline; everything else takes the branch `process_imported_audio` documents
honestly:

> compressed formats (m4a, mp3, ...) are sent whole to the transcription
> endpoint, which accepts them natively — there is no local decoder for them

"Sent whole" is the problem. The transcription route is capped at
`max_audio_bytes = 26_214_400` and the upstream model refuses more than 25 MB.
A one-hour conference recorded as MP4 is an order of magnitude past that, so
the one import users most want has never worked. It fails late, after the copy
into the note directory, with a size error that says nothing about what to do.

The recorder never hit this because it writes WAV and hands it to a pipeline
that already knows how to split, skip silence, and retry. The imported file is
the only audio in the product that arrives in a container the app cannot open.

The obvious fix is ffmpeg, and this repository has already refused it once, in
`carpe_diem/workflow_runs.rs`:

> two of its node types (frame extraction, assembly) need WebKit's decoders
> and MediaRecorder, which Rust deliberately does not replicate (no ffmpeg to
> bundle, notarize, or license)

Those reasons hold here and one more joins them: the macOS release deep-signs
and notarizes every bundled executable, an ffmpeg build is large and its
licensing depends on which encoders were compiled in, and on iOS a bundled
binary cannot be executed at all. An import path that only exists on the
desktop is not an import path.

The second candidate was the webview. Studio decodes video frames there
precisely because WebKit has the codecs. It is the wrong tool twice over:
[ADR-0018](0018-ios-background-work-is-durable-rows.md) forbids long work
living in a JavaScript promise, and `decodeAudioData` is all-or-nothing —
two hours of audio is roughly a gigabyte of `Float32Array` before a single
sample is transcribed.

## Decision

**The app decodes imported media itself, in-process, and produces exactly the
audio the transcription pipeline already wants.**

`src-tauri/src/audio/decode.rs` wraps [Symphonia](https://github.com/pdeljanov/Symphonia)
(pure Rust, MPL-2.0, no C toolchain, no subprocess) and emits a 16 kHz mono
16-bit WAV — the same shape `normalize_wav_for_transcription` produces. An
import therefore stops being a special case: it becomes a WAV, and takes the
recorded-audio path from there, with its chunking, its silence skipping, its
per-chunk context and its transient retries.

Four rules travel with it.

- **Streaming, always.** Decode, downmix, resample and gain run packet by
  packet through a bounded ring, and the peak needed for gain comes from a
  first streaming pass over the decoded output rather than from a `Vec` of
  every sample. Memory is a function of the packet size, never of the file's
  duration. `normalize_wav_for_transcription` was rewritten the same way in
  the same change: it used to `collect()` an entire recording into a `Vec<i16>`
  before deciding it had nothing to do, which was already a latent ceiling on
  long meetings.
- **A decoder, not a player.** This module exists to feed transcription, and it
  lives under `audio/` next to capture and turn detection because that is what
  it is. It exposes no seeking, no playback, no user-facing format conversion
  and no video path — a video file is an audio track the app reads and a
  container it skips.
- **Fall back, never fail silently.** What Symphonia cannot decode still takes
  the pre-existing whole-file route, which remains correct under the size
  limit. Past it, the user gets a named error that says which file and what to
  do, not a byte count.
- **Larger chunks for imported media.** The 30-second chunk exists because a
  *turn* is short. A prepared import is one continuous source, and the request
  ceiling allows ten minutes of 16 kHz mono per call, so the import path passes
  its own `max_chunk_ms`. A two-hour lecture becomes twelve requests instead of
  two hundred and forty, with more context in each. The turn path is untouched.

## Consequences

- The 25 MB ceiling disappears for every format Symphonia reads: MP4/M4A/MOV,
  MKV/WebM, OGG, WAV, MP3, FLAC, AAC-LC, ALAC, Vorbis, PCM. Duration is bounded
  by patience and credits, not by memory.
- Imports get **cheaper**, not more expensive. They gain the silence skipping
  the recorded path already had, so a lecture with a ten-minute silent tail
  stops paying for it.
- One implementation serves macOS, Windows and iOS. There is no
  `#[cfg(desktop)]` in this module, and that is the point.
- **Opus and HE-AAC are not implemented by Symphonia**, and Opus is YouTube's
  default audio codec. This is stated rather than hidden: the extractor path
  asks for M4A when it can choose, and an undecodable file says so by name. If
  the gap ever justifies a C dependency, `libopus` is BSD-3 and additive — a
  later decision, not this one.
- Symphonia is MPL-2.0: file-level copyleft, satisfied by using it unmodified
  and declaring it. `THIRD_PARTY_NOTICES.md` gains an entry.
- The app now opens arbitrary user-supplied media in-process. Symphonia is
  100% safe Rust with no `unsafe`, which is most of why it was chosen over
  binding a C decoder; a malformed file becomes a decode error, not a memory
  bug.
