# ADR-0123: Code events are one neutral contract with two adapters

Date: 2026-10-23. Status: accepted. Builds on
[ADR-0090](0090-office-files-are-written-by-the-app-and-code-mode-reviews-from-a-recorded-start.md)
(Code mode), [ADR-0014](0014-per-session-working-folder.md) (the working
folder grant), [ADR-0027](0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)
(nothing in `june-api/`) and [ADR-0063](0063-the-sidecar-streams-agent-chat.md)
(a streamed turn metered from its last frame). Lots C0.3 (the contract half) and C0.2 of the Code
plan. No migration.

## Context

The Code plan runs code work on more than one engine: Hermes, bundled, driven
through its gateway (`/api/ws`); later Claude Code and opencode, installed by
the person and driven over ACP. Each speaks its own wire. The chat already
reads Hermes through `src/lib/hermes-control-plane/` (`JuneHermesEvent`), a
classification shaped for a conversation: it knows transcripts, tool phases
and pending actions, not what a tool touched, what a modification did, what a
shell printed, or what the run cost. Everything the Code plan builds next (the
bench, a headless CLI, the review surface, the step timeline, CI) needs those,
and needs them the same way whatever the engine.

## Decision

1. **One contract, `CodeEvent`**, in Rust (`src-tauri/src/code/event.rs`, the
   reference) and TypeScript (`src/lib/code/events.ts`). Sixteen types:
   `run.started/finished`, `turn.started/finished`, `message.delta/completed`,
   `tool.started/progress/completed`, `terminal.output`,
   `approval.requested/resolved`, `todo.updated`, `step.recorded` (reserved for
   the P1 timeline, emitted by no adapter yet), `usage`, `error`. A tool call
   has a `kind` (read, edit, shell, search, delegate, other) and a `detail`
   (path, lines, command, query, and for an edit its strategy, formatter,
   diagnostics, line counts and diff, each optional because no engine reports
   all of them today). It extends what `JuneHermesEvent` says about a turn; it
   does not replace it for the chat.
2. **The line format follows `codex exec --json`**: one JSON object per line,
   `type` at the top level, snake_case fields, an envelope of `schema`,
   `run_id`, `seq` (continued across resumed invocations) and `at`. The schema
   version (1) changes only when an existing field or type changes meaning or
   goes; a new type or optional field is additive, and a consumer skips a type
   it does not know.
3. **Rust writes the fixture, TypeScript reads it.** A Rust test writes
   `src/lib/code/fixtures/code-events.v1.json` (one of each type, every
   optional field filled once) and fails when it is stale; `src/test/code-events.test.ts`
   parses every line with the TypeScript validator. Neither side can drift
   without a red test.
4. **Two adapters, one per wire.** The Hermes gateway adapter
   (`src-tauri/src/code/hermes_adapter.rs`) is pure: frames in, events out. It
   is pinned by the chat's replay corpus and by a recorded real run
   (`hermes-v0.19-run.frames.json`) whose output is committed beside it
   (`hermes-v0.19-run.events.json`); a second Hermes adapter, should the
   webview ever need one, must produce that same output from those frames.
   The ACP adapter (Claude Code, opencode) comes with P4.
5. **What Hermes v0.19 actually sends decides the mapping, not its names.**
   `thinking.delta` is the runtime's spinner line ("(¬_¬) synthesizing...",
   then empty), not reasoning, so it is dropped; `reasoning.delta` is the
   reasoning. `tool.start` carries a display label, never the arguments, so
   `tool.started` gets a `label` and its `detail` waits for the completion. A
   `message.complete` with `status: "error"` is an `error`, not a reply.
6. **The first host is a headless CLI, `subrosa-code run`** (C0.2,
   [docs/code-cli.md](../code-cli.md)). Its load-bearing choices:
   - It reuses the app's code rather than restating it: the sidecar's command
     and stdin secrets (`sidecar::backend_program`, `configure_backend`,
     `spawn_with_secrets`), the bridge's config rendering, guard plugin,
     Seatbelt profile, isolated environment and chat-completions forwarding
     (`hermes_bridge/headless.rs`, which the app's own spawn now also calls for
     the runtime check and the profile). What took an `AppHandle` now takes
     paths.
   - It has its **own Hermes home** (`<data>/code-cli/hermes`): the app
     rewrites its home's `config.yaml` with its own proxy port at every spawn,
     and two writers there would point one runtime at the other's proxy. One
     run at a time per data folder, under a lock, for the same reason.
   - The **run budget** is enforced from the operator's own metering of every
     completion that crosses the CLI's in-process proxy
     (`carpe_diem::cache_stats`), never from the runtime's token counts. A run
     stops by interrupting its turn once the budget is reached, so it ends over
     the budget by at most one completion; a model whose completions carry no
     price stops the run, because a budget that cannot be enforced is not one.
   - **Plan mode is enforced by the jail**: the folder is simply not granted to
     the Seatbelt profile, so a plan run cannot write it. Without the jail
     (not macOS, or the escape hatch set) plan mode refuses to start rather
     than degrade to a promise.
   - No one answers mid-run: the `clarify` toolset is off, a flagged command
     is denied unless `--approvals once`, sudo and secret requests are denied,
     a question that still arrives gets a fixed answer. Each is reported as
     `approval.requested` then `approval.resolved` by `policy`.
   - The key comes from `SUBROSA_DEV_API_KEY` first, in every build, without
     touching the keychain (a keychain prompt would hang a run no one
     watches), then from the app's keychain.
   - The binary sits behind the `code-cli` Cargo feature: the Tauri CLI bundles
     every binary of the package whose required features are enabled, and the
     app must not ship an unsigned second executable.

## Consequences

- The bench (C0.1), CI (C5.2) and the server mode (C6.4) read one stream of
  JSON lines. The Code surface (C1) consumes the same events; whether the
  webview gets them from a Rust observer of the gateway or by forwarding its
  frames to this adapter is decided there, under point 4.
- `hermes_bridge.rs` lost lines (the chat-completions forwarding moved into
  `provider_proxy.rs`, the profile writing into `headless.rs`), so its size
  ratchet goes down, not up.
- Upgrading Hermes means re-recording the run fixture and reading the diff of
  its committed events (a step added to docs/hermes-upgrade-checklist.md).
- The CLI's first run in a data folder seeds a Hermes home of its own (skills,
  the security scanner the runtime downloads on demand), separate from the
  app's.

## Alternatives rejected

- **Reuse `JuneHermesEvent` as the contract.** It is Hermes-shaped (its
  `pending_action` and `background_activity` mirror gateway families) and
  carries raw payloads; an ACP engine would have to pretend to be Hermes.
- **Drive Hermes over its ACP server too, so one adapter serves all engines.**
  The plan's study: ACP loses clarify, sudo and secret, subagent events,
  `tool.output_risk`, compress and branch, and wakes for background processes,
  shares `os.environ` between two prompts, and refuses approvals after 60 s.
- **A JSON Schema file both sides generate types from.** A second toolchain in
  both builds for sixteen types; the Rust-written fixture checks the same thing
  with what each side already runs.
- **Share the app's Hermes home from the CLI.** Simpler, and wrong: the two
  processes would rewrite one `config.yaml` with different proxy ports.
- **Count the budget from Hermes' `usage` tokens times a price table.** A
  second price source to keep right; the operator already reports what each
  completion cost.
