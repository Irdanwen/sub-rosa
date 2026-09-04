# June enforceable coding rules

Read every spec in your scope before writing code; **violations should fail
review.** When you add, rename, or remove a spec, update this index in the same
commit — it is the single source of truth for what rules exist. Each spec is
**Rule / Why / How to apply / Exceptions**.

These rules are summarized in [AGENTS.md](../AGENTS.md); the files here are the
authoritative, reviewable version.

## Frontend — UI copy

- [sentence-case](sentence-case.md) — sentence case for all UI labels
- [no-typographic-dashes](no-typographic-dashes.md) — no en/em dashes in user-facing copy
- [one-voice](one-voice.md) — address the reader, name their action, no jokes in failures

## Frontend — UI styling

- [icons-central-only](icons-central-only.md) — icons from `central-icons` / `central-icons-filled` only
- [design-tokens](design-tokens.md) — use the variables in `src/styles/tokens.css`

## Frontend — the note body

- [note-controls-must-serialize](note-controls-must-serialize.md) — no editor control without a markdown representation and a round-trip test

## Rust — the shell and the backend

The invariants below were held by tests with no readable rule next to them;
each spec names the test that holds it.

- [shared-commands-in-both-lists](shared-commands-in-both-lists.md) — every shared Tauri command is registered in both `generate_handler!` lists
- [no-write-path-over-ipc](no-write-path-over-ipc.md) — no command takes a destination path; the native dialog opens in Rust
- [every-egress-declared](every-egress-declared.md) — one HTTP client factory, every reachable host a declared constant
- [secrets-are-redacted-types](secrets-are-redacted-types.md) — a credential is a `Redacted<T>`, never in the environment, delivered to the backend on stdin
- [no-fork-feature-in-june-api](no-fork-feature-in-june-api.md) — fork features keep their prompts and routes in `src-tauri/`
- [background-work-is-a-row](background-work-is-a-row.md) — long work writes a durable row first and is re-driven by the sweep
- [modal-focus](modal-focus.md) — every modal surface takes keyboard and focus from `useModalFocus` (one Escape, one Tab trap, one restore)
- [copy-through-t](copy-through-t.md) — every sentence a person can read goes through `t()`, and the French catalog is a gate (ADR-0047)
