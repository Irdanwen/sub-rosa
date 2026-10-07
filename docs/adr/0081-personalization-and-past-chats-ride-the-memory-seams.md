---
status: accepted
date: 2026-10-07
---

# Personalization and past chats ride the memory seams, and a reply records its memories

## Context

The parity matrix (ADR-0078) left three rows open around personal context:
custom instructions with a personality, a memory of past chats ("reference
chat history"), and showing which memories a reply used. Each could have been
built as its own pipeline. The two chat shells already have exactly one place
each where personal context enters the prompt (ADR-0009): the desktop SOUL,
written when the Hermes runtime starts, and the phone's system prompt, rebuilt
every turn. Custom assistants carry their own instructions and memory
permission (ADR-0058) and must not inherit the default chat's voice.

## Decision

1. **One personalization block, at the memory seams only.** Three settings
   (about the user, how to respond, a preset among six personalities) render
   one pure block (`personalization::render_block`, capped at 1500 characters
   a field, nothing when empty or off). The phone adds it in the default
   chat's prompt next to the memory block; the desktop writes it into the SOUL
   next to the memory block. `assistants::runtime::system_prompt` never sees it.
2. **The SOUL's personal section is marked and rewritten in place.** The
   desktop section (personalization, memory, the past-chats line) sits between
   `<!-- sub-rosa:personal-context -->` markers, present even when empty.
   Saving personalization splices the section of the existing `SOUL.md`, so a
   chat started afterwards reads it without restarting the runtime. Memory
   switches keep their spawn-time behaviour, because the MCP tools they gate
   are fixed when the runtime starts.
3. **Personalization stays on the device.** Settings files have no sync codec
   (the account syncs table rows and one reserved credential object, ADR-0049),
   and adding one for a single file was not worth a contract change. Each
   device keeps its own; the settings copy says so.
4. **Past chats are searched, never summarised.** "Reference past chats" is a
   memory setting (`reference_chat_history`, on by default with memory). It
   reads `agent_messages_fts` at the moment of use: up to five screened
   excerpts of other general chats ride along with a phone turn (1500
   characters at most), and a `search_past_chats` tool (agent-lite, and the
   read-only `june_context` MCP on the desktop, withheld by `--memory=off` or
   `--past-chats=off`) reaches further. A custom assistant's conversation is
   never quoted. Nothing is stored ahead of time, so switching it off leaves
   nothing behind.
5. **A reply records the memories it was given** (migration 044,
   `memory_source_records` + `memory_sources`, ids only, local). On the phone
   the owner is the user message that opened the turn, so recording stays out
   of the reply-writing path; a rerun replaces it. On the desktop the runtime's
   injection is held in process and a stored session is bound to it the first
   time the chat is shown, only if the session began after the runtime: an
   older session stays unrecorded rather than credited with facts it may never
   have read. Listing joins the ids to the memories that still exist.

## Consequences

- A change to personalization reaches the phone's next message and the
  desktop's next new chat; a desktop chat already open keeps the SOUL it began
  with. Memories the desktop agent looks up mid-chat through
  `search_user_memories` are not part of "Memory in this chat".
- Past-chat excerpts cost one FTS query and, when a reflex is configured, one
  screen per phone turn, within a 1.5 s budget that falls back to nothing.
- Two devices with an account show different personalization until a settings
  codec exists; adding one later is additive.

## Alternatives rejected

- **A separate prompt section per feature, or a new seam in Hermes' prompt
  assembly.** Pinned upstream code (ADR-0009); the SOUL is the sanctioned seam.
- **Restarting the runtime when personalization changes.** It would cut any
  running turn short for a preference.
- **Summarising past chats into memories ahead of time.** That is extraction's
  job already; a second store would duplicate it and outlive the switch.
- **Keying the phone's record on the reply id.** The reply is written by the
  turn's persistence path, which other work owns; the opening user message is
  known before the call and identifies the same turn.
