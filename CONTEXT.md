# Sub Rosa

Sub Rosa is a Tauri desktop and iOS app that records meetings/dictation,
transcribes the audio, turns the transcript into structured notes, and hosts an
AI agent you can chat with over those notes. It has **no account and no hosted
service**: the user supplies a **Carpe Diem** key, the app runs **June API** as
a local sidecar pointed at it, and the **Hermes** runtime is the agent brain.

Sub Rosa is a fork of June (`open-software-network/os-june`, MIT). Where an
entry below describes upstream's hosted shape, it is marked; the fork keeps
upstream's technical identifiers deliberately
(see [ADR-0017](docs/adr/0017-product-autonomy-from-june.md)).

This document is a glossary, not a spec. Terms are canonical; the `_Avoid_`
lines are binding. Implementation, endpoints, and code shape live under
[docs/](docs/index.md).

## Language

### Platform

**Sub Rosa (the app)**:
The user-facing Tauri desktop product — the macOS `.app` users install, and
the iPhone app. The bundle identifier is `xyz.carpediem.subrosa`. Technical
identifiers stay upstream's: the binary on disk and the Cargo package are both
`os-june` (see [ADR-0017](docs/adr/0017-product-autonomy-from-june.md)).
_Avoid_: June (the upstream product this forks), notetaker, OS Notetaker.

**June API**:
The backend service that holds the upstream AI provider key and proxies the
metered AI calls (transcription, generation, agent chat, web). Lives in the
same repo under its own Cargo workspace; Cargo crates use the `june-*` prefix
and the binary is `june`. Upstream ships it as a container in a TEE; **this
fork runs it as a local sidecar** on loopback, spawned by the app and pointed
at Carpe Diem with the user's own key, so there is no hosted instance and no
metering (see [ADR-0017](docs/adr/0017-product-autonomy-from-june.md)).
_Avoid_: "the server", "the cloud" — it runs on the user's machine.
_Avoid_: backend, proxy, AI proxy (use **June API**).

**OS Accounts** (upstream only, removed here):
Upstream June's identity-and-credits platform. **Sub Rosa does not use it**:
there is no sign-in, no account, and no credits ledger of its own. The Rust
module keeps the name `os_accounts` but holds only local session state (the
sidecar bearer). Do not reintroduce the concept; spendable balance means
**Carpe Diem credits**, read from Carpe Diem.
_Avoid_: using it in new UI copy or new domain names.

**Upstream provider**:
A third-party AI service June API calls on the user's behalf — currently
**OpenAI** (transcription only) and **Venice** (transcription, generation,
agent chat, web). Upstream provider API keys live only in June API's
environment, never in June. In code, each upstream sits behind a domain trait
(`Transcriber`, `Generator`, `AgentChatCompleter`, ...) defined in
`june-domain` and implemented in `june-providers`.
_Avoid_: AI provider, model provider, vendor, "the LLM".

### Audio & recording

**Recording session**:
One note-backed capture lifecycle (a UUID) that owns its source mode,
artifacts, elapsed time, and status; the unit of recovery and retry.
_Avoid_: meeting object (June deliberately has no separate "meeting" entity).

**Source mode**:
The capture scope chosen before recording starts: `MicrophoneOnly` or
`MicrophonePlusSystem` (meeting mode).
_Avoid_: recording type.

**Source**:
A single audio lane — `Microphone` or `System` — each captured to its own
file and transcribed independently.
_Avoid_: channel (that is the WAV interleave sense), track.

**Turn**:
A detected active interval on one source (`source`, `start_ms`, `end_ms`,
`turn_index`) used to order the transcript as a back-and-forth conversation.
Detection is energy-based (RMS windows + noise floor), never diarization.
_Avoid_: segment (that is a live-preview chunk), utterance, speaker (no
speaker identity is inferred).

