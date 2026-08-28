# 36. Reports are GitHub Issues, filed with the user's own credential

Date: 2026-08-28

## Status

Accepted

## Context

Upstream June files a user's in-app report as an Issue on its own tracker,
through a bot key held by the hosted backend
(`OsPlatformIssueReportSink`). This fork has no hosted backend and no bot key,
so `june-api/config.toml` leaves that destination blank. The sink only builds
with a key, so the sidecar falls back to `LogIssueReportSink`, which writes the
report to `june-api.log` and returns `Ok(())`.

The app then told the user: "Your report was sent to the Sub Rosa team."

Nothing was sent, and nothing ever had been. The report was real, the log line
was real, and the sentence on screen was false. That is the problem this record
is about; the destination is only how it gets fixed.

The tracker is this repo's own Issues: `Irdanwen/sub-rosa`, public, issues
enabled. What was not obvious is **whose credential opens them**, because two
of the three answers are unavailable to this fork.

## Decision

**Reports become Issues on `Irdanwen/sub-rosa`, opened with a credential the
user holds, by one of two paths, and the UI says which one happened.**

1. **A GitHub token in the OS keychain** (Settings › Reports). The app opens
   the Issue itself and hands back its URL. The token is stored exactly like
   the Carpe Diem key: keychain only, never returned to the frontend, only its
   presence. A logged-in GitHub CLI can hand its token over with one button,
   because everyone who works on this app already ran `gh auth login` and
   minting a second credential by hand is a worse first run than pressing a
   button.
2. **No token: the browser.** The app opens GitHub's own new-issue form with
   the title and body already filled in, and the user presses Submit under
   their own account. Nothing to configure, and they read what they are about
   to file before it is filed.

Anything else - offline, a refused token, a shell with no browser - falls back
to the pre-existing local log, and **the message names that outcome**. A
`Delivery` enum crosses IPC for exactly this reason: `received: true` only ever
meant "the call did not throw", which is how the lie got printed in the first
place.

Two supporting decisions:

- **It lives fork-side**, in `src-tauri/src/carpe_diem/issue_reports.rs`, not
  in `june-api/`. Every line in `june-api/` is a line `upstream-sync.yml`
  re-merges forever, and upstream's sink is aimed at a different tracker with a
  different auth model. The sidecar keeps its log sink untouched as the floor.
- **A heading is a title.** The report prompt already asks the agent to head
  each distinct problem with `Issue 1: <short title>`, and says in as many
  words that it is the title "the team can use as the tracker title". So one
  heading titles one Issue, several headings make several Issues, and only a
  report with no heading at all falls back to the first line the user typed.
  The tempting shortcut - "fewer than two headings is not a split, use the
  description" - throws the written title away in the commonest case and files
  "it broke again, third time this week" over it. A heading never also appears
  in the body it titles.

## Alternatives considered

**A bot token shipped in the binary.** The upstream shape. Rejected outright:
the source repo is public and so are the builds, so a credential inside is a
credential published, and anyone holding it could file as the project.

**A relay holding the token.** A small service on the maintainer's VPS would
give every user silent filing under one identity. It is also precisely the
remote infrastructure this fork exists without (ADR-0017): one operator, no Sub
Rosa server, nothing to keep running for a feature that files bug reports.

**Keep the local log and just fix the sentence.** Honest, and nearly free. It
also leaves the maintainer reading log files for reports, which is not a
reporting system. Kept as the fallback rather than the destination.

**Email, or a form service.** A second vendor, an address to keep alive, and a
destination that is not where the work happens. Issues are already where this
project's work is tracked.

## Consequences

- **A report without a token is one click from being filed, not filed.** The
  browser path ends with a form the user must submit. The copy says so, and
  `issue-report-outcome.ts` is tested to keep it saying so.
- **Screenshots are named, never uploaded.** GitHub's REST API cannot attach a
  file to an Issue. The names go in the body so the reader knows to ask.
- **The browser body is trimmed to ~5,000 characters** to survive a query
  string, and says where it was cut. The token path carries the whole thing.
- **A user who is not the maintainer files under their own GitHub account.**
  Anyone can open an issue on a public repo, so this works; it also means the
  reporter is identifiable to themselves, which is honest, and that labels are
  ignored for anyone without push access, which is why they are best-effort.
- Nothing here reaches a Sub Rosa server, because there still is not one.
