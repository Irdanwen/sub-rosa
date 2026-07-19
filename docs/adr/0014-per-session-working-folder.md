# ADR-0014: Per-session working folder via a validated Seatbelt grant and restart-on-mismatch

Date: 2026-07-19
Status: Accepted

## Context

Users want to point a chat session at a real project: "work in this folder" —
read the files there, edit them in place, run tools with that directory as
cwd. Before this ADR the runtime always started in the app-owned workspace
(`<hermes_home>/workspace`), and on macOS the Seatbelt write-jail (ADR-0006)
made every user directory read-only, so the agent could only copy results
into its own workspace.

Three prior constraints shape the solution:

- **The jail is fixed at spawn.** `sandbox-exec` applies the profile when the
  process starts; neither the cwd nor the write grants can change on a live
  process. That is why per-session *modes* are served by a pair of processes
  (one per mode, ADR-0006).
- **A user-influenced write grant is an escalation.** `sandbox_write_roots`
  deliberately refused to grant the request's cwd: an unvalidated grant on
  `~` would make `~/.ssh` writable and let the agent poison the profile the
  next spawn reads. The code carried an explicit marker that a project-dir
  feature "would need an explicit, validated grant instead".
- **The runtime keeps at most one process per mode.** cwd is a per-process
  property, but sessions vary per message; two sessions with different
  folders can share one mode.

## Decision

1. **One validated grant, one gate.** A working folder is accepted only
   through `hermes_working_dir::validate_working_dir` (canonicalize, resolve
   symlinks, then refuse: filesystem roots, ancestors or descendants of the
   credential stores — which refuses `~` and its parents for free — the app
   data dir in both directions, system prefixes, exact container dirs like
   `/Volumes` or `/Users`; broad picks like `~/Documents` warn instead of
   refuse). The same function runs at pick time (UI feedback) and at every
   spawn (the folder may have changed underneath). The sandboxed profile
   then adds exactly that canonical path as a write root, plus a **trailing
   secret write-deny** (SBPL last-match-wins) so no present or future grant
   can make a credential store writable — proven by a kernel-level test that
   grants `$HOME` itself and asserts `~/.ssh` stays unwritable.

2. **Restart-on-mismatch, not process-per-folder.** Processes stay keyed by
   mode only. A start request carries a working-folder *requirement*
   (tri-state: no preference / default workspace / this folder); when the
   mode's live process serves a different folder, the backend stops that
   mode and respawns into the required one. Every send passes the target
   session's recorded folder, so a session's folder is re-enforced exactly
   like its recorded mode. Background callers (auto-start, reconnects,
   usage/compress RPCs) pass no preference and can never move a runtime a
   session deliberately pointed at a folder.

3. **Per-session record in localStorage,** mirroring `agent-session-modes.ts`
   (`june.agent.sessionWorkingDirs`), holding the canonical path. Absence =
   default workspace, the safe fallback direction. The record is dropped on
   session deletion (a recycled id must not inherit a folder its user never
   picked) and deliberately kept when a folder is temporarily unavailable —
   a send then falls back to the default workspace with a notice, and a
   replugged drive re-applies on the next send.

4. **The agent is told, per spawn.** The working folder rides
   `HERMES_ENVIRONMENT_HINT` (per-process, like the sandbox-status line —
   correct granularity because a folder change restarts the process), on
   every platform including Windows where no jail exists and the cwd alone
   would leave the agent guessing. SOUL.md gains one mode-split-level
   sentence describing the concept.

## Consequences

- Switching between two sessions of the same mode with different folders
  restarts that mode's runtime on each cross-send; in-flight runs of other
  sessions in that mode die with it (surfaced by the v1.20.0
  interrupted-turn banner, with retry). Accepted: folder switches are
  user-initiated sends, and the alternative below was worse.
- Reads outside the folder remain as open as before (ADR-0006's read
  posture); the working folder is a write scope and an attention scope, not
  a read prison. The UI copy says so.
- A folder containing project-local secrets (`.env`, keys in-tree) is
  writable and readable by design — same trade every coding agent makes;
  the home-anchored credential stores stay blocked at the kernel.
- The Files panel and file preview/download treat the live working folders
  as roots, so agent output in the user's folder is visible in-app.

## Alternatives considered

- **Key processes by `(mode, folder)`** — no restarts, but N concurrent
  Hermes runtimes (each a Python dashboard + provider connections) for
  marginal benefit, a process-reaping problem the bridge doesn't have today,
  and the same shared-home config races ADR-0006 warns about, multiplied.
  Rejected.
- **Grant without validation (just use `request.cwd`)** — rejected for the
  escalation reasons above; this is the exact hole the old
  `sandbox_write_roots` comment refused to open.
- **Store the folder in `agent_tasks` (SQLite)** — durable and visible to
  SQL, but it splits the two spawn parameters (mode in localStorage, folder
  in DB) across stores read at the same two seams (send routing, badge
  render), and localStorage loss degrades to the safe default anyway.
  Rejected for symmetry with the mode record; revisit only if session
  metadata as a whole moves server-side.
- **Multiple folders per session** — deferred, not rejected: the grant
  mechanism generalizes to a list, but the UI, the hint wording, and the
  mismatch equality all get meaningfully more complex. One folder covers the
  dominant "work on this project" case.
