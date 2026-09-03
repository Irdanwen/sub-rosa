import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { safeExternalHref } from "./external-link";

// Re-exported so modules that build their own command calls (e.g. the Hermes
// admin Rust transport) route through the same `invoke` the rest of the app's
// bindings use, rather than reaching into `@tauri-apps/api/core` directly.
export { invoke };

export type ProcessingStatus =
  | "draft"
  | "recording"
  | "validating"
  | "transcribing"
  | "generating"
  | "ready"
  | "failed"
  | "recoverable";

export type FolderDto = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

/** Which project (folder) an agent session is filed under. Sessions live in
 * Hermes, so only the assignment is stored locally. */
export type SessionFolderDto = {
  sessionId: string;
  folderId: string;
};

export type DictionaryEntryDto = {
  id: string;
  phrase: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteListItemDto = {
  id: string;
  title: string;
  preview: string;
  processingStatus: ProcessingStatus;
  folderIds: string[];
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
};

export type TranscriptDto = {
  id: string;
  text: string;
  sourceMode?: RecordingSourceMode;
  source?: RecordingSource;
  startMs?: number;
  endMs?: number;
  turnIndex?: number;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
};

export const LIVE_TRANSCRIPT_EVENT = "live-transcript-event";

export type LiveTranscriptEventDto = {
  noteId: string;
  sessionId: string;
  sourceMode: RecordingSourceMode;
  source: RecordingSource;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  stability: "partial" | "final";
};

export type AudioLevelDto = {
  peak: number;
  rms: number;
  recentPeaks: number[];
};

export type RecordingState =
  | "idle"
  | "permissionDenied"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "validating"
  | "partiallyValid"
  | "invalid"
  | "ready"
  | "failed"
  | "recoverable";

export type RecordingSourceMode = "microphoneOnly" | "microphonePlusSystem";
export type RecordingSource = "microphone" | "system";

export type DictationShortcutModifiers = {
  command: boolean;
  control: boolean;
  option: boolean;
  shift: boolean;
  function: boolean;
};

export type DictationShortcutSetting = {
  keyCode?: number;
  code: string;
  modifiers: DictationShortcutModifiers;
  label: string;
  pressCount: 1 | 2;
};

export type DictationShortcutKind = "push_to_talk" | "toggle";

export type DictationMicrophoneSetting = {
  id?: string;
  name?: string;
};

export type DictationStyle = "standard" | "casualLowercase" | "formal";

export type DictationSettingsDto = {
  pushToTalkShortcut: DictationShortcutSetting;
  toggleShortcut: DictationShortcutSetting;
  microphone: DictationMicrophoneSetting;
  style: DictationStyle;
  language?: string;
};

export type DictationSettingsResponse = {
  settings: DictationSettingsDto;
};

export type DictationHistoryItemDto = {
  id: string;
  text: string;
  language?: string;
  provider: string;
  createdAt: string;
};

export type ListDictationHistoryResponse = {
  items: DictationHistoryItemDto[];
  retentionDays: number;
};

export type DictationMicrophoneDeviceDto = {
  id: string;
  name: string;
};

export type DictationHelperEvent = {
  type: string;
  payload?: {
    devices?: DictationMicrophoneDeviceDto[];
    defaultDevice?: DictationMicrophoneDeviceDto;
    selectedID?: string;
    shortcut?: DictationShortcutSetting;
    message?: string;
    code?: string;
    path?: string;
    durationMs?: number | string;
    observedAudioLevel?: number | string;
    level?: number | string;
    [key: string]: unknown;
  };
};

export type ProviderModelMode = "transcription" | "generation" | "image";

export type ProviderModelSettingsDto = {
  transcriptionProvider: string;
  transcriptionModel: string;
  generationModel: string;
  imageModel: string;
  veniceApiKeyConfigured: boolean;
};

export type GeneratedImageDto = {
  imageBase64: string;
  mimeType: string;
  model: string;
  provider: string;
};

export type ProviderModelSettingsResponse = {
  settings: ProviderModelSettingsDto;
};

export type VeniceModelDto = {
  provider: string;
  id: string;
  name: string;
  modelType: string;
  description?: string;
  privacy?: string;
  pricing?: unknown;
  contextTokens?: number;
  traits: string[];
  capabilities: string[];
  priceUnit?: string;
  priceDescription?: string;
  creditsPerMillionSeconds?: number;
  inputCreditsPerMillionTokens?: number;
  outputCreditsPerMillionTokens?: number;
  /** Rate for prompt tokens the provider serves from its cache. Absent for the
   * models that publish none, which means they bill cached tokens like input. */
  cacheInputCreditsPerMillionTokens?: number;
};

export type VeniceModelsResponse = {
  mode: ProviderModelMode;
  modelType: string;
  selectedModel: string;
  models: VeniceModelDto[];
};

export type SourceState =
  | "pending"
  | "permissionDenied"
  | "unavailable"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "finalized"
  | "valid"
  | "invalid"
  | "recoverable"
  | "failed";

export type SourceStatusDto = {
  source: RecordingSource;
  state: SourceState;
  elapsedMs: number;
  bytesWritten: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  pathFinalized: boolean;
  lastError?: string;
};

export type SourceWarningDto = {
  source: RecordingSource;
  code: string;
  message: string;
};

export type RecordingStatusDto = {
  sessionId: string;
  noteId?: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  elapsedMs: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  bytesWritten: number;
  livePreviewEnabled?: boolean;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type RecordingPresenceBoundsDto = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecordingSessionDto = {
  id: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  startedAt: string;
  elapsedMs: number;
  deviceLabel?: string;
  level: AudioLevelDto;
  livePreviewEnabled?: boolean;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type AudioArtifactDto = {
  id: string;
  source?: RecordingSource;
  format: "wav";
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

/** Which view of a note is open. "summary" is the long-form reading
 * (ADR-0027); it only exists once there is a transcript to read. */
export type NoteTab = "notes" | "transcription" | "summary";

export type NoteDto = NoteListItemDto & {
  /** Calendar context, when a recording matched an event (crate::calendar).
   * Absent on every note without one — which is every note the app made
   * before this existed, and every recording outside a meeting. */
  calendarEventId?: string;
  /** When the meeting was scheduled (RFC3339), not when recording started. */
  scheduledStart?: string;
  /** Who was invited, from the invitation. Never an attribution of speech. */
  attendees?: string[];
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  transcriptCoverage?: TranscriptCoverageDto;
  sourceTranscripts?: TranscriptDto[];
  recording?: RecordingSessionDto;
  audio?: AudioArtifactDto;
  audioSources?: AudioArtifactDto[];
  activeTab?: NoteTab;
  lastError?: string;
  /** Recordings queued behind the one currently processing (0 when none). */
  queuedRecordings?: number;
};

export type TranscriptCoverageDto = {
  detectedSpeechMs: number;
  transcribedMs: number;
  warning: boolean;
};

export type RecoverableRecordingDto = {
  sessionId: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  startedAt: string;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  sources?: RecoverableSourceDto[];
};

export type RecoverableSourceDto = {
  source: RecordingSource;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  lastError?: string;
};

export type AgentSafetyProfile = "autonomousPrivate";

export type AgentTaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "waitingForUser"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentMessageRole = "system" | "assistant" | "user";

export type AgentToolEventStatus = "proposed" | "running" | "completed" | "failed" | "blocked";

export type AgentMessageDto = {
  id: string;
  taskId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
};

export type AgentToolEventDto = {
  id: string;
  taskId: string;
  toolName: string;
  status: AgentToolEventStatus;
  summary: string;
  argumentsJson?: string;
  resultJson?: string;
  redacted: boolean;
  createdAt: string;
  completedAt?: string;
};

export type AgentTaskDto = {
  id: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  safetyProfile: AgentSafetyProfile;
  hermesSessionId?: string;
  /** The chat model this session last ran with (agent-lite); absent means the
   * app default applies. */
  model?: string;
  progressSummary?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  messages: AgentMessageDto[];
  toolEvents: AgentToolEventDto[];
};

export type AgentTaskListResponse = {
  items: AgentTaskDto[];
};

export type MemorySource = "auto" | "manual";

export type MemoryDto = {
  id: string;
  text: string;
  source: MemorySource;
  /** 1 (essential) to 10 (trivial) — lower is more important. */
  importance: number;
  disabled: boolean;
  hasEmbedding: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemorySettings = {
  enabled: boolean;
  autoExtract: boolean;
};

export type MemoryListResponse = {
  items: MemoryDto[];
  settings: MemorySettings;
};

export type SuggestAgentSessionTitleResponse = {
  title: string;
};

export type HermesBridgeConnection = {
  baseUrl: string;
  wsUrl: string;
  token: string;
  port: number;
  command: string;
  hermesHome: string;
  cwd?: string | null;
  /** The validated per-session working folder this process was spawned into,
   * or null/absent for the default workspace. Canonical: the mismatch check
   * compares it to a session's recorded folder as a plain string equality.
   * Mirrors the Rust connection field. */
  workingDir?: string | null;
  providerProxyPort: number;
  pid: number;
  /** True when the runtime is wrapped in the macOS Seatbelt write-jail (false
   * on non-macOS, when sandbox-exec is missing, or when disabled via the
   * escape-hatch env var). Mirrors the Rust connection field. */
  sandboxed: boolean;
  /** True when the user opted this runtime into Full mode (sandbox
   * deliberately off). Distinct from `sandboxed`, which can also be false for
   * environmental reasons. Mirrors the Rust connection field. */
  fullMode: boolean;
};

export type HermesBridgeStatus = {
  /** True when any runtime process is up. */
  running: boolean;
  /** Primary connection (the requested mode for a start call, otherwise
   * sandboxed-first). Mode-aware callers should use `connections`. */
  connection?: HermesBridgeConnection;
  /** Every live runtime process — at most one per write-access mode. */
  connections?: HermesBridgeConnection[];
  message?: string;
};

export type HermesFilesystemEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | string;
  size?: number | null;
  modifiedAt?: string | null;
  children?: HermesFilesystemEntry[] | null;
};

export type HermesFilesystemRoot = {
  id: string;
  label: string;
  path: string;
  description: string;
  entries: HermesFilesystemEntry[];
};

export type HermesFilesystemSnapshot = {
  roots: HermesFilesystemRoot[];
};

export type ImportedHermesFile = {
  name: string;
  path: string;
  rootLabel: string;
  size: number;
  previewDataUrl?: string | null;
};

export type HermesSkillInfo = {
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
};

export type HermesSkillDocument = {
  name: string;
  relativePath: string;
  content: string;
  /** True for skills loaded from an external dir (e.g. ~/.agents/skills).
   *  June can read but not write them, so the editor is read-only. */
  readOnly?: boolean;
};

export type HermesToolsetInfo = {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  available?: boolean;
  tools?: string[];
  provider?: string;
};

export type HermesMessagingEnvVarInfo = {
  key: string;
  prompt?: string;
  description?: string;
  required?: boolean;
  advanced?: boolean;
  isSet?: boolean;
  is_set?: boolean;
  isPassword?: boolean;
  is_password?: boolean;
  redactedValue?: string | null;
  redacted_value?: string | null;
  url?: string | null;
};

export type HermesMessagingPlatformInfo = {
  id: string;
  name: string;
  description?: string;
  docsUrl?: string;
  docs_url?: string;
  enabled?: boolean;
  configured?: boolean;
  gatewayRunning?: boolean;
  gateway_running?: boolean;
  state?: string | null;
  errorCode?: string | null;
  error_code?: string | null;
  errorMessage?: string | null;
  error_message?: string | null;
  envVars?: HermesMessagingEnvVarInfo[];
  env_vars?: HermesMessagingEnvVarInfo[];
};

export type HermesMessagingPlatformsResponse = {
  platforms: HermesMessagingPlatformInfo[];
};

export type HermesSessionInfo = {
  id: string;
  active?: boolean;
  is_active?: boolean;
  status?: string;
  source?: string;
  kind?: string | null;
  session_type?: string | null;
  sessionType?: string | null;
  subagent_id?: string | null;
  subagentId?: string | null;
  user_id?: string;
  model?: string;
  title?: string;
  started_at?: string;
  startedAt?: string;
  ended_at?: string | null;
  endedAt?: string | null;
  end_reason?: string | null;
  message_count?: number;
  tool_call_count?: number;
  parent_session_id?: string | null;
  parentSessionId?: string | null;
  last_active?: string;
  lastActive?: string;
  preview?: string;
  has_system_prompt?: boolean;
  has_model_config?: boolean;
};

export type HermesSessionsResponse = {
  sessions?: HermesSessionInfo[];
  items?: HermesSessionInfo[];
  data?: HermesSessionInfo[];
  total?: number;
  limit?: number;
  offset?: number;
};

export type HermesSessionMessage = {
  id: string;
  session_id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  text?: unknown;
  context?: unknown;
  name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: string | number;
  created_at?: string | number;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
};

export type HermesSessionMessagesResponse = {
  messages?: HermesSessionMessage[];
  items?: HermesSessionMessage[];
  data?: HermesSessionMessage[];
};

export type BootstrapResponse = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  activeRecoveries: RecoverableRecordingDto[];
  providerConfigured: boolean;
};

export type AudioValidationDto = {
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude: number;
  rmsAmplitude: number;
  warnings: string[];
};

export type SourceValidationDto = {
  source: RecordingSource;
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs?: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude?: number;
  rmsAmplitude?: number;
  warnings: string[];
  error?: string;
};

export type FinishRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  validation: AudioValidationDto;
  validations?: SourceValidationDto[];
  processingStarted: boolean;
  warnings?: SourceWarningDto[];
};

export type ListNotesResponse = {
  items: NoteListItemDto[];
  nextCursor?: string;
};

export type SourceReadinessDto = {
  source: RecordingSource;
  required: boolean;
  ready: boolean;
  permissionState: "unknown" | "granted" | "denied" | "restricted" | "unsupported";
  deviceAvailable: boolean;
  captureAvailable: boolean;
  recoveryAction?:
    | "openMicrophoneSettings"
    | "openSystemAudioSettings"
    | "upgradeMacos"
    | "restartApp";
  message?: string;
};

export type RecordingSourceReadinessDto = {
  sourceMode: RecordingSourceMode;
  ready: boolean;
  checkedAt?: string;
  sources: SourceReadinessDto[];
};

export async function bootstrapApp() {
  return invoke<BootstrapResponse>("bootstrap_app");
}

/** Display-only mirror of JUNE_COMMUNITY_URL in commands.rs — the Rust
 * command is what actually opens the link; keep the two in sync. */
export const JUNE_COMMUNITY_URL = "https://t.me/CarpeDiemCommu";

/** Opens the june-api /verify page (attestation, routing, retention) in
 * the default browser. Routed through Rust because the webview drops
 * target="_blank" anchors. */
export async function juneOpenVerifyPage() {
  return invoke<void>("june_open_verify_page");
}

/** Opens the June community in the default browser. Routed through Rust for
 * the same target="_blank" reliability reason as the verify page. */
export async function juneOpenCommunityPage() {
  return invoke<void>("june_open_community_page");
}

// --- Spotlight (crate::spotlight) -----------------------------------------

export type SpotlightSettingsDto = {
  /** Titles and dates in the system index. On by default. */
  enabled: boolean;
  /** The note's own text. Off until asked for. */
  includeContent: boolean;
};

export async function spotlightGetSettings() {
  return invoke<SpotlightSettingsDto>("spotlight_get_settings");
}

/** Saving also makes the index match: turning it off removes what is there. */
export async function spotlightSetSettings(request: SpotlightSettingsDto) {
  return invoke<SpotlightSettingsDto>("spotlight_set_settings", { request });
}

// --- Proposed actions (crate::actions) ------------------------------------

export type ActionStateDto = {
  actionId: string;
  status: string;
  detail?: string;
};

/** Performs one proposed action. Only ever called from an explicit tap. */
export async function actionExecute(
  proposalId: string,
  action: import("./chat-blocks").ProposedAction,
) {
  return invoke<ActionStateDto>("action_execute", { request: { proposalId, action } });
}

/** What has already been done for a proposal — a message is immutable, so
 * this is where "done" actually lives. */
export async function actionStates(proposalId: string) {
  return invoke<ActionStateDto[]>("action_states", { proposalId });
}

// --- The moments the app speaks first (crate::moments) --------------------

export type MomentSettingsDto = {
  /** The ten-minutes-before brief. Off until asked for. */
  briefEnabled: boolean;
  /** "Your note is ready", after a recording becomes one. */
  recapEnabled: boolean;
};

export async function momentsGetSettings() {
  return invoke<MomentSettingsDto>("moments_get_settings");
}

export async function momentsSetSettings(request: MomentSettingsDto) {
  return invoke<MomentSettingsDto>("moments_set_settings", { request });
}

// --- Calendar context (crate::calendar) -----------------------------------
// The app reads the day so a NOTE can know what it is called, when it was
// scheduled and who was invited. There is no calendar screen and no meeting
// object: the product specs forbid both, and the note stays the only noun.

export type CalendarAccess = "granted" | "denied" | "notDetermined" | "unsupported";

export type CalendarEventDto = {
  id: string;
  title: string;
  /** Epoch seconds. */
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  /** The invitation's own notes. */
  agenda?: string;
  attendees: string[];
};

/** What a recording belongs to: nothing, exactly one, or a question. */
export type CalendarMatch =
  | { kind: "none" }
  | { kind: "one"; events: CalendarEventDto }
  | { kind: "ambiguous"; events: CalendarEventDto[] };

export async function calendarAccessState() {
  return invoke<CalendarAccess>("calendar_access_state");
}

/** Asks the system, once. Called at the first recording — the moment it pays
 * off — never at launch. */
export async function calendarRequestAccess() {
  return invoke<CalendarAccess>("calendar_request_access");
}

export async function calendarEventsBetween(start: number, end: number) {
  return invoke<CalendarEventDto[]>("calendar_events_between", { request: { start, end } });
}

export async function calendarEvent(id: string) {
  return invoke<CalendarEventDto | null>("calendar_event", { id });
}

/** Attaches the event a recording belongs to. One match attaches silently and
 * names an untitled note; several come back for the shell to ask about. */
export async function calendarLinkNote(noteId: string, startedAt: number) {
  return invoke<CalendarMatch>("calendar_link_note", { request: { noteId, startedAt } });
}

/** The answer to that question — or, with no event id, the undo. */
export async function calendarAttachNote(noteId: string, eventId: string | null) {
  return invoke<CalendarEventDto | null>("calendar_attach_note", {
    request: { noteId, eventId },
  });
}

export type PlacesSettingsDto = {
  googleKeyPresent: boolean;
};

/** Places settings: only key PRESENCE crosses IPC, never the key itself. */
export async function placesGetSettings() {
  return invoke<PlacesSettingsDto>("places_get_settings");
}

export async function placesSetGoogleKey(apiKey: string) {
  return invoke<PlacesSettingsDto>("places_set_google_key", { request: { apiKey } });
}

export async function placesClearGoogleKey() {
  return invoke<PlacesSettingsDto>("places_clear_google_key");
}

/** One place photo as a cached data URL, fetched by Rust with the user's own
 * Google key (the webview can neither reach Google nor hold the key). */
export async function placesPhotoDataUrl(photoRef: string, maxWidth = 96) {
  return invoke<{ dataUrl: string }>("places_photo_data_url", {
    request: { photoRef, maxWidth },
  });
}

/** Static map image for the places chat block: Rust stitches OSM tiles and
 * returns a data URL (the CSP allows no third-party fetch from the webview).
 * Pins are overlaid in DOM by the card from the same projection math. */
export async function renderMapCard(request: {
  centerLat: number;
  centerLng: number;
  zoom: number;
  width: number;
  height: number;
}) {
  return invoke<{ dataUrl: string }>("render_map_card", { request });
}

/**
 * Opens an https link outside the app: default browser on desktop, Safari on
 * iOS. Routed through Rust because neither webview honors target="_blank";
 * the browser preview (no Tauri bridge) falls back to window.open. The scheme,
 * length and character rules live in `safeExternalUrl` (which mirrors
 * `open_url.rs`), and Rust re-checks whatever gets through. This is the only
 * place in the app that may call `window.open`.
 */
export async function openExternalUrl(url: string) {
  const target = safeExternalHref(url);
  if (!target) return;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke<void>("open_external_url", { url: target }).catch(() => {});
  } else {
    window.open(target, "_blank", "noopener");
  }
}

/** One address the app can reach, and why. Mirrors `egress::EgressHost`. */
export type EgressHost = {
  host: string;
  /** `always` = while the app runs; `whenAsked` = only after you act. */
  reach: "always" | "whenAsked";
  reason: string;
};

/**
 * Every address this binary can contact. Read from Rust rather than written in
 * the frontend so the Privacy screen and the build-time guard
 * (`src-tauri/tests/egress.rs`) cannot describe different apps.
 */
export async function declaredEgress() {
  return invoke<EgressHost[]>("declared_egress");
}

export async function createNote(folderId?: string) {
  return invoke<NoteDto>("create_note", { request: { folderId } });
}

export async function createFolder(name: string, description?: string) {
  return invoke<FolderDto>("create_folder", {
    request: { name, description },
  });
}

export async function deleteFolder(folderId: string, deleteNotes: boolean) {
  return invoke<void>("delete_folder", {
    request: { folderId, deleteNotes },
  });
}

export async function renameFolder(folderId: string, name: string, description?: string) {
  return invoke<FolderDto>("rename_folder", {
    request: { folderId, name, description },
  });
}

export async function listFolders() {
  return invoke<FolderDto[]>("list_folders");
}

export async function assignNoteToFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("assign_note_to_folder", {
    request: { noteId, folderId },
  });
}

