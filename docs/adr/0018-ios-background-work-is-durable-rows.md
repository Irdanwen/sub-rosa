---
status: accepted
date: 2026-07-28
---

# Background work on iOS is durable rows, not long-lived tasks

## Context

The iPhone app has to keep making progress when the user locks the screen or
switches away — that is when a meeting transcription, a five-minute video render
or a chat turn is most likely to be running. iOS makes that hard in two separate
ways, and only one of them was being addressed.

**The webview is frozen first.** WKWebView stops executing the moment the app
leaves the foreground: timers do not fire, promises do not settle, `fetch` does
not resume. Any orchestration that lives in JavaScript is not slowed down by
backgrounding, it is stopped. Studio's async generations (video, music, sound
effects) were polled from `src/lib/studio/async-job.ts`, so locking the phone
stalled a render the user had already paid for until they reopened the app *and*
navigated back to the screen that started it.

**The process is suspended second.** Native code gets a grace window from
`beginBackgroundTask` — around 30 seconds on current iOS — and is then suspended
and, eventually, killed without warning. The Rust side already took that window
for note processing, dictation and chat turns, which is enough for a short reply
and nowhere near enough for a long transcription. Worse, a kill during the
suspension left rows stranded: a note stuck in `transcribing` forever, a
dictation whose audio was in the temp directory with nothing pointing at it, a
chat task stuck in `running` with no reply coming.

The levers iOS actually offers are: the `beginBackgroundTask` window;
`UIBackgroundModes: audio`, which grants unlimited runtime **while an audio
session is genuinely recording or playing**; and `BGTaskScheduler`, which wakes
the app up later — on the system's schedule, not ours — for a few minutes of
work. There is no fourth option, and there is no amount of engineering that
turns a backgrounded iOS app into a machine that runs whenever it likes.

## Decision

**Nothing that can outlive a foreground session may live in a promise or a bare
task. It writes a row first, and the row is the source of truth.**

Concretely:

- `media_jobs` and `pending_dictations` (migration `011_background_jobs.sql`)
  join the existing note rows. The Studio poll, download and gallery write moved
  out of the webview into `carpe_diem::jobs`; the frontend queues the generation,
  hands the id to Rust, and afterwards only *observes*.
- `crate::background::sweep` re-drives every one of those queues. It runs on
  cold launch, on `RunEvent::Resumed`, and from the `BGTaskScheduler` launch
  handlers. Every step is idempotent, so sweeping twice costs a query and
  produces nothing new.
- `ios_background` grew from a single RAII guard into the coordinator: guards are
  ref-counted onto one shared UIKit task, leaving the foreground submits a
  `BGProcessingTaskRequest` and a `BGAppRefreshTaskRequest` **when there is
  pending work**, and their launch handlers run the same sweep.
- Completion is announced by Rust, not by the webview. A render that lands while
  the user is in another app posts a local notification, because the webview
  that used to post it is precisely the thing that is asleep.
- Whether a row is being worked on right now is an **in-process** question, not a
  database one. `domain::processing::is_processing` and agent-lite's
  `TurnClaim` exist so a warm resume does not restart a pipeline that is still
  running and transcribe the same note twice.

The user-visible consequence: locking the phone costs *time*, never a result.

## Consequences

The failure mode changes shape. Work no longer dies; it pauses. A render queued
before locking the phone finishes in the background window if it is quick, in a
BGTaskScheduler slot if the system grants one, and on next launch otherwise —
and in all three cases the file is in the gallery and a notification says so.
"Resume" affordances disappeared from the Studio views because there is nothing
left to resume by hand.

`BGTaskScheduler` is opportunistic. iOS decides when (and whether) to run a
request, weighing battery, charging state and how the user actually uses the
app. This is why the requests are only submitted when something is pending:
waking up with nothing to do lowers the app's future priority. It is also why
the design cannot depend on those windows — they shorten the wait, the durable
rows are what guarantee the outcome.

The `audio` background mode stays honest. It covers recording and Studio
playback, both real audio. Playing silence to hold the process open is a known
technique and is deliberately not used: it is the kind of thing App Store review
rejects, and the durable queues make it unnecessary.

Desktop gets the same durable Studio queue for free, which also fixes "the app
quit mid-render" there. The note sweep stays mobile-only on purpose: desktop is
not suspended out from under a running pipeline, and auto-retrying would change
what the existing manual "retry processing" affordance means.

## Alternatives considered

**Keep polling in the webview and just hold a longer background task.** This
cannot work in either direction: no background task revives a frozen WKWebView,
and no `beginBackgroundTask` window lasts long enough for a video render.

**Silent-audio keepalive.** Playing an inaudible track keeps the process running
indefinitely under `UIBackgroundModes: audio`. Rejected: it is a
misrepresentation of why the app declares the audio mode, it drains the battery
for work that is mostly waiting on a server, and it is a documented App Store
rejection reason. The durable rows deliver the same outcome within the rules.

**Push notifications to wake the app when a render finishes.** The natural fit
for "the server knows before we do", but it requires a push-capable backend and
device tokens. Sub Rosa's whole architecture is a local sidecar in front of the
user's own Carpe Diem key ([ADR-0017](0017-product-autonomy-from-june.md));
there is no Sub Rosa server to send a push, and adding one would undo the point
of the fork.

**Port the workflow (Flows) DAG executor to Rust as well.** Not done. Its nodes
chain their outputs in memory — a generated image becomes the next node's
`image_url` — so making a run durable means moving the whole graph engine, its
catalog lookups and its media chaining across the boundary. Each *generation*
inside a Flow is already safe (nothing paid for is lost), but the step-to-step
progression still needs the app in the foreground. That port is a separate
change and deserves its own ADR.
