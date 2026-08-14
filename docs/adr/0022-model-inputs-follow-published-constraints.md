---
status: accepted
date: 2026-08-14
---

# Which inputs a media model accepts comes from its published constraints, not its id

## Context

Studio decides what a video form offers by reading the model id. `isSeedanceModel`
matches on the substring `seedance`, `isReferenceToVideoModel` on
`reference-to-video`, and `supportsReferenceMedia` was the conjunction of the two:
if an id said seedance and said reference, the surface offered a reference-clip
slot, and the request builder filled `reference_video_urls` from it.

That rule was written from Venice's Seedance guide, which describes four
prompt-routed workflows (reference, edit a clip, extend a clip, stitch clips).
Three of the four need a clip. The guide does not say which *models* have them.

The operator publishes that, and it says something else. Every seedance variant
Carpe Diem exposes under a `-basic` id — the public tier, and the only tier that
exists at all for seedance 2.0 Mini and seedance 2.5 — declares:

```json
{ "video_input": false, "audio_input": true }
```

So the studio was offering a clip slot on models that refuse video input, on the
strength of a guide written about their siblings. The failure mode is the
expensive kind: the prompt is what routes a seedance render, so an
`Extend <Video 1>` request whose clips the provider ignores or refuses does not
come back as a validation error the user can act on. It runs, or it fails after
being queued, and either way it is billed. Symmetrically, `audio_input: true`
was published on exactly those variants and no surface had ever offered it —
`reference_audio_urls` existed in the request builder with nothing able to fill
it.

The same reading-by-id also reaches places that never see the catalog: the
workflow editor validates a port's capacity from the model *id* held in the
node's params, with no `MediaModel` in hand.

## Decision

**What a model accepts is answered from its published constraints first, and
from its id only where nothing is published.**

Concretely, in `src/lib/studio/seedance.ts`:

- `takesReferenceClips(model)` reads `constraints.video_input`;
  `takesReferenceAudio(model)` reads `constraints.audio_input`. A boolean is an
  answer **in both directions** — a model that says no is refused a slot even
  when its id looks the part, and a model that says yes gets one even when its
  id does not.
- An **absent** flag means "nobody said", not "no". The full (non-`-basic`)
  seedance ids publish only their three option lists, so the id decides for
  them, exactly as before.
- The id-based fallback is itself sharpened with what we measured: a `-basic`
  reference variant takes no clips. That keeps the workflow port correct where
  only an id is available, without giving that surface catalog access.
- `supportsReferenceMedia` is gone. It conflated two capabilities the catalog
  distinguishes, and one cap (`maxReferenceVideos`) was gating both — so a model
  with no clips also silently accepted no audio.
- `isSeedanceReferenceModel` keeps what genuinely is an id question: the *prompt*
  contract (canonical `<Image 1>` mentions, the four workflow openings) applies
  to every seedance reference variant whatever media it accepts.

`videoRequestBody` enforces the same rule at the boundary: both caps are zero on
a model that declares no such input, so an input a surface should not have
offered is dropped there rather than queued and refused.

## Consequences

- The desktop's "Reference clips" slot disappears on every `-basic` reference
  variant, which is most of them. `seedanceWorkflowsFor` withholds the three
  clip-driven prompt openings from those models, leaving `Refer to...`.
- Reference audio is offered on both shells for the first time, and rides with a
  photo or a clip (never alone, which the contract forbids).
- Clips picked before a family switch are cleared when the new family cannot take
  them, rather than being dropped silently at submit after the prompt had been
  written around `<Video 1>`.
- New backend models are handled without a code change whenever they publish
  their flags, which is the point: the previous rule needed an id pattern per
  family and got the tier wrong on the family it was written for.
- A model that publishes nothing still depends on an id heuristic. That is a
  guess, and it is marked as one in the code; the honest alternative — offering
  nothing until the operator publishes — would remove working inputs from the
  full tier.

## Alternatives considered

**Keep reading the id and add `-basic` to the pattern.** Cheaper, and it would
have fixed today's catalog. It also keeps the shape that produced the bug: a
guide about one tier encoded as a rule about all of them, re-broken by the next
family whose ids do not spell out what they take. The operator publishes the
answer; asking it is strictly better than modelling it.

**Trust the constraints alone and offer nothing when they are absent.** Simpler
to state, and it silently removes reference clips from the full seedance
variants, which do take them and publish no flags either way. Absent is not
false.

**Probe the endpoint once and cache what it says**, the way
`model-constraints.ts` learns from rejections. Reasonable, and the existing
learn-from-a-rejection path still applies on top of this. But a probe for
"does this take a clip" is a billed render; the operator already publishes the
answer for free.
