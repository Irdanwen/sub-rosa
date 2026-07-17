---
status: accepted
date: 2026-07-17
---

# Mid-conversation model switching: the model is a property of the turn, not the session

## Context

Users want to start a conversation on one model and continue it on another —
because a model returns busy (`429`/`503 MODEL_INFRA_SATURATED`, see
[ADR-0012](0012-upstream-rate-limit-distinct-from-provider-failure.md)), gives a
weak answer, or they simply want a second model's take. Today the app has two
chat engines that treat "the model" oppositely:

- **Mobile (agent-lite)** is stateless per turn: every turn re-sends the whole
  transcript with `model` as a request field (`agent_lite/mod.rs`), so the model
  is already a per-turn choice.
- **Desktop (Hermes)** runs a long-lived runtime, **one process per write-access
  mode** (not per session), configured with a single `model.default`. Switching
  a live session dispatches the `/model` slash command over the gateway
  (`switchActiveSessionModel`). That dispatch bounces off the gateway's `4009`
  "session busy" guard whenever a turn is in flight — exactly when a busy model
  makes the user want to switch — so it fails with "Could not switch the running
  session."

A feasibility pass (recorded here so it is not re-run) established the load-bearing
constraints:

- The Hermes gateway server (`tui_gateway/server.py`) is **not in this repo**, so
  `/model`'s real effect is unverifiable from the code. Its "success" is a bare
  non-throwing ack; there is no confirming event (raw `model.switch`/`model.changed`
  frames classify as `unsupported`), and the smoke gate treats even a `4xxx`
  refusal as a pass. We cannot know whether `/model` re-binds the running
  session's model, nor whether it is per-session or per-process (a per-process
  rebind would clobber other concurrent same-mode sessions).
- `session.resume` carries **no model** — a persisted transcript cannot be
  reopened under a different model. Only `session.create` accepts a `model`, and
  only for a brand-new session (a fresh transcript).
- The desktop provider proxy is a **single shared, stateless** loopback server
  that forwards a standard OpenAI body with **no session id**. It cannot tell two
  concurrent same-mode sessions apart, so it cannot carry a per-session model
  override.

## Decision

**Treat the model as a property of the next turn, and make the conversation
portable across models — without relying on a live Hermes `/model` rebind.**

Concretely, three seams, all built on the reliable primitives:

1. **In-place per-turn switch (mobile).** The chosen model is a per-turn request
   field, so switching continues the same chat on the new model with full
   history. The choice is persisted **per session** (`agent_tasks.model`,
   migration via `ensure_column`) so it survives reopen — the app-wide default
   only seeds new chats.

2. **Resend / retry on the chosen model (both shells).** A turn that dies on a
   transient busy error keeps its message (mobile never loses it; desktop's
   composer already restores it, and the busy notice re-asks the last message),
   and the retry runs on whatever model is currently selected. Switching the
   picker then retrying = continue on another model, with no live `/model`.

3. **Fork onto another model (portable conversation).** `fork_agent_task` copies
   a chat's transcript into a new task bound to a chosen model, so the
   conversation branches onto a different model while the original stays intact
   (compare two models, or re-ask a busy turn on a fresh one). This is the
   robust "portable conversation": it uses only transcript copy + a
   per-turn/per-create model, never a live rebind.

## Alternatives rejected

- **Proxy-authoritative per-session model override (desktop).** Rewrite
  `body["model"]` at the shared proxy per session. **Blocked:** the proxy is
  shared and stateless, sees no session id, and one process multiplexes many
  same-mode sessions — it cannot differentiate them. It would only work if the
  Hermes runtime itself emitted a per-session model, which is the unverifiable
  `/model` path.

- **Reliable live `/model` rebind (desktop), e.g. interrupt → `/model` → resend.**
  Rejected as the *primary* mechanism because `/model`'s effect and granularity
  are unverifiable from this repo (runtime is upstream/out-of-repo), and a
  per-process rebind could corrupt concurrent same-mode sessions. The existing
  best-effort `/model` dispatch stays for the idle-session happy path, but the
  UI never claims the running session switched unless the gateway accepts it, and
  the durable choice is the per-chat override that applies next run.

## Consequences

- Continuity across models is delivered by mechanisms whose reliability we can
  verify in-repo (per-turn field, transcript copy, `session.create` model),
  rather than by an opaque runtime command.
- A desktop fork/retry resubmits the last user message, so a re-asked turn shows
  the message again in the transcript — honest history ("send again"), not a
  silent in-place regenerate.
- New shared commands (`set_agent_task_model`, `fork_agent_task`) must live in
  **both** `generate_handler!` lists, per the fork's mobile/desktop split.
- If a future, in-repo Hermes gateway makes `/model` verifiable (a confirming
  event, documented per-session semantics), seam (1) can extend to desktop
  in-place switching without revisiting seams (2) and (3).
