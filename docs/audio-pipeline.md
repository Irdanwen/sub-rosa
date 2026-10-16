# Audio pipeline — capture to note

How June records meeting audio, separates sources, detects conversation turns,
and transcribes into a note. It is **saved-audio-first**: the local WAV is the
source of truth, provider speed is secondary. See
[ADR-0005](adr/0005-source-separated-audio-capture.md) (one WAV per source),
[ADR-0004](adr/0004-out-of-process-system-audio-helper.md) (system-audio
helper), [ADR-0113](adr/0113-windows-captures-the-computers-sound-in-process.md)
(the three source modes and Windows loopback), and
[ADR-0002](adr/0002-live-transcript-preview-strategy.md) (live preview).

## Data flow

1. **`start_recording`** → `capture::start_capture` opens the lanes the source
   mode asks for: the microphone (`MicrophoneLane`, a CPAL input stream writing
   `microphone.partial.wav`) unless the mode is `SystemOnly`, and the computer
   (`audio::system::SystemAudioCapture` writing `system.partial.wav`: the macOS
   helper, or WASAPI loopback on Windows) unless it is `MicrophoneOnly`. The
   session row points at the primary lane: the microphone when it records, else
   the computer.
2. Per input callback: write 16-bit PCM, update `CaptureStats`, and
   non-blockingly feed the **live preview** sink (a bounded channel) — a worker
   transcribes ~8s chunks and emits ephemeral `live-transcript-event`s that are
   **never persisted**.
3. **`finish_recording`** finalizes the writer, atomically renames
   `*.partial.wav` → `*.wav` (the durability commit), stops the helper, cancels
   preview.
4. **`process_saved_source_audio`** (`src-tauri/src/domain/processing.rs`) runs
   the batch pipeline: `partition_silent_system_sources` (a computer-only take
   whose only lane is silent fails here with `system_audio_silent`, before any
   paid call) → `turns::detect_turns` →
   `coalesce_turns_for_transcription` → `write_turn_wav` (seek-extract each turn)
   → `normalize_wav_for_transcription` → `split_wav_for_transcription` (≤8-min
   chunks) → `transcribe_saved_audio` (POST `/v1/notes/transcribe`, provider
   routing is server-side) → persist per-source transcript rows → **note
   generation**.

## Key files

- `src-tauri/src/audio/capture.rs` — the optional microphone lane
  (`MicrophoneLane`), `CaptureStats`, the per-lane status and warnings (a
  computer never heard after 20 s raises `system_audio_silent`), the single
  global `ACTIVE_RECORDING` (one recorder at a time).
- `src-tauri/src/audio/readiness.rs` — which sources a mode requires and the
  system-audio permission probe.
- `src-tauri/src/audio/system.rs` — the one surface over both computer-sound
  backends (`SystemAudioCapture`, `SystemLaneStatus`, readiness, probe).
- `src-tauri/src/audio/system_macos.rs` + `native/mac-system-audio-recorder/
  main.swift` — the macOS system-audio helper and its readiness/permission
  probes.
- `src-tauri/src/audio/system_windows.rs` + `system_timeline.rs` — Windows
  loopback and the silence padding that keeps its lane on the wall clock.
- `src-tauri/src/audio/turns.rs` — turn detection, coalescing, WAV extraction,
  normalization, chunking, per-source configs.
- `src-tauri/src/audio/live_preview.rs` — mic/system preview workers, the
  `WavTailReader` that tails the helper's growing WAV.
- `src-tauri/src/audio/{validation,recovery}.rs` — artifact validation and
  crash recovery.

Tauri commands: `start_recording`, `pause_recording`, `resume_recording`,
`get_recording_status`, `finish_recording`, `check_recording_source_readiness`,
`recover_recording`, `get_microphone_permission_state`.

## System-audio helper IPC contract

The helper is controlled and observed out-of-process (see ADR-0004):

- **Control:** Unix signals — `SIGUSR1` / `SIGUSR2` = pause / resume,
  `SIGTERM` / `SIGKILL` = stop. Launched via `/usr/bin/open -n`.
- **Observation:** a `status.json` file with events `ready` / `level` / `error`
  / `stopped` (fields include `level` / `maxLevel` / `message`).
- **CLI:** `--output` / `--status` / `--pid` / `--log`.
- **Timeouts:** ~30s readiness, ~75s probe. **macOS 14.2+** required for
  CoreAudio process taps; older systems get microphone-only.

## Windows loopback

The computer's sound on Windows is captured in process (see ADR-0113):

- **Capture:** cpal builds an input stream on the default output device,
  which WASAPI opens as loopback. A dedicated worker thread owns the stream;
  the audio callback only queues packets.
- **Format:** the lane is always 16-bit mono at 48 kHz (`to_mono` and the
  streaming `Resampler` from `voice/resample.rs`), whatever the device mixes.
- **Clock:** loopback is silent while nothing plays, so the worker pads to the
  wall clock: a gap over 80 ms before a packet, or no packet for 200 ms (padded
  up to now minus 100 ms), and up to now before a pause and at the end.
- **Devices:** the default output's name is checked every second; a change or a
  stream error rebuilds the stream on the new device.
- **Level:** `min(1, rms * 4)` over 80 ms windows, the helper's scale, plus the
  maximum seen, which the never-heard warning reads.
- **Readiness:** ready when a default output device exists; there is no
  permission to probe.

## Turn detection

Energy-based, per-source, **no diarization**:

- 30 ms RMS windows; the activity threshold is the ~20th-percentile window
  energy times a per-source `noise_multiplier` (separates speech from
  background).
- Hysteresis: `start_active_ms` / `end_silence_ms` / `min_turn_ms` /
  `merge_gap_ms`, with separate microphone vs system config tables
  (`config_for_source`).
- Turns are ordered purely by `start_ms` / `turn_index`.
- **Speaker-echo trimming:** because the two sources are not captured through a
  single mixer, a remote participant's voice bleeding from the speakers into the
  mic can raise a false microphone turn. The detector trims the system-dominated
  spans out of a mic turn (keeping the genuine remainder) rather than dropping
  the whole turn, so a user's reply that merged with an echo survives.

## Normalization and chunking

Before transcription each turn WAV is downmixed to **mono**, resampled to
**16 kHz**, and gain-adjusted toward a target peak (bounded, with a
reuse-original shortcut when already loud enough), then split into **≤8-minute**
chunks with rolling context.

## Recovery

`scan_recoverable_recordings` reads `recording_sessions` + `audio_artifacts`.
The governing rule: **bytes on disk win over DB status** — the mic WAV is
flushed periodically and the finalized filename only appears after a clean
finalize, so a crash leaves replayable audio that recovery can finish
processing.