export async function removeNoteFromFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("remove_note_from_folder", {
    request: { noteId, folderId },
  });
}

export async function listSessionFolders() {
  return invoke<SessionFolderDto[]>("list_session_folders");
}

export async function assignSessionToFolder(sessionId: string, folderId: string) {
  return invoke<void>("assign_session_to_folder", {
    request: { sessionId, folderId },
  });
}

export async function removeSessionFromFolder(sessionId: string, folderId: string) {
  return invoke<void>("remove_session_from_folder", {
    request: { sessionId, folderId },
  });
}

export async function listDictionaryEntries() {
  return invoke<DictionaryEntryDto[]>("list_dictionary_entries");
}

export async function createDictionaryEntry(input: { phrase: string }) {
  return invoke<DictionaryEntryDto>("create_dictionary_entry", {
    request: input,
  });
}

export async function updateDictionaryEntry(input: { entryId: string; phrase: string }) {
  return invoke<DictionaryEntryDto>("update_dictionary_entry", {
    request: input,
  });
}

export async function deleteDictionaryEntry(entryId: string) {
  return invoke<void>("delete_dictionary_entry", {
    request: { entryId },
  });
}

export async function listAgentTasks() {
  return invoke<AgentTaskListResponse>("list_agent_tasks");
}

export async function memoryGetSettings() {
  return invoke<MemorySettings>("memory_get_settings");
}

