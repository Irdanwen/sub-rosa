use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl From<sqlx::error::Error> for AppError {
    fn from(value: sqlx::error::Error) -> Self {
        Self::new("storage_unavailable", value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub folders: Vec<FolderDto>,
    pub notes: Vec<NoteListItemDto>,
    pub active_recoveries: Vec<RecoverableRecordingDto>,
    pub provider_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesResponse {
    pub items: Vec<NoteListItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItemDto {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub processing_status: ProcessingStatus,
    pub folder_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub processing_status: ProcessingStatus,
    pub folder_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: Option<i64>,
    pub generated_content: Option<String>,
    pub edited_content: Option<String>,
    pub transcript: Option<TranscriptDto>,
    #[serde(default)]
    pub transcript_coverage: Option<TranscriptCoverageDto>,
    #[serde(default)]
    pub source_transcripts: Vec<TranscriptDto>,
    pub recording: Option<RecordingSessionDto>,
    pub audio: Option<AudioArtifactDto>,
    #[serde(default)]
    pub audio_sources: Vec<AudioArtifactDto>,
    pub active_tab: Option<String>,
    pub last_error: Option<String>,
    /// Recordings queued behind the one currently processing for this note
    /// (0 when nothing extra is waiting). Populated from the in-memory
    /// processing queue at the command layer, not persisted.
    #[serde(default)]
    pub queued_recordings: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCoverageDto {
    pub detected_speech_ms: i64,
    pub transcribed_ms: i64,
    pub warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteRequest {
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesRequest {
    pub folder_id: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNoteRequest {
    pub note_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNoteRequest {
    pub note_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNotesRequest {
    pub note_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteRequest {
    pub note_id: String,
    pub title: Option<String>,
    pub edited_content: Option<String>,
    pub active_tab: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderRequest {
    pub folder_id: String,
    pub delete_notes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFolderRequest {
    pub folder_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignNoteToFolderRequest {
    pub note_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveNoteFromFolderRequest {
    pub note_id: String,
    pub folder_id: String,
}

// Agent sessions are owned by Hermes; this only records which project
// (folder) a session was filed under, keyed by the Hermes session id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolderDto {
    pub session_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignSessionToFolderRequest {
    pub session_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSessionFromFolderRequest {
    pub session_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntryDto {
    pub id: String,
    pub phrase: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistoryItemDto {
    pub id: String,
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDictationHistoryResponse {
    pub items: Vec<DictationHistoryItemDto>,
    pub retention_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDictionaryEntryRequest {
    pub phrase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDictionaryEntryRequest {
    pub entry_id: String,
    pub phrase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDictionaryEntryRequest {
    pub entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub note_id: String,
    #[serde(default)]
    pub source_mode: Option<RecordingSourceMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRecordingResponse {
    pub note: NoteDto,
    pub recording: RecordingSessionDto,
    pub validation: AudioValidationDto,
    #[serde(default)]
    pub validations: Vec<SourceValidationDto>,
    pub processing_started: bool,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryProcessingRequest {
    pub note_id: String,
    pub step: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRecordingRequest {
    pub session_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePermissionResponse {
    pub state: String,
    pub recovery_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRecordingSourceReadinessRequest {
    pub source_mode: RecordingSourceMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSourceReadinessDto {
    pub source_mode: RecordingSourceMode,
    pub ready: bool,
    pub checked_at: String,
    pub sources: Vec<SourceReadinessDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReadinessDto {
    pub source: RecordingSource,
    pub required: bool,
    pub ready: bool,
    pub permission_state: String,
    pub device_available: bool,
    pub capture_available: bool,
    pub recovery_action: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPrivacySettingsRequest {
    pub pane: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub id: String,
    pub text: String,
    pub source_mode: Option<RecordingSourceMode>,
    pub source: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub turn_index: Option<i64>,
    pub language: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionDto {
    pub id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub state: RecordingState,
    pub started_at: String,
    pub elapsed_ms: i64,
    pub device_label: Option<String>,
    pub level: AudioLevelDto,
    #[serde(default)]
    pub live_preview_enabled: bool,
    #[serde(default)]
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatusDto {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    pub source_mode: RecordingSourceMode,
    pub state: RecordingState,
    pub elapsed_ms: i64,
    pub level: AudioLevelDto,
    pub silence_warning: bool,
    pub bytes_written: i64,
    #[serde(default)]
    pub live_preview_enabled: bool,
    #[serde(default)]
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioArtifactDto {
    pub id: String,
    pub source: String,
    pub format: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub checksum: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusDto {
    pub source: RecordingSource,
    pub state: SourceState,
    pub elapsed_ms: i64,
    pub bytes_written: i64,
    pub level: AudioLevelDto,
    pub silence_warning: bool,
    pub path_finalized: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceValidationDto {
    pub source: RecordingSource,
    pub file_exists: bool,
    pub non_zero_size: bool,
    pub readable_audio: bool,
    pub expected_duration_ms: i64,
    pub actual_duration_ms: Option<i64>,
    pub duration_within_tolerance: bool,
    pub non_silent_signal: bool,
    pub peak_amplitude: Option<f32>,
    pub rms_amplitude: Option<f32>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceWarningDto {
    pub source: RecordingSource,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioValidationDto {
    pub file_exists: bool,
    pub non_zero_size: bool,
    pub readable_audio: bool,
    pub expected_duration_ms: i64,
    pub actual_duration_ms: i64,
    pub duration_within_tolerance: bool,
    pub non_silent_signal: bool,
    pub peak_amplitude: f32,
    pub rms_amplitude: f32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelDto {
    pub peak: f32,
    pub rms: f32,
    pub recent_peaks: Vec<f32>,
}

impl Default for AudioLevelDto {
    fn default() -> Self {
        Self {
            peak: 0.0,
            rms: 0.0,
            recent_peaks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableRecordingDto {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub started_at: String,
    pub partial_path_present: bool,
    pub final_path_present: bool,
    pub bytes_found: i64,
    #[serde(default)]
    pub sources: Vec<RecoverableSourceDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableSourceDto {
    pub source: RecordingSource,
    pub partial_path_present: bool,
    pub final_path_present: bool,
    pub bytes_found: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskListResponse {
    pub items: Vec<AgentTaskDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskDto {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub status: AgentTaskStatus,
    pub safety_profile: AgentSafetyProfile,
    pub hermes_session_id: Option<String>,
    /// The chat model this session last ran with (agent-lite). `None` means the
    /// app default applies; set at creation and on a mid-conversation switch.
    pub model: Option<String>,
    pub progress_summary: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub messages: Vec<AgentMessageDto>,
    #[serde(default)]
    pub tool_events: Vec<AgentToolEventDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageDto {
    pub id: String,
    pub task_id: String,
    pub role: AgentMessageRole,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolEventDto {
    pub id: String,
    pub task_id: String,
    pub tool_name: String,
    pub status: AgentToolEventStatus,
    pub summary: String,
    pub arguments_json: Option<String>,
    pub result_json: Option<String>,
    pub redacted: bool,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// A durable fact about the user, remembered across conversations. Extracted
/// automatically from agent chats or added manually in Settings; injected into
/// the system prompt of future desktop (Hermes) and mobile (agent-lite) chats.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDto {
    pub id: String,
    pub text: String,
    pub source: MemorySource,
    /// 1 (essential) to 10 (trivial) — lower is more important.
    pub importance: i64,
    pub disabled: bool,
    pub has_embedding: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemorySource {
    Auto,
    Manual,
}

impl MemorySource {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
}

impl From<&str> for MemorySource {
    fn from(value: &str) -> Self {
        match value {
            "manual" => Self::Manual,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentTaskRequest {
    pub prompt: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub safety_profile: Option<AgentSafetyProfile>,
    #[serde(default)]
    pub run_placeholder: Option<bool>,
    /// The chat model the new session should record (agent-lite). Omitted or
    /// empty leaves it NULL so the app default applies.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentTaskRequest {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAgentMessageRequest {
    pub task_id: String,
    pub content: String,
    #[serde(default)]
    pub run_placeholder: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentAssistantMessageRequest {
    pub task_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentHermesSessionRequest {
    pub task_id: String,
    pub hermes_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentTaskModelRequest {
    pub task_id: String,
    /// The chat model id to remember for this session. Empty/whitespace clears
    /// it (NULL), so the session falls back to the app default.
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkAgentTaskRequest {
    pub source_task_id: String,
    /// The chat model the fork should run on. Empty/whitespace falls back to the
    /// source chat's own model.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestAgentSessionTitleRequest {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestAgentSessionTitleResponse {
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitIssueReportRequest {
    /// Which kind of report this is ("bug" | "feedback" | "feature"), used for
    /// triage on the server. Optional so older callers keep deserializing.
    #[serde(default)]
    pub category: Option<String>,
    pub description: String,
    #[serde(default)]
    pub agent_diagnosis: Option<String>,
    #[serde(default)]
    pub attachment_names: Vec<String>,
    /// Local paths of the attached files (already imported into the Hermes
    /// workspace); their bytes are uploaded with the report.
    #[serde(default)]
    pub attachment_paths: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitIssueReportResponse {
    pub received: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainAgentApprovalRequest {
    pub description: String,
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainAgentApprovalResponse {
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskRequest {
    pub task_id: String,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSafetyProfile {
    #[default]
    AutonomousPrivate,
}

impl AgentSafetyProfile {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::AutonomousPrivate => "autonomous_private",
        }
    }
}

impl From<&str> for AgentSafetyProfile {
    fn from(value: &str) -> Self {
        match value {
            "autonomous_private" | "autonomousPrivate" => Self::AutonomousPrivate,
            _ => Self::AutonomousPrivate,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentTaskStatus {
    Draft,
    Queued,
    Running,
    WaitingForUser,
    #[default]
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl AgentTaskStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingForUser => "waiting_for_user",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl From<&str> for AgentTaskStatus {
    fn from(value: &str) -> Self {
        match value {
            "draft" => Self::Draft,
            "queued" => Self::Queued,
            "running" => Self::Running,
            "waiting_for_user" | "waitingForUser" => Self::WaitingForUser,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Paused,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentMessageRole {
    System,
    Assistant,
    #[default]
    User,
}

impl AgentMessageRole {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Assistant => "assistant",
            Self::User => "user",
        }
    }
}

impl From<&str> for AgentMessageRole {
    fn from(value: &str) -> Self {
        match value {
            "system" => Self::System,
            "assistant" => Self::Assistant,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolEventStatus {
    Proposed,
    Running,
    Completed,
    Failed,
    #[default]
    Blocked,
}

impl AgentToolEventStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
        }
    }
}

impl From<&str> for AgentToolEventStatus {
    fn from(value: &str) -> Self {
        match value {
            "proposed" => Self::Proposed,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Blocked,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessingStatus {
    Draft,
    Recording,
    Validating,
    Transcribing,
    Generating,
    Ready,
    Failed,
    Recoverable,
}

impl ProcessingStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Recording => "recording",
            Self::Validating => "validating",
            Self::Transcribing => "transcribing",
            Self::Generating => "generating",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Recoverable => "recoverable",
        }
    }
}

impl From<&str> for ProcessingStatus {
    fn from(value: &str) -> Self {
        match value {
            "recording" => Self::Recording,
            "validating" => Self::Validating,
            "transcribing" => Self::Transcribing,
            "generating" => Self::Generating,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            "recoverable" => Self::Recoverable,
            _ => Self::Draft,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSourceMode {
    #[default]
    MicrophoneOnly,
    MicrophonePlusSystem,
}

impl RecordingSourceMode {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::MicrophoneOnly => "microphone_only",
            Self::MicrophonePlusSystem => "microphone_plus_system",
        }
    }

    pub fn required_sources(self) -> Vec<RecordingSource> {
        match self {
            Self::MicrophoneOnly => vec![RecordingSource::Microphone],
            Self::MicrophonePlusSystem => {
                vec![RecordingSource::Microphone, RecordingSource::System]
            }
        }
    }
}

impl From<&str> for RecordingSourceMode {
    fn from(value: &str) -> Self {
        match value {
            "microphone_plus_system" | "microphonePlusSystem" => Self::MicrophonePlusSystem,
            _ => Self::MicrophoneOnly,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSource {
    Microphone,
    System,
}

impl RecordingSource {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
        }
    }
}

impl From<&str> for RecordingSource {
    fn from(value: &str) -> Self {
        match value {
            "system" => Self::System,
            _ => Self::Microphone,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingState {
    Idle,
    PermissionDenied,
    Starting,
    Recording,
    Paused,
    Finalizing,
    Validating,
    PartiallyValid,
    Invalid,
    Ready,
    Failed,
    Recoverable,
}

impl RecordingState {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::PermissionDenied => "permission_denied",
            Self::Starting => "starting",
            Self::Recording => "recording",
            Self::Paused => "paused",
            Self::Finalizing => "finalizing",
            Self::Validating => "validating",
            Self::PartiallyValid => "partially_valid",
            Self::Invalid => "invalid",
            Self::Ready => "valid",
            Self::Failed => "failed",
            Self::Recoverable => "recoverable",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Pending,
    PermissionDenied,
    Unavailable,
    Starting,
    Recording,
    Paused,
    Finalizing,
    Finalized,
    Valid,
    Invalid,
    Recoverable,
    Failed,
}

/// A Studio generation the backend has already accepted (and charged for),
/// tracked in SQLite so the poll survives the app being suspended or killed.
/// Rust owns the whole lifecycle from here on: poll, download into the gallery,
/// notify. The frontend reads these rows instead of polling itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJobDto {
    /// The backend's queue id — also the row's primary key, so re-queueing the
    /// same job twice cannot produce two rows.
    pub id: String,
    /// "video" | "music" | "image" | "sfx" — the gallery bucket to file into.
    pub kind: String,
    pub model: String,
    pub prompt: String,
    /// Extension for the downloaded artifact ("mp4", "mp3", ...).
    pub extension: String,
    pub status: MediaJobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Absolute path of the finished file in the gallery directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_bytes: Option<i64>,
    /// Gallery id of the clip this one continues, when it was started from a
    /// handoff frame. Carried on the row so a chain survives the app being
    /// closed mid-render.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_artifact_id: Option<String>,
    /// Where in the parent the handoff frame was taken, in seconds: the point
    /// assembly trims the parent's tail to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_handoff_seconds: Option<f64>,
    /// The quote this render was accepted at, in credits. An estimate, not a
    /// receipt: it is what the backend priced before rendering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_credits: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaJobStatus {
    Queued,
    Processing,
    Completed,
    Failed,
}

impl MediaJobStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// Whether the backend may still be working on it — the rows a sweep picks
    /// back up.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Processing)
    }
}

impl From<&str> for MediaJobStatus {
    fn from(value: &str) -> Self {
        match value {
            "processing" => Self::Processing,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Queued,
        }
    }
}

/// A dictation whose audio is already on disk but whose transcription has not
/// come back yet. The row is what makes the round-trip resumable: losing it to
/// a screen lock used to lose the recording with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDictationDto {
    pub id: String,
    pub audio_path: String,
    pub style: String,
    pub language: Option<String>,
    pub attempts: i64,
    pub created_at: String,
}
