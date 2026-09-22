# ADR 0060: A Shortcuts action speaks through the app group, and only it may send

- Status: accepted
- Date: 2026-09-22

## Context

People wanted one tap from the iPhone's Shortcuts app, the Action button or a
widget to start an audio note. The app already answered to addresses
(`subrosa://record`, `subrosa://dictation`, `subrosa://chat?q=…`), listed in
Settings, but building a shortcut meant typing an address into an "Open URL"
action, and nothing in the Settings row said so: it copied the address
silently. App Intents had been set aside earlier because they need Swift in
the app target and a signed build to verify.

Two questions had to be answered together. How does a Swift intent reach the
app's logic, which lives in the webview and in Rust? And what may a request
from outside the app make happen without a tap? An address can be opened by
any page and any app on the phone, so `subrosa://chat?q=…` sending a message
on its owner's behalf would let a web page speak for them.

## Decision

**The intents live in the app target and hand over exactly as the share
extension does (ADR 0048): a manifest in the app group, then an address that
names it. Only a request that comes from a manifest may send a message
without a tap; an address may only pre-fill one.**

- **Three actions** (`gen/apple/Sources/os-june/Intents`): New audio note,
  Dictate, Ask Sub Rosa (a question, and whether to send it now). An
  `AppShortcutsProvider` lists them by themselves in Shortcuts, Spotlight and
  the Action button picker. `@available(iOS 16.0, *)`, AppIntents weakly
  linked: the app keeps running on iOS 15, where they simply do not exist.
- **The hand-off.** `perform()` writes `intent-inbox/<id>.json` and opens
  `subrosa://intent/<id>`. `intent_inbox.rs` reads a manifest once and
  deletes it before acting, refuses anything older than ten minutes, any
  unknown action, and a "send" without a question.
- **Two ways in, one consumer.** The address is the fast path; the shell also
  sweeps the inbox when it becomes ready and whenever it returns to the
  foreground, so a request whose address was lost on a cold start is still
  acted on. Taking a manifest is single-use, so the two cannot both act.
- **The trust line.** `chat?q=` from an address writes the question into the
  composer and stops. `send` exists only on a manifest, which only the app and
  its extension can write.
- **Destinations wait for the shell.** An address that arrives while the
  local engine starts or the key gate is up is held and replayed once the
  shell is ready (`useDestinationQueue`), and a launch URL is acted on once
  per webview session, not again after a reload (iOS keeps the last URL as
  "current" for the life of the process).

## Consequences

- The app target now compiles Swift. It has its own module name
  (`SubRosaApp`), because the share extension already emits `Sub_Rosa` and
  two identical module names collide in the products folder.
- The actions are verified by `src/test/ios-app-intents.test.mjs` (files in
  the app target, weak link, availability, French strings, agreement with
  Rust) and by a simulator build, which extracts them into
  `Metadata.appintents`. Whether the address reaches the app from `perform()`
  at a cold start is only visible on a device; the sweep is there for the case
  where it does not.
- Siri phrases come with an `AppShortcutsProvider` whether or not anyone uses
  Siri. They name the app, as the system requires.

## Alternatives rejected

- **Addresses only**, with better copy in Settings. Leaves "one tap" to the
  person's own shortcut building, and cannot send a question safely.
- **A bare address from `perform()`**, no manifest. Simpler, but either every
  page gets to send messages or no Shortcuts action can.
- **An intents extension.** An intent that opens the app runs in the app's
  process anyway; an extension would add a target, a profile and a signing
  step for nothing.