**Speaker bleed (echo)**:
System audio re-captured by the microphone after playing through the
loudspeakers — "speaker" is the device, never a person; no speaker identity
is inferred. Echo rejection trims bleed spans out of Microphone turns on
signal evidence (lag-aligned similarity, cancellation depth, level
dominance); the speech stays attributed to the System source, and no
downstream step may reintroduce trimmed audio.
_Avoid_: crosstalk, feedback (that is the amplification loop), AEC as the
concept name (it names the canceller mechanism, one evidence tier).

**Coalescing**:
Merging adjacent same-source turns before transcription when the gap is short
and no other source intervenes. Distinct from `merge_close_turns` (intra-turn
gap fill).
_Avoid_: merging (unqualified).

**Normalization**:
Preparing a source WAV for transcription: downmix to mono, resample to 16 kHz,
apply bounded gain toward a target peak.
_Avoid_: conversion, resampling (that is one step of it).

**Live transcript preview**:
Optional, ephemeral chunked transcription shown while recording. Revisable,
never written to `transcripts`, never the note's source of truth (see
[ADR-0002](docs/adr/0002-live-transcript-preview-strategy.md)).
_Avoid_: realtime transcription, live captions, streaming.

**Transcript coverage**:
How much of a recording's detected speech ended up in persisted, successful
note-transcription turns (`transcribed_ms` vs `detected_speech_ms`). Always
measured against detected speech spans, never wall-clock recording duration —
silence is not lost audio. Persisted per processing pass as a
`transcript_coverage` checkpoint; surfaced on the note (non-blocking) when
materially incomplete.
_Avoid_: transcript completeness, duration coverage (wall-clock framing).

**System audio helper**:
The out-of-process macOS `.app` (`june-system-audio-recorder`) that captures
system audio via CoreAudio process taps and reports over a `status.json` file
(see [ADR-0004](docs/adr/0004-out-of-process-system-audio-helper.md)).
_Avoid_: system driver, in-process capture.

### Agent runtime (Hermes)

**Automation address**:
A `subrosa://…` destination shown to the user so a Shortcut can open it.
Every destination the router understands is automatable this way — the Action
button, Siri, a scheduled shortcut — which is what App Intents would buy for
these verbs without Swift, an app group, or a provisioning change.
_Avoid_: API, integration endpoint.

**Proposed action**:
Something the assistant offers to do — a reminder, a calendar follow-up, a
line added to a note — rendered as a `subrosa:proposal` chat block. Nothing
runs without an explicit tap, and because a message is immutable the "done"
state lives in an `agent_actions` row rather than in the text that proposed
it. One confirmation surface for every kind.
_Avoid_: automation, auto-apply, agent action (unqualified).

**Moment**:
One of the two times the app speaks first: the **brief** (ten minutes before
a meeting with other people, what was last decided with them) and the
**recap** ("your note is ready", when a recording has become one). Both are
durable rows re-driven by the sweep, never timers, and both obey the rule
that silence is a feature — nothing to say means nothing is said. The brief
is off until asked for; the recap is on.
_Avoid_: reminder, alert, digest, push.

