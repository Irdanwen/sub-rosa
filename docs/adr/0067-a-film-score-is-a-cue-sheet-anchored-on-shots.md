---
status: accepted
date: 2026-09-29
---

# A film's score is a cue sheet anchored on shots, timed by the app

## Context

A film project could tick "generate a musical score". What that produced was
one music node whose prompt was "Score for <project name>.", with no length, no
reading of the script, and a model picked from a list that included the
sound-effect engines. With no length the music model's price was often
unpublished, which blocked the whole production's quote. And because a project
production drops the assembly node, the score was never mixed into anything: it
landed in Media, unplaced.

The owner asked for the music to be taken from the script the way the bible is,
and to be made the way shots are. Films are scored in two ways, and both were
asked for: one piece under the whole film, or a cue sheet that spots music where
the drama turns and leaves silence elsewhere.

## Decision

**The unit is the cue, and a cue is anchored on shots.** A project's `score` is
a mode (`single` or `cues`), a musical identity every cue shares (genre,
instruments, tempo range, colour) and a list of cues. A cue names the first and
last shot it plays under, by shot id, with a mood, an intensity, an English
prompt for the music model, and takes like a shot has. A single score is the
same structure with one cue that always spans the whole film (`projectScore`
repairs it, under the stable id `whole-film`).

**The app owns the clock** (the ADR-0027 rule). A cue's length is the sum of the
seconds its shots render for (`resolveShotDuration`, the same resolution the
compiler sends) plus a two-second release. The music model is asked for that
length snapped to its published range and step (`musicLength`); a model that
takes no length is asked for none. The language model that reads the script
answers in shot numbers, never in seconds, and the app clamps, orders and
de-overlaps what it returns.

**Reading is proposed, never applied** (ADR-0038). `score_propose` is one
transient completion in `src-tauri/src/score/`, fork-side, with its own
`SCORE_PROMPT_VERSION`. The proposal is shown; Accept writes it into the
project. A take already made stays with a cue whose span did not move.

**A cue compiles to its own music node**, `score-<cue id>`, which `nodeTarget`
reads back to attach the take. The node follows the measured music rules
(`model-input-rules.json`): lyrics only for a model that sings, "instrumental"
only told to a model that could sing, and a clear refusal when a model requires
lyrics and a cue has none.

## Consequences

- **Moving or retiming a shot moves its music.** A cue whose anchor shot is
  removed asks to be placed again instead of silently covering other shots.
- **A cue's length is an estimate until the takes exist.** Shots render at the
  resolved length, but a model may write a longer piece (a 60 s minimum on some):
  the montage places the cue at its first shot and trims what runs past its
  last. Placement and ducking under dialogue are the montage's job.
- **Legacy projects keep their single piece.** A project that only ticked the
  box and has no `score` compiles the old single node, now with a real music
  model.
- **Two prompts own the music**: `score/prompts.rs` (spotting a script) and
  `studio_ai::prompts::MUSIC_PROMPT_TASK` (rewriting one cue's prompt against
  its length and what is on screen under it).

## Alternatives rejected

- **Cues anchored on seconds.** Rejected: a shot's length is resolved late, from
  the model it renders with, and every retime would strand the music.
- **Letting the language model time the cues.** It cannot know a catalogue's
  durations, and a guessed time is billed. It answers in shot numbers.
- **One long piece cut to the scenes afterwards.** Cheaper, but a cut in the
  middle of a phrase is heard, and it cannot follow a change of mood. It remains
  available as the single mode, played whole.
- **Adding the reading to the shot-list reader.** Rejected: it would rerun a
  paid, durable reading to get music, and existing projects could not get a
  score without re-reading their shots.
