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

/// Epoch seconds to the RFC3339 the database stores everywhere else.
pub fn rfc3339_from_epoch_secs(seconds: i64) -> String {
    chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
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
    /// Calendar context (crate::calendar), when a recording matched an event.
    /// Every field is None for a note with no event, which is every note the
    /// app made before this existed — and any note the user records outside a
    /// meeting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_event_id: Option<String>,
    /// When the meeting was scheduled to start (RFC3339), as opposed to when
    /// the recording actually did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_start: Option<String>,
    /// Who was invited, from the invitation. Display metadata on the note —
    /// not a directory, and never an attribution of who said what.
    #[serde(default)]
    pub attendees: Vec<String>,
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

/// A link being turned into a note (ADR-0028).
///
/// Covers only the steps before transcription: resolve, fetch, hand over. Once
/// `note_id` is set the note carries its own status and this row is history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IngestDto {
    pub id: String,
    pub url: String,
    /// direct | feed | platform
    pub kind: String,
    /// pending | fetching | done | failed
    pub status: String,
    pub title: Option<String>,
    pub media_url: Option<String>,
    pub note_id: Option<String>,
    pub folder_id: Option<String>,
    pub bytes_done: i64,
    pub bytes_total: Option<i64>,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A film, which is to say a note that has been read as shots.
///
/// No new row and no new noun: the film IS the note, and this is the note's
/// title next to the state of its reading. Listing films is listing these.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilmListItemDto {
    pub note_id: String,
    pub title: String,
    /// pending | running | ready | failed
    pub status: String,
    pub shot_count: i64,
    pub updated_at: String,
}

/// A note broken into the shots a film is made of (migration 018).
///
/// Derived from the note, regenerable in place, and resumable part by part.
/// `shots_json` deliberately carries no model, duration or aspect ratio: the
/// model returns a motion class and who is in the shot, and the app resolves
/// the rest against a catalogue it can actually see.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShotListDto {
    pub note_id: String,
    /// pending | running | ready | failed
    pub status: String,
    /// The finished list, as JSON, when there is one.
    pub shots_json: Option<String>,
    /// Finished map passes, so a resume does not re-buy them.
    pub parts_json: Option<String>,
    pub chunk_count: i64,
    pub script_chars: i64,
    pub model: String,
    pub prompt_version: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One persistent identity of a production: a character, a location, a prop or
/// a look (see `migrations/017_bible.sql`).
///
/// `traits` is what must not drift between shots - the palette, the wardrobe,
/// the relative height - restated on every prompt because that restating is
/// what keeps a face the same face across separately generated clips.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibleEntryDto {
    pub id: String,
    /// character | location | prop | look
    pub kind: String,
    pub name: String,
    pub traits: String,
    pub note: String,
    pub refs: Vec<BibleRefDto>,
    pub created_at: String,
    pub updated_at: String,
}

/// A gallery artifact standing in for part of an entry.
///
/// `artifact_id` is the gallery id, which is the file name. Not a foreign key:
/// the gallery index lives in the webview and its entries come and go
/// legitimately, so a reference whose artifact has gone is reported rather
/// than deleted behind the user's back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibleRefDto {
    pub id: String,
    pub entry_id: String,
    pub artifact_id: String,
    /// portrait | profile | wide | medium | detail | voice
    pub role: String,
    pub label: String,
    pub ordinal: i64,
    pub created_at: String,
}

/// A long-form summary of a note's transcript (ADR-0027).
///
/// The row exists from the moment the work is asked for, so a summary
/// interrupted by a lock screen or a crash is a row to re-drive rather than a
/// lost task. `shortSummary` lands before `detailedSummary` on a multi-chunk
/// run: a provisional paragraph is worth more in ten seconds than a perfect
/// one in three minutes, and it is replaced by the final one at the end.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummaryDto {
    pub note_id: String,
    /// pending | running | ready | failed
    pub status: String,
    pub short_summary: Option<String>,
    /// Markdown, with resolved timestamps in the `##` headings.
    pub detailed_summary: Option<String>,
    pub transcript_chars: i64,
    pub chunk_count: i64,
    pub chunks_done: i64,
    /// Finished map passes, so an interrupted run resumes where it stopped
    /// rather than re-buying what already landed. Scaffolding, not content:
    /// cleared the moment the summary is ready, and never shown.
    #[serde(skip)]
    pub parts: Vec<String>,
    pub model: String,
    pub prompt_version: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
    /// What actually happened to the report. `received: true` only ever meant
    /// "the request did not error", which is why the UI could thank the user
    /// for a report that reached a log file and nothing else.
    #[serde(default)]
    pub delivery: Option<crate::carpe_diem::issue_reports::Delivery>,
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
    /// The HTTP status the failure arrived with, when it came from the backend
    /// rather than from us. Kept beside the message because the messages
    /// themselves do not distinguish the cases the user has to act on: a job
    /// the operator dropped and one the upstream refused read almost alike,
    /// and only the code says which.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_status: Option<i64>,
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
    /// Who queued the job. `None`/"studio" is a hand-run generation; a
    /// workflow run's renders say "workflow" so the Studio surfaces leave
    /// their rows alone (the run is what files and dismisses them).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
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

