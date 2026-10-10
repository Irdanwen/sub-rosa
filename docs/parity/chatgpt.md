# Parity with ChatGPT

What "Sub Rosa has no feature ChatGPT has" means, row by row. The list is the
vendor's own: the plan comparison grid on `chatgpt.com/fr-FR/pricing` (personal
plans, Free to Pro) plus the consumer announcements of DevDay 2026. It was read
on **2026-10-07**. Business administration (SAML, SCIM, admin console, data
residency) is out of this matrix by decision; see ADR-0078.

`src/test/parity-matrix.test.mjs` keeps this file honest (`node scripts/parity-gaps.mjs`
rewrites the three counters after a status changes): every status is one of
the seven words below, every claimed cell is backed by a file of its own
platform, every gap names the lot that closes it and only a gap names a lot,
every `equiv` is explained under "Assumed equivalences", every `gated` and
`unverified` cell is named with its dependency under "Gated" and "Unverified",
and the counters below are the real ones.

Statuses: `yes` (at parity or better, and reachable in the shipped build) ·
`partial` · `no` · `equiv` (a deliberate equivalent, explained below) · `n/a`
(the platform cannot have it) · `gated` (built and shipped, but it works only
after an external deployment, credential or review that Sub Rosa does not
control; named under "Gated") · `unverified` (shipped, but never run on the
target hardware; named under "Unverified").

Evidence is grouped per platform: `D:` desktop, `i:` iOS, `A:` Android, `W:`
web, each followed by backticked paths. A cell that claims anything (`yes`,
`partial`, `equiv`, `gated`, `unverified`) needs at least one existing path in
its own group: a file that only the desktop compiles does not prove a phone
row. `Gaps` counts `no` and `partial` cells only; `gated` and `unverified`
cells have their own counters, so a gate is never mistaken for parity.

Re-read the vendor grid every quarter (January, April, July, October). The
pricing page refuses scripted fetches (HTTP 403): open it in a browser, read
the comparison table under "Comparez les fonctionnalités", and add any row
that is not here as `no` with the lot that will close it. Write the date of
the reading here.

Gaps: 0
Gated: 62
Unverified: 14

## Matrix

