---
status: accepted
date: 2026-08-24
---

# The mix is rendered offline, in Web Audio

## Context

A film's sound was one background track at a fixed level under whatever the
clips happened to carry, summed live while a MediaRecorder captured the canvas.

That is a monitor path, not a mix. The levels drift with the machine's load, so
the result differs every run. There is nowhere to put a line of dialogue. And
nothing can get out of the way of anything else.

The obvious fix is the one every other tool uses: ffmpeg, with `amix`, `volume`
automation and a loudness filter. This app has declined to ship ffmpeg three
times, for reasons that have not changed.

## Decision

**Everything audible is rendered offline into one buffer, and the recording
plays that buffer.** `OfflineAudioContext`, faster than real time, before
anything is captured.

Three things follow, and they are the point.

**It is deterministic.** The same cut mixes to the same samples. A level the
user set is the level they get, every time.

**It can be measured.** Programme loudness needs the whole programme, which is
impossible while it is being played. `loudness.ts` implements ITU-R BS.1770 as
plain arithmetic over sample arrays rather than as an audio graph - the
K-weighting is two biquads and the gating is two passes - which means it can be
tested against the standard's own reference signal instead of only in a
browser. The coefficients are derived for the actual sample rate rather than
copied from the 48 kHz table: a 44.1 kHz mix measured with 48 kHz coefficients
reads about a decibel off, which is exactly the size of error nobody notices
and everybody inherits.

**Ducking becomes automation rather than detection.** The dialogue windows are
known before anything sounds, so the music is written down under them at
exactly the right instants. A sidechain compressor listening to the dialogue
bus also hears the music leaking through the mix and ducks against itself, and
its timing depends on a detector's attack rather than on where the line
actually is. Two lines a fifth of a second apart make one dip here, instead of
the music pumping between them - which is the single most recognisable sign of
an automatic mix.

This is not a cheaper substitute for the ffmpeg version. On the two things that
matter - reproducibility and the accuracy of the ducking - it is better.

## Consequences

- The planning is pure and fully tested; the renderer is a thin walk over the
  plan, and is the only part that needs a browser to run.
- The picture is still real time, because MediaRecorder is still what captures
  the canvas. Only the sound stopped being.
- Callers that ask for neither lanes nor a loudness target keep the old live
  path exactly, so nothing that existed changed behaviour silently.
- A clip whose audio the webview cannot decode contributes silence, and is not
  reported: a clip with no audio track fails the same way, and warning about
  every silent shot would train the user to ignore the warning that matters.