export async function memorySetSettings(input: MemorySettings) {
  return invoke<MemorySettings>("memory_set_settings", { request: input });
}

export async function memoryList() {
  return invoke<MemoryListResponse>("memory_list");
}

export async function memoryAdd(text: string) {
  return invoke<MemoryDto>("memory_add", { request: { text } });
}

export async function memoryUpdate(input: { memoryId: string; text?: string; disabled?: boolean }) {
  return invoke<MemoryDto>("memory_update", { request: input });
}

export async function memoryDelete(memoryId: string) {
  return invoke<void>("memory_delete", { request: { memoryId } });
}

export async function memoryClear() {
  return invoke<void>("memory_clear");
}

/** One (role, content) entry of the window sent to memory extraction. */
export type MemoryConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MemoryExtractResult = {
  added: number;
};

export async function memoryExtract(messages: MemoryConversationMessage[]) {
  return invoke<MemoryExtractResult>("memory_extract", { request: { messages } });
}

export async function agentHudShow() {
  return invoke<void>("agent_hud_show");
}

export async function agentHudHide() {
  return invoke<void>("agent_hud_hide");
}

export async function agentHudSetLayout(input: {
  expanded: boolean;
  cardCount?: number;
  contextMenuOpen?: boolean;
  width?: number;
  height?: number;
}) {
  return invoke<void>("agent_hud_set_layout", { request: input });
}

export async function agentHudOpenAgent(session?: HermesSessionInfo) {
  return invoke<void>("agent_hud_open_agent", { session });
}

export async function createAgentTask(input: {
  prompt: string;
  title?: string;
  safetyProfile?: AgentSafetyProfile;
  runPlaceholder?: boolean;
  /** The chat model the new session should record (agent-lite). */
  model?: string;
}) {
  return invoke<AgentTaskDto>("create_agent_task", { request: input });
}

/** Remembers the chat model a mobile (agent-lite) session runs with, so the
 * picker restores it on reopen and a mid-conversation switch survives. An empty
 * model clears the override (the app default applies). */
export async function setAgentTaskModel(input: { taskId: string; model: string }) {
  return invoke<AgentTaskDto>("set_agent_task_model", { request: input });
}

export async function getAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("get_agent_task", { request: { taskId } });
}

export async function sendAgentMessage(input: {
  taskId: string;
  content: string;
  runPlaceholder?: boolean;
}) {
  return invoke<AgentTaskDto>("send_agent_message", { request: input });
}

export async function saveAgentAssistantMessage(input: { taskId: string; content: string }) {
  return invoke<AgentTaskDto>("save_agent_assistant_message", {
    request: input,
  });
}

export async function saveAgentHermesSession(input: { taskId: string; hermesSessionId: string }) {
  return invoke<AgentTaskDto>("save_agent_hermes_session", {
    request: input,
  });
}

export async function suggestAgentSessionTitle(prompt: string) {
  return invoke<SuggestAgentSessionTitleResponse>("suggest_agent_session_title", {
    request: { prompt },
  });
}

export type SubmitIssueReportRequest = {
  /** Which kind of report this is: "bug" | "feedback" | "feature". Drives the
   * team's triage and (server side) the no-charge waiver for the turn. */
  category?: string;
  /** The user's report as they typed it, before the investigation wrapper. */
  description: string;
  /** June's diagnostic assessment from the report session, when available. */
  agentDiagnosis?: string;
  attachmentNames: string[];
  /** Workspace paths of the attached files; their bytes are uploaded with
   * the report. */
  attachmentPaths: string[];
  sessionId?: string;
};

/** What became of a report. `received` only ever meant "the call did not
 * throw", which is how the app came to thank people for reports that reached a
 * log file; `delivery` is the part that says where it actually went. */