| Feature | Desktop | iOS | Android | Web | Evidence | Lot |
|---|---|---|---|---|---|---|
| Unlimited chat with history | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` · i: `src/components/mobile/screens/AgentScreen.tsx` `src-tauri/src/agent_lite/mod.rs` · A: `src/components/mobile/screens/AgentScreen.tsx` `src-tauri/src/agent_lite/mod.rs` · W: `website/src/client/ui/WebClient.tsx` |  |
| Model picker | yes | yes | yes | gated | D: `src/components/settings/ModelPickerDialog.tsx` · i: `src/components/mobile/ModelSheet.tsx` · A: `src/components/mobile/ModelSheet.tsx` · W: `website/src/client/ui/WebClient.tsx` `website/src/client/models.ts` |  |
| Reasoning effort control | yes | yes | yes | gated | D: `src/lib/reasoning-effort.ts` `src-tauri/src/hermes_bridge/provider_proxy.rs` · i: `src/components/mobile/ReasoningEffortRow.tsx` `src/lib/reasoning-effort.ts` · A: `src/components/mobile/ReasoningEffortRow.tsx` `src/lib/reasoning-effort.ts` · W: `website/src/client/ui/WebClient.tsx` |  |
| Context window shown | yes | yes | yes | gated | D: `src/components/chat/ContextGauge.tsx` `src/lib/context-gauge.ts` · i: `src/components/chat/ContextGauge.tsx` `src/lib/context-gauge.ts` · A: `src/components/chat/ContextGauge.tsx` `src/lib/context-gauge.ts` · W: `website/src/client/ui/WebClient.tsx` |  |
| Streaming replies | yes | yes | yes | gated | D: `src/lib/hermes-gateway.ts` · i: `src-tauri/src/agent_lite/mod.rs` · A: `src-tauri/src/agent_lite/mod.rs` · W: `website/src/client/agent.ts` `website/src/client/ui/WebClient.tsx` |  |
| Stop a reply | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` · i: `src-tauri/src/agent_lite/cancel.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/agent_lite/cancel.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Edit a sent message | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` · i: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Regenerate a reply | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` `src/components/agent/ChatTurnControls.tsx` · i: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Branch a conversation | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` · i: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/agent_lite/controls.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Copy a reply | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` · i: `src/components/mobile/screens/AgentScreen.tsx` · A: `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Read a reply aloud | yes | yes | yes | gated | D: `src/components/chat/ReadAloudButton.tsx` `src/lib/speakable-text.ts` · i: `src/components/chat/ReadAloudButton.tsx` `src/lib/speakable-text.ts` · A: `src/components/chat/ReadAloudButton.tsx` `src/lib/speakable-text.ts` · W: `website/src/client/read-aloud.ts` `website/src/client/ui/WebClient.tsx` |  |
| Rate a reply | yes | yes | yes | gated | D: `src/components/chat/RateReply.tsx` `src-tauri/src/reply_ratings.rs` · i: `src/components/chat/RateReply.tsx` `src-tauri/src/reply_ratings.rs` · A: `src/components/chat/RateReply.tsx` `src-tauri/src/reply_ratings.rs` · W: `website/src/client/ui/WebClient.tsx` |  |
| Export a conversation | yes | yes | yes | gated | D: `src-tauri/src/conversation_export/mod.rs` `src/lib/conversation-export.ts` · i: `src/components/mobile/ChatExportButton.tsx` `src-tauri/src/conversation_export/mod.rs` · A: `src/components/mobile/ChatExportButton.tsx` `src-tauri/src/conversation_export/mod.rs` · W: `website/src/client/export.ts` `website/src/client/ui/WebClient.tsx` |  |
| Search across conversations | yes | yes | yes | gated | D: `src-tauri/src/db/repositories.rs` `src/components/agent/AgentSessionsList.tsx` · i: `src-tauri/src/db/repositories.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/db/repositories.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/search.ts` `website/src/client/ui/WebClient.tsx` |  |
| Archive a conversation | yes | yes | yes | gated | D: `src-tauri/src/account/session_folders.rs` `src/components/agent/AgentSessionsList.tsx` · i: `src-tauri/src/account/session_folders.rs` `src/components/mobile/screens/AgentScreen.tsx` · A: `src-tauri/src/account/session_folders.rs` `src/components/mobile/screens/AgentScreen.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Temporary chat | yes | yes | yes | gated | D: `src-tauri/src/temporary_chat/mod.rs` `src/components/agent/TemporaryChat.tsx` · i: `src-tauri/src/temporary_chat/mod.rs` `src/components/agent/TemporaryChat.tsx` · A: `src-tauri/src/temporary_chat/mod.rs` `src/components/agent/TemporaryChat.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Share a conversation by link | yes | yes | yes | gated | D: `src-tauri/src/account/shares.rs` `src/components/share/ShareNoteDialog.tsx` · i: `src-tauri/src/account/shares.rs` `src/components/share/ShareNoteDialog.tsx` · A: `src-tauri/src/account/shares.rs` `src/components/share/ShareNoteDialog.tsx` · W: `website/src/client/share.ts` `website/src/client/ui/ShareDialog.tsx` `website/src/pages/share.tsx` |  |
| Custom instructions and personality | yes | yes | yes | gated | D: `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/personalization/mod.rs` `src/components/settings/PersonalizationSettingsSection.tsx` · i: `src/components/mobile/screens/PersonalizationScreen.tsx` `src-tauri/src/personalization/mod.rs` · A: `src/components/mobile/screens/PersonalizationScreen.tsx` `src-tauri/src/personalization/mod.rs` · W: `website/src/client/ui/WebClient.tsx` |  |
| Memory | yes | yes | yes | gated | D: `src/components/settings/MemorySettingsSection.tsx` · i: `src/components/mobile/screens/MemoryScreen.tsx` · A: `src/components/mobile/screens/MemoryScreen.tsx` · W: `website/src/client/ui/MemoryManager.tsx` `website/src/client/memories.ts` |  |
| Memory of past chats | yes | yes | yes | gated | D: `src-tauri/src/db/repositories.rs` `src-tauri/src/memory/past_chats.rs` · i: `src-tauri/src/memory/past_chats.rs` · A: `src-tauri/src/memory/past_chats.rs` · W: `website/src/client/past-chats.ts` |  |
| Memory sources shown on a reply | equiv | yes | yes | gated | D: `src/components/agent/MemoryInChatIndicator.tsx` `src-tauri/src/memory/sources.rs` · i: `src/components/mobile/MemorySourcesChip.tsx` `src-tauri/src/memory/sources.rs` · A: `src/components/mobile/MemorySourcesChip.tsx` `src-tauri/src/memory/sources.rs` · W: `website/src/client/ui/WebClient.tsx` |  |
| Projects with instructions, files and memory | yes | yes | yes | gated | D: `src/components/folders/ProjectSettingsDialog.tsx` `src-tauri/src/projects/mod.rs` `src-tauri/src/hermes_bridge/project_memory.rs` · i: `src/components/mobile/screens/ProjectSettingsScreen.tsx` `src-tauri/src/projects/mod.rs` `src-tauri/src/agent_lite/project.rs` · A: `src/components/mobile/screens/ProjectSettingsScreen.tsx` `src-tauri/src/projects/mod.rs` `src-tauri/src/agent_lite/project.rs` · W: `website/src/client/ui/ProjectsView.tsx` `website/src/client/projects.ts` |  |
| Shared projects | yes | yes | yes | gated | D: `src-tauri/src/account/spaces/commands.rs` `src/components/spaces/SpaceDialog.tsx` · i: `src-tauri/src/account/spaces/commands.rs` `src/components/spaces/SpaceDialog.tsx` · A: `src-tauri/src/account/spaces/commands.rs` `src/components/spaces/SpaceDialog.tsx` · W: `website/src/client/spaces/SpacesPanel.tsx` `website/src/client/spaces/membership.ts` |  |
| File uploads (PDF, Word, Excel) | yes | yes | yes | gated | D: `src-tauri/src/assistants/references.rs` `src-tauri/src/documents.rs` · i: `src/components/mobile/ChatComposer.tsx` `src-tauri/src/documents.rs` · A: `src/components/mobile/ChatComposer.tsx` `src-tauri/src/documents.rs` · W: `website/src/client/attachments.ts` `website/src/client/ui/AttachmentBar.tsx` |  |
| Vision | yes | yes | yes | gated | D: `src/components/agent/AgentWorkspace.tsx` · i: `src/components/mobile/screens/AgentScreen.tsx` `src/components/mobile/ChatComposer.tsx` · A: `src/components/mobile/screens/AgentScreen.tsx` `src/components/mobile/ChatComposer.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Data analysis | yes | yes | yes | gated | D: `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/data_cards.rs` · i: `src-tauri/src/agent_lite/python.rs` `src/lib/python/bridge.ts` · A: `src-tauri/src/agent_lite/python.rs` `src/lib/python/bridge.ts` · W: `website/src/client/analysis` |  |
| Interactive tables and charts | yes | yes | yes | gated | D: `src/components/chat-blocks/ChartCard.tsx` `src/components/chat-blocks/TableCard.tsx` `src/lib/chat-blocks-data.ts` · i: `src/components/chat-blocks/ChartCard.tsx` `src/components/chat-blocks/TableCard.tsx` · A: `src/components/chat-blocks/ChartCard.tsx` `src/components/chat-blocks/TableCard.tsx` · W: `website/src/client/ui/ChatBlocks.tsx` |  |
| Writing and code blocks (canvas) | yes | yes | yes | gated | D: `src/components/canvas/CanvasHost.tsx` `src/components/canvas/CanvasPane.tsx` `src/components/note-editor` · i: `src/components/canvas/CanvasPane.tsx` `src/components/chat-blocks/CanvasCard.tsx` · A: `src/components/canvas/CanvasPane.tsx` `src/components/chat-blocks/CanvasCard.tsx` · W: `website/src/client/ui/CanvasPane.tsx` `website/src/client/canvas.ts` |  |
| Image generation and editing | yes | yes | yes | gated | D: `src/components/studio/ImageStudio.tsx` · i: `src/components/mobile/screens/StudioScreen.tsx` · A: `src/components/mobile/screens/StudioScreen.tsx` · W: `website/src/client/images.ts` `website/src/client/ui/ImagesView.tsx` |  |
| Image generation with thinking | yes | yes | yes | gated | D: `src-tauri/src/image_refine.rs` `src/lib/image-refine.ts` · i: `src-tauri/src/image_refine.rs` `src/lib/image-refine.ts` · A: `src-tauri/src/image_refine.rs` `src/lib/image-refine.ts` · W: `website/src/client/refine.ts` |  |
| Document scanning | n/a | unverified | unverified | n/a | i: `src-tauri/src/scan/mod.rs` `src-tauri/src/scan/ios.rs` · A: `src-tauri/src/scan/mod.rs` `src-tauri/src/scan/android.rs` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/DocumentScanner.kt` |  |
| Virtual try-on | yes | yes | yes | gated | D: `src/components/studio/TryOnPanel.tsx` `src/components/chat-blocks/TryOnCard.tsx` · i: `src/components/studio/TryOnPanel.tsx` `src/components/chat-blocks/TryOnCard.tsx` · A: `src/components/studio/TryOnPanel.tsx` `src/components/chat-blocks/TryOnCard.tsx` · W: `website/src/client/ui/WebClient.tsx` |  |
| Web search with sources | yes | yes | yes | gated | D: `src-tauri/src/hermes/june_web_mcp.py` · i: `src-tauri/src/agent_lite/mod.rs` · A: `src-tauri/src/agent_lite/mod.rs` · W: `website/src/client/research` |  |
| Deep research report | yes | yes | yes | gated | D: `src/lib/agent-composer-slash-commands.ts` `src-tauri/src/research/mod.rs` `src/components/research/ResearchDialog.tsx` `src-tauri/src/docx.rs` · i: `src-tauri/src/research/mod.rs` `src/components/research/ResearchDialog.tsx` · A: `src-tauri/src/research/mod.rs` `src/components/research/ResearchDialog.tsx` · W: `website/src/client/research` |  |
| Apps inside deep research | yes | yes | yes | gated | D: `src-tauri/src/connectors/research.rs` · i: `src-tauri/src/connectors/research.rs` · A: `src-tauri/src/connectors/research.rs` · W: `website/src/client/research` `website/src/client/connectors/relay.ts` |  |
| Study mode | yes | yes | yes | gated | D: `src/components/assistants/AssistantsDialog.tsx` `src-tauri/src/study/mod.rs` `src/lib/study-blocks.ts` · i: `src-tauri/src/study/mod.rs` `src/components/study/StudyReview.tsx` · A: `src-tauri/src/study/mod.rs` `src/components/study/StudyReview.tsx` · W: `website/src/client/study` |  |
| Work deliverables (documents, sheets, slides) | yes | yes | yes | gated | D: `src/components/settings/ToolsetsSection.tsx` `src-tauri/src/deliverables/mod.rs` `src/components/chat-blocks/FileCard.tsx` · i: `src-tauri/src/deliverables/mod.rs` `src/components/chat-blocks/FileCard.tsx` · A: `src-tauri/src/deliverables/mod.rs` `src/components/chat-blocks/FileCard.tsx` · W: `website/src/client/documents` |  |
| Code surface | yes | n/a | n/a | n/a | D: `src-tauri/src/hermes_bridge.rs` `src-tauri/src/code_review/mod.rs` `src/components/agent/CodeReviewPanel.tsx` |  |
| Scheduled tasks | yes | equiv | equiv | gated | D: `src/lib/hermes-routines.ts` `src/components/routines` `src-tauri/src/assignments/mod.rs` · i: `src-tauri/src/assignments/mod.rs` `src/components/mobile/screens/TodayScreen.tsx` · A: `src-tauri/src/assignments/mod.rs` `src/components/mobile/screens/TodayScreen.tsx` · W: `website/src/client/assignments` |  |
| Always-available agent | equiv | equiv | equiv | gated | D: `src-tauri/src/assignments/mod.rs` · i: `src-tauri/src/assignments/mod.rs` · A: `src-tauri/src/assignments/mod.rs` · W: `website/src/client/assignments` |  |
| Daily brief | yes | yes | yes | gated | D: `src-tauri/src/moments.rs` `src-tauri/src/moments/daily.rs` `src/components/assignments/TodaySurface.tsx` · i: `src-tauri/src/moments/daily.rs` `src/components/mobile/screens/TodayScreen.tsx` · A: `src-tauri/src/moments/daily.rs` `src/components/mobile/screens/TodayScreen.tsx` · W: `website/src/client/assignments/brief.ts` |  |
| Connectors and plugins | yes | yes | yes | gated | D: `src/components/settings/McpServersSection.tsx` `src-tauri/src/connectors/mcp.rs` `src-tauri/src/connectors/catalog.rs` `src/components/settings/ConnectorsSection.tsx` · i: `src/components/mobile/screens/ConnectorsScreen.tsx` `src-tauri/src/connectors/catalog.rs` · A: `src/components/mobile/screens/ConnectorsScreen.tsx` `src-tauri/src/connectors/catalog.rs` · W: `website/src/client/connectors` `website/src/client/connectors/relay.ts` |  |
| Built-in connectors (Google, Microsoft, GitHub) | gated | gated | gated | gated | D: `src-tauri/src/connectors/builtin.rs` `src-tauri/src/connectors/github.rs` `src/components/connectors/ConnectorsPanel.tsx` · i: `src-tauri/src/connectors/builtin.rs` `src/components/connectors/ConnectorsPanel.tsx` · A: `src-tauri/src/connectors/builtin.rs` `src/components/connectors/ConnectorsPanel.tsx` · W: `website/src/client/connectors/relay.ts` `website/src/client/connectors/store.ts` |  |
| Interactive apps in chat | yes | yes | yes | gated | D: `src/components/chat-blocks/ConnectorAppCard.tsx` `src-tauri/src/connectors/apps.rs` · i: `src/components/chat-blocks/ConnectorAppCard.tsx` `src-tauri/src/connectors/apps.rs` · A: `src/components/chat-blocks/ConnectorAppCard.tsx` `src-tauri/src/connectors/apps.rs` · W: `website/src/client/connectors` |  |
| Connector event triggers | equiv | equiv | equiv | gated | D: `src-tauri/src/connectors/triggers.rs` · i: `src-tauri/src/connectors/triggers.rs` · A: `src-tauri/src/connectors/triggers.rs` · W: `website/src/client/connectors/triggers.ts` `website/src/client/assignments` |  |
| Developer mode (custom connectors in chat) | yes | yes | yes | gated | D: `src/components/settings/McpServersSection.tsx` `src/components/settings/McpSecuritySection.tsx` `src-tauri/src/connectors/mcp.rs` · i: `src/components/mobile/screens/ConnectorsScreen.tsx` `src-tauri/src/connectors/mcp.rs` · A: `src/components/mobile/screens/ConnectorsScreen.tsx` `src-tauri/src/connectors/mcp.rs` · W: `website/src/client/connectors` `website/src/client/connectors/relay.ts` |  |
| Skills | yes | yes | yes | gated | D: `src/components/settings/InstalledSkillsSection.tsx` `src-tauri/src/skill_packs/mod.rs` · i: `src/components/mobile/SkillSlashMenu.tsx` `src/components/mobile/screens/SkillsScreen.tsx` · A: `src/components/mobile/SkillSlashMenu.tsx` `src/components/mobile/screens/SkillsScreen.tsx` · W: `website/src/client/skills` |  |
| Realtime voice conversation | yes | unverified | unverified | gated | D: `src-tauri/src/voice/engine.rs` `src-tauri/src/voice/machine.rs` `src/components/voice/VoiceConversation.tsx` · i: `src-tauri/src/voice/io_apple.rs` `src-tauri/src/audio/echo.rs` `src/components/voice/VoiceConversation.tsx` · A: `src-tauri/src/voice/io_android.rs` `src-tauri/src/audio/echo.rs` `src/components/voice/VoiceConversation.tsx` · W: `website/src/client/voice` |  |
| Voice with camera or screen | yes | unverified | unverified | gated | D: `src-tauri/src/voice/screen.rs` `src-tauri/src/voice/screen_windows.rs` `src/components/voice/VoiceConversation.tsx` · i: `src/components/voice/VoiceConversation.tsx` `src/components/voice/MobileVoiceButton.tsx` · A: `src/components/voice/VoiceConversation.tsx` `src/components/voice/MobileVoiceButton.tsx` · W: `website/src/client/voice` |  |
| Voice with connected apps | yes | unverified | unverified | gated | D: `src-tauri/src/voice/engine.rs` · i: `src-tauri/src/voice/engine.rs` · A: `src-tauri/src/voice/engine.rs` · W: `website/src/client/voice` |  |
| Agent browser | yes | n/a | n/a | n/a | D: `src-tauri/src/agent_browser/mod.rs` |  |
| Global chat bar | yes | n/a | n/a | n/a | D: `src-tauri/src/chat_bar/mod.rs` |  |
| Screen and app awareness | yes | n/a | n/a | n/a | D: `src-tauri/src/screen_awareness/mod.rs` |  |
| Home screen widgets | n/a | unverified | unverified | n/a | i: `src-tauri/gen/apple/Widgets` · A: `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/AskWidgetProvider.kt` |  |
| Watch app | n/a | unverified | n/a | n/a | i: `src-tauri/gen/apple/Watch` `src-tauri/src/watch_relay.rs` |  |
| Browser extension | gated | n/a | n/a | n/a | D: `browser-extension/manifest.json` `src-tauri/src/browser_extension/mod.rs` |  |
| Share into the app | n/a | yes | yes | n/a | i: `src-tauri/gen/apple/ShareExtension` `src-tauri/src/share_inbox.rs` · A: `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/ShareReceiverActivity.kt` `src-tauri/src/share_inbox.rs` |  |
| Siri and Shortcuts | n/a | yes | n/a | n/a | i: `src-tauri/gen/apple/Sources/os-june/Intents` |  |
| Spotlight | yes | yes | n/a | n/a | D: `src-tauri/src/spotlight.rs` · i: `src-tauri/src/spotlight.rs` |  |
| Interface languages | yes | yes | yes | yes | D: `src/locales/fr.json` `src/locales/de.json` `src/locales/it.json` `src/locales/es.json` `src/locales/pt-BR.json` `scripts/i18n/verify-catalogs.mjs` · i: `src/locales/fr.json` `scripts/i18n/verify-catalogs.mjs` · A: `src/locales/fr.json` `scripts/i18n/verify-catalogs.mjs` · W: `website/src/locales/de.json` `scripts/i18n/website.mjs` |  |
| Meeting record mode | yes | yes | yes | n/a | D: `src-tauri/src/meeting_detection.rs` `src/components/recorder/RecorderBar.tsx` · i: `src/components/mobile/screens/NotesScreen.tsx` `src-tauri/src/audio/ios_session.rs` · A: `src/components/mobile/screens/NotesScreen.tsx` `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/RecordingService.kt` |  |
| Audio uploads to notes | yes | yes | yes | n/a | D: `src-tauri/src/audio/decode.rs` `src-tauri/src/ingest` · i: `src/components/mobile/ImportSheet.tsx` `src-tauri/src/audio/decode.rs` · A: `src/components/mobile/ImportSheet.tsx` `src-tauri/src/audio/decode.rs` |  |
| Custom assistants: create | yes | yes | yes | gated | D: `src/components/assistants/AssistantsDialog.tsx` · i: `src/components/mobile/screens/assistants/AssistantCreator.tsx` · A: `src/components/mobile/screens/assistants/AssistantCreator.tsx` · W: `website/src/client/ui/AssistantsView.tsx` `website/src/client/assistants.ts` |  |
| Custom assistants: discover and share | yes | yes | yes | gated | D: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · i: `src-tauri/src/account/publications.rs` `src/components/mobile/screens/assistants/AssistantEditor.tsx` · A: `src-tauri/src/account/publications.rs` `src/components/mobile/screens/assistants/AssistantEditor.tsx` · W: `website/src/pages/assistants.tsx` `website/src/client/ui/PublishingView.tsx` |  |
| Public profile | yes | yes | yes | gated | D: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · i: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · A: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · W: `website/src/pages/assistants.tsx` `website/src/client/ui/PublishingView.tsx` |  |
| Saved library | yes | yes | yes | gated | D: `src/components/library/LibraryView.tsx` `src/components/chat/LibraryActions.tsx` `src-tauri/src/account/sync_tables.rs` · i: `src/components/library/LibraryView.tsx` `src/components/chat/LibraryActions.tsx` · A: `src/components/library/LibraryView.tsx` `src/components/chat/LibraryActions.tsx` · W: `website/src/client/ui/LibraryView.tsx` `website/src/client/library.ts` |  |
| Sites and pages | yes | yes | yes | gated | D: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · i: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · A: `src-tauri/src/account/publications.rs` `src/components/publishing/PublishNoteDialog.tsx` · W: `website/src/client/ui/PublishingView.tsx` `website/src/client/publish.ts` |  |
| Office extensions | gated | n/a | n/a | gated | D: `office-addins/manifests/excel.xml` `office-addins/manifests/word.xml` `office-addins/manifests/powerpoint.xml` · W: `office-addins/manifests/excel.xml` `office-addins/manifests/word.xml` `office-addins/manifests/powerpoint.xml` |  |
| Group chats | yes | yes | yes | gated | D: `src-tauri/src/account/spaces/turns.rs` `src/components/spaces/SpaceChat.tsx` · i: `src-tauri/src/account/spaces/turns.rs` `src/components/spaces/SpaceChat.tsx` · A: `src-tauri/src/account/spaces/turns.rs` `src/components/spaces/SpaceChat.tsx` · W: `website/src/client/spaces/client.ts` |  |
| Health | unverified | unverified | unverified | n/a | D: `src-tauri/src/health/mod.rs` `src/components/personal-data/HealthView.tsx` · i: `src-tauri/src/health/native.rs` `src/components/personal-data/HealthView.tsx` · A: `src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/HealthConnect.kt` `src/components/personal-data/HealthView.tsx` |  |
| Finances | yes | yes | yes | gated | D: `src-tauri/src/finance/mod.rs` `src/components/personal-data/FinancesView.tsx` · i: `src/components/mobile/screens/PersonalDataScreen.tsx` `src/components/personal-data/FinancesView.tsx` · A: `src/components/mobile/screens/PersonalDataScreen.tsx` `src/components/personal-data/FinancesView.tsx` · W: `website/src/client/finance` |  |
| Parental controls | equiv | equiv | equiv | gated | D: `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` `src-tauri/src/protected_mode/restrictions.rs` · i: `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` · A: `src-tauri/src/protected_mode/mod.rs` `src/components/settings/ProtectedModeSection.tsx` · W: `website/src/client/protected` |  |
| Privacy: no training, data controls | yes | yes | yes | yes | D: `src-tauri/src/egress.rs` · i: `src-tauri/src/egress.rs` · A: `src-tauri/src/egress.rs` · W: `website/public/_headers` `src/test/website-csp.test.ts` |  |
| Account security history | yes | yes | yes | yes | D: `src-tauri/src/account/security_events.rs` `src/components/settings/AccountSecurityHistory.tsx` · i: `src-tauri/src/account/security_events.rs` `src/components/settings/AccountSecurityHistory.tsx` · A: `src-tauri/src/account/security_events.rs` `src/components/settings/AccountSecurityHistory.tsx` · W: `website/src/pages/security-history.tsx` `subrosa-cloud/migrations/0010_security_events.sql` |  |

