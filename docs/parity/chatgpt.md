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

Gaps: 85

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
| Projects with instructions, files and memory | yes | yes | yes | no | `src/components/folders` `src-tauri/src/projects/mod.rs` `src/components/folders/ProjectSettingsDialog.tsx` `src/components/mobile/screens/ProjectSettingsScreen.tsx` `src-tauri/src/hermes_bridge/project_memory.rs` | P9 |
| Shared projects | no | no | no | no | | P9 |
| File uploads (PDF, Word, Excel) | yes | yes | yes | no | `src-tauri/src/assistants/references.rs` `src-tauri/src/documents.rs` `src/components/mobile/ChatComposer.tsx` | P9 |
| Vision | yes | yes | yes | no | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` | P9 |
| Data analysis | yes | yes | yes | no | `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/data_cards.rs` `src-tauri/src/agent_lite/python.rs` `src/lib/python/bridge.ts` `src-tauri/src/agent_lite/python_selftest.rs` | P9 |
| Interactive tables and charts | yes | yes | yes | no | `src/components/chat-blocks/ChartCard.tsx` `src/components/chat-blocks/TableCard.tsx` `src/lib/chat-blocks-data.ts` | P9 |
| Writing and code blocks (canvas) | yes | yes | yes | no | `src/components/note-editor` `src/components/canvas/CanvasHost.tsx` `src/components/canvas/CanvasPane.tsx` `src/components/chat-blocks/CanvasCard.tsx` | P9 |
| Image generation and editing | yes | yes | yes | no | `src/components/studio/ImageStudio.tsx` | P9 |
| Image generation with thinking | yes | yes | yes | no | `src-tauri/src/image_refine.rs` `src/lib/image-refine.ts` | P9 |
| Document scanning | n/a | yes | yes | n/a | `src-tauri/src/scan/mod.rs` `src-tauri/src/scan/ios.rs` `src-tauri/src/scan/android.rs` |  |
| Virtual try-on | yes | yes | yes | no | `src/components/studio/TryOnPanel.tsx` `src/components/chat-blocks/TryOnCard.tsx` | P9 |
| Web search with sources | yes | yes | yes | no | `src-tauri/src/hermes/june_web_mcp.py` `src-tauri/src/agent_lite/mod.rs` | P9 |
| Deep research report | yes | yes | yes | no | `src/lib/agent-composer-slash-commands.ts` `src-tauri/src/research/mod.rs` `src/components/research/ResearchDialog.tsx` `src-tauri/src/docx.rs` | P9 |
| Apps inside deep research | yes | yes | yes | no | `src-tauri/src/connectors/research.rs` | P9 |
| Study mode | yes | yes | yes | no | `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/study/mod.rs` `src/lib/study-blocks.ts` `src/components/study/StudyReview.tsx` | P9 |
| Work deliverables (documents, sheets, slides) | yes | yes | yes | no | `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/deliverables/mod.rs` `src/components/chat-blocks/FileCard.tsx` | P9 |
| Code surface | yes | n/a | n/a | n/a | `src-tauri/src/hermes_bridge.rs` `src-tauri/src/code_review/mod.rs` `src/components/agent/CodeReviewPanel.tsx` |  |
| Scheduled tasks | yes | equiv | equiv | no | `src/lib/hermes-routines.ts` `src/components/routines` `src-tauri/src/assignments/mod.rs` | P9 |
| Always-available agent | equiv | equiv | equiv | no | `src-tauri/src/assignments/mod.rs` | P9 |
| Daily brief | yes | yes | yes | no | `src-tauri/src/moments.rs` `src-tauri/src/moments/daily.rs` `src/components/assignments/TodaySurface.tsx` `src/components/mobile/screens/TodayScreen.tsx` | P9 |
| Connectors and plugins | yes | yes | yes | no | `src/components/settings/McpServersSection.tsx` `src-tauri/src/connectors/mcp.rs` `src-tauri/src/connectors/catalog.rs` `src/components/settings/ConnectorsSection.tsx` | P9 |
| Interactive apps in chat | yes | yes | yes | no | `src/components/chat-blocks` `src/components/chat-blocks/ConnectorAppCard.tsx` `src-tauri/src/connectors/apps.rs` | P9 |
| Connector event triggers | equiv | equiv | equiv | no | `src-tauri/src/connectors/triggers.rs` | P9 |
| Developer mode (custom connectors in chat) | yes | yes | yes | no | `src/components/settings/McpServersSection.tsx` `src/components/settings/McpSecuritySection.tsx` `src-tauri/src/connectors/mcp.rs` | P9 |
| Skills | yes | yes | yes | no | `src/components/settings/InstalledSkillsSection.tsx` `src-tauri/src/skill_packs/mod.rs` `src/components/mobile/SkillSlashMenu.tsx` | P9 |
| Realtime voice conversation | yes | yes | yes | no | `src-tauri/src/voice/engine.rs` `src-tauri/src/voice/machine.rs` `src/components/voice/VoiceConversation.tsx` | P9 |
| Voice with camera or screen | partial | yes | yes | no | `src-tauri/src/voice/screen.rs` `src/components/voice/VoiceConversation.tsx` | P7 |
| Voice with connected apps | yes | yes | yes | no | `src-tauri/src/voice/engine.rs` | P9 |
| Agent browser | no | n/a | n/a | n/a | | P8 |
| Global chat bar | no | n/a | n/a | n/a | | P8 |
| Screen and app awareness | no | n/a | n/a | n/a | | P8 |
| Home screen widgets | n/a | yes | yes | n/a | `src-tauri/gen/apple/Widgets` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/AskWidgetProvider.kt` |  |
| Watch app | n/a | yes | n/a | n/a | `src-tauri/gen/apple/Watch` `src-tauri/src/watch_relay.rs` |  |
| Browser extension | no | n/a | n/a | n/a | | P8 |
| Share into the app | n/a | yes | yes | n/a | `src-tauri/gen/apple/ShareExtension` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/ShareReceiverActivity.kt` `src-tauri/src/share_inbox.rs` |  |
| Siri and Shortcuts | n/a | yes | n/a | n/a | `src-tauri/gen/apple/Sources/os-june/Intents` | |
| Spotlight | yes | yes | n/a | n/a | `src-tauri/src/spotlight.rs` | |
| Interface languages | partial | partial | partial | partial | `src/locales/fr.json` | P8 |
| Meeting record mode | yes | yes | yes | n/a | `src-tauri/src/meeting_detection.rs` | |
| Audio uploads to notes | yes | yes | yes | n/a | `src-tauri/src/audio/decode.rs` `src-tauri/src/ingest` | |
| Custom assistants: create | yes | yes | yes | no | `src/components/assistants/AssistantsDialog.tsx` | P9 |
| Custom assistants: discover and share | no | no | no | no | | P9 |
| Public profile | no | no | no | no | | P9 |
| Saved library | yes | yes | yes | no | `src/components/studio` `src/components/library/LibraryView.tsx` `src/components/chat/LibraryActions.tsx` `src-tauri/src/account/sync_tables.rs` | P9 |
| Sites and pages | no | no | no | no | | P9 |
| Office extensions | no | n/a | n/a | n/a | | P9 |
| Group chats | no | no | no | no | | P9 |
| Health | n/a | no | no | n/a | | P9 |
| Finances | no | no | no | no | | P9 |
| Parental controls | equiv | equiv | equiv | no | `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` `src-tauri/src/protected_mode/restrictions.rs` | P9 |
| Privacy: no training, data controls | yes | yes | yes | yes | `src-tauri/src/egress.rs` | |
| Account security history | yes | yes | yes | yes | `subrosa-cloud/migrations/0010_security_events.sql` `website/src/pages/security-history.tsx` `src-tauri/src/account/security_events.rs` `src/components/settings/AccountSecurityHistory.tsx` |  |

## Assumed equivalences

- **Memory sources shown on a reply** (desktop): the desktop runtime receives
  memories once, when the session starts (the `sync_june_soul` seam of
  ADR-0009), so the desktop lists the memories a chat was given in the chat
  header rather than under each reply. The phones, which rebuild the prompt on
  every turn, show them per reply (ADR-0081).
- **Parental controls** (desktop, iOS, Android): the vendor links a parent's
  account to a teen's and enforces the limits on its servers. Sub Rosa's
  account server is a blind courier (ADR-0049) and holds no settings it could
  enforce, so the same limits (adult models and Studio safe mode, quiet hours,
  memory, image and video generation, voice, past chats) are a protected mode
  on the device, behind a PIN, enforced in Rust where requests leave
  (ADR-0084). There is no parent account and no notification to a parent.
- **Always-available agent**, **Scheduled tasks** (phones) and
  **Connector event triggers**: the vendor runs
  its agents and tasks on its own servers, around the clock. Sub Rosa's
  decision of 2026-10-07 is that agents run only while an app is open (the
  desktop app in the menu bar counts), never on the account server
  (ADR-0049). Assignments and phone tasks therefore run on the app's own clock:
  on the desktop while it is open (offered at login), on a phone in the
  foreground or opportunistically in the background, otherwise handed to a
  paired desktop as an errand, and a missed slot runs once, marked late
  (ADR-0091). When every app is closed, nothing runs.

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
