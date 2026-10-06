---
status: accepted
date: 2026-10-06
---

# An audio model is filed by what it does, not by its endpoint

## Context

Venice serves audio on two endpoints, and the catalog type names the endpoint:
`tts` models answer `/audio/speech` in one call, `music` models are queued on
`/audio/queue` (Carpe Diem: `/audio/music/queue`) and retrieved later. The
`music` type is not a description. It also carries the sound-effect engines,
and since 2026-09 the speaking models ElevenLabs TTS v3 and v4, v4 Turbo and
Multilingual v2, and Seed Audio: they publish voices, take a text as their
prompt and read it aloud. The four ElevenLabs ones were missing from Sub Rosa
because the operator had removed them after its own site sent them to the
wrong endpoint (Lumen-labs-ch/Carpe-diem-#312). They are listed again from
#450.

Two things in the studio were wrong in the same way. It filed every model by
its catalog type, so a speaking model would have landed in the music picker
(Seed Audio already had). And it decided what a music request may carry from
a hand-written table matched on id substrings, which contradicted what the
models publish on six points: MiniMax 2.5 and 2.6 were refused an
instrumental take, ACE-Step was sent the `force_instrumental` it refuses with
a 400, Sonilo and Seed Audio were offered lyrics, and three length ranges
were wrong. Venice publishes all of it as flat `model_spec` fields, and the
operator gathers it into `constraints` since 2026-08-24.

The alternatives were to keep filing by type and let the speech surface also
read the music list, to ask the operator for a new type, or to file by role.

## Decision

1. **An audio model's role (speech, music or effects) is read from what it
   publishes.** `audioRole` in `src/lib/studio/catalog.ts`: a `tts` model
   speaks; a `music` model that publishes voices and takes neither lyrics nor
   a length speaks too; one that offers a loop, or is known by id as an
   effects engine, makes effects; the rest make music. Every picker, the
   workflow nodes (`audioRoles` on a model param) and the film read the role.
2. **The rail is a property of the model, separate from its role.**
   `speechRail` says whether a speaking model is reached on `/audio/speech`
   or on the queue. The queue is a durable job (ADR-0018) wherever it is used.
3. **What a queue model accepts is read from its published limits first.**
   `musicCapabilities` and its Rust mirror in `assistants/media_settings.rs`
   read `supports_lyrics`, `lyrics_required`, `supports_force_instrumental`,
   `supports_lyrics_optimizer`, `supports_loop`, the length list or range and
   the text limits. `model-input-rules.json` only answers for a model that
   publishes nothing, and was corrected to agree with the publications.
   `musicQueueBody` builds the request once for every caller and sends a key
   only when the model accepts it, because Venice refuses an unknown key even
   when its value is a no-op.
4. The Rust catalog merge reads a music model's limits from the flat
   `model_spec` on the Venice-direct path, and lifts the voices of a speaking
   queue model out of its constraints, so both backends describe the same
   model the same way.

## Consequences

- The four ElevenLabs voices and Seed Audio appear with the voices, beside
  the `tts` models, and not in the music picker. Nothing in the studio names
  a model id to decide a role, except the effects engines that publish no
  loop.
- A model Venice adds to the queue is filed and driven correctly from its
  first day, provided it publishes its limits, without a release.
- ElevenLabs Music can now be asked for an instrumental take (it publishes
  the flag, and the old table hid the switch because it takes no lyrics);
  the film's score asks for one whenever a cue has no words.
- The film's default score engine is now the one that publishes the longest
  length, as its documentation always said: it read a video field before and
  picked the first model by name.
- The fallback table is still a guess for an unpublished model. Its default
  for an unknown model no longer offers an instrumental switch, which is the
  one key that costs a 400 when wrong.
