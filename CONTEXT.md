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

### Writing a note (fork)

**Rewrite**:
A named transformation of a passage the user has selected — correct,
reformulate, shorten, expand, restructure, translate, or a free instruction.
It is the operation, not its result. Only **restructure** may change the
markdown structure it was handed; every other kind keeps the heading levels,
the list markers and the checkbox states exactly as they were.
_Avoid_: AI action (that is a **proposed action**), AI tool (that is an agent
or MCP tool), edit (that is what the user does by typing).

**Revision**:
The replacement text a rewrite produced, while it is still only a proposal.
A revision is shown beside the passage it would replace and lands in the
document only on an explicit gesture, which is the same rule a **proposed
action** follows and for the same reason (ADR-0038). It is never stored: a
revision the user did not accept leaves no trace.
_Avoid_: suggestion (that is the editor library's menu machinery), draft,
version (that is a release).

**Selection toolbar**:
The floating controls that appear over selected text in a note body: block
style, list kind, marks, link, and the button that starts a **rewrite**. It
acts on text that is already written. On a phone it is *docked* above the
keyboard for as long as the editor has focus, because making a selection with
a thumb is the hard part and a control that only exists afterwards is a control
nobody finds.
_Avoid_: format bar, ribbon (there is no ribbon, deliberately), bubble menu.

**Note palette**:
The `/` menu in the note body, which inserts a block at the caret. Desktop
only: it is anchored to the caret, and on a phone the caret sits just above
the keyboard. Distinct from the **selection toolbar**, which acts on text that
is already written.
_Avoid_: slash command (that is the composer's, and it does other things),
block menu.

### Imports (fork)

**Import**:
A note whose audio did not come from the recorder — a file the user dropped,
picked or shared in, or media fetched from an **import link**. It becomes an
ordinary note the moment it has a transcript, and every downstream surface
(search, agent, memory, folders, export) treats it as one. The noun names the
note, never the work that made it (that is an **ingest**).
_Avoid_: upload (nothing is uploaded), source (that is an audio lane),
attachment (that is the Hermes workspace copy), media (that is Studio's).

**Import link**:
The URL an import is fetched from. Three kinds, and the difference is load
bearing: a **direct media URL**, a **feed URL** (RSS/Atom, whose enclosure is
a direct media URL), and a **platform page**, reachable only through an
extractor the user installed themselves
(see [ADR-0028](docs/adr/0028-import-links-are-fetched-never-scraped.md)).
_Avoid_: video URL (audio counts too), scraping (the app does not scrape).

**Ingest**:
The work that produces an import, and the durable row that records it:
resolve the link, fetch the bytes, decode to WAV. Everything *before*
transcription, swept like every other long-running row; once the WAV exists
the note pipeline owns the rest.
_Avoid_: download (that is one of its steps), job (that is `media_jobs`,
Studio's renders), import (that is the note it produces).

**Audio decoding**:
Reading an audio or video container in-process and emitting the 16 kHz mono
WAV transcription wants. A video file is an audio track the app reads and a
container it skips. Distinct from **normalization**, which is the gain and
rate work decoding reuses
(see [ADR-0026](docs/adr/0026-imported-media-is-decoded-in-process.md)).
_Avoid_: transcoding, conversion, extraction (that is the platform-page tool).

**Long-form summary**:
The map-reduce reading of a long transcript: a short summary, a detailed
summary, and timestamped **chapters**. Editorially the opposite of a generated
note — faithful to the material rather than filtered for decisions and owners
— and a separate row (`note_summaries`), so a note can hold both
(see [ADR-0027](docs/adr/0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)).
_Avoid_: summary (unqualified — a generated note is not one), recap (that is
the day's spoken recap), transcript summary.

**Map pass / merge pass**:
The two halves of a long-form summary: one model call per chunk, then one call
that fuses the chunk summaries into a single document. A chunk always ends on
a turn boundary and overlaps the previous one.
_Avoid_: reduce, pass (unqualified), chunking (that is the audio-splitting
sense).

**Chapter**:
A titled section of a long-form summary anchored to a real time in the
recording. The model tags it with a **turn index** it was handed; the app
resolves that index to `start_ms` and renders the time. The model never
produces a timestamp.
_Avoid_: section, segment (that is a live-preview chunk), turn (that is the
audio interval a chapter is anchored to), bookmark.

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

### The council (fork)

**Council**:
A named, saved group of **seats** convened on one request. It deliberates and
issues a **mandate**; it never executes anything and no seat of it holds a tool
that changes state. Desktop only: there is no Hermes on iOS, so there is
nothing for a mandate to be handed to (ADR-0034).
_Avoid_: bot, multi-agent, swarm, room, channel, member (all of these describe
a chat product this is not).

**Seat**:
One specialist at the table: a name, its instructions, **its own model**, and a
**role** -- what it is there to do (hold a position, object, judge conformance,
hunt collateral damage, hunt satisfaction in the letter only). Two seats of one
council never run on the same model family: the diversity being bought is
diversity of weights, not of personas. A seat reads and argues; it cannot
write, run a command, or touch the disk.
_Avoid_: agent, persona, role, participant, expert.

**Sitting**:
One run of a council over one request: the **blind round**, the questions, the
contradiction round, and the issuing of the mandate. A durable row, resumable
part by part, and a finished seat is never re-bought.
_Avoid_: session (that is a Hermes chat session), run (that is a workflow run),
conversation, thread.

**The chair**:
Sub Rosa itself. It puts the request to the seats, intersects their questions,
compares their answers mechanically, decides who speaks in the contradiction
round, holds the budget, and renders the mandate. It is never a seat and it
never has an opinion of its own.
_Avoid_: orchestrator, moderator, supervisor, lead agent.

**Blind round**:
The first round, in which every seat answers without seeing any other seat's
answer, in parallel. It is what prevents the anchoring that makes free
discussion converge -- and, because it is one independent answer per model, it
doubles as the single-model baseline the council is measured against.
_Avoid_: first pass, round one (say which round it is), fan-out.

**Mandate**:
What a sitting produces: a fixed structure of capped slots -- objective,
deliverable, constraints, **acceptance criteria**, out of scope, first step --
that the app renders deterministically into the prompt handed to the agent. The
council fills the fields; the app owns the prompt, and no model is ever asked
for the final string. Editable by the user before it is issued, and writable by
hand without a council at all.
_Avoid_: brief (that is a **moment**, ten minutes before a meeting), spec,
prompt (that is the rendered string, not the structure), plan.

**Acceptance criterion**:
One checkable statement in a mandate, carrying **how it is verified** -- a
command, a file, a rendered page, a reading. Seven at most. A criterion that
names no means of verification is not one, and "it looks good" is not one. The
agent is given them all: the defence against satisfying the letter is the
**verdict**, not secrecy.
_Avoid_: requirement, goal, test (a test is one way of verifying, not the
criterion).

**Verdict**:
The council's judgement of finished work against the mandate that asked for it:
each criterion satisfied, not satisfied or not verifiable, with the evidence
that settled it, plus what was changed without being asked and what was
quietly skipped. It never runs on the model the session ran on.
_Avoid_: review, report, audit, score.

**Retake**:
A corrective mandate issued after a verdict that found something unsatisfied.
Two at most per cycle: when they run out the app states what remains rather
than looping. A bounded cycle that reports its residue beats an unbounded one
that reports success.
_Avoid_: retry, iteration, loop.

### Film production (fork)

Films are produced by the app, locally, out of the user's own notes, paid in
Carpe Diem credits. The remote studio this fork used to drive is gone
([ADR-0029](docs/adr/0029-film-production-is-local.md)).
_Avoid_: Videomaker, "asset pack", "studio wallet", "the film API" - all of
them named the remote service, and none of them names anything now. **DIEM is
not on that list**: it is a Venice balance bucket the credits reader still
parses, and the studio merely quoted its prices in it.

**Film (the surface)**:
The Studio tab where a film is made, first in the list and where the Studio
opens. One screen and one order: describe, review, make, finish. It composes
what the other tabs hold in detail and owns nothing of its own.
_Avoid_: wizard, project.

**Reading**:
One pass of a script, producing the **shot list** and the **cast**. Paid for,
durable, and resumable - never re-run to get back to it.

**Cast**:
Everyone and everywhere a script names, described. A cast member the bible has
never met can be given a face in one gesture, which creates the bible entry and
draws its reference. _Avoid_: characters (a location is cast too), roles.

**Retake**:
Making one shot again. The resume machinery pointed the other way: everything
else replays from cache, so a retake costs one shot and the cut, not the film.
_Avoid_: regenerate, rerun (both read as the whole thing).

**Script**:
A note the user wrote that a film is made from. Not a new kind of thing: the
import doctrine again. _Avoid_: screenplay object, film project.

**Shot list**:
One script read as the shots a film is made of - a derived row on that note,
regenerable in place and resumable part by part. It is neither the script nor
the graph: it is what compiles into the graph.
_Avoid_: shotlist (one word, that was the remote studio's spelling), storyboard
(that is pictures).

**Shot**:
One continuous take of a few seconds. Carries a **motion class** (`low`,
`medium`, `high`) and whether it **continues** the shot before it. Never a
duration, a model or an aspect ratio - those are the app's to resolve.
_Avoid_: scene (a scene groups shots), clip (that is the rendered file).

**Take**:
One rendered attempt at a shot. Takes are branches of a shot chain
([ADR-0019](docs/adr/0019-shot-chains-are-parent-links.md)), not rows.

**Compiling**:
Turning a shot list into a workflow. Free, local, instant, and repeatable with
a different ceiling until the figure is one the user accepts
([ADR-0030](docs/adr/0030-a-production-compiles-into-a-workflow.md)).
_Avoid_: generating (that spends), planning (that is the reading).

**Spend ceiling**:
The credit envelope a production may not exceed. A graph over it is *refused at
compile time*, with the figure - in front of the confirmation handshake, not
instead of it. _Avoid_: budget ceiling (that was the remote studio's, and it
guarded an enqueue rather than the work).

### The bible (fork)

**Bible**:
the persistent identities of a production, kept on this install rather than on
a project or a run: a character outlives every film it is in. Rows in
`bible_entries` and `bible_refs` (migration 017), surfaced as Studio > Bible.
_Avoid_: "cast" (a location is not cast), "asset pack" (that was the remote
studio's server-side copy, and it is gone).

**Bible entry**:
one identity, of a **kind**: `character`, `location`, `prop` or `look`. Carries
a name, **invariant traits**, and references.

**Invariant traits**:
what must not drift between shots - the palette, the wardrobe, the relative
height. Restated on the prompt of *every* shot, because nothing carries over
between separately generated clips. This restating is the difference between a
character and a resemblance.

**Bible reference**:
a pointer at a gallery artifact standing in for part of an entry, in a **role**:
`portrait`, `profile`, `wide`, `medium`, `detail` or `voice`. Never a copy of
the file. Their **order** is load bearing: the first image is what a
reference-to-video model treats as the identity to hold.

**Voice donor**:
the `voice` reference of a character - a speech artifact that rides as
`reference_audio_urls` so a generated line keeps the same timbre. Chosen by
**audition**: a few voices saying the same line, one kept.

**Judge**:
a model looking at work in progress and saying what is weak - a panel, a shot,
or the assembled cut. Returns a score and at most three weaknesses; whether that
clears the bar is decided by the app, not by the model. A judge never blocks: no
vision model, a refusal or an unreadable answer all mean "no opinion", and the
production carries on. _Avoid_: "QA", "critic".

**Judged gate**:
an approval gate that asks a judge first. `judged` lets the work past on its own
when the verdict clears the bar; `judged-then-human` always stops, but stops
with the verdict attached.

### Studio finishing (fork)

**Mix**:
every sound in a film, placed and levelled, rendered *offline* into one buffer
that the recording then plays. Deterministic, measurable, and the only way to
duck music under dialogue properly. Distinct from the **lanes** it is made of:
`clips`, `dialogue`, `sfx`, `music`.

**Ducking**:
writing the music down under the dialogue, as gain automation computed from the
dialogue windows. Not a compressor: the windows are known before anything
sounds.

**Programme loudness**:
the integrated LUFS of the whole film, to ITU-R BS.1770. One normalisation gain
is applied from it. Distinct from a clip's own level.

**Timeline**:
the interchange file another editor opens - FCPXML or Premiere xmeml - written
into a self-contained **bundle** with copies of the media beside it. The
finishing path. Distinct from the **cut list** (the internal structure) and from
the **film export** (the real-time recorder capture, which is a preview).

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
Distinct from a **shot list**, which is planned up front and compiles into
a graph: a chain is what the renders turned out to be.
_Avoid_: sequence, timeline (that is Assemble's cut list), storyboard.

**Anchor frame**:
A frame from a chain's *first* clip, sent as a reference on later shots so the
subject and lighting do not drift over generations that each only ever see
their immediate predecessor. Rides the reference-to-video contract.
_Avoid_: keyframe, style reference (too generic).

### Waiting on a render (fork)

**Darkroom**:
What a generation looks like while it is being made: a frame at the render's
own aspect ratio, in the place the result will occupy, holding a slow field of
seeded light and film grain. It is abstract on purpose - it never shows the
opening frame or anything else derived from the request, because a placeholder
that looks like a preview is a promise the arriving render breaks. One
component, every surface: the desktop queue, the mobile panels, a running
workflow node, a film being made.
_Avoid_: loader, spinner, skeleton, placeholder (the frame is not a stand-in
for a layout, it is the reserved shape of the result); "preview" above all.

**Render estimate**:
The median wall time this machine has seen for a model, over the last few
finished renders of that kind. Two samples minimum, and the bar it drives
eases toward a ceiling it never reaches - only a finished render may say a
render is finished. Local, best-effort, and absent by default: with no
estimate the darkroom sweeps rather than fills.
_Avoid_: ETA, progress (the backend reports none), percentage complete.

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
run, never to the saved workflow. A **judged** gate asks a model first and can
let the work past on its own; a judge never blocks. _Avoid_: breakpoint, review
step.

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
editing**. See [ADR 0045](docs/adr/0045-image-generation-and-editing-tools.md).
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

### Keeping and carrying (fork)

**Search**:
The full-text index over notes, transcripts, memories and conversations
(migration 020, FTS5), ranked by bm25, accent-folded, with the last word as a
prefix. The ⌘K palette's "In your notes" group, the phone's notes search and
agent-lite's `search_notes` all read it. Terms are ANDed.
_Avoid_: filter (the old substring pass over the loaded list), recall (that is
memory's word, see **Memory**).

**Archive**:
One file of the person's corpus: every table that is theirs as JSON lines, a
Markdown copy of each note, the recordings on request; a tar stream, sealed
with age when a passphrase is given (`.subrosa`, `.subrosa.age`). Written and
restored on purpose (ADR-0042). Importing is an upsert by id.
_Avoid_: backup (implies a schedule), sync (there is none, by decision), export
alone (that is one note to PDF or Markdown).

**Report**:
A bug, feedback or feature request filed as a GitHub Issue with the user's own
credential, or opened pre-filled in the browser (ADR-0036). Never sent to a
Sub Rosa server; there is none.
_Avoid_: ticket, telemetry (the app has none).

**Diagnostics bundle**:
The dated folder Settings › Reports writes: the logs' tails, the version, the
local backend's state, the egress list, the capability map and the storage
report, every byte passed through `diagnostics::redact` first.
_Avoid_: crash report (the app never sends one), logs (the bundle is more, and
redacted).

**Capability map**:
What this build can do on this platform (`diagnostics::capabilities`): system
audio, HUD, global dictation, Spotlight, calendar, meeting detection, share,
agent runtime, updater. Read by the webview instead of `navigator.platform`;
`false` is a fact the settings state in a sentence, not a failure.
_Avoid_: feature flag (nothing here is toggled), platform check.

**Storage bucket**:
One thing on disk the app is responsible for, measured in Settings › Storage:
the database, the recordings, the Studio gallery, the agent's workspace, its
state, its runtime, the logs. The one action offered removes the audio of
notes transcribed more than N days ago, previewed first, never automatic.
_Avoid_: cache (nothing here is regenerable except the runtime), cleanup.

**Offline**:
The state the shell shows while notes wait because their request never reached
the endpoint: a banner with the count, a probe every thirty seconds, and one
"Retry all" once the endpoint answers. Nothing retries on its own on the
desktop (ADR-0018).
_Avoid_: degraded mode, queue (the notes are simply failed, and known to be).

### Desktop shell & updates

**Release channel**:
The updater track: `stable` (every tag on `main`) or `rc` (ADR-0003, promoted
to stable from the same artifacts). Every release carries its notes, generated
from the commit subjects since the previous bump.
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

### Asking the notes (fork)

**Ask (ask your notes)** — a question answered from the notes, with
citations. The app picks the passages (FTS5), sends only those, and turns
the `[n]` the model writes back into links to notes (ADR-0044). Offered
from the ⌘K palette when the query reads as a question, and from the notes
search on the phone.
_Avoid:_ "chat with your notes" (that is the agent, which chooses its own
reads); "RAG" in copy.

**Passage** — one excerpt handed to the model for an ask, numbered from 1,
with its note id and kind (note or transcript). The list of passages is
"what was sent" and is shown under the answer.
_Avoid:_ "chunk" (that is the long-form summary's unit), "source" (an audio
lane).

**Citation** — an index in the answer that names a passage that was sent.
An index that was never sent is *invented*, and the answer says so rather
than hiding it.
_Avoid:_ "reference", "footnote".

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
  Carpe Diem call) and a **film** (a production of many shots, compiled from a
  shot list). Say which.
- **"media"** in fork code means Studio's generated media (`media_jobs`, the
  media proxy of [ADR-0008](docs/adr/0008-studio-media-proxy-in-tauri.md)),
  never an **import**. An imported file is media in English and an import in
  this codebase.
- **"bible"** means the local rows of persistent identities
  ([ADR-0032](docs/adr/0032-the-bible-is-local-rows-over-gallery-artifacts.md)).
  The remote studio had a server-side "bible" of its own, and it is gone: if a
  sentence needs to say which, the sentence is out of date.

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
