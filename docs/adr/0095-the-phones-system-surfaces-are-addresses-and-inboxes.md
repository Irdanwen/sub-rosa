# ADR 0095: The phones' system surfaces are addresses and inboxes

- Status: accepted
- Date: 2026-10-08

## Context

People reach for an app from outside it: a widget on the Home Screen or the
Lock Screen, a complication on the watch face, the share sheet on Android, a
question asked into a watch. Sub Rosa had the iPhone share extension
(ADR 0048) and the Shortcuts actions (ADR 0060), and nothing else. Each new
surface is native code built only by a release lane, in a process that has
none of the app's data, key or sidecar; the question was how much of the
app each one should carry.

The watch is the hard case. A watch app could call Carpe Diem itself, but it
would need the key on the wrist, its own notes search, its own tool loop: a
third copy of the chat. And a turn takes longer than WatchConnectivity lets a
reply wait, longer than iOS lets a background launch run.

## Decision

**Every surface hands over and lets the app act. A widget is an address, a
share is a manifest in an inbox, a watch question is a chat the phone runs as
a durable row and answers when it can.**

- **Widgets are links, not intents.** The iOS widgets (`gen/apple/Widgets`:
  small "Ask", medium Ask, Dictate and Record, and the Lock Screen "Ask") and
  the Android widget (`AskWidgetProvider`) open `subrosa://chat/new`,
  `subrosa://dictation?start=1` and `subrosa://record`, addresses the app
  already answers (`parseDestination`; `chat/new` is new and means a fresh
  chat). Every one of these actions opens the app, which is what a link does;
  an App Intent button would be needed only for an action completing without
  the app, and would put intent code in two targets (an extension cannot call
  `UIApplication.open`). The widgets show nothing of the person's data, so
  they have one timeline entry and never refresh. The iOS widgets carry the
  app group like the other extensions, so a later widget that does show data
  needs no new entitlement.
- **Android shares into the same inbox.** `ShareReceiverActivity` takes
  `SEND` and `SEND_MULTIPLE` (text, links, images, audio, video, PDF and
  Office files), copies each item into `share-inbox/` with the manifest the
  iOS extension writes (ADR 0048), and opens `subrosa://share/<id>`. It runs
  in the app's process, so the inbox is a folder of the app's data directory
  (Tauri's `app_data_dir` is that `dataDir` on Android), not a shared
  container: `share_inbox::inbox_dir` is the only per-platform line.
- **What a share becomes, on both phones.** A link starts an import, an audio
  or video file becomes an imported note, a text becomes a note (unchanged).
  A picture or a document now goes to a fresh chat's composer
  (`kind: "attachment"`): the picture as a data URL the shell downsizes like
  a picked one, the document as its text (ADR 0085). Nothing is sent: the
  person writes the question.
- **The share inbox is swept.** Android hands a cold start only the last
  address of a batch, so the shell asks for the young manifests still waiting
  (`pending_shared_items`, ten minutes, like the Shortcuts inbox) when it is
  ready and when it comes back to the foreground. The shell acts on a share
  id once per session whichever way it arrives, and a manifest that cannot be
  read is deleted rather than refused again at every launch.
- **The watch asks, the phone answers.** The watch app (`gen/apple/Watch`,
  watchOS 10, a single-target app embedded in the iOS app) takes a question
  through the system's dictation and sends it over WatchConnectivity:
  `sendMessage` when the phone is in reach (iOS wakes the app in the
  background for it), a queued `transferUserInfo` otherwise. On the phone,
  `WatchBridge.swift` owns the session and hands each message to Rust through
  a C function pointer Rust registers at setup; `watch_relay.rs` files it as
  an ordinary agent-lite chat (so it is also in the phone's history, with the
  same tools, memory and model), writes `watch-requests/<id>.json` as the
  promise of an answer, and runs the turn. The answer goes back as plain text
  (the chat's cards left out), sent at once or queued by WatchConnectivity;
  the watch shows it and reads it aloud with `AVSpeechSynthesizer`. A failure
  is a flag, and the watch words it.
- **Durable rows (ADR 0018).** The chat is the turn's row, re-run by the
  resume sweep if the phone suspends; the promise file is the delivery's row,
  re-driven by `background::sweep` after the chat resume and dropped once
  handed to WatchConnectivity or after a day. A question the phone already
  took is answered from its chat, never asked again.
- **The complication is "Ask"** (`gen/apple/WatchWidgets`), opening the watch
  app on its question field.

## Alternatives rejected

- **App Intent buttons in the widgets.** Interactive, but every action here
  opens the app anyway, and the intents would have to compile into the
  extension where `UIApplication` does not exist.
- **The watch calling Carpe Diem itself.** A key on the wrist, a third copy of
  the chat loop, no notes, no memory.
- **Answering in the WatchConnectivity reply.** The reply has to come back in
  seconds; a turn with a web search does not. The reply is an acknowledgement
  and the answer is a message of its own.
- **A database table for the watch's promises.** A migration for a handful of
  short-lived rows that only the iPhone writes; a file per question, written
  atomically, is the same durability (the share inbox already works this way).
- **One manifest per batch on Android.** A new manifest shape for both
  platforms when the sweep already covers what a batch needs.

## Consequences

- Three new bundles: `xyz.carpediem.subrosa.widgets` (app group),
  `xyz.carpediem.subrosa.watchkitapp` and
  `xyz.carpediem.subrosa.watchkitapp.widgets`, each with an App Store profile;
  `ios-release.yml` requires the three secrets (`HANDOFF.md`) and stamps and
  maps five bundles. A watch app must carry its iPhone app's version and build
  exactly; `pnpm ios:version` and the version test now cover all five plists.
- Xcode 26's `actool` compiles the watch app's icon only with the watchOS
  platform installed, device builds included; the lane installs it when the
  runner lacks it.
- `gen/apple` was regenerated with `xcodegen` (the app's `Info.plist` kept as
  committed: it carries `ITSAppUsesNonExemptEncryption`, which `project.yml`
  does not, so regenerating it would drop the key).
- What only hardware shows: the widgets on a Home Screen and a Lock Screen,
  the complication on a face, dictation on the watch, the background wake of
  the iPhone for a watch message, speech, and the Android share sheet and
  widget. The Swift targets compile for their simulators and devices; the
  Kotlin compiles only in the Android lane.

## Addendum 2026-10-08: the lane makes its own profiles

- The widgets left the app group. They are links and read nothing the app
  keeps, and associating a group with a bundle is the one step the App Store
  Connect API cannot take, so keeping it would have meant a portal visit for
  nothing. `phone-widgets-watch.test.ts` now pins them outside it.
- `ios-release.yml` no longer requires the three profile secrets.
  `scripts/ios-provision.mjs` registers the bundle ids, turns on HealthKit for
  the app (ADR-0099), and makes or remakes each App Store profile through the
  API at run time; the secrets are a fallback. A bundle that still has no
  profile is removed from the archive before export (the complication with
  its watch app) and the app ships without it, with a warning. Only the app is
  required.
