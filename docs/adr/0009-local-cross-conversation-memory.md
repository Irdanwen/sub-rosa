---
status: accepted
date: 2026-07-10
---

# Cross-conversation user memory: local SQLite, prompt-time injection, direct embeddings

> **Fork-only ADR (Sub Rosa).** The memory store, extraction, and recall live
> in `src-tauri/src/memory/` plus one table in the app database; june-api is
> untouched.

Sub Rosa remembers durable facts about the user ("prefers answers in French",
"works on the Lexion project") across conversations, on both shells. The
design follows the publicly documented recipe of Venice's Memoria system
(automatic extraction every 3rd assistant reply over the last 5+5 messages,
importance-scored 1-10 with lower = more important and > 8 discarded, hybrid
keyword + vector recall), adapted to the fork's architecture. Four decisions
here are load-bearing:

1. **Memories persist in the app's SQLite (`memories` table, migration 010),
   not in browser storage and not in Hermes' own memory files.** One store
   serves both chat pipelines (desktop Hermes, mobile agent-lite), survives
   webview resets, ships in the existing DB backup story, and is readable by
   the read-only `june_context` MCP for on-demand recall.

2. **Injection happens at prompt-build time, differently per pipeline.**
   Mobile rebuilds the agent-lite system prompt every turn, so the top-20
   block is always fresh. Desktop injects the block into `SOUL.md` at Hermes
   spawn time — facts extracted mid-session only reach the soul at the next
   runtime start, and the `search_user_memories` MCP tool covers the gap.
   We deliberately did NOT patch Hermes' per-turn prompt assembly: that is
   pinned upstream code, and SOUL.md is the fork's sanctioned injection seam.

3. **Desktop extraction is triggered from the frontend, not from Rust.**
   Desktop transcripts live inside Hermes (not in `agent_messages`), so the
   only place that reliably sees every completed turn is the workspace's
   terminal-event handler; it counts assistant completions per session and
   calls the `memory_extract` command with the recent window. Mobile has a
   real Rust post-turn hook (`agent_lite_run`) and uses it directly. The
   extraction prompt, cadence, filtering, and dedup are one shared Rust path
   (`memory/extract.rs`) either way.

4. **Embeddings call Carpe Diem's `/embeddings` directly from the Tauri
   process (BGE-M3, 1024-dim), not through the june-api sidecar** — the same
   pattern ADR 0008 established for Studio media. June never priced embedding
   models, so the sidecar's authorize/charge pipeline has no lane for them;
   a direct reqwest call works identically on desktop and iOS and keeps
   fork-only lines out of the weekly upstream merge path. Vectors are stored
   as little-endian f32 BLOBs and backfilled best-effort; recall merges
   keyword LIKE and cosine rankings with Reciprocal Rank Fusion, and degrades
   to keyword-only when embedding is unavailable (offline, no key).

## Consequences

- Privacy matches the fork's posture: memories exist only in the local DB;
  the extraction window and embedding inputs transit Carpe Diem exactly like
  any chat message. Disabling memory stops injection/extraction/recall but
  does not delete anything (deletion is an explicit "forget" action).
- The `memory.json` toggles (`enabled`, `auto_extract`) snapshot into the
  Hermes MCP config at spawn (`--memory=off` hides the recall tool), so a
  toggle change reaches desktop sessions at the next runtime start.
- A desktop session closed before its 3rd assistant reply extracts nothing;
  accepted (identical to Memoria's client-side behavior).
- The extraction model rides the chat-completions proxy default; a dedicated
  cheaper model is a later knob, not a schema change.

## Alternatives rejected

- **A `/v1/embeddings` route in june-api**: four layers (domain trait,
  provider, service, handler) of fork-only code in the hottest merge files,
  plus pricing-table entries for a model class upstream deliberately filters
  out of its catalog.
- **FTS5 or a vector index in SQLite**: the corpus is one user's facts
  (hundreds, not millions); brute-force cosine over a few hundred 1 KB
  vectors is microseconds. Revisit only if document-import lands.
- **Letting the agent write its own memories via an MCP tool**: writes from
  the sandboxed Python MCP would add a second SQLite writer process; all
  writes stay in the Rust process, the MCP stays read-only.
