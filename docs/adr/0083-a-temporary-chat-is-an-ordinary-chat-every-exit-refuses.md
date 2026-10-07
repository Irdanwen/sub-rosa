---
status: accepted
date: 2026-10-07
---

# A temporary chat is an ordinary chat that every exit refuses

## Context

The parity matrix (ADR-0078) left "Temporary chat" open: a conversation that
is not saved, not remembered, and gone once you leave it. A chat in Sub Rosa
reaches much further than its own screen. Its messages feed the history lists
and search, the full-text index past-chat recall reads (ADR-0081), memory
extraction (ADR-0009), the chat title the model writes, the account outbox
(ADR-0049), the portable copy of a desktop Hermes session, and the archive
(ADR-0042). On the desktop it also lives in a Hermes session in `state.db`.

## Decision

1. **A temporary chat is an `agent_tasks` row with `ephemeral = 1`
   (migration 046).** It runs on the same machinery as any chat, so nothing
   in the turn loop forks. The flag is written in the `INSERT` that creates
   the row, so no trigger ever sees the row without it. The flag is local and
   never travels.
2. **Every exit asks the flag, and each one has its own test**
   (`src-tauri/src/temporary_chat/tests.rs`): the general list, the
   portable conversation list and `list_agent_tasks`; the FTS triggers
   (rewritten in 046 with a `WHEN`) and the search join; past-chat recall;
   memory extraction on the phone (`extract_after_turn`) and on the desktop
   (`memory_extract` refuses a temporary session id, and the webview never
   asks); chat titles (`mark_first_reply`); the account outbox triggers and
   the first inventory, down to the tombstone of a deletion; the mirror of a
   desktop session into portable history; the archive; and a branch, which is
   temporary too. A temporary chat cannot be shared by link either.
3. **Deleted when left, swept at the next launch.** The webview holds an open
   temporary chat and deletes it when its surface moves to another chat or
   goes away (with a short grace for a remount). Whatever a crash or a quit
   leaves is deleted the first time the database opens in a process. A
   desktop chat is deleted through Hermes' own `DELETE /api/sessions/{id}`,
   which takes its messages and search rows out of `state.db`; until the
   runtime answers, the rows stay, hidden from every list, and the sweep
   retries once it does. Children are deleted before the chat row, so the
   outbox triggers can still ask the parent and stay silent.
4. **Liveness is in process** (ADR-0018): the sessions opened by this process
   are a registry in memory, never a database column. A row from an earlier
   process is, by definition, one nobody is looking at.
5. **Unmistakable on screen.** A switch on the new chat screen of both shells,
   and a banner, "Temporary chat: not saved, not remembered", at the head of
   the chat while it is open. Its title is always "Temporary chat".

## Consequences

- Recall still works inside a temporary chat: it may read memories and past
  chats. It only never becomes one of them.
- The Hermes runtime has its own memory tool and session search. While a
  desktop temporary chat is open, the agent could still write a fact to
  Hermes' own memory directory (distinct from Sub Rosa's user memory) if it
  decided to call that tool; the session itself is deleted on leaving.
- A turn still running when the chat is left is cut short with it.

## Alternatives rejected

- **A separate table or an in-memory chat.** Every turn path (agent-lite, the
  background resume sweep, Hermes) would need a second code path, and a crash
  mid-turn would lose the durability ADR-0018 asks for.
- **Suppressing the outbox with the `applying` flag while writing.** It would
  silence every other table written in the same window, and it hides the
  rule inside a write instead of stating it in the trigger.
- **Relying on the FTS gate alone for search and past chats.** A row that
  reached the index another way would leak; the joins ask the flag too.
