---
status: accepted
date: 2026-08-23
---

# Import links are fetched, never scraped, and the app ships no downloader

## Context

Once the app can decode media ([ADR-0026](0026-imported-media-is-decoded-in-process.md))
and summarize a long transcript
([ADR-0027](0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)),
the only missing piece between "a talk I want to read" and "a note I can
search" is the fetch. The user has a link, not a file.

Links are not one problem. They are three, and they have very different
answers:

1. A direct media URL — an MP3, an M4A, an MP4 served over HTTPS.
2. A podcast, which is an RSS feed whose `<enclosure>` is case 1, published
   for exactly this purpose, with the title, the show and the duration
   attached.
3. A streaming platform page, where the media URL is deliberately not in the
   markup and is reconstructed by tools that track the platform's changes
   week by week.

The temptation is to solve all three at once by bundling `yt-dlp`. It would
work on the desktop today. It is the wrong thing to ship:

- It is a second executable to sign, notarize and update, and it goes stale
  fast — an extractor that is six weeks old is an extractor that is broken.
- Redistributing an extractor inside a paid product makes Sub Rosa the party
  circumventing whatever the platform's terms say, rather than the user.
- It cannot run on iOS at all, so the phone would get a different product.
- Reimplementing extraction in Rust is worse on every one of those axes and
  adds a maintenance treadmill nobody asked for.

The opposite temptation — refusing links entirely — throws away the two cases
that are unambiguous, well-specified and permanent. An RSS enclosure is a
public URL published in a feed whose entire purpose is for clients to fetch
it.

## Decision

**The app fetches what is published, and never reconstructs what is hidden.
No downloader is bundled and none is reimplemented.**

Three rails, in decreasing order of cleanliness:

- **A file.** Dropped, picked or shared in. Already the best path, and after
  ADR-0026 it works for real files at real durations.
- **A published URL.** A direct media URL is fetched with the HTTP client the
  app already carries. A feed URL is parsed as RSS/Atom and its enclosure is
  fetched, with the episode's title, show and duration seeding the note. This
  covers every podcast, every self-hosted recording, and every conference that
  publishes an MP4 — with no binary, no scraping, and it works on iOS.
- **A platform page, only through a tool the user already has.** If `yt-dlp`
  is on the `PATH` *and* the user has switched it on in settings, the desktop
  shells out to it. The app never installs it, never bundles it, never updates
  it, and says plainly where the capability came from. When it is absent, the
  UI explains the two rails that do work instead of failing with a stack
  trace.

Four rules travel with it.

- **A URL is an outbound request from the user's machine.** Sub Rosa is
  local-first and nothing here routes through an operator; the fetch goes
  direct, from the user's IP, to a host the user named. That is the honest
  behaviour, and it is stated in the UI at the moment of pasting rather than
  buried, because a privacy-first product does not get to be quiet about the
  one action that touches a third party.
- **Free transcript first.** When the extractor rail is active and the source
  publishes captions, the captions are taken and no audio is transcribed at
  all: no cost, no wait. Author-published chapters, when present, become the
  chunk boundaries — better than any boundary the app could infer.
- **Fetching is a durable row, not a promise.** A download that outlives a
  foreground session is an `ingests` row, swept like everything else under
  [ADR-0018](0018-ios-background-work-is-durable-rows.md). Only the steps
  *before* transcription live there; once the WAV is on disk the existing note
  pipeline owns the rest, resume included. No new state is added to
  `ProcessingStatus`.
- **Bounded by default.** A ceiling on fetched bytes and on duration, with
  redirects capped and non-media content types refused before the body is
  read. A pasted link is untrusted input.

## Consequences

- The two rails that carry the most real use — files and podcasts — are the
  two that need no maintenance. Extractors rot; RSS does not.
- The platform rail is honestly second-class, and visibly so. A user without
  `yt-dlp` is told what the app can do rather than what it cannot.
- iOS gets rails A and B in full, and never rail C. That asymmetry is a
  platform fact, surfaced as such, not a missing feature.
- The app gains an outbound fetcher for arbitrary user-supplied URLs, which is
  a new attack surface: it is capped, content-type checked, redirect-limited,
  and its output is only ever handed to a decoder that is safe Rust.
- Nothing here depends on rail C existing. If a platform makes extraction
  impossible tomorrow, the feature keeps working for everything it was really
  built for.
