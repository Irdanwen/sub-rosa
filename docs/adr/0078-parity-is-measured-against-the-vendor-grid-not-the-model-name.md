---
status: accepted
date: 2026-10-07
---

# Parity is measured against the vendor's grid, not the model's name

## Context

The product goal set on 2026-10-07 is that Sub Rosa has no feature ChatGPT
has and it lacks. "Feature" has no fixed meaning: marketing pages list
categories ("Voice", "Work"), release notes list launches that are retired a
quarter later (the canvas was folded into chat blocks in May 2026), and a
comparison made from memory drifts the day it is written.

Three things had to be settled: which list counts, what counts as closing a
row, and what Sub Rosa deliberately does differently without calling it a gap.

## Decision

1. **The list is the vendor's plan comparison grid** on
   `chatgpt.com/fr-FR/pricing` for the personal plans (Free to Pro), plus the
   consumer launches of DevDay 2026. It is copied into
   `docs/parity/chatgpt.md`, one row per feature and one column per platform
   (desktop, iOS, Android, web), each status backed by the files that carry it.
2. **The matrix is checked, not trusted.** `src/test/parity-matrix.test.mjs`
   fails when a status is not one of `yes`, `partial`, `no`, `equiv`, `n/a`,
   when a `yes` names a file that does not exist, when a gap names no lot,
   when an `equiv` is not explained, or when the announced gap count is not
   the real one. "No feature behind" means no `no` and no `partial` cell.
3. **Capabilities, not model names.** The vendor's models are not served here;
   parity is the capability (a reasoning effort control, a voice conversation,
   a chart), on the Venice catalog that Carpe Diem serves (ADR-0007).
4. **Boundaries are not traded for a row.** A row is closed inside the
   decisions already taken: inference stays between the device and Carpe Diem,
   the account server stays a blind courier (ADR-0049), background work stays
   durable rows (ADR-0018), and agents run only while an app is open, the
   desktop app in the menu bar included (decision of 2026-10-07). Where the
   vendor's version needs one of those crossed, the row is closed by an
   equivalent and marked `equiv` with its reason.
5. **Business administration is outside the matrix** (SAML, SCIM, admin
   console, roles, data residency): an horizon, recorded as such, not a gap.
6. **The grid is re-read every quarter.** A row the vendor adds enters as `no`.

## Consequences

- "Are we behind?" has an answer a test can give, and the answer moves when
  the vendor moves.
- Some rows close as equivalents rather than copies, and say so in the same
  file, so nobody mistakes a deliberate boundary for an oversight.
- The web column is honest from the start: most rows read `no` there until a
  browser client exists.