**Calendar context**:
What the day says about a note: the event it was recorded inside, when that
was scheduled, and who was invited. It lands ON a note as three nullable
columns — there is no calendar screen, no meetings list, and deliberately no
"meeting" noun in this language (ADR-0025, honouring the specs' exclusion).
A note with no event behaves exactly as every note did before this existed.
_Avoid_: meeting (as an object), event object, calendar surface.

**Destination**:
A `subrosa://…` address naming a place in the app (a note, the chat, the
dictation surface, Studio, "start recording"). One vocabulary, three ways in:
a cold-launch deep link, a link that arrives while the app runs, and the tap
on a notification — which carries its address in the notification's `extra`.
Parsed by `src/lib/destinations.ts`, built by `src-tauri/src/destinations.rs`;
an address the parser does not recognise is ignored, never guessed at.
_Avoid_: route, deep link (for the address itself), URL scheme.

**Chat block**:
A rich inline card inside an assistant reply — a fenced code block whose info
string is `subrosa:<kind>` and whose body is one versioned JSON object,
intercepted by both markdown renderers and mounted as a component (link
previews, places). The payload travels in the message text so it persists in
transcripts and `agent_messages` unchanged, and degrades to a readable code
block anywhere the parser is absent (ADR-0024).
_Avoid_: widget, embed, rich message (unqualified).

**Hermes**:
The embedded upstream (Nous Research) agent runtime June bundles, pinned to a
commit and SHA-verified. June drives it as the chat/agent brain but presents
as June, never as Hermes (an injected `SOUL.md` asserts the identity).
_Avoid_: the model, the LLM, the agent (unqualified).

**Bridge**:
The Rust layer (`src-tauri/src/hermes_bridge.rs`) that spawns, sandboxes, and
proxies to Hermes child processes and exposes them as Tauri commands.
_Avoid_: server, daemon.

**Gateway**:
The Hermes JSON-RPC-over-WebSocket endpoint and its client
(`HermesGatewayClient`) — pure transport (connect coalescing, req/resp
correlation, timeouts).
_Avoid_: control plane, API.

**Control plane**:
The typed seam (`src/lib/hermes-control-plane/`) that turns raw Hermes frames
into the total `JuneHermesEvent` union and typed outbound methods.
_Avoid_: gateway, adapter.

**Runtime mode**:
The write-access mode of a spawned Hermes process: `sandboxed` (a Seatbelt
write-jail, default) or `unrestricted`. Opt-in is per session; June keeps one
gateway per mode so an unrestricted session can't un-sandbox others.
_Avoid_: permission, profile.

**Working folder**:
The user-picked directory a session's runtime is started in (its cwd) and —
sandboxed — the one user directory the write-jail explicitly re-grants after
validation (`hermes_working_dir.rs`, ADR-0014). Chosen per new session in the
hero composer; absence means the default **workspace** under the Hermes home.
_Avoid_: project dir; workspace (that's the Hermes-home scratch area); folder
(unqualified — `folders`/projects are the session-grouping feature, no
filesystem meaning).

**Stored session id** vs **runtime session id**:
The persistent id June keys all UI and history on, versus the live process's
per-resume id. `session.create` returns both; conflating them attaches
traces/artifacts to the wrong identity.
_Avoid_: "the session id" (always say which).

**Composer**:
The ProseMirror chat input with slash commands and attachment chips.
_Avoid_: textbox.

**Slash command**:
A `/name arg` handled client-side before submit — builtin `/model` and
`/file`, plus skill slash commands. (There is no `/image` builtin on `main`;
image *generation* is an upstream Hermes tool, not a June slash command.)
_Avoid_: gateway command.

**Model capability**:
An authoritative boolean flag from the live Venice catalog `capabilities`
(`supportsFunctionCalling` → tools, `supportsVision` → image input), never
inferred from marketing `traits` (see
[ADR-0007](docs/adr/0007-model-capability-source-of-truth.md)).
_Avoid_: trait (`traits` is a separate, non-authoritative Venice field).

**Attachment**:
A file or image imported into the Hermes workspace and referenced by path;
images additionally get a structured `image.attach_bytes`.
_Avoid_: upload (unqualified).

**Process notice**:
The notification Hermes injects to wake the agent when a background process
matches a watch pattern, ends, or an async subagent reports back. The runtime
delivers it by *submitting it as a prompt*, so it persists as a `user` message
— but the user never wrote it, and the transcript renders it as a quiet
process row, never as a message bubble (`src/lib/hermes-process-notice.ts`).
_Avoid_: user message, background task (that is the work itself, not the
notification about it).

**Mention**:
A document the message points at, typed with `@` in the composer: a file or
folder in the session's **working folder**, or a note. A mention *refers* —
the agent opens the real file in place — where an **attachment** *imports* (a
copy in the workspace). It carries a path or a note id, never the document's
content.
_Avoid_: attachment (that is the copy), reference (unqualified), tag (that is
the report category chip).

**Skill / Toolset / MCP server**:
A Skill is a bundled/installed capability pack; a Toolset is a togglable tool
group; an MCP server is an external tool provider (June ships `june_context`
and `june_web`).
_Avoid_: using "tool" for all three.

**Memory (user memory)**:
A durable fact about the user stored in the local `memories` table, extracted
automatically from chats (or added manually in Settings) and injected into
future conversations on both shells (see
[ADR-0009](docs/adr/0009-local-cross-conversation-memory.md)). Distinct from
Hermes' own memory *directory* (runtime workspace files) and from note
content.
_Avoid_: history, context (unqualified), Hermes memory (that is the runtime's
folder, not this store).

### Film production (fork)

**Videomaker** (Videomaker Studio):
The first-party film-production service (`studio.furetier.com`) Sub Rosa
drives over REST to produce complete short films. Accounts are Ethereum
wallets; all generation bills the user's Carpe Diem key in **DIEM**. See
[ADR-0010](docs/adr/0010-videomaker-film-production.md).
_Avoid_: Furetier (the domain, not the product), "the film API".

**Film project**:
One Videomaker production (a slug): brief, production bible, assets,
shotlist, storyboard, shots, final cut. Purged server-side after 7 idle days.
Distinct from Studio **video generation** (single clips via Carpe Diem).
_Avoid_: video (unqualified — a film is many shots; a video is one clip).

**Run**:
Videomaker's server-side one-shot driver: it advances a film project through
every creative phase from a brief and optionally starts production under a
cost cap. Re-POSTing a run *resumes* it (state-based).
_Avoid_: job, pipeline.

**Phase gate**:
A server-enforced approval checkpoint between film phases (`concept`,
`bible`, `asset_pack`, `shotlist`, `storyboard`, `production`, `final`).
Autonomous projects skip gates but then *require* a budget ceiling.
_Avoid_: step, milestone.

**Shot** / **Take**:
A shot is one planned 4-15 s unit of the shotlist; a take is one rendered
attempt at a shot (selectable, retakeable). Selecting a take is free;
retaking spends DIEM.
_Avoid_: scene (a scene groups shots), clip.

**DIEM**:
The Carpe Diem credit unit all Videomaker costs are quoted in. Never convert
to currency in UI copy, and never confuse with OS Accounts **credits**.
_Avoid_: dollars, credits (that is OS Accounts).

**Studio wallet**:
The app-managed secp256k1 keypair that *is* the user's Videomaker account
(SIWE identity only — holds no funds, never exported, keychain-stored).
_Avoid_: crypto wallet, account key (ambiguous with the `cdm_` API key).

### Shot continuity (fork)

**Handoff frame**:
The still taken near the end of a generated clip so the next clip can start
from it: the sharpest of a few candidates sampled just before the end, never
the last frame (blurred, and a seek to `duration` reads back black). Where it
was taken is recorded, so assembly trims the parent's tail to exactly that
point. See [ADR-0019](docs/adr/0019-shot-chains-are-parent-links.md).
_Avoid_: last frame (it deliberately is not), thumbnail, poster.

**Shot chain**:
A sequence of Studio clips where each continues the previous one from its
handoff frame — how a sequence outruns a single model's clip length. Never
stored as a list: each clip records only its parent, and the chain is derived.
Distinct from a Videomaker **shotlist**, which is planned up front server-side.
_Avoid_: sequence, timeline (that is Assemble's cut list), storyboard.

**Anchor frame**:
A frame from a chain's *first* clip, sent as a reference on later shots so the
subject and lighting do not drift over generations that each only ever see
their immediate predecessor. Rides the reference-to-video contract.
_Avoid_: keyframe, style reference (too generic).

### Studio gallery (fork)

**Gallery**:
Every file the Studio produced, on disk, indexed in localStorage and reconciled
against the disk on load. It is also the exchange format between Studio
surfaces: anything produced can be pulled into any image input, and anything
worth keeping is written into it rather than held in a form's state. See
[ADR-0020](docs/adr/0020-the-gallery-is-the-studio-exchange-format.md).
_Avoid_: library, assets, media pool, uploads (nothing is uploaded); "the
gallery" is the word in the code, the desktop UI, and the mobile sheet alike.

### Studio workflows (fork)

**Port (workflow input)**:
A named, typed input on a workflow node — a video node's prompt, opening
frame, end frame, and references are four ports, not one merged stream. Media
ports are binding (an image port only takes images); text ports take anything
and degrade media to a description. Edges saved before ports existed resolve
by kind affinity. _Avoid_: slot, socket, pin.

**Closed port**:
A port the node's chosen model does not carry, so it is not drawn, refuses
connections, and makes any edge left on it an error (a reference-to-video
model has no opening frame; an image-to-video model takes no reference
photos). Expressed as a capacity of zero — one rule, read through
`openInputPorts`, which every surface must use instead of `schema.inputs`. A
port is only ever closed on a **positive** answer: an unknown model keeps all
of them. _Avoid_: hidden port, disabled input; closed is not *absent* (an
image whose ports are all closed lands nowhere rather than degrading into the
prompt), and not *empty* (an open port with nothing wired to it).

**Model direction**:
Which inputs a video model's contract is built around — text, image (a
supplied frame), reference (style/subject photos), or video (a source clip).
It decides the node's ports, and only the catalog can say it: nine of the
operator's video models name no direction in their id, five of them
image-to-video. Recorded as `modelDirection` beside the model id when it is
picked, so the validator and the engine reach the same answer without a
catalog. _Avoid_: mode, variant type; distinct from **variant**, which is the
concrete model a family resolves to in the studios.

**Node name**:
What the user calls one node, so several of a type can be told apart ("Hero
sheet" and "Street plate", not two nodes reading "Asset"). Nodes are created
*unnamed* and show their type in its place, which is what keeps "never named"
tellable; read it through `nodeLabel`, never off `label`. The name is what the
connection lists, the gate candidates and the cost breakdown all show.
_Avoid_: title, caption.

**Asset node**:
The workflow node that pulls one gallery item (image, clip, or track) into a
graph, typically fanned out to every scene that should reuse it. It reads the
gallery; it never uploads anything. _Avoid_: reference node (a *reference* is
one specific video port), import node.

**Approval gate**:
The workflow node that pauses a production until the user decides. With one
input it is a checkpoint; with several, approving picks which *candidate*
(alternative take, wired in as its own node) continues. Approvals belong to a
run, never to the saved workflow. _Avoid_: breakpoint, review step; and it is
distinct from Videomaker's server-side phase gates (`decideGate`).

**Canonical mention** (seedance):
How a seedance reference prompt names its inputs: `<Image 1>`, `<Video 1>`,
`<Audio 1>` — case-sensitive, angle brackets included. Plain prose ("image 1")
is not a mention: the model reads it as description and ignores the reference.
Distinct from **connection order**, which is what decides the number.
_Avoid_: placeholder, token, variable.

**Seedance workflow**:
Which of four jobs a seedance reference-to-video request performs — reference,
edit, extend or stitch — decided by how the *prompt opens* ("Refer to…",
"Strictly edit <Video 1>…", "Extend <Video 1>…", "<Video 1> + …"), never by a
parameter. A prompt matching none of them is misrouted, runs something else,
and still bills. Only the workflows a model can honour are offered
(`seedanceWorkflowsFor`): the three clip-driven ones need **reference clips**,
which the public tier does not take. _Avoid_: mode, operation; and distinct
from a Sub Rosa **workflow** (the node graph).

**Reference media**:
What a render *follows* rather than starts from: reference photos
(`reference_image_urls`, style and subject), reference **clips**
(`reference_video_urls`, what edit/extend/stitch work on) and reference
**audio** (`reference_audio_urls`, a timbre or a voice). Distinct from the
**opening frame**, which the clip starts on. Which of the three a model takes
comes from its published constraints (`video_input`, `audio_input`), not from
its id — see [adr/0022](docs/adr/0022-model-inputs-follow-published-constraints.md).
Audio never travels alone; it rides with a photo or a clip.
_Avoid_: input image (that is the opening frame), attachment, source clip
(that is the video-to-video input).

**Public tier** / **full tier** (of a model family):
The backends publish some families twice: a `-basic` id, which the model
catalog names and which the studio shows plainly ("Seedance 2.5"), and a
sibling without the suffix, shown as "… (full)". They are different models: the
public tier refuses media showing a recognisable person whatever the caller
attests, and takes no reference clips. Some families ship only one of the two
(seedance 2.5 is public-tier only). _Avoid_: free/paid, lite, downgraded.

**Connection order**:
The order of a multi port's inputs — assemble's cut list, a video node's
references, an image edit's sources, a gate's candidates. It IS the order of
the edges in the workflow's edge array (the order the connections were made),
shown as numbered badges and a reorderable list once a port has two inputs,
and it is what "image 1" / "image 2" mean in a prompt. _Avoid_: z-order,
index, priority.

**Captured still**:
An image the user pulls out of a generated clip and keeps: written to the
gallery as an ordinary image artifact, at the clip's native resolution, so it
exports, edits, and serves as a reference like any other. Chosen rather than
computed — the scrubber runs the whole clip and reaches the last readable
position if that is what is wanted — and it records `sourceArtifactId` /
`sourceTimeSeconds`, never a chain's parent link.
_Avoid_: handoff frame (that one is computed and feeds a render), screenshot,
thumbnail, grab.

### AI work & billing

**Dictation**:
A latency-critical June mode where the user pushes-to-talk, speaks a short
phrase, releases, and expects cleaned-up text inserted into the foreground
app within a few hundred milliseconds. Distinct from **note transcription**.
Goes through June API in v1, so the binary holds no upstream provider key.
_Avoid_: speech-to-text (too generic — covers both dictation and note
transcription).

**Note transcription**:
June records a full meeting or capture session, then transcribes the saved
audio as a single batch operation and runs **note generation** on the
transcript. Higher latency tolerance than dictation; cost typically dominates
dictation by 100×+ per call.
_Avoid_: transcription (ambiguous between dictation and note transcribe — say
which).

**Note generation**:
The step that turns a note transcription (plus any manual notes) into a
structured markdown note, currently via a Venice chat-completion call. Always
follows a successful note transcription; not used in dictation.
_Avoid_: notes generation, AI summarisation.

**Image generation**:
Producing a new image from a text **prompt** (text-to-image), via Venice. The
user reaches it two ways: an explicit `/image` command (a fast, no-model shot),
or the assistant calling it as a tool mid-conversation. Distinct from **image
editing**. See [ADR 0003](docs/adr/0003-image-generation-and-editing-tools.md).
_Avoid_: rendering, drawing (say **image generation**).

**Image editing**:
Producing a new image by transforming an *existing* image plus an instruction
(image-to-image / inpaint), via Venice's separate edit models. Always references
a prior image (a generated one, by filename); never starts from a blank canvas.
Distinct from **image generation**.
_Avoid_: img2img (jargon), regenerate (that's a fresh **image generation**).

**Credit price** (per upstream model):
The number of OS Accounts credits June charges per unit of consumed work
(audio seconds for transcription, tokens for generation) for a given upstream
model. Stored as a typed lookup keyed by `model_id`; the live Venice catalog
extends the built-in fallback each boot. An upstream model with no credit
price is rejected at the boundary before any work runs — there is no "default
rate".
_Avoid_: rate, tariff, cost (cost is the *upstream's* dollar cost to June;
credit price is what the user pays in credits).

**Hold** / **authorize**:
The pre-flight wallet reservation (`POST /authorize` to OS Accounts) that
returns an **Action token** and an optional `cap_credits`, sized by a flat
estimate. Expires by TTL if never charged.
_Avoid_: pre-charge, lock.

**Charge** / **settle**:
Debiting the wallet (`POST /charge`) for usage already incurred, keyed by a
deterministic **idempotency key** and clamped to the Hold's cap. Metering
settles only *after* the upstream call succeeds, so a retry can't double-charge.
_Avoid_: bill, deduction.

**Action token**:
The opaque token returned by authorize and consumed by charge, binding a
single operation to its cap.
_Avoid_: access token (that is the user's JWT).

**Action slug**:
The metered-operation id (e.g. `note_transcribe`, `dictate_transcribe`,
`agent_chat`, `web_search`) that scopes idempotency keys and Hold TTLs and
splits the bill in the dashboard.
_Avoid_: operation, endpoint.

### Desktop shell & updates

**Release channel**:
The updater track: `stable` (the only track on `main` today) or `rc`
(in-flight on branch `jakub/rc-channel-for-june`, PR #529).
_Avoid_: beta.

**Update manifest** (`latest.json`):
The signed JSON on the public releases repo listing per-platform artifacts and
their Ed25519 signatures; the RC variant is `latest-rc.json`.
_Avoid_: appcast.

**Releases repo**:
The separate public repo `Irdanwen/sub-rosa-releases` that hosts signed
artifacts + the update manifest, and is the only endpoint the updater reads
(see [ADR-0001](docs/adr/0001-auto-updates-via-tauri-updater.md)). Upstream
used its own; this fork publishes to its own in one stage, see the addendum on
[ADR-0003](docs/adr/0003-release-candidate-channel-and-promotion.md).
_Avoid_: "GitHub release" (unqualified).

**Provider settings / Model mode**:
The persisted choice of which model handles each `ModelMode`
(`Transcription`, `Generation`, ...), stored in `provider-settings.json`.
Venice is the default; OpenAI is used only for specific ASR models.
_Avoid_: model config (unqualified).

**Carpe Diem credits** (`CarpeDiemCreditsDto`):
The spendable balance read from Carpe Diem and shown in the sidebar footer,
with the current price factor. This is the only balance the app knows about;
the upstream `AccountStatus` snapshot is gone.
_Avoid_: account balance, profile.

**Key gate** (`CarpeDiemGate`):
The wall shown until a `cdm_` key is stored, or when the sidecar has hard
failed. It replaces upstream's sign-in and funding walls, both removed.
_Avoid_: sign-in gate, AccountGate, FundingGate (all deleted).
_Avoid_: paywall (unqualified — say which gate).

**Permission**:
A macOS TCC grant June needs — microphone, accessibility, or screen/system
audio recording. System-audio permission is probe-driven (there is no
query-only macOS API); the dictation helper is the authoritative source for
mic + accessibility state.
_Avoid_: entitlement (that is the code-signing sense).

## Flagged ambiguities

- **"proxy"** usually means **June API** (the thing in front of OpenAI /
  Venice), not a network proxy in the HTTP-CONNECT sense. Prefer **June API**.
  (June also runs a separate on-device **provider proxy** for identity
  stripping — qualify when you mean that.)
- **"transcribe"** is overloaded between **dictation** (short, latency-
  critical) and **note transcription** (long, batch). Always qualify which.
- **"credits"** always means OS Accounts credits (integers, `$1 = 1000
  credits`). Never use it for upstream provider cost (which is dollars).
- **"the session id"** is ambiguous — say **stored** (persistent, UI-facing) or
  **runtime** (live process) session id.
- **"the model"** never means Hermes — Hermes is the runtime; the model is the
  Venice-served LLM the runtime calls.
- **"channel"** is overloaded: a **Source** lane (mic/system), a **release
  channel** (stable/rc), or a WAV interleave channel. Qualify.
- **"video"** is overloaded between Studio **video generation** (one clip, one
  Carpe Diem call) and a **film project** (a full Videomaker production of many
  shots). Say which.
- **"wallet"** in fork code means the **Studio wallet** (SIWE identity for
  Videomaker), never a funds-holding crypto wallet and never the OS Accounts
  wallet.

## Example dialogue

> **Dev:** "Can I add a Whisper model to the picker?"
>
> **PM:** "Sure, but make sure it has a **credit price** before you list it,
> otherwise **June API** rejects transcribe requests for that **upstream
> model**. The picker shouldn't show models the server can't price."
>
> **Dev:** "Got it. And the credit price covers both **dictation** and **note
> transcription**, right?"
>
> **PM:** "Yes, same per-second rate for the same model regardless of which
> surface called it. The **action slug** differs (`dictate_transcribe` vs
> `note_transcribe`) so we can split the bills, but the price comes from the
> same entry."
