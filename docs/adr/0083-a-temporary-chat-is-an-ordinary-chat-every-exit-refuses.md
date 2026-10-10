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

## Addendum 2026-10-08: the runtime's own memory is closed too

The consequence above ("the agent could still write a fact to Hermes' own
memory directory") was a leak, and it is closed.

**What the pinned runtime offers, checked in its source** (v2026.7.20,
`tui_gateway/server.py`, `agent/tool_executor.py`, `hermes_cli/plugins.py`):
`config.set` has no memory or toolset key; `tools.configure` rewrites the
shared `config.yaml`, so it would switch memory off for every chat at once;
`skip_memory` is read from the process environment (`HERMES_IGNORE_RULES`),
so it is per process, not per session. There is no per-session switch. There
is a `pre_tool_call` plugin hook, asked on the sequential and the concurrent
dispatch path before any tool runs, with the id of the session the call
belongs to; a `block` answer becomes the tool's result and the tool never
runs. The background memory and skill review runs under its parent's session
id, so it is asked too.

**Decision.** The app installs a Hermes user plugin, `subrosa_guard`
(`src-tauri/src/hermes/subrosa_guard.py`, written to
`$HERMES_HOME/plugins/` and enabled in the `config.yaml` the app writes at
every runtime start), and keeps a ledger beside it, `subrosa-guard.json`,
listing the stored session ids of the temporary chats
(`hermes_bridge/guard.rs`). The plugin refuses `memory` and `skill_manage`
in those sessions and in any session descended from one (a branch, or a
continuation the runtime forks when it compacts), walking `state.db`'s
parent links. `temporary_chat_register` writes the ledger before it returns,
and the webview sends the first message only after, so not even the first
turn can write; a ledger that cannot be written fails the registration and
the send. Leaving or sweeping a chat rewrites it. A ledger that exists but
cannot be read refuses the guarded tools; a call with no session id while a
temporary chat is open is refused rather than guessed at.

**What a temporary chat still has**: every other tool, including reading
memory and searching past sessions (recall works, as decided above).

**Rejected.** Routing desktop temporary chats through agent-lite (ADR-0058)
closes the leak by having no runtime memory at all, but costs the chat every
runtime tool (files, terminal, browser, skills, MCP servers, sub-agents,
routines), which would make "temporary" a different product. Stripping the
memory tool from requests in the provider proxy (it can tell a temporary
session by a model alias, as ADR-0080 does for effort) does not close it:
the runtime dispatches by its own tool registry, so a model that calls
`memory` without being offered it would still be obeyed.

**Verified** against the pinned runtime's own plugin manager (the plugin
loads from a `config.yaml` like the app's, and `resolve_pre_tool_block`
returns the refusal for a temporary session and nothing for another), and in
`hermes_bridge::guard::tests`, which run the installed plugin in Python
against a ledger and a `state.db`.

## Addendum 2026-10-10: the exits the audit found

The post-release audit of 1.89.0 found four more ways out, now closed:

- **Deep research and study mode** refuse in Rust when the chat they are
  started from is temporary, by task id or by desktop session id
  (`temporary_chat::refuse_in_temporary`, called by `research::chat_of` and
  by `study::set_mode` and `study::add_cards`). A report and a deck are kept,
  listed and synchronised on their own. Both composers stop offering them in
  a temporary chat (`ComposerModes`, shared by the two shells); Review stays,
  since it is about cards already kept. Tests:
  `temporary_chat::tests::deep_research_is_refused_from_a_temporary_chat`,
  `study_mode_and_its_cards_are_refused_in_a_temporary_chat`,
  `src/test/study-mode.test.tsx`.
- **The gallery.** The desktop agent's media tools save every generation
  into the Studio gallery (`/v1/media/save`) and `make_document` writes a
  file there (`/v1/media/document`); the gallery is synchronised. These
  requests come from the `june_media` MCP server, which serves every session
  of the runtime and is never told which one called it, so the provider
  proxy cannot tell a temporary chat's request from another's. The refusal
  is made where the session is known: the `subrosa_guard` plugin now refuses
  `generate_image`, `generate_video`, `generate_music`, `check_media` and
  `make_document` in a temporary session and its descendants (and while a
  temporary chat is open, in a call that names no session), from the same
  ledger Rust writes. A Rust check in the proxy was considered and rejected:
  without a session it could only refuse every chat's media while any
  temporary chat is open. Test: `hermes_bridge::guard::tests`.
- **The runtime's files.** Hermes' `DELETE /api/sessions/{id}` removes the
  session from `state.db` but leaves `sessions/request_dump_{id}_*.json`,
  `{id}.json`, `{id}.jsonl` and `session_{id}.json`, which hold the
  conversation. Rust deletes them once the runtime has answered
  (`temporary_chat::remove_session_files`, an id that is not the runtime's
  own shape never becomes a path). Test:
  `temporary_chat::tests::the_runtimes_files_for_a_session_go_with_it`.

## Addendum 2026-10-10: the runtime's log

The parity run of 1.89.1 found one more trace: the pinned runtime logs the
start of every turn at INFO into `hermes/logs/agent.log`, with the first 80
characters of the message (`agent/turn_context.py`, "conversation turn:
session=... msg=..."). After a temporary chat was left, its rows and its
session were gone, and that line stayed.

**Decision.** The `subrosa_guard` plugin, which the runtime loads before any
turn (plugin discovery runs when `model_tools` is imported), adds a
`logging.Filter` to the runtime's `agent.turn_context` logger. The record
carries the session id as its first argument, so the plugin checks it
against the same ledger and lineage as the tool hook, and replaces the
message argument with `[temporary chat]` for a temporary session or one
descended from it, for a record that names no session while a temporary
chat is open, and when the ledger cannot be read. The line itself stays: it
says a turn started, not what was said. Every other chat's line is left as
the runtime wrote it, since it is the runtime's only per-turn diagnostic.

**Rejected.** Changing the runtime (it is pinned, and the fix would be
re-merged at every bump); redacting every turn's message (the session is
known at log time, so there is no need to blind the diagnostic for every
chat); scrubbing `agent.log` when a temporary chat ends (a rewrite of a file
the runtime holds open, after the words were already on disk).

**Not covered.** Lines written before this change stay in `agent.log` and
its rotated copies until the runtime rotates them away.

**Verified** in `hermes_bridge::guard::tests::the_plugin_keeps_a_temporary_chats_words_out_of_the_turn_log`
(the installed plugin, registered as the runtime registers it, in Python),
and against the pinned runtime's own plugin discovery and `setup_logging`:
`agent.log` received `msg='[temporary chat]'` for the temporary session and
the words for an ordinary one.