export type IssueReportDelivery =
  /** Filed on the tracker from the app, with the token. */
  | { filed: { urls: string[] } }
  /** GitHub's new issue form is open in the browser, filled in, not yet
   * submitted. Copy must not call this "sent". */
  | "browser"
  /** Nowhere but this machine, and why. */
  | { logged: { reason: string } };

export type SubmitIssueReportResponse = {
  received: boolean;
  delivery?: IssueReportDelivery | null;
};

export async function submitIssueReport(request: SubmitIssueReportRequest) {
  return invoke<SubmitIssueReportResponse>("submit_issue_report", { request });
}

/** Where reports go, and whether the app can file them itself. The GitHub
 * token never crosses IPC once saved, only whether one exists. */
export type IssueReportSettingsDto = {
  repo: string;
  repoUrl: string;
  hasToken: boolean;
  /** A logged-in GitHub CLI is sitting there to take a token from, so the
   * import button is worth showing. */
  hasCliToken: boolean;
  canOpenBrowser: boolean;
};

export async function issueReportsGetSettings() {
  return invoke<IssueReportSettingsDto>("issue_reports_get_settings");
}

export async function issueReportsSetGithubToken(token: string) {
  return invoke<IssueReportSettingsDto>("issue_reports_set_github_token", {
    request: { token },
  });
}

export async function issueReportsImportCliToken() {
  return invoke<IssueReportSettingsDto>("issue_reports_import_cli_token");
}

export async function issueReportsClearGithubToken() {
  return invoke<IssueReportSettingsDto>("issue_reports_clear_github_token");
}

export async function issueReportsTestToken() {
  return invoke<{ ok: boolean; message: string }>("issue_reports_test_token");
}

export type ExplainAgentApprovalResponse = {
  explanation: string;
};

/** One-shot generation call that explains a pending approval request in
 * plain language — the agent runtime stays parked on the approval. */
export async function explainAgentApproval(input: { description: string; command?: string }) {
  return invoke<ExplainAgentApprovalResponse>("explain_agent_approval", {
    request: input,
  });
}

export async function deleteAgentTask(taskId: string) {
  return invoke<void>("delete_agent_task", { request: { taskId } });
}

export async function cancelAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("cancel_agent_task", { request: { taskId } });
}

export async function retryAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("retry_agent_task", { request: { taskId } });
}

/** Duplicate a mobile (agent-lite) chat onto another model: a new task with the
 * same transcript, bound to the chosen model, so the conversation can branch
 * onto a different model while the original stays untouched. */
export async function forkAgentTask(input: { sourceTaskId: string; model?: string }) {
  return invoke<AgentTaskDto>("fork_agent_task", { request: input });
}

export async function listAgentToolEvents(taskId: string) {
  return invoke<AgentToolEventDto[]>("list_agent_tool_events", {
    request: { taskId },
  });
}

export async function hermesBridgeStatus() {
  return invoke<HermesBridgeStatus>("hermes_bridge_status");
}

export async function ensureHermesBridgeGateway() {
  return invoke<void>("ensure_hermes_bridge_gateway");
}

export async function hermesBridgeSkills() {
  return invoke<HermesSkillInfo[]>("hermes_bridge_skills");
}

export async function getHermesBridgeSkill(name: string) {
  return invoke<HermesSkillDocument>("get_hermes_bridge_skill", {
    request: { name },
  });
}

export async function updateHermesBridgeSkill(input: { name: string; content: string }) {
  return invoke<HermesSkillDocument>("update_hermes_bridge_skill", {
    request: input,
  });
}

export async function toggleHermesBridgeSkill(input: { name: string; enabled: boolean }) {
  return invoke<{ ok: boolean; name: string; enabled: boolean }>("toggle_hermes_bridge_skill", {
    request: input,
  });
}

export async function hermesBridgeToolsets() {
  return invoke<HermesToolsetInfo[]>("hermes_bridge_toolsets");
}

export async function toggleHermesBridgeToolset(input: { name: string; enabled: boolean }) {
  return invoke<{ ok: boolean; name: string; enabled: boolean }>("toggle_hermes_bridge_toolset", {
    request: input,
  });
}

export type AgentCliAccessStatus = {
  enabled: boolean;
};

/** Whether sandboxed sessions may write the state folders of installed
 * agent CLIs (Claude Code, Codex, Gemini, opencode). */
export async function hermesAgentCliAccess() {
  return invoke<AgentCliAccessStatus>("hermes_agent_cli_access");
}

/** Persists the Agent CLI access opt-in and retires the sandboxed runtime so
 * the next session spawns with matching sandbox grants. */
export async function setHermesAgentCliAccess(enabled: boolean) {
  return invoke<AgentCliAccessStatus>("set_hermes_agent_cli_access", {
    request: { enabled },
  });
}

export async function hermesBridgeMessagingPlatforms() {
  return invoke<HermesMessagingPlatformsResponse>("hermes_bridge_messaging_platforms");
}

export async function hermesBridgeFilesystemSnapshot() {
  return invoke<HermesFilesystemSnapshot>("hermes_bridge_filesystem_snapshot");
}

export async function downloadHermesBridgeFile(path: string) {
  return invoke<string>("download_hermes_bridge_file", { request: { path } });
}

// Copies a workspace file to a destination the user picked in a native save
// dialog (any folder + name), unlike the silent copy-to-Downloads above.
/**
 * Saves a workspace file where the user chooses. The native save dialog is
 * opened by Rust, so no destination path crosses IPC — `suggestedName` only
 * pre-fills the name field. Resolves to the saved path, or `null` if the user
 * cancelled.
 */
export async function saveHermesBridgeFile(path: string, suggestedName?: string) {
  return invoke<string | null>("save_hermes_bridge_file", {
    request: { path, suggestedName },
  });
}

// Puts a workspace file on the OS clipboard as a file reference (pasteable into
// Finder). macOS only; other platforms reject it (the UI hides the button).
export async function copyHermesBridgeFileToClipboard(path: string) {
  return invoke<void>("copy_hermes_bridge_file_to_clipboard", { request: { path } });
}

export async function hermesBridgeFilePreview(path: string) {
  return invoke<string | null>("hermes_bridge_file_preview", {
    request: { path },
  });
}

// Reads a workspace image as a data url sized for the model, re-encoding it
// when the file is bigger than the request can carry. Use this for attaching,
// not hermesBridgeFilePreview: that one stays byte-faithful for the thumbnail,
// while an attach has to clear the proxy's body cap and june-api's character
// caps. `maxBytes` is this turn's per-image budget (see imageAttachByteBudget).
export async function hermesBridgeImageForModel(path: string, maxBytes?: number) {
  return invoke<string | null>("hermes_bridge_image_for_model", {
    request: { path, maxBytes },
  });
}

// Null when the file can't be shown as text (too large or binary) — the
// caller falls back to a download affordance instead of erroring.
export async function hermesBridgeFileText(path: string) {
  return invoke<string | null>("hermes_bridge_file_text", {
    request: { path },
  });
}

export async function importHermesBridgeFile(path: string) {
  return invoke<ImportedHermesFile>("import_hermes_bridge_file", {
    request: { path },
  });
}

// DOM drops in WKWebView carry no filesystem path, so the file's contents go
// over as the raw invoke payload with the name in a header (URI-encoded:
// header values must be ASCII).
export async function importHermesBridgeFileBytes(name: string, bytes: Uint8Array) {
  return invoke<ImportedHermesFile>("import_hermes_bridge_file_bytes", bytes, {
    headers: { "x-file-name": encodeURIComponent(name) },
  });
}

export async function hermesBridgeSessions(
  input: {
    limit?: number;
    offset?: number;
    archived?: "exclude" | "include" | "only";
    minMessages?: number;
    order?: string;
    query?: string;
  } = {},
) {
  return invoke<HermesSessionsResponse>("hermes_bridge_sessions", {
    request: input,
  });
}

export async function hermesBridgeSessionMessages(sessionId: string) {
  return invoke<HermesSessionMessagesResponse>("hermes_bridge_session_messages", {
    request: { sessionId },
  });
}

export async function deleteHermesBridgeSession(sessionId: string) {
  return invoke<unknown>("delete_hermes_bridge_session", {
    request: { sessionId },
  });
}

export async function ensureHermesBridgeSession(input: {
  sessionId: string;
  title?: string;
  model?: string;
}) {
  return invoke<unknown>("ensure_hermes_bridge_session", {
    request: input,
  });
}

/** A raw cron job record from the bridge's dashboard API, as stored in
 * Hermes's jobs file — unlike the gateway's formatted view, `prompt` is the
 * full text and `schedule` is the parsed structure next to its display
 * string. Only the fields the app reads are typed. */
export type HermesCronJobRecord = {
  id: string;
  name: string;
  prompt: string;
  schedule?: { kind?: string } | null;
  schedule_display?: string | null;
  repeat?: { times?: number | null; completed?: number } | null;
  deliver?: string | null;
  enabled?: boolean;
  state?: string | null;
  paused_reason?: string | null;
  created_at?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: "ok" | "error" | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  enabled_toolsets?: string[] | null;
  script?: string | null;
  no_agent?: boolean;
};

