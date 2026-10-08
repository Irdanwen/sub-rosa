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

Gaps: 6

## Matrix

| Feature | Desktop | iOS | Android | Web | Evidence | Lot |
|---|---|---|---|---|---|---|
| Unlimited chat with history | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Model picker | yes | yes | yes | yes | `src/components/settings/ModelPickerDialog.tsx` `src/components/mobile/ModelSheet.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Reasoning effort control | yes | yes | yes | yes | `src/lib/reasoning-effort.ts` `src-tauri/src/hermes_bridge/provider_proxy.rs` `website/src/client/ui/WebClient.tsx` |  |
| Context window shown | yes | yes | yes | yes | `src/components/chat/ContextGauge.tsx` `src/lib/context-gauge.ts` `website/src/client/ui/WebClient.tsx` |  |
| Streaming replies | yes | yes | yes | yes | `src-tauri/src/agent_lite/mod.rs` `website/src/client/ui/WebClient.tsx` |  |
| Stop a reply | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src-tauri/src/agent_lite/cancel.rs` `website/src/client/ui/WebClient.tsx` |  |
| Edit a sent message | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` `src-tauri/src/agent_lite/controls.rs` `website/src/client/ui/WebClient.tsx` |  |
| Regenerate a reply | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` `src-tauri/src/agent_lite/controls.rs` `website/src/client/ui/WebClient.tsx` |  |
| Branch a conversation | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src-tauri/src/agent_lite/controls.rs` `website/src/client/ui/WebClient.tsx` |  |
| Copy a reply | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Read a reply aloud | yes | yes | yes | yes | `src/components/chat/ReadAloudButton.tsx` `src/lib/speakable-text.ts` `website/src/client/ui/WebClient.tsx` |  |
| Rate a reply | yes | yes | yes | yes | `src/components/chat/RateReply.tsx` `src-tauri/src/reply_ratings.rs` `website/src/client/ui/WebClient.tsx` |  |
| Export a conversation | yes | yes | yes | yes | `src-tauri/src/conversation_export/mod.rs` `src/lib/conversation-export.ts` `website/src/client/ui/WebClient.tsx` |  |
| Search across conversations | yes | yes | yes | yes | `src-tauri/src/db/repositories.rs` `src/components/agent/AgentSessionsList.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Archive a conversation | yes | yes | yes | yes | `src-tauri/src/account/session_folders.rs` `src/components/agent/AgentSessionsList.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Temporary chat | yes | yes | yes | yes | `src-tauri/src/temporary_chat/mod.rs` `src/components/agent/TemporaryChat.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Share a conversation by link | yes | yes | yes | yes | `src-tauri/src/account/shares.rs` `website/src/pages/share.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Custom instructions and personality | yes | yes | yes | yes | `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/personalization/mod.rs` `src/components/settings/PersonalizationSettingsSection.tsx` `src/components/mobile/screens/PersonalizationScreen.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Memory | yes | yes | yes | yes | `src/components/settings/MemorySettingsSection.tsx` `src/components/mobile/screens/MemoryScreen.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Memory of past chats | yes | yes | yes | yes | `src-tauri/src/db/repositories.rs` `src-tauri/src/memory/past_chats.rs` `website/src/client/ui/WebClient.tsx` |  |
| Memory sources shown on a reply | equiv | yes | yes | yes | `src-tauri/src/memory/sources.rs` `src/components/mobile/MemorySourcesChip.tsx` `src/components/agent/MemoryInChatIndicator.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Projects with instructions, files and memory | yes | yes | yes | yes | `src/components/folders` `src-tauri/src/projects/mod.rs` `src/components/folders/ProjectSettingsDialog.tsx` `src/components/mobile/screens/ProjectSettingsScreen.tsx` `src-tauri/src/hermes_bridge/project_memory.rs` `website/src/client/ui/WebClient.tsx` |  |
| Shared projects | yes | yes | yes | partial | `src-tauri/src/account/spaces/commands.rs` `src/components/spaces/SpaceDialog.tsx` `website/src/client/spaces/SpacesPanel.tsx` | P9 |
| File uploads (PDF, Word, Excel) | yes | yes | yes | yes | `src-tauri/src/assistants/references.rs` `src-tauri/src/documents.rs` `src/components/mobile/ChatComposer.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Vision | yes | yes | yes | yes | `src/components/agent/AgentWorkspace.tsx` `src/components/mobile/screens/AgentScreen.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Data analysis | yes | yes | yes | yes | `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/data_cards.rs` `src-tauri/src/agent_lite/python.rs` `src/lib/python/bridge.ts` `src-tauri/src/agent_lite/python_selftest.rs` `website/src/client/analysis` |  |
| Interactive tables and charts | yes | yes | yes | yes | `src/components/chat-blocks/ChartCard.tsx` `src/components/chat-blocks/TableCard.tsx` `src/lib/chat-blocks-data.ts` `website/src/client/ui/WebClient.tsx` |  |
| Writing and code blocks (canvas) | yes | yes | yes | yes | `src/components/note-editor` `src/components/canvas/CanvasHost.tsx` `src/components/canvas/CanvasPane.tsx` `src/components/chat-blocks/CanvasCard.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Image generation and editing | yes | yes | yes | yes | `src/components/studio/ImageStudio.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Image generation with thinking | yes | yes | yes | yes | `src-tauri/src/image_refine.rs` `src/lib/image-refine.ts` `website/src/client/ui/WebClient.tsx` |  |
| Document scanning | n/a | yes | yes | n/a | `src-tauri/src/scan/mod.rs` `src-tauri/src/scan/ios.rs` `src-tauri/src/scan/android.rs` |  |
| Virtual try-on | yes | yes | yes | yes | `src/components/studio/TryOnPanel.tsx` `src/components/chat-blocks/TryOnCard.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Web search with sources | yes | yes | yes | yes | `src-tauri/src/hermes/june_web_mcp.py` `src-tauri/src/agent_lite/mod.rs` `website/src/client/research` |  |
| Deep research report | yes | yes | yes | yes | `src/lib/agent-composer-slash-commands.ts` `src-tauri/src/research/mod.rs` `src/components/research/ResearchDialog.tsx` `src-tauri/src/docx.rs` `website/src/client/research` |  |
| Apps inside deep research | yes | yes | yes | partial | `src-tauri/src/connectors/research.rs` `website/src/client/research` | P9 |
| Study mode | yes | yes | yes | yes | `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/study/mod.rs` `src/lib/study-blocks.ts` `src/components/study/StudyReview.tsx` `website/src/client/study` |  |
| Work deliverables (documents, sheets, slides) | yes | yes | yes | yes | `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/deliverables/mod.rs` `src/components/chat-blocks/FileCard.tsx` `website/src/client/documents` |  |
| Code surface | yes | n/a | n/a | n/a | `src-tauri/src/hermes_bridge.rs` `src-tauri/src/code_review/mod.rs` `src/components/agent/CodeReviewPanel.tsx` |  |
| Scheduled tasks | yes | equiv | equiv | equiv | `src/lib/hermes-routines.ts` `src/components/routines` `src-tauri/src/assignments/mod.rs` `website/src/client/assignments` |  |
| Always-available agent | equiv | equiv | equiv | equiv | `src-tauri/src/assignments/mod.rs` `website/src/client/assignments` |  |
| Daily brief | yes | yes | yes | partial | `src-tauri/src/moments.rs` `src-tauri/src/moments/daily.rs` `src/components/assignments/TodaySurface.tsx` `src/components/mobile/screens/TodayScreen.tsx` `website/src/client/assignments` | P9 |
| Connectors and plugins | yes | yes | yes | partial | `src/components/settings/McpServersSection.tsx` `src-tauri/src/connectors/mcp.rs` `src-tauri/src/connectors/catalog.rs` `src/components/settings/ConnectorsSection.tsx` `website/src/client/connectors` | P9 |
| Interactive apps in chat | yes | yes | yes | yes | `src/components/chat-blocks` `src/components/chat-blocks/ConnectorAppCard.tsx` `src-tauri/src/connectors/apps.rs` `website/src/client/connectors` |  |
| Connector event triggers | equiv | equiv | equiv | equiv | `src-tauri/src/connectors/triggers.rs` `website/src/client/assignments` |  |
| Developer mode (custom connectors in chat) | yes | yes | yes | partial | `src/components/settings/McpServersSection.tsx` `src/components/settings/McpSecuritySection.tsx` `src-tauri/src/connectors/mcp.rs` `website/src/client/connectors` | P9 |
| Skills | yes | yes | yes | yes | `src/components/settings/InstalledSkillsSection.tsx` `src-tauri/src/skill_packs/mod.rs` `src/components/mobile/SkillSlashMenu.tsx` `website/src/client/skills` |  |
| Realtime voice conversation | yes | yes | yes | yes | `src-tauri/src/voice/engine.rs` `src-tauri/src/voice/machine.rs` `src/components/voice/VoiceConversation.tsx` `website/src/client/voice` |  |
| Voice with camera or screen | yes | yes | yes | yes | `src-tauri/src/voice/screen.rs` `src/components/voice/VoiceConversation.tsx` `src-tauri/src/voice/screen_windows.rs` `website/src/client/voice` |  |
| Voice with connected apps | yes | yes | yes | yes | `src-tauri/src/voice/engine.rs` `website/src/client/voice` |  |
| Agent browser | yes | n/a | n/a | n/a | `src-tauri/src/agent_browser/mod.rs` |  |
| Global chat bar | yes | n/a | n/a | n/a | `src-tauri/src/chat_bar/mod.rs` |  |
| Screen and app awareness | yes | n/a | n/a | n/a | `src-tauri/src/screen_awareness/mod.rs` |  |
| Home screen widgets | n/a | yes | yes | n/a | `src-tauri/gen/apple/Widgets` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/AskWidgetProvider.kt` |  |
| Watch app | n/a | yes | n/a | n/a | `src-tauri/gen/apple/Watch` `src-tauri/src/watch_relay.rs` |  |
| Browser extension | yes | n/a | n/a | n/a | `browser-extension/manifest.json` `src-tauri/src/browser_extension/mod.rs` |  |
| Share into the app | n/a | yes | yes | n/a | `src-tauri/gen/apple/ShareExtension` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/ShareReceiverActivity.kt` `src-tauri/src/share_inbox.rs` |  |
| Siri and Shortcuts | n/a | yes | n/a | n/a | `src-tauri/gen/apple/Sources/os-june/Intents` | |
| Spotlight | yes | yes | n/a | n/a | `src-tauri/src/spotlight.rs` | |
| Interface languages | yes | yes | yes | partial | `src/locales/fr.json` `src/locales/de.json` `src/locales/it.json` `src/locales/es.json` `src/locales/pt-BR.json` `scripts/i18n/verify-catalogs.mjs` | P9 |
| Meeting record mode | yes | yes | yes | n/a | `src-tauri/src/meeting_detection.rs` | |
| Audio uploads to notes | yes | yes | yes | n/a | `src-tauri/src/audio/decode.rs` `src-tauri/src/ingest` | |
| Custom assistants: create | yes | yes | yes | yes | `src/components/assistants/AssistantsDialog.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Custom assistants: discover and share | yes | yes | yes | yes | `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` `website/src/pages/assistants.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Public profile | yes | yes | yes | yes | `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` `website/src/pages/assistants.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Saved library | yes | yes | yes | yes | `src/components/studio` `src/components/library/LibraryView.tsx` `src/components/chat/LibraryActions.tsx` `src-tauri/src/account/sync_tables.rs` `website/src/client/ui/WebClient.tsx` |  |
| Sites and pages | yes | yes | yes | yes | `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` `website/src/pages/assistants.tsx` `website/src/client/ui/WebClient.tsx` |  |
| Office extensions | yes | n/a | n/a | yes | `office-addins/manifests/excel.xml` `office-addins/manifests/word.xml` `office-addins/manifests/powerpoint.xml` |  |
| Group chats | yes | yes | yes | yes | `src-tauri/src/account/spaces/turns.rs` `src/components/spaces/SpaceChat.tsx` `website/src/client/spaces/client.ts` |  |
| Health | yes | yes | yes | n/a | `src-tauri/src/health/mod.rs` `src/components/personal-data/HealthView.tsx` | P9 |
| Finances | yes | yes | yes | yes | `src-tauri/src/finance/mod.rs` `src/components/personal-data/FinancesView.tsx` `website/src/client/finance` |  |
| Parental controls | equiv | equiv | equiv | equiv | `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` `src-tauri/src/protected_mode/restrictions.rs` `website/src/client/protected` |  |
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
  (ADR-0084). On the web the same guards are a per-browser PIN lock
  (ADR-0104). There is no parent account and no notification to a parent.
- **Always-available agent**, **Scheduled tasks** (phones) and
  **Connector event triggers**: the vendor runs
  its agents and tasks on its own servers, around the clock. Sub Rosa's
  decision of 2026-10-07 is that agents run only while an app is open (the
  desktop app in the menu bar counts), never on the account server
  (ADR-0049). Assignments and phone tasks therefore run on the app's own clock:
  on the desktop while it is open (offered at login), on a phone in the
  foreground or opportunistically in the background, otherwise handed to a
  paired desktop as an errand, and a missed slot runs once, marked late
  (ADR-0091). A browser tab with the web client open counts as an open
  app and runs what names it (ADR-0104). When every app is closed, nothing
  runs.

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
