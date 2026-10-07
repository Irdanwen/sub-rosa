# Parity with ChatGPT

What "Sub Rosa has no feature ChatGPT has" means, row by row. The list is the
vendor's own: the plan comparison grid on `chatgpt.com/fr-FR/pricing` (personal
plans, Free to Pro) plus the consumer announcements of DevDay 2026. It was read
on **2026-10-07**. Business administration (SAML, SCIM, admin console, data
residency) is out of this matrix by decision; see ADR-0078.

`src/test/parity-matrix.test.mjs` keeps this file honest (`node scripts/parity-gaps.mjs` rewrites the count after a status changes): every status is one
of the five words below, every `yes` names files that exist, every gap names
the lot that closes it, every `equiv` is explained under "Assumed
equivalences", and the gap count below is the real one.

Statuses: `yes` (at parity or better) · `partial` · `no` · `equiv` (a deliberate
equivalent, explained below) · `n/a` (the platform cannot have it).

Re-read the vendor grid every quarter (January, April, July, October). The
pricing page refuses scripted fetches (HTTP 403): open it in a browser, read
the comparison table under "Comparez les fonctionnalités", and add any row
that is not here as `no` with the lot that will close it. Write the date of
the reading here.

Gaps: 158

## Matrix

| Feature | Desktop | iOS | Android | Web | Evidence | Lot |
|---|---|---|---|---|---|---|
| Unlimited chat with history | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` | P9 |
| Model picker | yes | yes | yes | no | `src/components/settings/ModelPickerDialog.tsx` `src/components/mobile/ModelSheet.tsx` | P9 |
| Reasoning effort control | yes | yes | yes | no | `src/lib/reasoning-effort.ts` `src-tauri/src/hermes_bridge/provider_proxy.rs` | P9 |
| Context window shown | yes | yes | yes | no | `src/components/chat/ContextGauge.tsx` `src/lib/context-gauge.ts` | P9 |
| Streaming replies | yes | yes | yes | no | `src-tauri/src/agent_lite/mod.rs` | P9 |
| Stop a reply | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src-tauri/src/agent_lite/cancel.rs` | P9 |
| Edit a sent message | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` `src-tauri/src/agent_lite/controls.rs` | P9 |
| Regenerate a reply | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` `src-tauri/src/agent_lite/controls.rs` | P9 |
| Branch a conversation | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src-tauri/src/agent_lite/controls.rs` | P9 |
| Copy a reply | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` | P9 |
| Read a reply aloud | yes | yes | yes | no | `src/components/chat/ReadAloudButton.tsx` `src/lib/speakable-text.ts` | P9 |
| Rate a reply | yes | yes | yes | no | `src/components/chat/RateReply.tsx` `src-tauri/src/reply_ratings.rs` | P9 |
| Export a conversation | yes | yes | yes | no | `src-tauri/src/conversation_export/mod.rs` `src/lib/conversation-export.ts` | P9 |
| Search across conversations | yes | yes | yes | no | `src-tauri/src/db/repositories.rs` `src/components/agent/AgentSessionsList.tsx` | P9 |
| Archive a conversation | yes | yes | yes | no | `src-tauri/src/account/session_folders.rs` `src/components/agent/AgentSessionsList.tsx` | P9 |
| Temporary chat | yes | yes | yes | no | `src-tauri/src/temporary_chat/mod.rs` `src/components/agent/TemporaryChat.tsx` | P9 |
| Share a conversation by link | yes | yes | yes | no | `src-tauri/src/account/shares.rs` `website/src/pages/share.tsx` | P9 |
| Custom instructions and personality | yes | yes | yes | no | `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/personalization/mod.rs` `src/components/settings/PersonalizationSettingsSection.tsx` `src/components/mobile/screens/PersonalizationScreen.tsx` | P9 |
| Memory | yes | yes | yes | no | `src/components/settings/MemorySettingsSection.tsx` `src/components/mobile/screens/MemoryScreen.tsx` | P9 |
| Memory of past chats | yes | yes | yes | no | `src-tauri/src/db/repositories.rs` `src-tauri/src/memory/past_chats.rs` | P9 |
| Memory sources shown on a reply | equiv | yes | yes | no | `src-tauri/src/memory/sources.rs` `src/components/mobile/MemorySourcesChip.tsx` `src/components/agent/MemoryInChatIndicator.tsx` | P9 |
| Projects with instructions, files and memory | partial | yes | yes | no | `src/components/folders` `src-tauri/src/projects/mod.rs` `src/components/folders/ProjectSettingsDialog.tsx` `src/components/mobile/screens/ProjectSettingsScreen.tsx` | P3 |
| Shared projects | no | no | no | no | | P9 |
| File uploads (PDF, Word, Excel) | yes | yes | yes | no | `src-tauri/src/assistants/references.rs` `src-tauri/src/documents.rs` `src/components/mobile/ChatComposer.tsx` | P9 |
| Vision | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` | P9 |
| Data analysis | partial | no | no | no | `src/components/settings/ToolsetsSection.tsx` | P4 |
| Interactive tables and charts | no | no | no | no | | P4 |
| Writing and code blocks (canvas) | partial | no | no | no | `src/components/note-editor` | P4 |
| Image generation and editing | yes | yes | yes | no | `src/components/studio/ImageStudio.tsx` | P9 |
| Image generation with thinking | no | no | no | no | | P4 |
| Document scanning | n/a | no | no | n/a | | P4 |
| Virtual try-on | no | no | no | no | | P4 |
| Web search with sources | yes | yes | yes | no | `src-tauri/src/hermes/june_web_mcp.py` `src-tauri/src/agent_lite/mod.rs` | P9 |
| Deep research report | partial | no | no | no | `src/lib/agent-composer-slash-commands.ts` | P5 |
| Apps inside deep research | no | no | no | no | | P6 |
| Study mode | partial | partial | partial | no | `src/components/assistants/AssistantsDialog.tsx` | P5 |
| Work deliverables (documents, sheets, slides) | partial | no | no | no | `src/components/settings/ToolsetsSection.tsx` | P5 |
| Code surface | partial | n/a | n/a | n/a | `src-tauri/src/hermes_bridge.rs` | P5 |
| Scheduled tasks | yes | no | no | no | `src/lib/hermes-routines.ts` `src/components/routines` | P5 |
| Always-available agent | no | no | no | no | | P5 |
| Daily brief | partial | partial | partial | no | `src-tauri/src/moments.rs` | P5 |
| Connectors and plugins | partial | no | no | no | `src/components/settings/McpServersSection.tsx` | P6 |
| Interactive apps in chat | partial | partial | partial | no | `src/components/chat-blocks` | P6 |
| Connector event triggers | no | no | no | no | | P6 |
| Developer mode (custom connectors in chat) | yes | no | no | no | `src/components/settings/McpServersSection.tsx` `src/components/settings/McpSecuritySection.tsx` | P6 |
| Skills | yes | no | no | no | `src/components/settings/InstalledSkillsSection.tsx` | P6 |
| Realtime voice conversation | no | no | no | no | | P7 |
| Voice with camera or screen | no | no | no | no | | P7 |
| Voice with connected apps | no | no | no | no | | P7 |
| Agent browser | no | n/a | n/a | n/a | | P8 |
| Global chat bar | no | n/a | n/a | n/a | | P8 |
| Screen and app awareness | no | n/a | n/a | n/a | | P8 |
| Home screen widgets | n/a | no | no | n/a | | P8 |
| Watch app | n/a | no | n/a | n/a | | P8 |
| Browser extension | no | n/a | n/a | n/a | | P8 |
| Share into the app | n/a | yes | no | n/a | `src-tauri/gen/apple/ShareExtension` | P8 |
| Siri and Shortcuts | n/a | yes | n/a | n/a | `src-tauri/gen/apple/Sources/os-june/Intents` | |
| Spotlight | yes | yes | n/a | n/a | `src-tauri/src/spotlight.rs` | |
| Interface languages | partial | partial | partial | partial | `src/locales/fr.json` | P8 |
| Meeting record mode | yes | yes | yes | n/a | `src-tauri/src/meeting_detection.rs` | |
| Audio uploads to notes | yes | yes | yes | n/a | `src-tauri/src/audio/decode.rs` `src-tauri/src/ingest` | |
| Custom assistants: create | yes | yes | yes | no | `src/components/assistants/AssistantsDialog.tsx` | P9 |
| Custom assistants: discover and share | no | no | no | no | | P9 |
| Public profile | no | no | no | no | | P9 |
| Saved library | partial | partial | partial | no | `src/components/studio` | P4 |
| Sites and pages | no | no | no | no | | P9 |
| Office extensions | no | n/a | n/a | n/a | | P9 |
| Group chats | no | no | no | no | | P9 |
| Health | n/a | no | no | n/a | | P9 |
| Finances | no | no | no | no | | P9 |
| Parental controls | partial | partial | partial | no | `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` | P2 |
| Privacy: no training, data controls | yes | yes | yes | yes | `src-tauri/src/egress.rs` | |
| Account security history | partial | partial | partial | yes | `subrosa-cloud/migrations/0010_security_events.sql` `website/src/pages/security-history.tsx` | P2 |

## Assumed equivalences

- **Memory sources shown on a reply** (desktop): the desktop runtime receives
  memories once, when the session starts (the `sync_june_soul` seam of
  ADR-0009), so the desktop lists the memories a chat was given in the chat
  header rather than under each reply. The phones, which rebuild the prompt on
  every turn, show them per reply (ADR-0081).

## Out of this matrix

- Business administration: SAML single sign-on, SCIM, admin console, roles,
  data residency, enterprise key management. An horizon, not a gap (ADR-0078).
- Business features of the grid: workspace agents, company knowledge base,
  sharing assistants inside a workspace, team tasks, ChatGPT in Slack and
  Teams, workspace connections, agent security policies.
- Platform services for third parties, not features a person uses: "Sign in
  with ChatGPT", the API, Codex Cloud environments and Codex Security.
- Early access to new features: a release channel, which Sub Rosa already has
  as release candidates (ADR-0003), not a capability.
- The vendor's own model names. Parity is measured on capabilities; models are
  the Venice catalog served by Carpe Diem (ADR-0007).
