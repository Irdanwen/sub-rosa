---
status: accepted
date: 2026-08-21
---

# Chat blocks are in-band fenced JSON, and their data flows through the proxy

## Context

We want rich, interactive cards inside assistant replies — link previews for
web citations, a places card with a map — on both shells. The two chats have
very different plumbing: the desktop renders Hermes transcripts with a
hand-rolled markdown renderer in AgentWorkspace, the phone renders
`agent_messages.content` (a flat TEXT column) with SimpleMarkdown, and mobile
tool results never reach the frontend at all (they are strings fed back to the
model; `agent_tool_events` stays empty for agent-lite). The webview CSP allows
`img-src https:` but blocks external `connect-src`, all iframes, and any
third-party script, and neither webview honors `target="_blank"`.

Three transports were on the table for card payloads: (a) a custom syntax
inside the message text, (b) rendering from tool events, (c) a new
event/column pair.

## Decision

Cards travel **in the message text**, as fenced code blocks whose info string
is `subrosa:<kind>` and whose body is one versioned JSON object (`"v": 1`).
Both markdown renderers intercept the fence: a valid payload mounts the card,
an unterminated fence in a still-running reply mounts a skeleton, and anything
else falls through to the ordinary code block. Parsing lives in
`src/lib/chat-blocks.ts` and treats the payload as untrusted model output:
never throws, length caps, clamped list sizes, https-only URLs, domains
derived rather than trusted. The prompts that teach the syntax (agent-lite's
`SYSTEM_PROMPT`, the Hermes soul's `JUNE_SOUL_BLOCKS_MD`) ship in the same
build as the renderer, so capability and instruction cannot drift apart.

Card **data** comes from tools and stays on the app's existing data path
(june-api → Carpe Diem augment for web results; later place providers join
the same june-api surface). The webview never fetches from a third party, no
iframe or external script is introduced, and every outbound click routes
through the `open_external_url` command (https-only; default browser on
desktop, `UIApplication openURL:` on iOS) because the webviews drop
`target="_blank"`.

## Consequences

- Blocks persist verbatim in `agent_messages.content` and Hermes transcripts:
  reload, history, copy, and export need no new schema, and one spec serves
  both runtimes.
- Degradation is built in: an app version without the parser (or an invalid /
  hallucinated payload) shows a readable JSON code block, never a broken card.
- The model can, in principle, garble a payload the tool returned correctly;
  validation drops it to the code block and the prompt's "copy tool JSON
  verbatim" rule makes it rare. We accepted this over (b)'s asymmetry — rich
  on desktop via `structuredContent`, impossible on mobile without new
  plumbing and persistence.
- New kinds extend the same envelope (`subrosa:<kind>`, `"v"` bump for
  breaking shape changes); renderers ignore kinds they do not know, which
  keeps old builds safe when newer models emit newer blocks.