## Assumed equivalences

- **Memory sources shown on a reply** (desktop): the desktop runtime receives
  memories once, when the session starts (the `sync_june_soul` seam of
  ADR-0009), so the desktop lists the memories a chat was given in the chat
  header rather than under each reply. The phones, which rebuild the prompt on
  every turn, show them per reply (ADR-0081).
- **Connectors and plugins**, **Developer mode (custom connectors in chat)**
  and **Apps inside deep research** (web): a browser tab can only call
  connector servers that accept its origin. Six catalog servers do; for the
  others (and any custom server the site's policy does not name) the tab
  hands the call to the person's own open app as an errand, which runs it
  under that device's rules and writes the result back (ADR-0107). Nothing
  runs on the account server, so this needs one of the person's apps open,
  as everything else here does (decision of 2026-10-07).
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

## Known gaps

Every `partial` and `no` cell, with what is missing.


## Gated

What each `gated` cell waits for, and the rows that are `yes` but ship behind
a switch of their own. A gate is lifted by its owner, not by Sub Rosa code;
when one is lifted, flip the cells to `yes` and remove the entry.

- **Web column** (every `gated` web cell; rows gated elsewhere too are named
  again below): the
  web client at `/app` opens only for a browser holding its own Carpe Diem key
  (ADR-0096, `website/src/pages/web-app.tsx`). Minting that key and calling
  Carpe Diem from the page need the operator's browser routes and CORS, merged
  as Carpe Diem #464 on 2026-10-10 and not deployed yet. Until it is, a
  visitor of `/app` stops at the "This browser needs a new key" screen. Gate:
  deployment of Carpe Diem #464 (order: operator, then the account service,
  then the site), owned by Geolours.