export async function hermesBridgeCronJobs() {
  return invoke<HermesCronJobRecord[]>("hermes_bridge_cron_jobs");
}

/** Archives a corrupted cron store so routines can start fresh; resolves to
 * the archive path. The backend refuses when the store parses fine, so a
 * stale corruption banner cannot throw away healthy routines. */
export async function hermesBridgeResetCronStore() {
  return invoke<string>("hermes_bridge_reset_cron_store");
}

export async function createHermesBridgeCronJob(input: {
  prompt: string;
  schedule: string;
  name?: string;
  deliver?: string;
}) {
  return invoke<HermesCronJobRecord>("create_hermes_bridge_cron_job", {
    request: input,
  });
}

export async function updateHermesBridgeCronJob(jobId: string, updates: Record<string, unknown>) {
  return invoke<HermesCronJobRecord>("update_hermes_bridge_cron_job", {
    request: { jobId, updates },
  });
}

export async function hermesBridgeCronJobAction(
  jobId: string,
  action: "pause" | "resume" | "trigger",
) {
  return invoke<HermesCronJobRecord>("hermes_bridge_cron_job_action", {
    request: { jobId, action },
  });
}

export async function deleteHermesBridgeCronJob(jobId: string) {
  return invoke<unknown>("delete_hermes_bridge_cron_job", {
    request: { jobId },
  });
}

export async function updateHermesBridgeMessagingPlatform(input: {
  platformId: string;
  enabled?: boolean;
  env?: Record<string, string>;
}) {
  return invoke<{ ok: boolean; platform: string }>("update_hermes_bridge_messaging_platform", {
    request: input,
  });
}

/** Ensures the runtime process for a write-access mode.
 *
 * `fullMode` names the mode to ensure (fresh starts without it are always
 * sandboxed). `workingDir` is tri-state: `undefined` expresses no preference
 * and reuses whatever folder the mode's live process already has; `null`
 * requires the default workspace; a string requires that validated folder.
 * A requirement that differs from the live process's folder restarts that
 * mode's runtime (cwd and the Seatbelt grant are fixed at spawn). */
export async function startHermesBridge(options?: {
  fullMode?: boolean;
  workingDir?: string | null;
}) {
  const { fullMode, workingDir } = options ?? {};
  return invoke<HermesBridgeStatus>("start_hermes_bridge", {
    request: {
      fullMode,
      ...(workingDir !== undefined ? { workingDir: { path: workingDir } } : {}),
    },
  });
}

export type WorkingDirValidation = {
  /** Canonical path — store and compare this, never the raw pick. */
  path: string;
  /** The folder's own name, for the composer chip. */
  displayName: string;
  /** True for broad picks (Documents, Desktop, Downloads): confirm before
   * adopting. */
  broad: boolean;
};

/** Validates a candidate working folder against the backend's guard rails
 * (secret stores, system folders, the app's own data dir) and returns its
 * canonical form. Throws an AppError with code `working_dir_invalid` or
 * `working_dir_unavailable`. */
export async function validateAgentWorkingDir(path: string) {
  return invoke<WorkingDirValidation>("validate_agent_working_dir", {
    request: { path },
  });
}

/** Opens the folder in the OS file manager (Finder / Explorer). */
export async function revealAgentWorkingDir(path: string) {
  return invoke<void>("reveal_agent_working_dir", {
    request: { path },
  });
}

export type AgentFolderEntry = {
  path: string;
  relativePath: string;
  name: string;
  kind: "file" | "folder";
};

export type AgentFolderEntries = {
  root: string;
  rootLabel: string;
  entries: AgentFolderEntry[];
};

/** Files and folders under a session's root, for the composer's `@` palette.
 * `path` is the session's working folder; omitting it searches the default
 * workspace. Build output, dependency trees, dotfiles and symlinks never come
 * back — see `list_agent_folder_entries`. */
export async function listAgentFolderEntries(input: {
  path?: string;
  query?: string;
  limit?: number;
}) {
  return invoke<AgentFolderEntries>("list_agent_folder_entries", {
    request: {
      path: input.path ?? null,
      query: input.query ?? "",
      limit: input.limit ?? null,
    },
  });
}

export async function stopHermesBridge() {
  return invoke<HermesBridgeStatus>("stop_hermes_bridge");
}

/** The redacted result of an MCP OAuth login attempt. The Rust bridge runs
 * `hermes mcp login <server>`, opens the authorization URL in the OS browser,
 * and waits for the CLI to finish. It NEVER returns a token: only whether the
 * login succeeded, an already-redacted status message, and the (token-free)
 * authorization URL so June can offer a manual "open in browser" fallback.
 * `timedOut` is true when the wait elapsed before the CLI completed (the browser
 * sign-in is still the user's to finish; June never blocks on it). */
export type HermesMcpOauthLoginResult = {
  ok: boolean;
  /** A safe, already-redacted status message, or null when the CLI said nothing
   * quotable. Never carries a token, bearer value, or auth code. */
  message: string | null;
  /** The authorization URL the CLI emitted (token-free), or null. */
  authUrl: string | null;
  /** True when the wait elapsed before the CLI reported a terminal state. */
  timedOut: boolean;
};

/**
 * Runs the MCP OAuth sign-in for one server through the Rust bridge:
 * `hermes mcp login <server>` against the chosen runtime's profile, opening the
 * authorization URL in the OS browser. `mode` selects the runtime explicitly
 * (sandboxed vs unrestricted) — Rust never falls back to the first connection.
 * The result is redacted in Rust and re-checked in the view layer; no token is
 * ever returned to the webview.
 */
export async function hermesMcpOauthLogin(input: {
  mode: "sandboxed" | "unrestricted";
  server: string;
  profile?: string;
}) {
  return invoke<HermesMcpOauthLoginResult>("hermes_mcp_oauth_login", {
    request: input,
  });
}

/** The redacted result of a bundled-skill reset. Carries no skill content and no
 * secret-shaped CLI output: only whether the CLI reported success, an already
 * redacted status message, and whether the bounded wait elapsed. */
export type HermesResetSkillResult = {
  ok: boolean;
  /** A safe, already-redacted status message, or null when the CLI said nothing
   * quotable. */
  message: string | null;
  /** True when the wait elapsed before the CLI reported a terminal state. */
  timedOut: boolean;
};

/**
 * Resets (or restores) a bundled skill to its shipped baseline through the Rust
 * bridge: `hermes skills reset <name> [--restore]` against the chosen runtime's
 * profile. The dashboard exposes no reset endpoint, so this is the narrow CLI
 * fallback. `mode` selects the runtime explicitly (sandboxed vs unrestricted) —
 * Rust never falls back to the first connection. The skill name is validated
 * argument-safe on both sides and passed as a discrete CLI argument (no shell).
 * The result is redacted in Rust; no skill content is returned to the webview.
 */
export async function hermesResetBundledSkill(input: {
  mode: "sandboxed" | "unrestricted";
  name: string;
  profile?: string;
  restore?: boolean;
}) {
  return invoke<HermesResetSkillResult>("hermes_reset_bundled_skill", {
    request: input,
  });
}

/** One configured custom GitHub skill tap, as parsed from `hermes skills tap
 * list` by the Rust bridge. Carries only a validated `owner/repo`, an optional
 * safe path, and a trust marker. Never a token. Mirrors the Rust `HermesSkillTap`
 * (camelCase). */
export type HermesSkillTapDto = {
  /** The tap repository as `owner/repo` (validated argument-safe). */
  repo: string;
  /** The path override inside the repo, when the tap declares one. */
  path?: string;
  /** True only when Hermes explicitly marks the tap trusted/verified. The UI
   * treats every other tap as community. */
  trusted: boolean;
};

/** The result of listing taps. `taps` is the parsed list; `message` is an
 * already-redacted status line when the CLI failed. */
export type HermesSkillTapListResult = {
  ok: boolean;
  taps: HermesSkillTapDto[];
  /** A safe, already-redacted status message, or null. Never carries a token. */
  message: string | null;
  /** True when the bounded wait elapsed before the CLI reported a result. */
  timedOut: boolean;
};

/** The redacted result of a tap add/remove. Carries no token: only whether the
 * CLI reported success, an already-redacted status message, and whether the
 * bounded wait elapsed. */
export type HermesSkillTapWriteResult = {
  ok: boolean;
  message: string | null;
  timedOut: boolean;
};

/**
 * Lists the configured custom GitHub skill taps for the chosen runtime/profile.
 * The dashboard (v2026.6.19) exposes no tap endpoints, so this runs the pinned
 * `hermes skills tap list` CLI through the Rust bridge. `mode` selects the
 * runtime explicitly (sandboxed vs unrestricted) with no first-connection
 * fallback. The output is parsed and redacted in Rust; no token is returned.
 */
export async function hermesSkillTapList(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
}) {
  return invoke<HermesSkillTapListResult>("hermes_skill_tap_list", {
    request: input,
  });
}

