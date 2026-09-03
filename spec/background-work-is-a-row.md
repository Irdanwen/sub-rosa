# Background work is a durable row, never a long-lived task

**Rule.** Anything that can outlast a foreground session writes a row first
(`notes`, `media_jobs`, `pending_dictations`, `agent_tasks`, `ingests`,
`note_summaries`, `briefs`) and is re-driven from that row by
`crate::background::sweep`. Nothing long lives in a JavaScript promise or a
bare tokio task, and no polling loop is added under `src/lib/studio/`.

**Why.** iOS freezes the webview and suspends the process whenever it likes;
a promise that was waiting simply never resumes, and the work it was watching
is lost with no error anyone sees. A row survives the suspension, the crash
and the reinstall, and the sweep on cold launch, on `Resumed`, and from the
BGTaskScheduler handlers finishes what was started (ADR 0018).

**How to apply.** Design the durable row before the code that does the work:
what state it is in, what re-driving it means, what makes re-driving
idempotent. Whether a row is *live* right now is an in-process question
(`domain::processing::is_processing`, agent-lite's `TurnClaim`, a `Notify`
registry), never a database one, or a warm resume double-runs it.

**Exceptions.** A note rewrite is transient on purpose (ADR 0038): durability
there would resurrect a revision onto a paragraph edited since. Desktop does
not auto-retry a failed note: the manual "retry processing" keeps its meaning.

**Held by.** Review, `src-tauri/tests/agent.rs`, and the sweep's own tests in
`src-tauri/src/background.rs`.
