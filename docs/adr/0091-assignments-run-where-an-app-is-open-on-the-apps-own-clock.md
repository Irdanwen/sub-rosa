---
status: accepted
date: 2026-10-08
---

# Assignments run where an app is open, on the app's own clock

## Context

The parity matrix (ADR-0078) left three P5 rows open: an **always-available
agent** (a goal the assistant keeps working on, whose results you review),
**scheduled tasks on the phones** (the desktop has Hermes routines, the
phones had nothing), and a **daily brief** (one card in the morning).

The product owner settled the boundary before any design: **an agent runs
only while an app is open, and the desktop sitting in the menu bar counts.**
Nothing runs on the account service (ADR-0049). That rules out the obvious
shape (a server that wakes up at 9:00), and it sharpens three facts that
were already true:

- **Hermes's gateway outlives the app.** It is launchd-managed on purpose
  (cron routines, messaging), so a recurring Hermes cron job keeps firing
  with Sub Rosa quit.
- **iOS gives no clock.** The process is suspended, BGAppRefresh runs when
  the system decides, and the webview is frozen (ADR-0018).
- **Synchronised state is history, not instruction** (ADR-0049), with one
  argued exception: the errand (ADR-0054).

## Decision

**An assignment is a synchronised row addressed to one device, which runs
its slots on the app's own clock while the app is open there. A run is a
one-shot Hermes cron job on the desktop and an agent-lite chat on the phone,
behind a row written first.**

- **Vocabulary.** An *assignment* is a goal, a cadence (hourly, daily,
  weekdays, weekly, every n hours), an autonomy ("ask before anything leaves
  the device" or "act within these tools"), the tool groups it may use, a
  results inbox and its history. A *scheduled task* is the same row with
  `kind = task`: it runs and notifies, nothing to review. Migration 060:
  `assignments`, `assignment_runs`, the unsynchronised `assignment_slot_runs`
  ledger, `daily_briefs` and `followed_topics`.
- **The app owns the clock.** `assignments/schedule.rs` answers one pure
  question each tick: the latest slot at or before now, after the row became
  active, and unrun here or anywhere. A missed morning is one late run that
  says so, never seven; older slots perish. The clock is the background
  sweep (launch, resume, BGTaskScheduler) plus a one-minute loop that holds
  no state while the app is open.
- **Desktop runs ride Hermes cron, one shot at a time.** Each due slot
  becomes a cron job scheduled a minute out, with explicit
  `enabled_toolsets`; Hermes removes it after it ran, and the answer is read
  from the `cron_<job>_<time>` session. A recurring Hermes schedule was
  rejected because it would fire with the app quit.
- **Phone runs are chats.** The run's prompt is the user turn of an
  agent-lite chat; the chat is the durable row, and the run's own tools ride
  a task-local that `assistants::runtime::allows_tool` reads, re-established
  when the sweep resumes an interrupted run before the generic chat resume.
- **One device runs a row: the one it names.** A row created on the desktop
  names it. A phone picks "this phone" or one of the account's computers.
  The computer treats a row another device wrote exactly like an errand
  (ADR-0054): addressed, authenticated by the vault, run only when its owner
  switched on "Run links sent from your other devices", single use per slot
  (the local ledger, plus run ids derived from assignment and slot so two
  devices that both ran one slot made one object), and perishable (only the
  latest slot). "Run now" from the phone is a real errand whose address is
  `subrosa://assignment/<id>`; an older desktop hands it to the import rail,
  which refuses it in words.
- **The phone catches up.** When the computer leaves a slot of a
  phone-created assignment unrun for thirty minutes and the phone is open,
  the phone runs it in the foreground, late, with the tools it has.
- **The inbox is the loop.** A reviewed run carries its verdict and feedback
  in its synchronised row, and every later run reads the last five. Under
  "ask first", Approve means "go ahead": the device that runs the assignment
  carries the proposal out once (slot `approved:<run>`), with the groups
  that leave the device or change the machine now allowed.
- **Launch at login is offered** when the first assignment exists on the
  desktop, once, through the existing autostart plugin.
- **Phones in the background.** iOS: the existing refresh identifier is
  submitted whenever this phone runs a schedule, so the system may wake the
  sweep now and then; no new identifier. Android: no WorkManager (it needs a
  dependency and a Kotlin worker that would boot the Rust runtime headless);
  the screen says runs happen while the app is open and catch up when it
  opens.

## Addendum to the moments: the daily brief

The daily brief is the third moment the app speaks first, and keeps their two
rules. It is off until asked for. Silence is a feature: a morning with no
meeting, no note yesterday, nothing to review, nothing failed and nothing new
on a followed topic writes a `silent` row and says nothing. It counts against
the moments' daily cap (`MAX_BRIEFS_PER_DAY`) in both directions. It is read,
not written by a model: the agenda as one sentence (the calendar stays
context, never a list to open, ADR-0025), yesterday's notes and the
follow-ups under their headings, results to review, failed runs and failed
desktop routines, and up to five followed topics, one web search each. A card
first written more than four hours after its time waits quietly in Today.

## Consequences

- The always-available agent is as available as the app: a laptop asleep in
  a bag runs nothing, and the phone's copy says so rather than pretending.
- The service gained two synchronised tables and still runs nothing. An app
  too old to know them refuses their revisions as an unknown table, the same
  safe outcome ADR-0085 accepted for scoped memories.
- Desktop routine history now also lists the one-shot jobs assignments
  create, named "Assignment: …".
- Notifications posted from Rust are in English, like the other moments.

## Alternatives rejected

- **Recurring Hermes cron jobs.** Fire with the app quit, against the
  product owner's rule, and cannot read feedback written after creation
  without rewriting the job each time.
- **A server-side scheduler.** ADR-0049 and the product owner both refuse it.
- **Any device runs any due slot.** Two devices, two paid runs. Naming the
  device removes the race instead of detecting it; the derived run id is the
  backstop for the phone's catch-up.
- **An assistant snapshot per assignment to restrict phone tools.** It would
  reuse the gate but forbids writing notes and files assignments as assistant
  conversations.
- **WorkManager on Android.** A new dependency and a headless runtime, for
  wake-ups the platform may defer anyway.

## Addendum (2026-10-08): run jobs carry a tag, and notifications are translated

- The Consequences above said routine history would list the assignments'
  one-shot jobs. It no longer does. Each run's job is named with a machine
  tag before the assignment's title (`ASSIGNMENT_JOB_TAG`, `"[assignment] "`,
  in `assignments/mod.rs`, mirrored in `src/lib/assignment-runs.ts` and
  tested equal), never a translated word. Hermes titles the run's session
  from the job name, so a finished run is recognised by its title (the
  adapter gives it the source `assignment` and shows the title without the
  tag, in the chat list too); a run still going has no title yet and is
  recognised by its job, which is still listed. The Routines list, its run
  history and the daily brief's failed routines leave both out.
- Notifications posted from Rust are rendered in the app's language (the
  addendum of 2026-10-08 to ADR-0047), so the last Consequence above no
  longer holds.
