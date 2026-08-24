---
status: accepted
date: 2026-08-24
supersedes: [0010, 0011]
---

# Film production is local, and the remote studio is gone

## Context

Sub Rosa produced films through **Videomaker Studio**
([ADR-0010](0010-videomaker-film-production.md)): a remote service with its own
identity (a wallet signing SIWE messages, a `vmk_` token), its own currency
(DIEM), its own run driver, and its own supervision problem
([ADR-0011](0011-autonomous-film-run-supervision.md)).

[ADR-0017](0017-product-autonomy-from-june.md) says product autonomy is
*enforced*, not merely intended: OS Accounts is deleted, `june_api_url()` has
no remote fallback, and `repository-hygiene.yml` fails any PR that reintroduces
upstream's coordinates. Videomaker was the contradiction left standing. The
binary contacted a second infrastructure that was neither Carpe Diem nor the
user's machine.

Three facts made the question urgent rather than philosophical.

**It was frozen.** The last functional work on the Films surface was around
v1.26; the app reached v1.45 with the module touched only incidentally.

**It cost a great deal to carry.** About 3 100 lines of Rust, a 726-line MCP
server, 640 lines of frontend plus five components, **33 Tauri commands** in
the desktop handler list, three cryptographic dependencies present only to sign
a login message, and a Content Security Policy widened to allow images and
media from any `https:` origin because the studio served signed URLs.

**It cost a great deal to keep working.** A payment rail returning 402 in
windows, provider capacity returning 503, a gateway restart killing a run in
flight, a gate that wedged multi-tenant projects, a 422 on a required field, a
production quote lost inside FastAPI's `detail` envelope, and a run lifecycle
the app could not see. Every one of those was compensated for on this side.

Meanwhile the local Studio had quietly grown the machinery a production needs:
durable workflow runs that survive restarts and iOS suspension
([ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md)),
shot chaining through handoff frames
([ADR-0019](0019-shot-chains-are-parent-links.md)), the gallery as an exchange
format ([ADR-0020](0020-the-gallery-is-the-studio-exchange-format.md)), cost
estimation, approval gates, and a job runner that keeps polling while the app
is closed.

## Decision

**Films are produced by the app, on the user's machine, paid in Carpe Diem
credits, out of the user's own notes. The remote studio is removed.**

Concretely:

- A **script is a note**, and a **shot list** is a derived row on it, resumable
  part by part - the long-form summary pattern
  ([ADR-0027](0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md))
  applied to a different reading.
- A shot list **compiles into a workflow** rather than getting a runtime of its
  own ([ADR-0030](0030-a-production-compiles-into-a-workflow.md)).
- Finishing is local and lossless: an offline mix
  ([ADR-0033](0033-the-mix-is-rendered-offline.md)) and a timeline bundle
  ([ADR-0031](0031-the-timeline-export-is-the-finishing-path.md)).
- Identities persist in a **bible**
  ([ADR-0032](0032-the-bible-is-local-rows-over-gallery-artifacts.md)).
- `repository-hygiene.yml` fails any PR reintroducing `furetier.com`, `vmk_`
  or `videomaker` outside its allowlist. Without that, this decision would be a
  preference rather than a property. Deliberately not `DIEM`: that is a Venice
  balance bucket the credits reader still parses, and a guard that bans a word
  the app legitimately uses is a guard people learn to work around.

Before removal, a **rescue window** shipped: every film could be brought home
as a note plus gallery artifacts, so nothing the user made depends on a service
they no longer run.

## What is genuinely lost

**Production while the app is closed.** The remote studio rendered on a VPS; a
local run needs a foreground session between chained shots. The expensive part
is unaffected - renders are durable `media_jobs` rows that Rust keeps polling
through a close, a suspension or a restart - but stitching a handoff frame and
cutting the film need the webview. Mitigated by compiling graphs whose
independent renders all queue at once, so a thirty-shot film has a handful of
handoff points rather than thirty.

Accepted rather than solved. The escalation exists and is named - a Rust-side
frame extractor over VideoToolbox and Media Foundation, which would reopen what
ADR-0021 rejected - and is deliberately not built, because the need is not
measured.

## What is carried across

These are lessons bought by incidents. They are listed because deleting the
code that learned them is how they get bought twice.

1. **A 402 from the payment rail or a 503 from capacity is not a node
   failure.** Both come and go in windows. Nodes temporise and retry the same
   step, saying what they are waiting for.
2. **Resume is state-based and never re-buys what landed.** Already true
   locally (ADR-0021); it must stay true.
3. **A run that is paused, failed or interrupted must never look idle.** A
   failed run showing nothing after a reload was a real defect, on both sides.
4. **A hard spend envelope, in front of the confirmation.** A production over
   the ceiling is refused at compile time, with the figure, rather than built
   and offered.
5. **Nothing spends without having shown a number first.**

## Alternatives considered

**Keep both, as complementary paths.** Rejected: two pipelines means the user
choosing between them, two vocabularies, two failure modes, and a remote
dependency kept alive for a capability the local path now has.

**Keep the remote studio for unattended production only.** Rejected: it would
keep every one of the costs above - the wallet, the rail, the CSP, the 33
commands - for one property, and that property is precisely the one whose
absence is cheapest to live with.

**Port the run driver locally.** Rejected: it re-litigates
[ADR-0030](0030-a-production-compiles-into-a-workflow.md) before it is written.
The Studio already has a durable executor.

## Consequences

- The binary contacts only Carpe Diem. ADR-0017 is complete rather than
  aspirational.
- The CSP no longer allows images or media from arbitrary remote origins.
- Three dependencies and 33 commands leave the desktop handler list, shrinking
  the divergence between the two `generate_handler!` lists.
- The Videomaker server survives as an independent product in its own
  repository. It simply stops being something Sub Rosa depends on.