- **Built-in connectors (Google, Microsoft, GitHub)**: the app signs in to
  these with its own OAuth clients, whose ids are compiled in
  (`SUBROSA_GOOGLE_CLIENT_ID`, `SUBROSA_MS_CLIENT_ID`,
  `SUBROSA_GITHUB_CLIENT_ID`, `option_env!`); a build without one does not
  offer that provider at all, and no release build has them yet. Gate: the
  three OAuth clients created and their ids set as CI secrets (HANDOFF.md,
  "10 octobre 2026"). Full Gmail access also waits for Google's CASA
  assessment (`GMAIL_VERIFIED`). The web reaches them only through a paired
  app (ADR-0107), so it waits for both gates.
- **Office extensions**: the task panes are browser devices (ADR-0102) and
  need the same Carpe Diem browser key as the web column, then a dedicated
  Office origin and an AppSource listing for anyone to install them without
  sideloading. Gate: Carpe Diem #464 deployed, the Office origin cutover, the
  AppSource review. They are also unverified (see below).
- **Browser extension** (desktop): the extension and its native-messaging
  host ship with the app (ADR-0100), but the host's allowed origins list only
  store-assigned extension ids, and a release build has none yet; the unpacked
  development id is accepted only by debug builds or a build made with
  `SUBROSA_ALLOW_UNPACKED_EXTENSION=1` (`src-tauri/src/browser_extension/host_manifest.rs`).
  So a person on a release build gets "no extension" until a listing exists.
  Gate: the Chrome Web Store, Edge Add-ons and Firefox Add-ons listings, then
  their ids in the allowed origins (HANDOFF.md, "10 octobre 2026").
