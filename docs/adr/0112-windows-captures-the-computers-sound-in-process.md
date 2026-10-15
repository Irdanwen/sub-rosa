# ADR-0112: Windows captures the computer's sound in process, and a note can record it alone

Date: 2026-10-14. Status: accepted. Builds on
[ADR-0004](0004-out-of-process-system-audio-helper.md) (the macOS helper),
[ADR-0005](0005-source-separated-audio-capture.md) (one WAV per source,
joined as turns) and [ADR-0018](0018-ios-background-work-is-durable-rows.md).
Design notes: [plan-sources-enregistrement-2026-10-14.md](../plan-sources-enregistrement-2026-10-14.md).

## Context

A note recorded the microphone, and on macOS 14.2 and later the computer's
sound as well, through the helper of ADR-0004. Three things kept that from
covering an online meeting:

- **Windows had nothing.** `system_audio_readiness` answered
  `unsupported` and the option was hidden, although the app is published
  there.
- **The microphone was always open.** Someone listening to a webinar
  recorded their room, and the OS microphone indicator stayed on.
- **The choice could not be relied on.** One switch, hidden behind a
  chevron, forgotten at every launch, and a start that quietly dropped the
  computer when it was not ready. The worst possible failure, learning after
  the call that the other participants were never recorded, was the silent
  default.

## Decision

1. **Three source modes, named by situation.** `MicrophonePlusSystem`
   ("Microphone and computer", for a call), `MicrophoneOnly` ("Microphone
   only", for a meeting in the room) and the new `SystemOnly` ("Computer
   only", for a webinar or a video). In `SystemOnly` the microphone lane is
   never opened (`capture.rs`: `ActiveRecording.microphone` is an
   `Option<MicrophoneLane>`). The session row describes the mode's
   `primary_source`, the computer's file when there is no microphone. The
   database value is `system_only`; no migration, because `source_mode`
   has no CHECK constraint, and an older app reads the unknown value as
   microphone only.
2. **The choice is the person's and it is remembered**
   (`os-june:recording-source-mode`, `src/lib/recording-source-mode.ts`).
   It defaults to "Microphone and computer", which supersedes FR-002 of spec
   002 (see its addendum). Readiness never rewrites the choice. Each start
   resolves it (`resolveRecordingStart`). "Microphone and computer"
   degrades to the microphone, and the recorder says so for the whole take.
   "Computer only" never degrades: it refuses to start rather than open the
   microphone of someone who chose not to be heard. A call detected on macOS
   always starts as "Microphone and computer".
3. **On Windows the computer's sound is captured in process with WASAPI
   loopback through cpal** (`audio/system_windows.rs`). macOS keeps the
   helper. Both sit behind one surface, `audio::system`, with the same
   status shape (`SystemLaneStatus`) and the same level scale
   (`min(1, rms * 4)`), so the recorder, the thresholds and the live
   preview read both the same way.
4. **The Windows lane keeps the wall clock.** Loopback delivers nothing
   while nothing plays, so a file written from its packets alone would be
   short, and every turn after a silence would land early against the
   microphone (ADR-0005). The worker pads silence by the rule the macOS
   helper applies (`audio/system_timeline.rs`, pure and tested on any
   host). It writes a fixed format (16-bit mono, 48 kHz) and rebuilds the
   stream on the new default output device when it changes mid-take.
5. **Silence is decided before money.** A computer lane that was never heard
   raises `system_audio_silent` during the take (the recorder's warning,
   which the person may dismiss). A computer-only take whose only lane is
   silent fails before transcription with a sentence that says why,
   instead of paying to transcribe silence and reporting "no speech".

## Why in process on Windows, when macOS went out of process

ADR-0004 isolated the macOS capture for reasons that do not exist on
Windows:

- **No permission to isolate.** macOS ties process taps to their own TCC
  grant and signing context. Windows asks no permission for loopback.
- **No new dependency.** cpal is already linked for the microphone, and it
  opens loopback when an input stream is built on an output device.
- **No second binary.** A helper `.exe` would need its own IPC, its own
  packaging, and signing in an NSIS pipeline that does not sign today.

## Considered options

- **A helper `.exe` mirroring macOS.** Rejected for the reasons above.
- **Process loopback** (`ActivateAudioInterfaceAsync` with
  `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 2004 and
  later). Deferred. It would capture one application, or exclude Sub Rosa's
  own sounds, at the cost of raw COM code. Recording one application can
  also lose a call silently when the audio comes from a helper process
  (browsers, the new Teams), the very failure this ADR removes.
- **A virtual audio driver.** Rejected: an install, administrator rights and
  driver signing, for a capture the OS already offers.
- **Opening the microphone in "computer only" and discarding it.** Rejected:
  the OS indicator would still say the person is being recorded, and the
  only promise of that mode is that they are not.

## Consequences

- Rust owns the Windows lane's timeline: the padding rule and the device
  rebuild live in this repository, not in a helper.
- Only the default output device for the console role is captured. A call
  app playing to another device (the communications role, a second output),
  exclusive-mode streams and DRM-protected content arrive silent. The
  never-heard warning is the guard.
- Windows shows no OS indicator for loopback capture. The recorder's
  computer lane is the only sign that it runs.
- A native audio driver crash now shares the app's process on Windows, as
  the microphone already did.
- Sub Rosa's own sounds (the start chime) are part of the computer lane on
  both platforms.
- `capture.rs`, `commands.rs` and `processing.rs` are upstream files the
  fork changes further: see FORK_NOTES.md.
- Only real hardware verifies the Windows lane: long silences, device
  changes (speakers to a USB headset, a Bluetooth headset switching to
  hands-free), 44.1 and 96 kHz and 5.1 outputs, sleep and resume.