/**
 * Adds a custom GitHub skill tap (`owner/repo`, optional path override) through
 * the Rust bridge: `hermes skills tap add <owner/repo> [--path <path>]`. The repo
 * and path are validated argument-safe on both sides and passed as discrete CLI
 * arguments (no shell). `mode` selects the runtime explicitly. The result is
 * redacted in Rust; no token is returned.
 */
export async function hermesSkillTapAdd(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  repo: string;
  path?: string;
}) {
  return invoke<HermesSkillTapWriteResult>("hermes_skill_tap_add", {
    request: input,
  });
}

/**
 * Removes a custom GitHub skill tap by `owner/repo` through the Rust bridge:
 * `hermes skills tap remove <owner/repo>`. The repo is validated argument-safe on
 * both sides and passed as a discrete CLI argument (no shell).
 */
export async function hermesSkillTapRemove(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  repo: string;
}) {
  return invoke<HermesSkillTapWriteResult>("hermes_skill_tap_remove", {
    request: input,
  });
}

/** The read-only filesystem status of one configured external skill directory,
 * as reported by the June-side `hermes_inspect_external_dirs` command. Carries
 * both the raw configured path and the resolved one. Mirrors the Rust
 * `ExternalDirStatus` (camelCase). */
export type ExternalDirStatus = {
  /** The path exactly as configured (with `~`/`${VAR}` unexpanded). */
  rawPath: string;
  /** The expanded absolute path, or null when a variable could not be resolved. */
  resolvedPath: string | null;
  /** The name of an unresolved environment variable referenced in the path, or
   * null. Never the variable's value. */
  unresolvedVar: string | null;
  /** True when the resolved path exists. */
  exists: boolean;
  /** True when the resolved path exists and is a directory. */
  isDir: boolean;
  /** True when June could list the directory. */
  readable: boolean;
  /** True/false when writability was safely detected, null when ambiguous. */
  writable: boolean | null;
  /** Count of discovered skills, or null when missing/unreadable. */
  skillCount: number | null;
  /** Discovered skill names (for shadowing explanation). */
  skillNames: string[];
};

/**
 * Inspects the configured external skill directories read-only through June's
 * own (non-jailed) Rust process: expands `~`/`${VAR}`, stats each path, probes
 * readability/writability, and counts discovered skills. No mutation, no
 * file-content reads, no secrets returned. The CONFIG itself is written through
 * Hermes' `PUT /api/config` (so the jailed dashboard owns the config.yaml
 * write); this command only reports filesystem status the dashboard can't.
 */
export async function hermesInspectExternalDirs(dirs: string[]) {
  return invoke<ExternalDirStatus[]>("hermes_inspect_external_dirs", {
    request: { dirs },
  });
}

/** A Hermes skill bundle as June reads/writes it. `slug` is the file stem and
 * the slash command; `skills` is the ordered member list; `instructions` is the
 * optional prompt text Hermes prepends at invocation. Mirrors the Rust
 * `HermesSkillBundle`. */
export type HermesSkillBundleDto = {
  slug: string;
  name?: string;
  description?: string;
  skills: string[];
  instructions?: string;
};

/**
 * Lists the skill bundles for the chosen runtime/profile. The dashboard exposes
 * no bundle endpoints, so this reads the per-profile `skill-bundles` directory
 * through the Rust bridge. `mode` selects the runtime explicitly (sandboxed vs
 * unrestricted) with no first-connection fallback. Returns an empty list when no
 * bundles exist yet.
 */
export async function hermesListSkillBundles(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
}) {
  return invoke<HermesSkillBundleDto[]>("hermes_list_skill_bundles", {
    request: input,
  });
}

/**
 * Creates or updates a bundle by writing its YAML file. `previousSlug`, when it
 * differs from `bundle.slug`, removes the old file after the new one is written
 * (a rename). The slug is validated argument/path safe on both sides; the write
 * is confined to the bundles directory. Returns the saved bundle.
 */
export async function hermesSaveSkillBundle(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  bundle: HermesSkillBundleDto;
  previousSlug?: string;
}) {
  return invoke<HermesSkillBundleDto>("hermes_save_skill_bundle", {
    request: input,
  });
}

/** Deletes a bundle's YAML file. The slug is validated and the path confined to
 * the bundles directory; a missing file is treated as success. */
export async function hermesDeleteSkillBundle(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  slug: string;
}) {
  return invoke<void>("hermes_delete_skill_bundle", { request: input });
}
/** Developer-only: resume a June session in Hermes' own raw TUI in a Terminal
 * window. `unrestricted` mirrors the session's mode so the debug session runs
 * under the same Seatbelt jail June used. macOS only; rejects elsewhere. */
export async function openHermesTuiDebug(input: {
  sessionId: string;
  unrestricted: boolean;
  /** The session's recorded working folder, so the debug TUI runs under the
   * exact profile (and in the exact folder) June used for the session. */
  workingDir?: string;
}) {
  return invoke<void>("open_hermes_tui_debug", { request: input });
}

/** How many notes one `list_notes` call returns; the backend clamps at 1000. */
const NOTES_PAGE_SIZE = 500;
/** A ceiling on what the list will hold in memory, not a product limit. */
const NOTES_LIST_CEILING = 20_000;

/**
 * Every note, newest first.
 *
 * The backend pages by keyset cursor; this walks the pages so callers keep
 * the one-call shape they had when the list was capped at a hundred notes
 * and silently dropped the rest. A single page is still available through
 * `listNotesPage` for surfaces that want to render as they go.
 */
export async function listNotes(folderId?: string): Promise<ListNotesResponse> {
  const items: NoteListItemDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await listNotesPage({ folderId, cursor, limit: NOTES_PAGE_SIZE });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < NOTES_LIST_CEILING);
  return { items };
}

/** One hit of the search that reads everything. `kind` says where it came from. */
export type SearchHit = {
  kind: "note" | "transcript" | "memory" | "conversation";
  targetId: string;
  title: string;
  /** Matched passage; hits are wrapped in  …  for the UI to highlight. */
  excerpt: string;
  updatedAt: string;
  rank: number;
};

/**
 * Full-text search over notes, transcripts, memories and conversations.
 * Terms are ANDed; the last one matches as a prefix so results move while
 * typing. Empty input returns no hits rather than everything.
 */
export async function searchEverything(query: string, limit = 20): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  return invoke<SearchHit[]>("search_everything", { request: { query, limit } });
}

export async function listNotesPage(request: {
  folderId?: string;
  cursor?: string;
  limit?: number;
}): Promise<ListNotesResponse> {
  return invoke<ListNotesResponse>("list_notes", { request });
}

export async function getNote(noteId: string) {
  return invoke<NoteDto>("get_note", { request: { noteId } });
}

export async function deleteNote(noteId: string) {
  return invoke<void>("delete_note", { request: { noteId } });
}

export async function deleteNotes(noteIds: string[]) {
  return invoke<void>("delete_notes", { request: { noteIds } });
}

export async function updateNote(input: {
  noteId: string;
  title?: string;
  editedContent?: string;
  activeTab?: NoteTab;
}) {
  return invoke<NoteDto>("update_note", { request: input });
}

export async function checkRecordingSourceReadiness(sourceMode: RecordingSourceMode) {
  return invoke<RecordingSourceReadinessDto>("check_recording_source_readiness", {
    request: { sourceMode },
  });
}

export async function openPrivacySettings(pane: "microphone" | "accessibility" | "systemAudio") {
  return invoke<void>("open_privacy_settings", { request: { pane } });
}

export async function startRecording(
  noteId: string,
  sourceMode: RecordingSourceMode = "microphoneOnly",
) {
  return invoke<RecordingSessionDto>("start_recording", {
    request: { noteId, sourceMode },
  });
}

export async function pauseRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("pause_recording", {
    request: { sessionId },
  });
}

export async function resumeRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("resume_recording", {
    request: { sessionId },
  });
}

export async function getRecordingStatus(sessionId: string) {
  return invoke<RecordingStatusDto>("get_recording_status", {
    request: { sessionId },
  });
}

export async function setRecordingPresenceBounds(
  bounds: RecordingPresenceBoundsDto | null,
  ownerId: string,
) {
  return invoke<void>("set_recording_presence_bounds", {
    request: { bounds, ownerId },
  });
}

export async function finishRecording(sessionId: string) {
  return invoke<FinishRecordingResponse>("finish_recording", {
    request: { sessionId },
  });
}

export async function retryProcessing(noteId: string) {
  return invoke<NoteDto>("retry_processing", {
    request: { noteId, step: "all" },
  });
}

export async function recoverRecording(sessionId: string, action: "validate" | "discard") {
  return invoke<NoteDto>("recover_recording", {
    request: { sessionId, action },
  });
}

/** Import an existing audio or video file as a new note and start the
 * transcription pipeline. Three ways in, in decreasing order of preference:
 * `stagedPath` (written slice by slice by {@link stageImportedFile}, no size
 * limit, works everywhere), `sourcePath` (a path Rust can already open),
 * `base64` (the whole file through a JavaScript string — kept for small
 * payloads only). */
export async function importAudioNote(input: {
  sourcePath?: string;
  stagedPath?: string;
  base64?: string;
  fileName?: string;
  folderId?: string;
}) {
  return invoke<NoteDto>("import_audio_note", { request: input });
}