/// A Studio workflow production, frozen at launch and resumable (ADR-0021).
///
/// The graph executes in the webview (two of its node types need WebKit), but
/// the *state* of the run lives here: which nodes are done and what they
/// produced, which render job a node is waiting on. Long renders ride
/// `media_jobs`, so a kill mid-render loses nothing — the next foreground
/// session reads these rows and stitches on from exactly where it stopped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDto {
    pub id: String,
    /// The saved workflow this run was started from (may be deleted since).
    pub workflow_id: String,
    pub name: String,
    /// The workflow graph as launched, JSON. Frozen so edits to the saved
    /// workflow cannot change what a resume re-executes.
    pub definition: String,
    pub status: WorkflowRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Per-node cost figures the run was confirmed at, JSON, for stamping
    /// onto what a resume produces.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_costs: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One node's durable state inside a workflow run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunNodeDto {
    pub node_id: String,
    /// Mirrors the engine: pending, running, done or error.
    pub status: String,
    /// The node's dehydrated output once done (JSON: artifact references and
    /// small payloads, never large media bytes) — or, while running, the
    /// `pendingJobId` of the media job it waits on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStatus {
    Running,
    /// A gate node is holding the production for the user's approval. Not
    /// terminal: the run resumes once they decide.
    AwaitingGate,
    Completed,
    Failed,
    Cancelled,
}

impl WorkflowRunStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::AwaitingGate => "awaiting_gate",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl From<&str> for WorkflowRunStatus {
    fn from(value: &str) -> Self {
        match value {
            // Both spellings: the DB stores snake case, the IPC camel case.
            "awaiting_gate" | "awaitingGate" => Self::AwaitingGate,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Running,
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

// --- The council (ADR-0034) ------------------------------------------------
//
// These live here rather than in `council/` because the repository writes them
// and the repository is compiled on both platforms. The module itself, and
// every command it exposes, is desktop-only: there is no Hermes on iOS, so
// there is nothing for a mandate to be handed to.

/// One seat of a council, frozen at convocation together with the model it
/// will run on.
///
/// The model is recorded rather than looked up later because the whole point
/// of the roster is that two seats never share a family: a verdict read months
/// afterwards has to be able to show which weights said what.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CouncilSeatDto {
    pub id: String,
    pub name: String,
    /// position | objection | conformance | collateral | letter
    pub role: String,
    /// What this seat is for, in one line. Shown to the user, so it is prose,
    /// not the seat's system prompt.
    pub charge: String,
    pub model: String,
    /// Derived from the id (see `council::seats::model_family`). Stored so the
    /// no-two-seats-share-a-family rule can be audited after the fact.
    pub model_family: String,
}

/// One checkable statement in a mandate, carrying how it is verified.
///
/// `verified_by` is not decoration. A criterion whose verification is empty is
/// rejected by the validator, because the verdict has nothing to do with it
/// and "it looks good" would otherwise pass as a criterion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCriterionDto {
    pub statement: String,
    pub verified_by: String,
}

/// The mandate itself: capped slots, never prose.
///
/// The app renders these into the string handed to the agent
/// (`council::mandate::render`). No model is ever asked for that string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MandateDto {
    pub objective: String,
    pub deliverable: Vec<String>,
    pub constraints: Vec<String>,
    pub acceptance: Vec<AcceptanceCriterionDto>,
    pub out_of_scope: Vec<String>,
    pub first_step: String,
}

