---
status: accepted
date: 2026-08-22
---

# The calendar is context on a note, never a meeting object

## Context

Sub Rosa records meetings and knows nothing about them. A recording starts
blank and untitled; the user names it, remembers who was there, and later
searches for "the one with Marie" through prose. Everything needed to fix
that is already on the device — macOS and iOS both expose the day through
EventKit — and the fix is small: a recording started at 09:58 belongs to the
10:00 invitation, which has a title and an attendee list.

The obstacle is not technical. The product specs exclude the calendar, and
not once:

> "MUST remain notes-first and MUST NOT reintroduce legacy workspaces, auth,
> billing, calendar, chat, sharing, or a dedicated meetings product surface"
> — `specs/002-system-audio-source-mode/spec.md` FR-023

> "no meeting object" — `specs/002-system-audio-source-mode/plan.md`

> "must not create a meetings page, meeting object, workspace switcher,
> calendar surface…" — the same feature's UI contract

Read carelessly, that forbids this work. Read for what it protects, it
forbids something else: a second product noun. The legacy app had meetings as
first-class objects with their own page and their own switcher, and the note
was one of their attachments. The specs are defending the inversion — the
note is the product, and nothing competes with it.

## Decision

The app reads the calendar, and **the calendar never becomes a thing you can
open**. Concretely:

- There is no calendar screen, no meetings list, no meeting picker, and no
  `meetings` table. A note gains three columns —`calendar_event_id`,
  `scheduled_start`, `attendees_json` — and that is the entire data model.
  A table would have been exactly the object the specs refuse; columns say
  what the design means: this is context *on* a note.
- The vocabulary gains no noun. There is no "meeting" in the domain language;
  there is a note that knows when it was scheduled and who was invited.
- The only two surfaces are a line under the note title, and one question
  when two meetings overlapped the same recording.
- A recording with no matching event behaves exactly as every recording did
  before this existed. That is the test of whether the constraint held.

Two rules travel with it:

- **Retrieval, never injection.** The agent reaches the calendar through a
  tool (`search_calendar`, on both shells) that answers for a bounded window.
  A planning dump is never poured into a prompt, for the same reason the
  notes are searched rather than pasted.
- **Ask, never guess.** One candidate attaches silently and names an untitled
  note. Several come back as a question, asked once, with "neither" as a real
  answer. Guessing between two overlapping meetings is worse than asking.

Permission is requested at the first recording — the moment it pays off —
never at launch, and a refusal degrades to today's behaviour in silence.

## Consequences

- A future reader who greps the specs will find `calendar` in an exclusion
  list and this ADR next to it, so the constraint reads as respected rather
  than forgotten. Anyone proposing a calendar *screen* is still refused by
  the specs, and by this record.
- EventKit is one framework on both platforms, so `src-tauri/src/calendar.rs`
  serves the desktop and the phone from one implementation — unusual enough
  among native integrations to be worth stating.
- Attendees come from the invitation, and only from there. The app has no
  diarization (its "speaker" is a loudspeaker, and its two audio lanes are
  microphone and system), so it never claims to know who said what.
- The three columns are nullable and unused by every note that predates them;
  no migration rewrites anything.
