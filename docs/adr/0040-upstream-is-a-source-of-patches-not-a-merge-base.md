# ADR 0040: Upstream June is a source of patches, not a merge base

- Status: accepted
- Date: 2026-09-02

## Context

Sub Rosa forked June at `bce09361` (2026-07-01). Since then the fork has
landed 1 270 commits of its own (the Carpe Diem sidecar, iOS, memory, the
Studio, imports, the council, the note surface, the hardening pass) and
upstream has landed 993. The fork has never merged upstream. What it has done,
twice, is read upstream's log and cherry-pick the fixes worth having: the
v1.25.2 recovery took six (a blank window, the ⌘K palette, the chat menu, a
HUD shadow, two macOS lifecycle fixes) and deliberately left the rest.

`upstream-sync.yml` was written for the other model: every Monday it pushed
upstream's tip to a branch and opened a pull request from it. It failed for
five weeks because the Actions token may not push workflow files, and when
that was fixed on 2026-09-02 the pull request it produced (#83) touched 1 484
files, +340 590 / −139 639 lines: the whole of the fork's divergence, with
`june-api/crates/providers/src/venice.rs` (3 191 lines, the one file both
sides rewrite) at its centre. Nobody will review that, and merging it blind is
what ADR 0017 and the repository-hygiene guard exist to prevent.

Two decisions elsewhere hang on this one. `docs/threat-model.md` leaves the
Carpe Diem key in the sidecar's environment with a single justification,
"moving it to stdin would mean changing `june-api/`, which every upstream sync
re-merges forever. Revisit if the app stops tracking upstream." And ADR 0027
keeps fork features out of `june-api/` for the same reason.

## Decision

**The fork does not merge upstream. It reads upstream and takes patches.**

- `upstream-sync.yml` no longer opens a pull request. Every Monday it lists
  the upstream commits that have appeared since the last review in a single
  issue, "Upstream digest", one line per commit with its subject and link.
  Closing the issue, or moving the marker, records that the log was read.
  The marker is `.github/upstream-reviewed`: the upstream commit up to which
  the log has been looked at.
- A fix worth having is cherry-picked onto `main`, one upstream commit per
  fork commit, with the upstream hash in the message, and it goes through
  the same guards as anything else (the hygiene job refuses a reintroduced
  June coordinate; the PR template asks what was deliberately not taken).
- `june-api/` is therefore no longer a re-merge surface. Changes there are
  still kept small, because a cherry-pick into it is easier when it is close
  to upstream, but the "forever" argument is gone. In particular the sidecar
  may now receive the upstream key on stdin rather than in its environment,
  which the threat model can stop listing as out of scope once that lands.
- Pull request #83 stays closed as the record of what a merge would cost.

## Alternatives considered

- **Keep the weekly merge PR and resolve it once.** Two months of upstream on
  a fork that rewrote the same files is not one afternoon of conflicts; it is
  a re-fork. And the week after, the same PR reopens with a week's worth.
- **Rebase the fork onto upstream.** Rewrites 1 270 commits of history the
  release tags point at; the updater's signed artifacts are keyed to those
  tags.
- **Stop reading upstream.** Loses the fixes the two recoveries show are
  worth having. Reading is cheap; merging is what was expensive.

## Consequences

- Upstream drift is measured, not fought: the digest says how many commits
  are unread, and the marker says how far the reading went.
- A cherry-pick may need adapting (paths moved, names changed); that
  adaptation is the fork's, and the commit says what it changed.
- FORK_NOTES § 13 ("procédure de synchronisation upstream") is superseded by
  this ADR's procedure.
- The `upstream-sync` label and the `upstream-sync` branch are retired.