/** Append one slice of a file to a staging file Rust owns. Returns the staged
 * path on the final slice and `null` before that. */
export async function stageImportedFile(input: {
  uploadId: string;
  fileName: string;
  base64: string;
  done: boolean;
}) {
  return invoke<string | null>("stage_imported_file", { request: input });
}

// --- Link ingests (ADR-0028) ----------------------------------------------

/** Emitted whenever an ingest row changes, so a download is followed rather
 * than polled. */
export const INGEST_EVENT = "june://ingest";

export type IngestDto = {
  id: string;
  url: string;
  kind: "direct" | "feed" | "platform";
  status: "pending" | "fetching" | "done" | "failed";
  title: string | null;
  mediaUrl: string | null;
  noteId: string | null;
  folderId: string | null;
  bytesDone: number;
  bytesTotal: number | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinkPreview = {
  url: string;
  kind: "directMedia" | "feed" | "platformPage";
  host: string;
  /** Whether the app can fetch it as things stand. */
  fetchable: boolean;
  /** Why not, when it cannot. */
  reason: string | null;
};

/** Whether the extractor rail is on, and whether the tool it needs exists.
 * Desktop only: iOS cannot run a binary the user installed (ADR-0028). */
export type ExtractorStatus = {
  enabled: boolean;
  available: boolean;
  path: string | null;
  version: string | null;
};

export async function ingestExtractorStatus() {
  return invoke<ExtractorStatus>("ingest_extractor_status");
}

export async function ingestSetExtractorEnabled(enabled: boolean) {
  return invoke<ExtractorStatus>("ingest_set_extractor_enabled", { enabled });
}

/** What a link is, answered without fetching anything. */
export async function previewIngestLink(url: string) {
  return invoke<LinkPreview>("preview_ingest_link", { url });
}

/** Start fetching a link. Returns as soon as the row exists; progress arrives
 * on {@link INGEST_EVENT}. */
export async function startLinkIngest(url: string, folderId?: string) {
  return invoke<IngestDto>("start_link_ingest", { url, folderId });
}

export async function listActiveIngests() {
  return invoke<IngestDto[]>("list_active_ingests");
}

/** Drop an ingest. Also the cancel: a fetch in flight notices the row is gone. */
export async function discardIngest(id: string) {
  return invoke<void>("discard_ingest", { id });
}

// --- Long-form summaries (ADR-0027) ---------------------------------------

/** Emitted whenever a summary row changes, so the UI follows a run instead of
 * polling it. */
export const NOTE_SUMMARY_EVENT = "june://note-summary";

export type NoteSummaryDto = {
  noteId: string;
  status: "pending" | "running" | "ready" | "failed";
  shortSummary: string | null;
  /** Markdown, with timestamps already resolved into the headings. */
  detailedSummary: string | null;
  transcriptChars: number;
  chunkCount: number;
  chunksDone: number;
  model: string;
  promptVersion: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteSummaryPlan = {
  noteId: string;
  transcriptChars: number;
  chunkCount: number;
  /** Model calls the run will make. What the user is being asked to spend. */
  modelCalls: number;
  summarizable: boolean;
  reason: string | null;
};

export async function noteSummary(noteId: string) {
  return invoke<NoteSummaryDto | null>("note_summary", { noteId });
}

/** What a run would cost, before spending anything. */
export async function noteSummaryPlan(noteId: string) {
  return invoke<NoteSummaryPlan>("note_summary_plan", { noteId });
}

/** Start (or restart) the long-form summary. Returns as soon as the row is
 * claimed; progress arrives on {@link NOTE_SUMMARY_EVENT}. */
export async function summarizeNoteLongform(noteId: string) {
  return invoke<NoteSummaryDto>("summarize_note_longform", { noteId });
}

export async function forgetNoteSummary(noteId: string) {
  return invoke<void>("forget_note_summary", { noteId });
}

// --- Note rewrites (ADR-0038) ---------------------------------------------

/** Emitted while a rewrite runs, so the panel shows it being written instead
 * of showing nothing for twenty seconds. */
export const NOTE_REWRITE_EVENT = "june://note-rewrite";

/** What a rewrite is asked to do. Only `restructure` may change the markdown
 * structure it was handed. */
export type RewriteKind =
  | "correct"
  | "reformulate"
  | "shorten"
  | "expand"
  | "restructure"
  | "translate"
  | "custom";

export type NoteRewriteEvent = {
  requestId: string;
  phase: "started" | "delta" | "done" | "failed";
  text: string | null;
};

export type NoteRewriteResult = {
  requestId: string;
  text: string;
  promptVersion: string;
};

export type NoteRewriteRequest = {
  requestId: string;
  kind: RewriteKind;
  text: string;
  /** Required by `translate`. */
  targetLanguage?: string;
  /** Required by `custom`. */
  instruction?: string;
};

/** Rewrite a passage. Resolves with the whole replacement; the deltas that
 * arrived on the way are a preview, not the answer. Nothing is written to the
 * note: what comes back is a revision the user still has to accept. */
export async function noteRewrite(request: NoteRewriteRequest) {
  return invoke<NoteRewriteResult>("note_rewrite", { request });
}

/** Stop a running rewrite. A no-op for a request that is not running. */
export async function cancelNoteRewrite(requestId: string) {
  return invoke<void>("cancel_note_rewrite", { requestId });
}

/** Ceiling on a selection, mirroring `note_ai::MAX_SELECTION_CHARS`. Checked
 * here too so an oversize selection is refused before it costs a round trip. */
export const MAX_REWRITE_CHARS = 24_000;

/** Drop a staged file that will not be imported after all. */
export async function discardStagedImport(uploadId: string, fileName: string) {
  return invoke<void>("discard_staged_import", { uploadId, fileName });
}

// --- Mobile dictation (in-app mode; desktop dictation uses the helper) ---

export type MobileDictationStatusDto = {
  sessionId: string;
  elapsedMs: number;
  peak: number;
};

export type MobileDictationResultDto = {
  text: string;
  rawText: string;
  language?: string;
};

export async function mobileDictationStart() {
  return invoke<MobileDictationStatusDto>("mobile_dictation_start");
}

export async function mobileDictationStatus() {
  return invoke<MobileDictationStatusDto | null>("mobile_dictation_status");
}

export async function mobileDictationStop(input: { style?: DictationStyle; language?: string }) {
  return invoke<MobileDictationResultDto>("mobile_dictation_stop", { request: input });
}

export async function mobileDictationCancel() {
  return invoke<void>("mobile_dictation_cancel");
}

export async function mobileListDictationHistory() {
  return invoke<ListDictationHistoryResponse>("mobile_list_dictation_history");
}

export async function mobileDeleteDictationHistoryItem(id: string) {
  return invoke<void>("mobile_delete_dictation_history_item", { id });
}

// --- Agent-lite (mobile chat over notes; desktop uses the Hermes runtime) ---

export const AGENT_LITE_STATUS_EVENT = "agent-lite://status";
export const AGENT_LITE_DONE_EVENT = "agent-lite://done";
/** Reply text as it is generated: `{ taskId, text }`, `text` being the
 * fragment to append to what has arrived so far. */
export const AGENT_LITE_DELTA_EVENT = "agent-lite://delta";
/** The assistant wrote to the notes (create_note / append_to_note), so any
 * list showing them is stale. Not agent-lite's alone since the desktop agent
 * got the same two tools: both shells write through `crate::agent_notes`, and
 * both emit this. */
export const NOTES_CHANGED_EVENT = "june://notes-changed";

export type AgentLiteStatusDto = {
  taskId: string;
  stage:
    | "thinking"
    | "searching-notes"
    | "searching-web"
    | "searching-memory"
    | "searching-places"
    | "searching-calendar"
    | "reading-note"
    | "writing-note"
    | "remembering"
    | "reading-page";
  detail?: string;
};

export type AgentLiteAttachment = {
  /** "image" (data is a data URI) or "text" (data is the file content). */
  kind: "image" | "text";
  name: string;
  data: string;
};

export async function agentLiteRun(
  taskId: string,
  model?: string,
  attachments?: AgentLiteAttachment[],
) {
  return invoke<AgentTaskDto>("agent_lite_run", { request: { taskId, model, attachments } });
}

/** iOS only: save a Studio artifact to the photo library. */
export async function saveToPhotos(path: string, kind: "image" | "video") {
  return invoke<void>("save_to_photos", { request: { path, kind } });
}

/** iOS only: open the system share sheet with a text payload. */
// iOS only: flips the shared AVAudioSession into the playback category before
// Studio media plays (so audio survives the lock screen and the silent
// switch) and releases it once playback stops. Desktop has no such command.
export async function setPlaybackAudioSession(active: boolean) {
  return invoke<void>("set_playback_audio_session", { active });
}

export async function shareText(text: string) {
  return invoke<void>("share_text", { request: { text } });
}

export async function dictationSettings() {
  return invoke<DictationSettingsResponse>("dictation_settings");
}

export async function listDictationHistory() {
  return invoke<ListDictationHistoryResponse>("list_dictation_history");
}

export async function deleteDictationHistoryItem(id: string) {
  return invoke<void>("delete_dictation_history_item", { id });
}

export async function providerModelSettings() {
  return invoke<ProviderModelSettingsResponse>("provider_model_settings");
}

export async function listVeniceModels(mode: ProviderModelMode) {
  return invoke<VeniceModelsResponse>("list_venice_models", {
    request: { mode },
  });
}

export async function setVeniceModel(mode: ProviderModelMode, modelId: string) {
  return invoke<ProviderModelSettingsDto>("set_venice_model", {
    request: { mode, modelId },
  });
}

export async function setVeniceApiKey(apiKey: string) {
  return invoke<ProviderModelSettingsDto>("set_venice_api_key", {
    request: { apiKey },
  });
}

export async function clearVeniceApiKey() {
  return invoke<ProviderModelSettingsDto>("clear_venice_api_key");
}

// --- Carpe Diem (Sub Rosa fork) --------------------------------------------
// The base URL is non-secret; the API key lives in the OS keychain and is never
// returned here — only `hasApiKey`. The sidecar status drives readiness gating.

export type CarpeDiemSettingsDto = {
  baseUrl: string;
  defaultBaseUrl: string;
  // The two endpoint choices offered in Settings, both built from the current
  // base's operator root. `routerBaseUrl` = the `/router` best-price rail (may
  // leave Carpe Diem's confidential network); `v1BaseUrl` = the `/v1` private
  // rail. The UI stores whichever the user picks via `carpeDiemSetBaseUrl`.
  routerBaseUrl: string;
  v1BaseUrl: string;
  hasApiKey: boolean;
};

export type CarpeDiemTestConnectionResult = {
  ok: boolean;
  modelCount?: number;
  message: string;
  code?: string;
};

export type CarpeDiemSidecarStatus = "unconfigured" | "starting" | "ready" | "failed";

export type CarpeDiemSidecarStatusDto = {
  status: CarpeDiemSidecarStatus;
  port?: number;
  message?: string;
  hasApiKey: boolean;
};

export async function carpeDiemGetSettings() {
  return invoke<CarpeDiemSettingsDto>("carpe_diem_get_settings");
}

export async function carpeDiemSetBaseUrl(baseUrl: string) {
  return invoke<CarpeDiemSettingsDto>("carpe_diem_set_base_url", {
    request: { baseUrl },
  });
}

export async function carpeDiemSetApiKey(apiKey: string) {
  return invoke<CarpeDiemSettingsDto>("carpe_diem_set_api_key", {
    request: { apiKey },
  });
}

export async function carpeDiemClearApiKey() {
  return invoke<CarpeDiemSettingsDto>("carpe_diem_clear_api_key");
}

export async function carpeDiemTestConnection() {
  return invoke<CarpeDiemTestConnectionResult>("carpe_diem_test_connection");
}

// Live balance for the sidebar footer. `priceMultiplier` is the current Carpe
// Diem fraction of the upstream rate (global daily factor, resets 00:00 UTC);
// it is absent when the public pricing endpoint can't be read. With a Venice
// key (no cdm_ prefix) the balance is Venice's USD + DIEM converted to credits
// (1 credit = $0.01) and the factor is a fixed 1.0 (full rate).
export type CarpeDiemCreditsDto = {
  availableCredits: number;
  escrowCredits: number;
  priceMultiplier?: number;
  /** Which rail this balance is for: the footer shows the balance that actually
   * pays (prepaid amounts are the account's USDC as credits). Absent for Venice. */
  rail?: "credits" | "prepaid";
  /** When the active rail is empty but the other rail holds funds, the rail to
   * propose switching to. Drives the proactive rail-switch prompt. */
  suggestSwitchTo?: "credits" | "prepaid";
};

export async function carpeDiemGetCredits() {
  return invoke<CarpeDiemCreditsDto>("carpe_diem_get_credits");
}

export type CarpeDiemRail = "auto" | "credits" | "prepaid";

/** Rail-aware payment view: the credits pool and the separate prepaid account,
 * plus the active rail. Carpe Diem keys only. */
export type CarpeDiemBillingDto = {
  availableCredits: number;
  availableUsdc: number;
  prepaidRegistered: boolean;
  prepaidUsdcBalance: number;
  rail: CarpeDiemRail;
  railFallback: boolean;
  hasPrepaidAccount: boolean;
};

export async function carpeDiemGetBilling() {
  return invoke<CarpeDiemBillingDto>("carpe_diem_get_billing");
}

export async function carpeDiemSetRail(rail: CarpeDiemRail) {
  return invoke<CarpeDiemBillingDto>("carpe_diem_set_rail", { request: { rail } });
}

/** Opens the Carpe Diem dashboard, where credits are bought. Routed through
 * Rust because the webview swallows target="_blank" anchors. */
export async function carpeDiemOpenDashboard() {
  return invoke<void>("carpe_diem_open_dashboard");
}

/** What the operator's prompt cache did for this run of the app.
 *
 * Counted in Rust from the metering the sidecar publishes on every completion,
 * so it covers both shells: the desktop agent, the mobile chat, memory
 * extraction, session titles and the Studio briefs all land in the same
 * totals. Resets when the app restarts - it answers "is the cache working",
 * not "what did I spend this month". */
export type CarpeDiemCacheStatsDto = {
  turns: number;
  turnsWithCacheHit: number;
  promptTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  completionTokens: number;
  cacheSavedUsdcMicro: number;
  costUsdcMicro: number;
  /** 0 to 1, or null when no turn has been measured yet. Null is "unknown",
   * not "zero percent" - the UI must not show a 0 % hit rate for a session
   * that has not talked to the model yet. */
  hitRatio: number | null;
};

export async function carpeDiemCacheStats() {
  return invoke<CarpeDiemCacheStatsDto>("carpe_diem_cache_stats");
}

export async function carpeDiemSidecarStatus() {
  return invoke<CarpeDiemSidecarStatusDto>("carpe_diem_sidecar_status");
}

export async function carpeDiemRestartSidecar() {
  return invoke<void>("carpe_diem_restart_sidecar");
}

// --- Local film production -------------------------------------------------

/** A note read as the shots a film is made of. See `src-tauri/src/shotlist`. */
export type ShotListDto = {
  noteId: string;
  status: "pending" | "running" | "ready" | "failed";
  shotsJson?: string | null;
  partsJson?: string | null;
  chunkCount: number;
  scriptChars: number;
  model: string;
  promptVersion: string;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ShotListPlanDto = {
  noteId: string;
  scriptChars: number;
  chunkCount: number;
  modelCalls: number;
  breakable: boolean;
  reason?: string | null;
};

/** A film, which is to say a note that has been read as shots. */
export type FilmListItemDto = {
  noteId: string;
  title: string;
  status: "pending" | "running" | "ready" | "failed";
  shotCount: number;
  updatedAt: string;
};

export async function listFilms() {
  return invoke<FilmListItemDto[]>("list_films");
}

export const SHOT_LIST_EVENT = "june://shot-list";

export async function shotList(noteId: string) {
  return invoke<ShotListDto | null>("shot_list", { noteId });
}

export async function shotListPlan(noteId: string) {
  return invoke<ShotListPlanDto>("shot_list_plan", { noteId });
}

export async function buildShotList(noteId: string) {
  return invoke<ShotListDto>("build_shot_list", { noteId });
}

/** Deleting the row is the cancel: there is nothing else to stop. */
export async function forgetShotList(noteId: string) {
  return invoke<void>("forget_shot_list", { noteId });
}

// Generates an image from a prompt via the June API. `model` is optional; the
// backend falls back to the saved default image model when it is omitted.
export async function generateImage(prompt: string, model?: string) {
  return invoke<GeneratedImageDto>("generate_image", {
    request: { prompt, model },
  });
}

export async function setDictationShortcut(
  kind: DictationShortcutKind,
  shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label" | "pressCount">,
) {
  return invoke<DictationSettingsDto>("set_dictation_shortcut", {
    kind,
    shortcut,
  });
}

export async function setDictationMicrophone(id?: string, name?: string) {
  return invoke<DictationSettingsDto>("set_dictation_microphone", {
    id,
    name,
  });
}

export async function setDictationStyle(style: DictationStyle) {
  return invoke<DictationSettingsDto>("set_dictation_style", { style });
}

export async function setDictationLanguage(language?: string) {
  return invoke<DictationSettingsDto>("set_dictation_language", {
    language: language || undefined,
  });
}

export async function dictationHelperCommand(command: Record<string, unknown>) {
  return invoke<void>("dictation_helper_command", { command });
}

export function localAudioFileSrc(path: string) {
  return convertFileSrc(path);
}

export async function dictationHotkeyStatus() {
  return invoke<DictationHelperEvent>("dictation_hotkey_status");
}

export async function latestDictationEvent() {
  const payload = await invoke<string | undefined>("latest_dictation_event");
  return payload ? (JSON.parse(payload) as DictationHelperEvent) : undefined;
}