- **Shared projects** and **Group chats** (desktop and phones `yes`): end-to-end
  encrypted with a protocol of Sub Rosa's own (ADR-0098,
  `docs/security/spaces-protocol.md`). They ship behind a "Preview" switch, off
  by default, until an independent review of that protocol. Gate: the
  external review. Their web cells also wait for Carpe Diem #464.
- **Apps inside deep research**, **Connectors and plugins**, **Developer mode
  (custom connectors in chat)**, **Connector event triggers**, **Scheduled
  tasks**, **Always-available agent** and **Parental controls** (web): the
  equivalences explained above hold for the web too, but they run in `/app`
  and wait for the same Carpe Diem #464 deployment.

## Unverified

What each `unverified` cell has never been run on, and what running it means.
Each is shipped and passes its tests and simulators; none has been tried on
the hardware it targets. Flip the cell to `yes` with the date and device of
the first real run (the trial goes in `docs/qa/`).

- **Document scanning** (iOS, Android): VisionKit's document camera and ML
  Kit's scanner need a real camera; simulators have none. Needs an iPhone and
  an Android phone.
- **Realtime voice conversation**, **Voice with camera or screen** and
  **Voice with connected apps** (iOS, Android): the voice cascade runs on the
  phones, but its echo cancellation (`src-tauri/src/audio/echo.rs`) has never
  been heard through a phone's loudspeaker and microphone, where the reply
  would otherwise interrupt itself, nor has the phone camera fed it. Needs an
  iPhone and an Android phone, speaker on.
- **Home screen widgets** (iOS, Android): built and installed with the app,
  never placed on a real home screen. Needs an iPhone and an Android phone.
- **Watch app** (iOS): built and embedded, never installed on a watch paired
  with an iPhone. Needs an Apple Watch.
- **Health** (iOS, Android, desktop): HealthKit and Health Connect reads have
  never returned real data; the simulators hold none. The desktop only shows
  what a phone sent, so it is unverified with them. Needs an iPhone with
  Health data and an Android phone with Health Connect.
- **Office extensions**: never loaded in real Excel, Word or PowerPoint, on the
  desktop or on the web; tried in a browser only. Needs Office, once the gates
  above are lifted.

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
