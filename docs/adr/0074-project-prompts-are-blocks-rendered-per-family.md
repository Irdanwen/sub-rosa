---
status: accepted
date: 2026-10-05
---

# A project's prompts are blocks, rendered per family

## Context

The film project's shot prompts were one sentence built to sixty words for
every model: the subject, the action, the invariant traits, then the camera
as free text, dropped first when the budget was tight. Nothing said the
film's genre, mood, look or light; nothing described the sound; nothing
forbade what a shot risked; a reference image had no role beyond "Refer to
<Image 1> for Léa"; every line was voiced by TTS; and the AI rewrite was told
to write in English, never to quote a line, never to write a duration, and to
cut long takes into beats with "Lens switch.".

The person's prompt bible (a guide to filling a nine-block template, with
vocabularies, model syntaxes, recipes and pitfalls) asks for the opposite on
almost every point, and asked for the whole project tool to follow it. Five
questions had real alternatives.

1. Where does the template live, and how do the TypeScript composer and the
   Rust rewrite and reader agree on it?
2. How does one template fit families that take sixty words and families that
   take two hundred, that read labels or not, that take a time range or cut
   on one?
3. Who speaks a line?
4. What do the bible's multi-shot prompts and transitions become, when one
   project shot is one generation?
5. What does the bible's own syntax change in what the app already verified?

## Decision

1. **Blocks are data, written once.** `src/lib/studio/direction/vocabulary.json`
   holds every choice with the exact English a model reads; `profiles.json`
   holds each family's budget, labels, timing, sound and languages. Both are
   read by the webview and by Rust (`include_str!`). Labels a person reads are
   literal `t()` calls in `labels.ts`. One composer
   (`src/lib/studio/prompt/compose.ts`) writes every project shot's prompt;
   the old sixty-word `shotPrompt`, `joinBeats` and "Lens switch." are gone.
2. **One plan, rendered per family.** The composer builds the bible's blocks,
   then renders them with labels or in prose, to the family's budget. Over
   budget, it drops the sound, then the place's long descriptor (its image
   or the frame shows it), secondary descriptors, optional negatives, lens
   details, then the mood, one part at a time from the end. It never drops a
   reference's role sentence, the subject, the framing, the movement, the
   action or a spoken line, and it reports any overflow rather than hiding it.
   The film's genre, mood and style are written in the same words on every
   shot of a family: their wording depends on the film and the family, never
   on one shot's budget pressure.
3. **A line is native only where the model speaks it.** It goes in the prompt
   with the family's syntax when the model renders sound (the catalog's flag,
   else the profile) and its family speaks the line's language (MiniMax H3:
   French and English; the others English at most). Otherwise it is dubbed:
   the prompt shows the speaker speaking without quoting it, the render is
   silenced with `audio: false` where the model has the switch (measured on
   `/video/quote` 2026-10-05), and the montage mutes the take otherwise. A
   native line skips the TTS node, rides with the speaker's bible voice as
   reference audio where the model takes one, and dips the music like a
   dubbed line does.
4. **One project shot is one continuous take.** The bible's multi-shot
   generations are not used: the montage owns the cuts (ADR-0061). A shot's
   transition becomes a fade in the montage, never words in the prompt. The
   app writes the duration it resolved into [OVERALL]; the reader still never
   chooses one.
5. **What was verified stays.** Seedance keeps `<Image 1>` (verified on the
   Venice route the app uses; the bible's `@Image1` is ByteDance's direct
   access), and its reference prompt opens with "Refer to", because that
   opening routes the request. Kling keeps `@Element1`, gets one sentence per
   element with its roles merged, and never gets a number. Wan and MiniMax
   take "Image 1" as the bible writes it.

The reader (`shotlist-v4`) returns vocabulary ids, the frozen descriptor and a
proposed direction the person accepts; the rewrite (`studio-rewrite-v4`)
improves the composed prompt and keeps its blocks.

## Alternatives rejected

- **The template as a prompt to the language model only.** Every render's
  prompt would depend on a rewrite the person may never run, and nothing
  would guarantee the style is the same on every shot.
- **Labels everywhere, as the bible's example writes them.** They cost words
  a sixty-word family does not have, and a Seedance reference prompt must open
  with "Refer to", not "[OVERALL]".
- **Always native dialogue.** A model that does not speak the line's
  language reads French as English; a take costs more than a voice.
- **Multi-shot generations.** They hide cuts from the montage, its fades and
  its export, and one bad shot would cost the whole generation again.
- **The bible's `@Image1` for Seedance.** Unverified on the route the app
  uses, where `<Image 1>` is the documented and measured mention.

## Consequences

- Budgets marked `budgetMeasured: false` (Seedance 2.5, Wan 3, MiniMax H3, 200
  words, the length of the bible's own example) are starting values, to be
  measured on real renders.
- Takes stay current across the change: the composer's version is never part
  of a take's signature; the film direction is, once set.
- A prompt the AI wrote with the previous method says so and can go back to
  the composed prompt; a prompt written by hand is never touched.
- A breakdown interrupted by the update says the reader changed instead of
  blaming the script, and readings made before still land, their free camera
  note read for ids.
