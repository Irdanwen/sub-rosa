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

## Addendum, 2026-08-14: the workflow canvas closes the ports a model does not have

The decision above was applied to the studios, where the user picks a *family*
and the filled-in inputs resolve the variant. The workflow node is the other
shape: it pins **one model**, so the same question has a sharper answer there,
and the editor was not asking it. A video node drew five media inputs whatever
model it held. Two of those were expensive to leave open:

- Reference photos wired onto an image-to-video model. `videoRequestBody` fills
  `reference_image_urls` for the reference direction and no other, so they were
  **dropped at submit**, after a prompt had been written around them.
- An opening frame wired onto a reference-to-video model. The operator
  documents `image_url` as image-to-video only; the render comes back having
  quietly ignored the frame, and is billed.

**A port whose capacity is zero is closed**: not drawn, not connectable, and an
error when an edge is left on it. That is one rule rather than a new predicate
— `referenceClips` already answered zero on the variants that publish
`video_input: false` — read everywhere through `openInputPorts` instead of
`schema.inputs`.

Three things make it safe rather than merely strict:

- **Nothing closes on a guess.** The direction comes from the catalog's own
  `carpe_diem_type`, and the id is only consulted when the catalog is out of
  reach. An id that vouches for no direction leaves every port open — which
  matters: nine of the operator's 101 video models carry no direction in their
  id, and five of those are image-to-video, including
  `flux-3-first-last-frame-to-video` and the two `pixverse-*-transition`
  models, whose whole point is the frames. An id-only rule would have taken the
  frames away from exactly the models that exist for them.
- **The answer travels in the params.** The picker writes `modelDirection`
  beside the model id, the way an asset node keeps `assetLabel` beside
  `artifactId`. The validator and the engine hold no catalog (this ADR noted
  that as its own compromise); carrying the answer is what lets them agree with
  the picker without one.
- **Affinity re-homes rather than breaks.** A portless edge — anything saved
  before ports existed, and everything mobile's linear editor builds — now
  resolves among the *open* ports, so an image feeding a reference model joins
  the references instead of resolving to nothing. It does **not** fall through
  to a text port: a node whose ports of that kind are all closed has nowhere
  for that media to land, and saying so is better than chaining a photo as
  "[generated image]" into a prompt.

Connections that a model change strands are let go where the user can see it,
with the port named, at both moments it can happen: picking the model, and
*opening* a workflow saved before the model was understood (an edge pinned to a
handle the node no longer draws would otherwise render as a dangling wire).
This is the same handling the video studio already gives clips on a family
switch.

The same reasoning extends to **settings**, not just inputs: a param whose
model publishes an empty option list is not shown at all (an image-to-video
model has no aspect ratio — its validator answers "This model does not support
aspect_ratio"), while a model nobody knows anything about keeps a free text
field. Empty is a statement; absent is silence.

Not settled by probing, and that is worth recording: the operator's pre-flight
(`400 VIDEO_PARAM_REJECTED`, live on `/video/queue` since this ADR was written)
enumerates every rejected **value** with its accepted list, and says nothing
about unrecognised **keys**. So a frame sent to a reference model cannot be
detected for free — which is itself the argument for closing the port.