/// A question the seats want answered before the mandate is issued.
///
/// `raised_by` is how many seats asked it independently in the blind round.
/// One is an idiosyncrasy and never reaches the user, two or more is a real
/// ambiguity in the request -- which is the whole reason for having several
/// seats ask.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CouncilQuestionDto {
    pub id: String,
    pub question: String,
    pub raised_by: i64,
    pub answer: Option<String>,
}

/// One cycle: a request, the seats convened on it, the mandate they issued,
/// and the session that executed it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilMandateDto {
    pub id: String,
    pub council_id: String,
    /// The user's words, verbatim. Never rewritten -- the mandate is the
    /// interpretation, and being able to compare the two is the point.
    pub request: String,
    /// deliberating | questions | ready | executing | reviewing | settled | failed
    pub status: String,
    pub seats: Vec<CouncilSeatDto>,
    /// The ground the seats were handed: the working folder and what is in it,
    /// the runtime mode, what the agent can actually do.
    pub situation: Option<String>,
    pub questions: Vec<CouncilQuestionDto>,
    pub mandate: Option<MandateDto>,
    /// Where the seats disagreed and the chair had to choose. A property of the
    /// sitting, not of the mandate: the mandate is the contract with the agent
    /// and this is not part of it. Shown to the user before they accept,
    /// because they are the person who can settle it.
    pub dissent: Vec<String>,
    /// What the caps had to cut. Empty is the good case. Never swallowed: a
    /// truncation nobody is told about reads as "everything you asked for is in
    /// there".
    pub cuts: Vec<String>,
    /// Exactly the string the agent was handed. Stored rather than recomputed:
    /// the feature rests on being able to say what was asked, without trusting
    /// that the renderer has not changed since.
    pub rendered_prompt: Option<String>,
    pub session_id: Option<String>,
    pub working_dir: Option<String>,
    /// The folder's HEAD when the agent took the mandate. What the verdict
    /// diffs against, so work the session committed is visible to it.
    pub base_commit: Option<String>,
    /// The model the work was done on. The verdict stays off its family.
    pub session_model: Option<String>,
    /// Retake count. Zero is the first pass.
    pub round: i64,
    pub model_calls: i64,
    pub prompt_version: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// What one seat produced in one phase of one round. The resume unit: a
/// sitting interrupted at the fourth of five seats restarts at the fifth.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilTurnDto {
    pub mandate_id: String,
    pub round: i64,
    /// blind | contradiction | verdict
    pub phase: String,
    pub seat_id: String,
    pub model: String,
    pub content: String,
    /// A seat that failed is recorded, not retried forever. A council of five
    /// that loses one still deliberates -- and the verdict says it did.
    pub failed: bool,
    pub created_at: String,
}

/// One criterion, judged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CriterionVerdictDto {
    pub statement: String,
    /// satisfied | unsatisfied | unverifiable
    pub status: String,
    /// What settled it: a path, a line, a command's output, a reading. Empty
    /// evidence downgrades a "satisfied" to "unverifiable" in the chair's
    /// merge -- an unevidenced pass is an opinion.
    pub evidence: String,
    pub seat: String,
}

/// Something the mandate did not ask about: a change nobody requested, work
/// that was quietly skipped, a criterion satisfied in the letter only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerdictFindingDto {
    /// collateral | skipped | letter
    pub kind: String,
    pub summary: String,
    pub evidence: String,
    pub seat: String,
}

/// The council's judgement of finished work against the mandate that asked for
/// it. One per round, because a retake produces another and the first must
/// survive it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilVerdictDto {
    pub mandate_id: String,
    pub round: i64,
    /// running | ready | failed
    pub status: String,
    pub session_id: Option<String>,
    pub criteria: Vec<CriterionVerdictDto>,
    pub findings: Vec<VerdictFindingDto>,
    /// The chair's short reading. Never a score: a number would invite tuning
    /// the number.
    pub summary: Option<String>,
    /// The prompts that produced this verdict, not the ones that produced the
    /// mandate: a retake can land after an app update.
    pub prompt_version: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The parsed contents of `council_verdicts.verdict_json`, kept as a type so
/// the row mapper and the module agree on the shape without a `Value` in
/// between.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CouncilVerdictBody {
    #[serde(default)]
    pub criteria: Vec<CriterionVerdictDto>,
    #[serde(default)]
    pub findings: Vec<VerdictFindingDto>,
    #[serde(default)]
    pub summary: Option<String>,
}
