---
status: accepted
date: 2026-08-24
---

# The timeline export is the finishing path; the recorder is a preview

## Context

The app assembles a film by playing trimmed clips onto a canvas and recording
the result with MediaRecorder. That exists because of a decision this app keeps
making: no ffmpeg to bundle, notarize or license (see the header of
`src/lib/studio/assemble.ts` and
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md)).

It is a real ceiling, and it is three ceilings at once. It re-encodes, so the
master is a generation worse than the renders that went into it. It runs in
real time, so a ten-minute film takes ten minutes to export. And it flattens
everything into one track, so there is nothing left to balance afterwards.

Until now the answer to "I want to grade this" or "the music is too loud under
the second line" was: render it again.

## Decision

**The cut is also written as an interchange file, and that is the finishing
path.** FCPXML 1.10 (Final Cut and Resolve), Premiere xmeml v5, and a SubRip
sidecar instead of a burn-in. Nothing is re-encoded, it is instant, and the
grade, the transitions and the fine mix happen in a tool built for them.

It is written as a **self-contained bundle**: a folder with the document and a
copy of every clip in `media/`, referenced relatively. Two reasons, and the
second is decisive. A timeline pointing back into the gallery breaks the first
time the user tidies up and cannot be handed to anybody. And the app refuses to
overwrite an earlier export, so the final folder name is not known when the
document is generated - a relative reference is the only one that can be
correct.

Three invariants decide whether such a file opens at all, and each has a test:

- Every time is a rational on the timeline's own denominator, and 29.97 is
  written `1001/30000`, never `29.97` - the difference is a second of drift an
  hour.
- The spine accumulates in whole frames, not floating seconds.
- A connected sound is positioned in its *parent clip's* time, not the
  timeline's. Getting this wrong puts the dialogue somewhere plausible and
  wrong, which is worse than putting it nowhere.

## Alternatives considered

**Ship ffmpeg after all.** Rejected for the fourth time, and this is the
decision that makes the rejection cheap rather than merely principled: the
capability people want ffmpeg *for* is downstream of the cut, and an editor
does it better.

**An EDL.** Simpler, and universally supported, but it carries reel names and
timecodes rather than file references, which is the wrong shape for
file-based media.

**A separate "Resolve-tuned" FCPXML.** The design this borrows from ships one.
Rejected: the differences people tune for are folklore that changes with each
Resolve release, and nothing here can test the result. One conservative
document - only constructs present since 1.8 - is defensible. Two, where one is
a guess, means shipping a file we could not defend and letting the user find
out which is which.

## Consequences

- The recorder export stays, and is honest about what it is: a preview, and the
  one-click answer when nobody is going to open an editor.
- Subtitles are a sidecar rather than burned in, which costs nothing and leaves
  the look to the edit.
- Desktop only. The share sheet takes a file rather than a folder, there is no
  zip, and an interchange file is only useful beside a non-linear editor - of
  which there are none on the phone.
