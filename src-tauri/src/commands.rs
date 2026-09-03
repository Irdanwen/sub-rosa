use crate::{
    app_paths::AppPaths,
    audio::{
        capture::{
            capture_status_for_recovery, finish_active_capture, finish_capture, is_capture_active,
            microphone_device_available, microphone_device_hint, microphone_permission_state,
            pause_capture, resume_capture, start_capture, CaptureRecoverySnapshot,
        },
        recovery::scan_recoverable_recordings,
        validation::{
            checksum_file, source_audio_passes_validation, validate_audio_artifact,
            validation_config_for_source, AudioValidationConfig,
        },
    },
    db::{migrations::run_migrations, repositories::Repositories},
    domain::{
        processing::{
            is_wav_path, manual_notes_for_generation, process_imported_audio, process_saved_audio,
            process_saved_source_audio,
        },
        processing_queue,
        types::{
            AgentMessageRole, AgentTaskDto, AgentTaskListResponse, AgentTaskRequest,
            AgentTaskStatus, AgentToolEventDto, AgentToolEventStatus, AppError,
            AssignNoteToFolderRequest, AssignSessionToFolderRequest, BootstrapResponse,
            CheckRecordingSourceReadinessRequest, CreateAgentTaskRequest,
            CreateDictionaryEntryRequest, CreateFolderRequest, CreateNoteRequest,
            DeleteDictionaryEntryRequest, DeleteFolderRequest, DeleteNoteRequest,
            DeleteNotesRequest, DictionaryEntryDto, ExplainAgentApprovalRequest,
            ExplainAgentApprovalResponse, FinishRecordingResponse, ForkAgentTaskRequest,
            GetAgentTaskRequest, GetNoteRequest, ListNotesRequest, ListNotesResponse,
            MicrophonePermissionResponse, NoteDto, OpenPrivacySettingsRequest, ProcessingStatus,
            RecordingSessionDto, RecordingSource, RecordingSourceMode, RecordingSourceReadinessDto,
            RecordingStatusDto, RemoveNoteFromFolderRequest, RemoveSessionFromFolderRequest,
            RenameFolderRequest, RetryProcessingRequest, SaveAgentAssistantMessageRequest,
            SaveAgentHermesSessionRequest, SendAgentMessageRequest, SessionFolderDto,
            SessionRequest, SetAgentTaskModelRequest, SourceReadinessDto, StartRecordingRequest,
            SubmitIssueReportRequest, SubmitIssueReportResponse, SuggestAgentSessionTitleRequest,
            SuggestAgentSessionTitleResponse, UpdateDictionaryEntryRequest, UpdateNoteRequest,
        },
    },
};
use chrono::{TimeZone, Utc};
use sqlx::query::query;
use sqlx::row::Row;
use sqlx_sqlite::SqlitePool;
use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::AppHandle;
use tokio::sync::OnceCell;

#[tauri::command]
pub async fn bootstrap_app(app: AppHandle) -> Result<BootstrapResponse, AppError> {
    let repos = repositories(&app).await?;
    // Complete stale tasks that already received their assistant reply
    // before pausing the rest: the repair only considers queued/running
    // tasks, so it must run before they are flipped to paused.
    repos.complete_agent_tasks_with_assistant_messages().await?;
    repos.pause_running_agent_tasks_on_launch().await?;
    let active_recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .map_err(|error| AppError::new("recovery_scan_failed", error.to_string()))?;
    for recovery in &active_recoveries {
        repos
            .mark_recording_recoverable(&recovery.session_id, &recovery.note_id)
            .await?;
    }
    let folders = repos
        .list_folders()
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    let notes = repos
        .list_notes(None, 100, None)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
        .items;
    Ok(BootstrapResponse {
        folders,
        notes,
        active_recoveries,
        provider_configured: crate::providers::provider_configured(),
    })
}

#[tauri::command]
pub async fn create_note(app: AppHandle, request: CreateNoteRequest) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .create_note(request.folder_id)
        .await?)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEverythingRequest {
    pub query: String,
    pub limit: Option<i64>,
}

/// The search that reads the notes, the transcripts, the memories and the
/// conversations (migration 020). Shared by both shells: the palette on the
/// desktop, the notes screen on the phone, and agent-lite's `search_notes`.
#[tauri::command]
pub async fn search_everything(
    app: AppHandle,
    request: SearchEverythingRequest,
) -> Result<Vec<crate::db::repositories::SearchHit>, AppError> {
    Ok(repositories(&app)
        .await?
        .search_everything(&request.query, request.limit.unwrap_or(20))
        .await?)
}

#[tauri::command]
pub async fn list_notes(
    app: AppHandle,
    request: ListNotesRequest,
) -> Result<ListNotesResponse, AppError> {
    Ok(repositories(&app)
        .await?
        .list_notes(
            request.folder_id,
            request.limit.unwrap_or(100),
            request.cursor,
        )
        .await?)
}

#[tauri::command]
pub async fn get_note(app: AppHandle, request: GetNoteRequest) -> Result<NoteDto, AppError> {
    let mut note = repositories(&app).await?.get_note(&request.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&request.note_id);
    Ok(note)
}

#[tauri::command]
pub async fn update_note(app: AppHandle, request: UpdateNoteRequest) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .update_note(
            &request.note_id,
            request.title,
            request.edited_content,
            request.active_tab,
        )
        .await?)
}

#[tauri::command]
pub async fn delete_note(app: AppHandle, request: DeleteNoteRequest) -> Result<(), AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let audio_paths = repos
        .audio_artifact_paths_for_note(&request.note_id)
        .await?;
    repos.delete_note(&request.note_id).await?;
    // A search result must never outlive the note it points at.
    crate::spotlight::forget(std::slice::from_ref(&request.note_id));
    for path in audio_paths {
        if path.trim().is_empty() {
            continue;
        }
        if let Err(error) = paths.remove_recording_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove deleted note audio {path}: {error}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_notes(app: AppHandle, request: DeleteNotesRequest) -> Result<(), AppError> {
    let note_ids = request
        .note_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if note_ids.is_empty() {
        return Ok(());
    }

    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let audio_paths = repos.audio_artifact_paths_for_notes(&note_ids).await?;
    repos.delete_notes(&note_ids).await?;
    crate::spotlight::forget(&note_ids);
    for path in audio_paths {
        if path.trim().is_empty() {
            continue;
        }
        if let Err(error) = paths.remove_recording_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove deleted note audio {path}: {error}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_folder(
    app: AppHandle,
    request: CreateFolderRequest,
) -> Result<crate::domain::types::FolderDto, AppError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            "folder_name_required",
            "Folder name is required.",
        ));
    }
    Ok(repositories(&app)
        .await?
        .create_folder(name, request.description.as_deref())
        .await?)
}

#[tauri::command]
pub async fn list_folders(
    app: AppHandle,
) -> Result<Vec<crate::domain::types::FolderDto>, AppError> {
    Ok(repositories(&app).await?.list_folders().await?)
}

#[tauri::command]
pub async fn delete_folder(app: AppHandle, request: DeleteFolderRequest) -> Result<(), AppError> {
    repositories(&app)
        .await?
        .delete_folder(&request.folder_id, request.delete_notes)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(
    app: AppHandle,
    request: RenameFolderRequest,
) -> Result<crate::domain::types::FolderDto, AppError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            "folder_name_required",
            "Folder name is required.",
        ));
    }
    repositories(&app)
        .await?
        .rename_folder(&request.folder_id, name, request.description.as_deref())
        .await
}

#[tauri::command]
pub async fn assign_note_to_folder(
    app: AppHandle,
    request: AssignNoteToFolderRequest,
) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .assign_note_to_folder(&request.note_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn remove_note_from_folder(
    app: AppHandle,
    request: RemoveNoteFromFolderRequest,
) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .remove_note_from_folder(&request.note_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_session_folders(app: AppHandle) -> Result<Vec<SessionFolderDto>, AppError> {
    Ok(repositories(&app).await?.list_session_folders().await?)
}

#[tauri::command]
pub async fn assign_session_to_folder(
    app: AppHandle,
    request: AssignSessionToFolderRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .assign_session_to_folder(&request.session_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn remove_session_from_folder(
    app: AppHandle,
    request: RemoveSessionFromFolderRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .remove_session_from_folder(&request.session_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_dictionary_entries(app: AppHandle) -> Result<Vec<DictionaryEntryDto>, AppError> {
    Ok(repositories(&app).await?.list_dictionary_entries().await?)
}

#[tauri::command]
pub async fn list_agent_tasks(app: AppHandle) -> Result<AgentTaskListResponse, AppError> {
    let repos = repositories(&app).await?;
    repos.complete_agent_tasks_with_assistant_messages().await?;
    let response = repos.list_agent_tasks().await?;
    for task in &response.items {
        if let Err(error) = hydrate_agent_task_from_hermes(&app, &repos, &task.id).await {
            eprintln!(
                "failed to hydrate agent task {} from Hermes state: {}",
                task.id, error.message
            );
        }
    }
    Ok(repos.list_agent_tasks().await?)
}

#[tauri::command]
pub async fn create_agent_task(
    app: AppHandle,
    request: CreateAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::new(
            "agent_prompt_required",
            "Describe what the agent should do.",
        ));
    }
    let repos = repositories(&app).await?;
    let task = repos
        .create_agent_task(
            prompt,
            request.title.as_deref(),
            request.safety_profile.unwrap_or_default(),
            request.model.as_deref(),
        )
        .await?;
    if request.run_placeholder.unwrap_or(true) {
        schedule_agent_runtime_placeholder(repos, task.id.clone());
    }
    Ok(task)
}

#[tauri::command]
pub async fn get_agent_task(
    app: AppHandle,
    request: GetAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    if let Err(error) = hydrate_agent_task_from_hermes(&app, &repos, &request.task_id).await {
        eprintln!(
            "failed to hydrate agent task {} from Hermes state: {}",
            request.task_id, error.message
        );
    }
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn send_agent_message(
    app: AppHandle,
    request: SendAgentMessageRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = request.content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "agent_message_required",
            "Message content is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .add_agent_message(&request.task_id, AgentMessageRole::User, content)
        .await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Queued,
            Some("Queued for the agent runtime."),
            None,
        )
        .await?;
    if request.run_placeholder.unwrap_or(true) {
        schedule_agent_runtime_placeholder(repos.clone(), request.task_id.clone());
    }
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn save_agent_assistant_message(
    app: AppHandle,
    request: SaveAgentAssistantMessageRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = request.content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "agent_message_required",
            "Message content is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .add_agent_message(&request.task_id, AgentMessageRole::Assistant, content)
        .await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Completed,
            Some("Completed."),
            None,
        )
        .await?;
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn save_agent_hermes_session(
    app: AppHandle,
    request: SaveAgentHermesSessionRequest,
) -> Result<AgentTaskDto, AppError> {
    let hermes_session_id = request.hermes_session_id.trim();
    if hermes_session_id.is_empty() {
        return Err(AppError::new(
            "agent_hermes_session_required",
            "Hermes session id is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .set_agent_task_hermes_session(&request.task_id, hermes_session_id)
        .await?;
    Ok(repos.get_agent_task(&request.task_id).await?)
}

/// Remembers the chat model a mobile (agent-lite) session runs with, so the
/// picker restores it on reopen and a mid-conversation switch survives. Best
/// effort from the caller's view: an empty model clears the override.
#[tauri::command]
pub async fn set_agent_task_model(
    app: AppHandle,
    request: SetAgentTaskModelRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    repos
        .set_agent_task_model(&request.task_id, Some(request.model.as_str()))
        .await?;
    Ok(repos.get_agent_task(&request.task_id).await?)
}

/// Duplicate a mobile (agent-lite) chat onto another model: a new task with the
/// same transcript, bound to the chosen model, so the conversation can branch
/// onto a different model while the original stays untouched.
#[tauri::command]
pub async fn fork_agent_task(
    app: AppHandle,
    request: ForkAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    Ok(repos
        .fork_agent_task(&request.source_task_id, request.model.as_deref())
        .await?)
}

#[tauri::command]
pub async fn suggest_agent_session_title(
    request: SuggestAgentSessionTitleRequest,
) -> Result<SuggestAgentSessionTitleResponse, AppError> {
    let title = crate::june_api::suggest_agent_session_title(&request.prompt).await?;
    Ok(SuggestAgentSessionTitleResponse { title })
}

#[tauri::command]
pub async fn submit_issue_report(
    app: AppHandle,
    request: SubmitIssueReportRequest,
) -> Result<SubmitIssueReportResponse, AppError> {
    let app_version = app.package_info().version.to_string();
    let delivery = crate::carpe_diem::issue_reports::deliver(&app, &request, &app_version).await;
    Ok(SubmitIssueReportResponse {
        // The report is out of the user's hands either way; `delivery` is what
        // says whether it reached the tracker, and the UI reads that.
        received: true,
        delivery: Some(delivery),
    })
}

#[tauri::command]
pub async fn explain_agent_approval(
    request: ExplainAgentApprovalRequest,
) -> Result<ExplainAgentApprovalResponse, AppError> {
    let explanation =
        crate::june_api::explain_agent_approval(&request.description, request.command.as_deref())
            .await?;
    Ok(ExplainAgentApprovalResponse { explanation })
}

#[tauri::command]
pub async fn cancel_agent_task(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    repositories(&app)
        .await?
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Cancelled,
            Some("Cancelled by the user."),
            None,
        )
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn retry_agent_task(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Queued,
            Some("Queued for the agent runtime."),
            None,
        )
        .await?;
    schedule_agent_runtime_placeholder(repos.clone(), request.task_id.clone());
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn list_agent_tool_events(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<Vec<AgentToolEventDto>, AppError> {
    Ok(repositories(&app)
        .await?
        .agent_tool_events(&request.task_id)
        .await?)
}

#[tauri::command]
pub async fn create_dictionary_entry(
    app: AppHandle,
    request: CreateDictionaryEntryRequest,
) -> Result<DictionaryEntryDto, AppError> {
    let phrase = request.phrase.trim();
    if phrase.is_empty() {
        return Err(AppError::new(
            "dictionary_phrase_required",
            "Dictionary word or phrase is required.",
        ));
    }
    Ok(repositories(&app)
        .await?
        .create_dictionary_entry(phrase)
        .await?)
}

#[tauri::command]
pub async fn update_dictionary_entry(
    app: AppHandle,
    request: UpdateDictionaryEntryRequest,
) -> Result<DictionaryEntryDto, AppError> {
    let phrase = request.phrase.trim();
    if phrase.is_empty() {
        return Err(AppError::new(
            "dictionary_phrase_required",
            "Dictionary word or phrase is required.",
        ));
    }
    repositories(&app)
        .await?
        .update_dictionary_entry(&request.entry_id, phrase)
        .await
}

#[tauri::command]
pub async fn delete_dictionary_entry(
    app: AppHandle,
    request: DeleteDictionaryEntryRequest,
) -> Result<(), AppError> {
    repositories(&app)
        .await?
        .delete_dictionary_entry(&request.entry_id)
        .await
}

#[tauri::command]
pub async fn get_microphone_permission_state() -> Result<MicrophonePermissionResponse, AppError> {
    let (state, recovery_hint) = microphone_permission_state();
    Ok(MicrophonePermissionResponse {
        state,
        recovery_hint,
    })
}

#[tauri::command]
pub async fn check_recording_source_readiness(
    request: CheckRecordingSourceReadinessRequest,
) -> Result<RecordingSourceReadinessDto, AppError> {
    // The system-audio permission probe can block for over a minute while the
    // helper waits on a CoreAudio permission grant; keep that work off the
    // async runtime so other commands stay responsive.
    tokio::task::spawn_blocking(move || recording_source_readiness(request.source_mode))
        .await
        .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))
}

/// Opens the local backend's `/verify` page (what the backend does with the
/// user's data, and where prompts go) in the default browser. Must route
/// through Rust: the webview installs no new-window handler, so
/// `target="_blank"` anchors are silently dropped.
///
/// Errors rather than guessing an origin when the sidecar is down. Guessing
/// would mean opening somebody else's `/verify` page in the user's browser
/// and presenting it as this app's.
#[tauri::command]
pub fn june_open_verify_page() -> Result<(), AppError> {
    let url = crate::june_api::verify_url().ok_or_else(|| {
        AppError::new(
            "backend_not_ready",
            "The local backend is not running yet, so there is nothing to verify.",
        )
    })?;
    crate::os_accounts::open_in_browser(&url)
}

const JUNE_COMMUNITY_URL: &str = "https://t.me/CarpeDiemCommu";

/// Opens the Carpe Diem Telegram community in the default browser.
#[tauri::command]
pub fn june_open_community_page() -> Result<(), AppError> {
    crate::os_accounts::open_in_browser(JUNE_COMMUNITY_URL)
}

#[tauri::command]
pub async fn open_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let url = match request.pane.as_str() {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "systemAudio" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security",
        };
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| AppError::new("settings_open_failed", error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(AppError::new(
                "settings_open_failed",
                format!("System Settings returned status {status}."),
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        open_non_macos_privacy_settings(request)
    }
}

#[cfg(target_os = "windows")]
fn open_non_macos_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    match request.pane.as_str() {
        "microphone" => crate::os_accounts::open_in_browser("ms-settings:privacy-microphone"),
        _ => Err(AppError::new(
            "settings_open_unsupported",
            "This privacy settings shortcut is only supported on macOS.",
        )),
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_non_macos_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    let _ = request;
    Err(AppError::new(
        "settings_open_unsupported",
        "Privacy settings shortcuts are only supported on macOS.",
    ))
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    request: StartRecordingRequest,
) -> Result<RecordingSessionDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let note = repos.get_note(&request.note_id).await?;
    let source_mode = request.source_mode.unwrap_or_default();
    // iOS cannot tap other apps' audio (sandbox); only the microphone records.
    #[cfg(mobile)]
    if source_mode == RecordingSourceMode::MicrophonePlusSystem {
        return Err(AppError::new(
            "source_mode_unsupported",
            "System audio capture is not available on this device; record with the microphone.",
        ));
    }
    // Readiness probing and capture startup both wait on the system-audio
    // helper (up to tens of seconds); run them off the async runtime.
    let readiness = tokio::task::spawn_blocking(move || recording_source_readiness(source_mode))
        .await
        .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))?;
    if !readiness.ready {
        let message = readiness
            .sources
            .iter()
            .find(|source| source.required && !source.ready)
            .and_then(|source| source.message.clone())
            .unwrap_or_else(|| "The selected recording sources are not ready.".to_string());
        return Err(AppError::new("source_not_ready", message));
    }
    finish_active_capture_before_start(&app, &repos).await?;
    let capture_paths = paths.clone();
    let capture_note_id = note.id.clone();
    let started = tokio::task::spawn_blocking(move || {
        start_capture(app, &capture_paths, capture_note_id, source_mode)
    })
    .await
    .map_err(|error| AppError::new("recording_start_failed", error.to_string()))??;
    repos
        .create_recording_session(
            &note.id,
            &started.session_id,
            source_mode,
            &started.partial_path.to_string_lossy(),
            &started.final_path.to_string_lossy(),
            started.device_label.clone(),
        )
        .await?;
    for source in &started.sources {
        repos
            .create_pending_source_artifact(
                &note.id,
                &started.session_id,
                source.source.as_db(),
                &source.partial_path.to_string_lossy(),
                &source.final_path.to_string_lossy(),
            )
            .await?;
    }
    Ok(RecordingSessionDto {
        id: started.session_id,
        note_id: note.id,
        source_mode,
        state: started.status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: started.status.elapsed_ms,
        device_label: started.device_label,
        level: started.status.level,
        live_preview_enabled: started.status.live_preview_enabled,
        sources: started.status.sources,
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn pause_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    let snapshot = pause_capture(&request.session_id)?;
    checkpoint_recording_recovery_snapshot(&app, &snapshot).await;
    Ok(snapshot.status)
}

#[tauri::command]
pub async fn resume_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    let snapshot = resume_capture(&request.session_id)?;
    checkpoint_recording_recovery_snapshot(&app, &snapshot).await;
    Ok(snapshot.status)
}

#[tauri::command]
pub async fn get_recording_status(
    app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    let snapshot = capture_status_for_recovery(&request.session_id)?;
    checkpoint_recording_recovery_snapshot(&app, &snapshot).await;
    Ok(snapshot.status)
}

async fn checkpoint_recording_recovery_snapshot(
    app: &AppHandle,
    snapshot: &CaptureRecoverySnapshot,
) {
    if !snapshot.should_persist {
        return;
    }
    let repos = match repositories(app).await {
        Ok(repos) => repos,
        Err(error) => {
            eprintln!(
                "recording recovery checkpoint unavailable for session {}: {}: {}",
                snapshot.status.session_id, error.code, error.message
            );
            return;
        }
    };
    if let Err(error) = persist_recording_recovery_snapshot(&repos, snapshot).await {
        eprintln!(
            "recording recovery checkpoint failed for session {}: {}: {}",
            snapshot.status.session_id, error.code, error.message
        );
    }
}

async fn persist_recording_recovery_snapshot(
    repos: &Repositories,
    snapshot: &CaptureRecoverySnapshot,
) -> Result<(), AppError> {
    repos
        .update_recording_recovery_snapshot(
            &snapshot.status.session_id,
            snapshot.status.state,
            snapshot.status.elapsed_ms,
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn finish_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<FinishRecordingResponse, AppError> {
    let repos = repositories(&app).await?;
    let finalization_started = Instant::now();
    let finished = finish_capture(&request.session_id)?;
    finish_recording_session(&app, &repos, finished, finalization_started).await
}

async fn finish_active_capture_before_start(
    app: &AppHandle,
    repos: &Repositories,
) -> Result<(), AppError> {
    let finalization_started = Instant::now();
    if let Some(finished) = finish_active_capture()? {
        finish_recording_session(app, repos, finished, finalization_started).await?;
    }
    Ok(())
}

async fn finish_recording_session(
    app: &AppHandle,
    repos: &Repositories,
    finished: crate::audio::capture::FinishedRecording,
    finalization_started: Instant,
) -> Result<FinishRecordingResponse, AppError> {
    let finalization_ms = finalization_started
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    repos
        .add_checkpoint(
            &finished.session_id,
            "recording_finalization",
            Some(
                serde_json::json!({
                    "durationMs": finalization_ms,
                    "sourceCount": finished.sources.len(),
                })
                .to_string(),
            ),
        )
        .await?;
    repos
        .add_checkpoint(&finished.session_id, "done", None)
        .await?;
    let source_artifacts = repos
        .source_artifacts_for_session(&finished.session_id)
        .await?;
    let mut source_validations = Vec::new();
    let mut valid_sources = Vec::new();
    let mut warnings = Vec::new();
    let mut primary_validation = None;
    let mut primary_checksum = String::new();
    let mut primary_file_size = 0;
    let validation_started = Instant::now();
    for source in &finished.sources {
        let source_artifact = source_artifacts
            .iter()
            .find(|artifact| artifact.source == source.source.as_db());
        if let Some(issue) = source.capture_issue.as_ref() {
            repos
                .add_source_checkpoint(
                    &finished.session_id,
                    source_artifact.map(|artifact| artifact.id.as_str()),
                    Some(source.source.as_db()),
                    "capture_stream_error",
                    Some(
                        serde_json::json!({
                            "message": issue.message,
                            "elapsedMs": issue.elapsed_ms,
                        })
                        .to_string(),
                    ),
                )
                .await?;
        }
        let validation = validate_audio_artifact(
            &source.final_path,
            source.elapsed_ms,
            validation_config_for_source(source.source),
        )
        .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
        let checksum = checksum_file(&source.final_path).unwrap_or_default();
        let file_size = std::fs::metadata(&source.final_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or_default();
        if source.source == RecordingSource::Microphone {
            primary_validation = Some(validation.clone());
            primary_checksum = checksum.clone();
            primary_file_size = file_size;
        }
        let valid = source_audio_passes_validation(source.source, &validation);
        if let Some(artifact) = source_artifact {
            let final_path = source.final_path.to_string_lossy().into_owned();
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &final_path,
                    if valid { "valid" } else { "invalid" },
                    validation.actual_duration_ms,
                    file_size,
                    &checksum,
                    source.elapsed_ms,
                    Some(serde_json::to_string(&validation).unwrap_or_default()),
                    if valid {
                        None
                    } else {
                        Some(validation.warnings.join("; "))
                    },
                )
                .await?;
            if valid {
                valid_sources.push((
                    artifact.id.clone(),
                    source.source.as_db().to_string(),
                    source.final_path.clone(),
                ));
            }
        }
        if !valid {
            warnings.push(crate::domain::types::SourceWarningDto {
                source: source.source,
                code: "source_validation_failed".to_string(),
                message: format!(
                    "{} source did not pass validation: {}",
                    source.source.as_db(),
                    validation.warnings.join("; ")
                ),
            });
        }
        source_validations.push(crate::domain::types::SourceValidationDto {
            source: source.source,
            file_exists: validation.file_exists,
            non_zero_size: validation.non_zero_size,
            readable_audio: validation.readable_audio,
            expected_duration_ms: validation.expected_duration_ms,
            actual_duration_ms: Some(validation.actual_duration_ms),
            duration_within_tolerance: validation.duration_within_tolerance,
            non_silent_signal: validation.non_silent_signal,
            peak_amplitude: Some(validation.peak_amplitude),
            rms_amplitude: Some(validation.rms_amplitude),
            warnings: validation.warnings.clone(),
            error: if valid {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        });
    }
    let validation =
        primary_validation.unwrap_or_else(|| crate::domain::types::AudioValidationDto {
            file_exists: false,
            non_zero_size: false,
            readable_audio: false,
            expected_duration_ms: finished.elapsed_ms,
            actual_duration_ms: 0,
            duration_within_tolerance: false,
            non_silent_signal: false,
            peak_amplitude: 0.0,
            rms_amplitude: 0.0,
            warnings: vec!["No microphone validation was available.".to_string()],
        });
    let primary_valid = source_audio_passes_validation(RecordingSource::Microphone, &validation);
    repos
        .update_recording_session(
            &finished.session_id,
            if validation.readable_audio && validation.non_zero_size {
                "valid"
            } else {
                "invalid"
            },
            finished.elapsed_ms,
            Some(primary_file_size),
            Some(validation.actual_duration_ms),
            Some(primary_checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if primary_valid {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;

    if valid_sources.is_empty() {
        repos
            .set_note_status(
                &finished.note_id,
                crate::domain::types::ProcessingStatus::Failed,
                Some(validation.warnings.join("; ")),
            )
            .await?;
        return Ok(FinishRecordingResponse {
            note: repos.get_note(&finished.note_id).await?,
            recording: finished.recording,
            validation,
            validations: source_validations,
            processing_started: false,
            warnings,
        });
    }

    repos
        .add_checkpoint(
            &finished.session_id,
            "audio_validation",
            Some(
                serde_json::json!({
                    "durationMs": validation_started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                    "validSourceCount": valid_sources.len(),
                    "sourceCount": finished.sources.len(),
                })
                .to_string(),
            ),
        )
        .await?;

    // Capture is single-instance, but processing runs asynchronously — so the
    // user may have already recorded (and stopped) another message on this note
    // while a previous one is still in flight. Register this recording behind
    // any in-flight job for the note; the spawned task waits its turn and reads
    // the note's generated content *after* acquiring the lock, so incremental
    // generation always builds on whatever the previous job wrote.
    let (ticket, depth) = processing_queue::enqueue(&finished.note_id);
    if depth <= 1 {
        // First in line: reflect "processing" immediately for snappy feedback.
        repos
            .set_note_status(
                &finished.note_id,
                crate::domain::types::ProcessingStatus::Transcribing,
                None,
            )
            .await?;
    }

    let mut note = repos.get_note(&finished.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&finished.note_id);

    let task_repos = repos.clone();
    let task_note_id = finished.note_id.clone();
    let task_session_id = finished.session_id.clone();
    let task_source_mode = finished.source_mode;
    // The recap is posted from this task because it lands whenever the
    // pipeline finishes — often with the app in the background.
    let task_app = app.clone();
    tokio::spawn(async move {
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        // Now that earlier jobs on this note are done, read the latest note so
        // generation has the freshest existing content as context.
        let note = match task_repos.get_note(&task_note_id).await {
            Ok(note) => note,
            Err(_) => {
                ticket.finish();
                return;
            }
        };
        let title = note.title.clone();
        let existing_generated_note = note.generated_content.clone();
        let manual_notes = manual_notes_for_generation(&note);
        let result = if valid_sources.len() == 1
            && task_source_mode == RecordingSourceMode::MicrophoneOnly
        {
            // `valid_sources.len() == 1` was tested in the condition above.
            #[allow(clippy::expect_used)]
            let (artifact_id, _source, path) = valid_sources
                .into_iter()
                .next()
                .expect("valid source was checked before starting processing");
            process_saved_audio(
                &task_repos,
                &task_note_id,
                &task_session_id,
                &artifact_id,
                path,
                title,
                existing_generated_note,
                manual_notes,
            )
            .await
        } else {
            process_saved_source_audio(
                &task_repos,
                &task_note_id,
                &task_session_id,
                task_source_mode,
                valid_sources,
                title,
                existing_generated_note,
                manual_notes,
            )
            .await
        };
        match result {
            Err(error) => {
                let _ = task_repos
                    .set_note_status(
                        &task_note_id,
                        crate::domain::types::ProcessingStatus::Failed,
                        Some(error.message),
                    )
                    .await;
            }
            // A long transcription usually finishes while the app is in the
            // background — which is exactly when the webview is frozen and
            // cannot tell anyone. Rust says it instead, and the tap opens the
            // note (crate::moments).
            Ok(ready) => {
                // It has a real title now, which is what makes it findable.
                crate::spotlight::reindex_detached(&task_app);
                crate::moments::announce_note_ready(
                    &task_app,
                    &ready.id,
                    &ready.title,
                    ready
                        .edited_content
                        .as_deref()
                        .or(ready.generated_content.as_deref())
                        .unwrap_or_default(),
                );
            }
        }
        ticket.finish();
    });
    Ok(FinishRecordingResponse {
        note,
        recording: finished.recording,
        validation,
        validations: source_validations,
        processing_started: true,
        warnings,
    })
}

#[tauri::command]
pub async fn delete_agent_task(
    app: AppHandle,
    request: GetAgentTaskRequest,
) -> Result<(), AppError> {
    let repos = repositories(&app).await?;
    repos
        .delete_agent_task(&request.task_id)
        .await
        .map_err(AppError::from)
}

/// Containers accepted by `import_audio_note`.
///
/// Almost all of these are decoded in-process into the WAV the transcription
/// pipeline wants (ADR-0026), which is what lets an import be hours long. A
/// few — Opus above all — Symphonia cannot read, and they are still listed
/// because the whole-file fallback handles them under the request ceiling; the
/// pipeline says so by name when it cannot.
///
/// Video extensions are here on purpose: a video file is an audio track the
/// app reads and a container it skips.
const IMPORTABLE_AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "aif", "aiff", "caf", "flac", "m4a", "m4b", "m4v", "mka", "mov", "mp3", "mp4", "mpga",
    "oga", "ogg", "ogv", "opus", "wav", "webm",
];

/// Ceiling on the bytes-in-the-payload import variant.
///
/// The desktop hands over a path and pays nothing for size. iOS cannot: the
/// picked file lives in a security-scoped location Rust cannot open, so the
/// webview reads it and base64 inflates it by a third on the way through a
/// JavaScript string. A two-hour film would take the tab down before Rust saw
/// a byte, so the boundary refuses it with something actionable instead.
const MAX_IMPORT_PAYLOAD_BYTES: usize = 300 * 1024 * 1024;

/// Largest single chunk the staging command accepts, as base64 characters.
/// The webview slices a file into pieces this size so neither side ever holds
/// a whole recording in memory.
const MAX_STAGED_CHUNK_CHARS: usize = 24 * 1024 * 1024;
/// Total bytes one staged file may reach. Generous — a three-hour 1080p talk
/// is a few gigabytes — but not unbounded: this writes to the user's disk.
const MAX_STAGED_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageImportChunkRequest {
    /// Groups the chunks of one file. Sanitized before it reaches a path.
    pub upload_id: String,
    /// Only its extension is used, and only after sanitizing.
    pub file_name: String,
    pub base64: String,
    /// Set on the final chunk; the staged path comes back with it.
    pub done: bool,
}

/// Append one chunk of a file the webview is handing over, and return the
/// staged path once the last chunk lands.
///
/// A file dropped onto the window arrives as a `File` with no path — the
/// window runs with `dragDropEnabled: false` so the agent composer can handle
/// its own drops — and on iOS a picked file lives somewhere Rust cannot open
/// at all. Both used to mean base64-ing the whole thing through a JavaScript
/// string, which caps an import at whatever the webview can hold. Streaming it
/// in slices removes the cap on every platform.
#[tauri::command]
pub async fn stage_imported_file(
    request: StageImportChunkRequest,
) -> Result<Option<String>, AppError> {
    use base64::Engine as _;
    if request.base64.len() > MAX_STAGED_CHUNK_CHARS {
        return Err(AppError::new(
            "import_chunk_too_large",
            "That upload chunk is too large.",
        ));
    }
    let path = staged_import_path(&request.upload_id, &request.file_name)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.base64)
        .map_err(|error| AppError::new("import_invalid_payload", error.to_string()))?;
    let existing = std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if existing.saturating_add(bytes.len() as u64) > MAX_STAGED_FILE_BYTES {
        let _ = std::fs::remove_file(&path);
        return Err(AppError::new(
            "import_too_large",
            "This file is too large to import.",
        ));
    }
    if !bytes.is_empty() {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| AppError::new("import_copy_failed", error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| AppError::new("import_copy_failed", error.to_string()))?;
    }
    if !request.done {
        return Ok(None);
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Drop a staged file the webview decided not to import after all.
#[tauri::command]
pub async fn discard_staged_import(upload_id: String, file_name: String) -> Result<(), AppError> {
    let path = staged_import_path(&upload_id, &file_name)?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Build the staging path from values the webview supplied, trusting neither.
/// The id becomes the file name and the extension is rebuilt from scratch, so
/// nothing a caller sends can escape the temp directory.
fn staged_import_path(upload_id: &str, file_name: &str) -> Result<std::path::PathBuf, AppError> {
    let id: String = upload_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    if id.len() < 8 {
        return Err(AppError::new(
            "import_invalid_payload",
            "Invalid upload identifier.",
        ));
    }
    let extension: String = std::path::Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>()
        .to_lowercase();
    let extension = if extension.is_empty() {
        "bin".to_string()
    } else {
        extension
    };
    Ok(std::env::temp_dir().join(format!("subrosa-staging-{id}.{extension}")))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudioNoteRequest {
    /// Path variant (desktop file dialogs). On iOS the picked file lives in a
    /// security-scoped location Rust cannot open, so the webview reads it and
    /// sends the bytes instead.
    pub source_path: Option<String>,
    /// Bytes variant: base64 payload + original file name (for the extension
    /// and the note title). Superseded by `staged_path` for anything large.
    pub base64: Option<String>,
    /// A file `stage_imported_file` wrote and this app owns: used like
    /// `source_path`, then deleted once it has been copied into the note.
    pub staged_path: Option<String>,
    pub file_name: Option<String>,
    pub folder_id: Option<String>,
}

/// Import an existing audio file (Files, Voice Memos, ...) as a new note:
/// copy it into the note's recording dir, register a synthetic recording
/// session + artifact, then run the transcription/generation pipeline.
#[tauri::command]
pub async fn import_audio_note(
    app: AppHandle,
    request: ImportAudioNoteRequest,
) -> Result<NoteDto, AppError> {
    let source_name = request
        .file_name
        .clone()
        .or_else(|| {
            request
                .source_path
                .as_deref()
                .or(request.staged_path.as_deref())
                .map(std::path::PathBuf::from)
                .and_then(|path| path.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_default();
    let extension = std::path::Path::new(&source_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !IMPORTABLE_AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::new(
            "import_unsupported_format",
            format!(
                "This file type is not supported. Supported formats: {}.",
                IMPORTABLE_AUDIO_EXTENSIONS.join(", ")
            ),
        ));
    }
    // Materialize the bytes variant into a temp file so both variants share
    // the copy-into-session-dir path below.
    let mut temp_source: Option<std::path::PathBuf> = None;
    let source = if let Some(base64_payload) = request.base64.as_deref() {
        use base64::Engine as _;
        if base64_payload.len() > MAX_IMPORT_PAYLOAD_BYTES {
            return Err(AppError::new(
                "import_too_large",
                "This file is too large to import from the file picker. Save it to Files and \
                 import it from there, or import a smaller file.",
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_payload)
            .map_err(|error| AppError::new("import_invalid_payload", error.to_string()))?;
        let path = std::env::temp_dir().join(format!(
            "subrosa-import-{}.{extension}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes)
            .map_err(|error| AppError::new("import_copy_failed", error.to_string()))?;
        temp_source = Some(path.clone());
        path
    } else if let Some(staged) = request.staged_path.as_deref() {
        let path = std::path::PathBuf::from(staged);
        temp_source = Some(path.clone());
        path
    } else {
        std::path::PathBuf::from(request.source_path.clone().unwrap_or_default())
    };
    if !source.exists() {
        return Err(AppError::new(
            "import_file_missing",
            "The selected audio file could not be read.",
        ));
    }
    import_media_from_path(
        &app,
        &source,
        &source_name,
        request.folder_id.clone(),
        temp_source.take().is_some(),
    )
    .await
}

/// Turn a file already on disk into a note and start the pipeline.
///
/// Split out of [`import_audio_note`] so a fetched link reaches exactly the
/// same code (ADR-0028): an ingest that has produced its file is an import
/// like any other, and the two must not drift.
///
/// `consume_source` deletes the file once it has been copied into the note —
/// true for anything the app staged or downloaded itself, false for a file the
/// user picked, which is theirs.
pub(crate) async fn import_media_from_path(
    app: &AppHandle,
    source: &std::path::Path,
    source_name: &str,
    folder_id: Option<String>,
    consume_source: bool,
) -> Result<NoteDto, AppError> {
    import_media_from_path_with_captions(app, source, source_name, folder_id, consume_source, None)
        .await
}

/// [`import_media_from_path`], with a transcript the source already published.
///
/// When `cues` is present nothing is decoded and nothing is transcribed: the
/// cues become turn rows and the note is generated from them (ADR-0028).
pub(crate) async fn import_media_from_path_with_captions(
    app: &AppHandle,
    source: &std::path::Path,
    source_name: &str,
    folder_id: Option<String>,
    consume_source: bool,
    cues: Option<Vec<crate::ingest::vtt::Cue>>,
) -> Result<NoteDto, AppError> {
    let app = app.clone();
    let extension = std::path::Path::new(source_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let source = source.to_path_buf();
    let mut consumable = if consume_source {
        Some(source.clone())
    } else {
        None
    };

    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let note = repos.create_note(folder_id).await.map_err(AppError::from)?;
    // An import is a note the moment its row exists: say so, so the list
    // shows it without a reload and the phone's sweep is not the only one
    // that knows (FORK_NOTES: "une note créée hors UI n'apparaît pas").
    crate::agent_notes::announce(&app, std::slice::from_ref(&note.id));
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_dir = paths
        .recording_session_dir(&note.id, &session_id)
        .map_err(|error| AppError::new("invalid_recording_path", error.to_string()))?;
    std::fs::create_dir_all(&session_dir)
        .map_err(|error| AppError::new("import_copy_failed", error.to_string()))?;
    let dest = session_dir.join(format!("imported.{extension}"));
    std::fs::copy(&source, &dest)
        .map_err(|error| AppError::new("import_copy_failed", error.to_string()))?;
    if let Some(consumed) = consumable.take() {
        let _ = std::fs::remove_file(consumed);
    }
    let dest_str = dest.to_string_lossy().into_owned();
    let size_bytes = std::fs::metadata(&dest)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or_default();
    let checksum = checksum_file(&dest).unwrap_or_default();

    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophoneOnly,
            &dest_str,
            &dest_str,
            None,
        )
        .await
        .map_err(AppError::from)?;
    repos
        .update_recording_session(
            &session_id,
            "valid",
            0,
            Some(size_bytes),
            None,
            Some(checksum.clone()),
            None,
            None,
            None,
            None,
        )
        .await
        .map_err(AppError::from)?;
    let artifact = repos
        .create_audio_artifact(&note.id, &session_id, &dest_str, 0, size_bytes, &checksum)
        .await
        .map_err(AppError::from)?;

    // Same per-note ordering discipline as finish_recording: imports queue
    // behind any in-flight processing for the note (a fresh note here, but
    // the queue also serializes a rapid double-import).
    let (ticket, depth) = processing_queue::enqueue(&note.id);
    if depth <= 1 {
        repos
            .set_note_status(&note.id, ProcessingStatus::Transcribing, None)
            .await?;
    }
    let title = std::path::Path::new(&source_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Imported audio")
        .to_string();
    let note = repos.get_note(&note.id).await?;

    let task_repos = repos.clone();
    let task_note_id = note.id.clone();
    let task_session_id = session_id.clone();
    let task_artifact_id = artifact.id.clone();
    tokio::spawn(async move {
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        let outcome = match cues {
            Some(cues) => {
                crate::domain::processing::process_captioned_import(
                    &task_repos,
                    &task_note_id,
                    &task_session_id,
                    &task_artifact_id,
                    cues,
                    None,
                    title,
                )
                .await
            }
            None => {
                process_imported_audio(
                    &task_repos,
                    &task_note_id,
                    &task_session_id,
                    &task_artifact_id,
                    dest,
                    title,
                    None,
                    None,
                )
                .await
            }
        };
        if let Err(error) = outcome {
            let _ = task_repos
                .set_note_status(&task_note_id, ProcessingStatus::Failed, Some(error.message))
                .await;
        }
        ticket.finish();
    });

    Ok(note)
}

fn recording_source_readiness(source_mode: RecordingSourceMode) -> RecordingSourceReadinessDto {
    let (microphone_state, microphone_hint) = microphone_permission_state();
    // iOS reports "unknown" before the first prompt; keep it startable so the
    // record attempt can raise the system permission prompt (blocking here
    // would make it unreachable). Desktop gates on device availability because
    // macOS 14.0/14.1 can report a stale TCC permission state (JUN-223); an
    // explicit denied/restricted still blocks.
    let microphone_permission_blocked =
        matches!(microphone_state.as_str(), "denied" | "restricted");
    let microphone_device_available = microphone_device_available();
    let microphone_ready = microphone_state == "unknown"
        || (!microphone_permission_blocked && microphone_device_available);
    let microphone_message = if microphone_permission_blocked {
        microphone_hint.clone()
    } else if !microphone_device_available && microphone_state != "unknown" {
        Some(microphone_device_hint())
    } else {
        None
    };
    let microphone = SourceReadinessDto {
        source: RecordingSource::Microphone,
        required: true,
        ready: microphone_ready,
        permission_state: microphone_state.clone(),
        device_available: microphone_ready,
        capture_available: microphone_ready,
        recovery_action: microphone_permission_blocked
            .then(|| "openMicrophoneSettings".to_string()),
        message: microphone_message,
    };
    #[cfg(desktop)]
    let system = {
        let mut system = crate::audio::system_macos::system_audio_readiness();
        if should_probe_system_audio_permission(source_mode, system.ready, is_capture_active()) {
            system = apply_system_audio_permission_probe_result(
                system,
                crate::audio::system_macos::helper_permission_check(),
            );
        }
        system
    };
    // Mobile: system audio never becomes ready; report it as unsupported so
    // the UI can hide the option instead of dangling a probe.
    #[cfg(mobile)]
    let system = SourceReadinessDto {
        source: RecordingSource::System,
        required: true,
        ready: false,
        permission_state: "unsupported".to_string(),
        device_available: false,
        capture_available: false,
        recovery_action: None,
        message: Some("System audio capture is not available on this device.".to_string()),
    };
    assemble_recording_source_readiness(microphone, system, source_mode)
}

/// Readiness describes the machine, not the request: the system source is
/// always reported so callers can explain why it is unavailable. Only
/// `required` follows the requested mode, keeping the `start_recording` gate
/// from blocking a microphone-only take on a Mac that cannot capture system
/// audio at all.
fn assemble_recording_source_readiness(
    microphone: SourceReadinessDto,
    mut system: SourceReadinessDto,
    source_mode: RecordingSourceMode,
) -> RecordingSourceReadinessDto {
    system.required = source_mode == RecordingSourceMode::MicrophonePlusSystem;
    let sources = vec![microphone, system];
    let ready = sources
        .iter()
        .all(|source| !source.required || source.ready);
    RecordingSourceReadinessDto {
        source_mode,
        ready,
        checked_at: crate::db::repositories::timestamp(),
        sources,
    }
}

fn should_probe_system_audio_permission(
    source_mode: RecordingSourceMode,
    system_ready: bool,
    capture_active: bool,
) -> bool {
    source_mode == RecordingSourceMode::MicrophonePlusSystem && system_ready && !capture_active
}

fn apply_system_audio_permission_probe_result(
    mut system: SourceReadinessDto,
    result: Result<(), AppError>,
) -> SourceReadinessDto {
    match result {
        Ok(()) => {
            system.permission_state = "granted".to_string();
        }
        Err(error) => {
            system.ready = false;
            system.capture_available = false;
            match error.code.as_str() {
                "system_audio_permission_denied" => {
                    system.permission_state = "denied".to_string();
                    system.recovery_action = Some("openSystemAudioSettings".to_string());
                }
                "system_audio_capture_unavailable" => {
                    system.permission_state = "granted".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
                _ => {
                    system.permission_state = "unknown".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
            }
            system.message = Some(error.message);
        }
    }
    system
}

#[tauri::command]
pub async fn retry_processing(
    app: AppHandle,
    request: RetryProcessingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let sources = retry_audio_sources(&repos, &paths, &request.note_id).await?;
    let (ticket, depth) = processing_queue::enqueue(&request.note_id);
    if depth <= 1 {
        repos
            .set_note_status(&request.note_id, ProcessingStatus::Transcribing, None)
            .await?;
    }

    let mut note = repos.get_note(&request.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&request.note_id);

    let task_repos = repos.clone();
    let task_note_id = request.note_id.clone();
    tokio::spawn(async move {
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        let note = match task_repos.get_note(&task_note_id).await {
            Ok(note) => note,
            Err(_) => {
                ticket.finish();
                return;
            }
        };
        let title = note.title.clone();
        let existing_generated_note = note.generated_content.clone();
        let manual_notes = manual_notes_for_generation(&note);
        let result = if sources.len() == 1 {
            // `sources.len() == 1` was tested in the condition above.
            #[allow(clippy::expect_used)]
            let (audio_artifact_id, _source, audio_path, session_id) = sources
                .into_iter()
                .next()
                .expect("retry sources were checked before starting processing");
            // An import's audio is whatever container the user had. Sending it
            // through the recorded path would open an MP4 with a WAV reader
            // and fail every retry, which is exactly what used to happen.
            if is_wav_path(&audio_path) {
                process_saved_audio(
                    &task_repos,
                    &task_note_id,
                    &session_id,
                    &audio_artifact_id,
                    audio_path,
                    title,
                    existing_generated_note,
                    manual_notes,
                )
                .await
            } else {
                process_imported_audio(
                    &task_repos,
                    &task_note_id,
                    &session_id,
                    &audio_artifact_id,
                    audio_path,
                    title,
                    existing_generated_note,
                    manual_notes,
                )
                .await
            }
        } else {
            let session_id = sources
                .first()
                .map(|(_id, _source, _path, session_id)| session_id.clone())
                .unwrap_or_default();
            process_saved_source_audio(
                &task_repos,
                &task_note_id,
                &session_id,
                RecordingSourceMode::MicrophonePlusSystem,
                sources
                    .into_iter()
                    .map(|(id, source, path, _session_id)| (id, source, path))
                    .collect(),
                title,
                existing_generated_note,
                manual_notes,
            )
            .await
        };
        if let Err(error) = result {
            let _ = task_repos
                .set_note_status(&task_note_id, ProcessingStatus::Failed, Some(error.message))
                .await;
        }
        ticket.finish();
    });
    Ok(note)
}

/// Resume-time sweep (mobile): re-run the notes whose processing did not
/// survive the app leaving the foreground. Two shapes, both covered:
///
/// - the pipeline woke up to a dead loopback request and marked the note
///   `failed` (a screen lock kills the in-flight request even with the
///   background-task grace period);
/// - the process was suspended and then killed outright, so the note is still
///   sitting in `transcribing`/`generating` with nobody working on it.
///
/// The second case is why the sweep asks `domain::processing::is_processing`
/// rather than trusting the row: a warm resume can find a pipeline that is
/// genuinely still running, and restarting it would transcribe the note twice.
///
/// Best-effort: any failure leaves the note where it was, where the manual
/// retry still applies.
#[cfg(mobile)]
pub fn resume_interrupted_processing(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SWEEPING: AtomicBool = AtomicBool::new(false);
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sweep = async {
            let repos = repositories(&app).await?;
            // The two queries select disjoint statuses, so concatenating them
            // cannot produce the same note twice.
            let mut note_ids = repos.list_notes_failed_in_transit().await?;
            for note_id in repos.list_notes_stuck_in_processing().await? {
                if !crate::domain::processing::is_processing(&note_id) {
                    note_ids.push(note_id);
                }
            }
            for note_id in note_ids {
                let _ = retry_processing(
                    app.clone(),
                    RetryProcessingRequest {
                        note_id,
                        step: None,
                    },
                )
                .await;
            }
            Ok::<(), AppError>(())
        };
        let _ = sweep.await;
        SWEEPING.store(false, Ordering::SeqCst);
    });
}

async fn retry_audio_sources(
    repos: &Repositories,
    paths: &AppPaths,
    note_id: &str,
) -> Result<Vec<(String, String, PathBuf, String)>, AppError> {
    let sources = repos
        .latest_valid_audio_artifact_paths(note_id)
        .await?
        .into_iter()
        .filter_map(|(id, source, path, session_id)| {
            paths
                .contained_recording_file(path)
                .ok()
                .map(|path| (id, source, path, session_id))
        })
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Err(AppError::new(
            "audio_artifact_missing",
            "No saved audio is available for retry.",
        ));
    }
    Ok(sources)
}

#[tauri::command]
pub async fn recover_recording(
    app: AppHandle,
    request: crate::domain::types::RecoverRecordingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let Some(info) = repos.recording_recovery_info(&request.session_id).await? else {
        return Err(AppError::new(
            "recording_not_found",
            format!(
                "Recoverable recording {} was not found.",
                request.session_id
            ),
        ));
    };
    if request.action == "discard" {
        for artifact in repos
            .source_artifact_paths_for_session(&request.session_id)
            .await?
        {
            for path in [&artifact.partial_path, &artifact.final_path]
                .into_iter()
                .flatten()
            {
                let _ = paths
                    .remove_recording_file(path)
                    .map_err(|error| AppError::new("audio_delete_failed", error.to_string()));
            }
        }
        for path in [&info.partial_path, &info.final_path].into_iter().flatten() {
            let _ = paths
                .remove_recording_file(path)
                .map_err(|error| AppError::new("audio_delete_failed", error.to_string()));
        }
        return Ok(repos
            .mark_recording_discarded(&info.session_id, &info.note_id)
            .await?);
    }
    let source_paths = repos
        .source_artifact_paths_for_session(&request.session_id)
        .await?;
    if !source_paths.is_empty() {
        let mut valid_sources = Vec::new();
        for artifact in source_paths {
            let Some(path) = recovery_source_path(&paths, &artifact) else {
                continue;
            };
            let expected_duration_ms =
                recovery_validation_expected_duration_ms(&path, artifact.expected_duration_ms);
            let validation = validate_audio_artifact(
                &path,
                expected_duration_ms,
                AudioValidationConfig::default(),
            )
            .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
            let checksum = checksum_file(&path).unwrap_or_default();
            let file_size = std::fs::metadata(&path)
                .map(|metadata| metadata.len() as i64)
                .unwrap_or_default();
            let recovered_path = path.to_string_lossy().into_owned();
            let source = RecordingSource::from(artifact.source.as_str());
            let valid = source_audio_passes_validation(source, &validation);
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &recovered_path,
                    if valid { "valid" } else { "invalid" },
                    validation.actual_duration_ms,
                    file_size,
                    &checksum,
                    expected_duration_ms,
                    Some(serde_json::to_string(&validation).unwrap_or_default()),
                    if valid {
                        None
                    } else {
                        Some(validation.warnings.join("; "))
                    },
                )
                .await?;
            if valid {
                valid_sources.push((artifact.id, artifact.source, path));
            }
        }
        if valid_sources.is_empty() {
            repos
                .set_note_status(
                    &info.note_id,
                    crate::domain::types::ProcessingStatus::Failed,
                    Some("No recoverable source audio passed validation.".to_string()),
                )
                .await?;
            return Ok(repos.get_note(&info.note_id).await?);
        }
        let note = repos.get_note(&info.note_id).await?;
        let existing_generated_note = note.generated_content.clone();
        let manual_notes = manual_notes_for_generation(&note);
        repos
            .mark_recording_recovery_valid(&info.session_id)
            .await?;
        return process_saved_source_audio(
            &repos,
            &info.note_id,
            &info.session_id,
            info.source_mode,
            valid_sources,
            note.title,
            existing_generated_note,
            manual_notes,
        )
        .await;
    }
    let path = recovery_audio_path(&paths, &info).ok_or_else(|| {
        AppError::new(
            "audio_artifact_missing",
            "No recoverable audio bytes are available.",
        )
    })?;
    let expected_elapsed_ms =
        recovery_validation_expected_duration_ms(&path, info.expected_elapsed_ms);
    let validation =
        validate_audio_artifact(&path, expected_elapsed_ms, AudioValidationConfig::default())
            .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
    let checksum = checksum_file(&path).unwrap_or_default();
    let file_size = std::fs::metadata(&path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or_default();
    repos
        .update_recording_session(
            &info.session_id,
            if validation.readable_audio && validation.non_zero_size {
                "valid"
            } else {
                "invalid"
            },
            expected_elapsed_ms,
            Some(file_size),
            Some(validation.actual_duration_ms),
            Some(checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if source_audio_passes_validation(RecordingSource::Microphone, &validation) {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;
    if !source_audio_passes_validation(RecordingSource::Microphone, &validation) {
        repos
            .set_note_status(
                &info.note_id,
                crate::domain::types::ProcessingStatus::Failed,
                Some(validation.warnings.join("; ")),
            )
            .await?;
        return Ok(repos.get_note(&info.note_id).await?);
    }
    let artifact = repos
        .create_audio_artifact(
            &info.note_id,
            &info.session_id,
            &path.to_string_lossy(),
            validation.actual_duration_ms,
            file_size,
            &checksum,
        )
        .await?;
    let note = repos.get_note(&info.note_id).await?;
    let existing_generated_note = note.generated_content.clone();
    let manual_notes = manual_notes_for_generation(&note);
    process_saved_audio(
        &repos,
        &info.note_id,
        &info.session_id,
        &artifact.id,
        path,
        note.title,
        existing_generated_note,
        manual_notes,
    )
    .await
}

fn recovery_audio_path(
    paths: &AppPaths,
    info: &crate::db::repositories::RecordingRecoveryInfo,
) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        let Ok(path) = paths.contained_recording_file(path) else {
            continue;
        };
        if std::fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn recovery_source_path(
    paths: &AppPaths,
    info: &crate::db::repositories::SourceArtifactPath,
) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        let Ok(path) = paths.contained_recording_file(path) else {
            continue;
        };
        if std::fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn recovery_validation_expected_duration_ms(path: &Path, stored_duration_ms: i64) -> i64 {
    if stored_duration_ms > 1 {
        return stored_duration_ms;
    }
    // Pending source rows persist expected_duration_ms = 0, so the expectation
    // is derived from the WAV itself. Repair a stale header first — otherwise a
    // SIGKILLed long capture yields a short expected duration that its own
    // repaired (true) duration then fails as "stale long audio".
    let _ = crate::audio::validation::repair_stale_wav_header_in_place(path);
    wav_duration_ms(path).unwrap_or_else(|| stored_duration_ms.max(1))
}

fn wav_duration_ms(path: &Path) -> Option<i64> {
    let reader = hound::WavReader::open(path).ok()?;
    let sample_rate = reader.spec().sample_rate.max(1) as i64;
    let duration_ms = (reader.duration() as i64 * 1000) / sample_rate;
    (duration_ms > 0).then_some(duration_ms)
}

static AGENT_PLACEHOLDER_TASKS_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn agent_placeholder_tasks_in_flight() -> &'static Mutex<HashSet<String>> {
    AGENT_PLACEHOLDER_TASKS_IN_FLIGHT.get_or_init(Mutex::default)
}

fn schedule_agent_runtime_placeholder(repos: Repositories, task_id: String) {
    // Two concurrent placeholder runs for the same task (e.g. a rapid
    // double retry) would double-insert tool events and messages, so only
    // one in-flight run per task is allowed.
    {
        // A poisoned set is still a set of ids: reuse it rather than crash
        // the shell over a panic in another task.
        let mut in_flight = agent_placeholder_tasks_in_flight()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !in_flight.insert(task_id.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        run_agent_runtime_placeholder(&repos, &task_id).await;
        agent_placeholder_tasks_in_flight()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&task_id);
    });
}

async fn run_agent_runtime_placeholder(repos: &Repositories, task_id: &str) {
    // Only move a still-queued task to running. If the user cancelled the
    // task (or it otherwise changed state) since this run was scheduled,
    // the placeholder must not resurrect it.
    let started = repos
        .update_agent_task_status_if_in(
            task_id,
            AgentTaskStatus::Running,
            Some("Preparing local privacy and tool policy."),
            None,
            &[AgentTaskStatus::Queued],
        )
        .await;
    if !matches!(started, Ok(true)) {
        return;
    }
    let _ = repos
        .add_agent_tool_event(
            task_id,
            "local_tool_policy",
            AgentToolEventStatus::Completed,
            "Autonomous private mode is active. Sensitive actions will be blocked or escalated.",
            Some(r#"{"profile":"autonomous_private"}"#),
            Some(r#"{"localToolsReady":true,"rawOutputShared":false}"#),
            true,
        )
        .await;
    let _ = repos
        .add_agent_tool_event(
            task_id,
            "backend_agent_runtime",
            AgentToolEventStatus::Blocked,
            "Backend agent orchestration is not configured in this build.",
            Some(r#"{"endpoint":"/v1/agent/tasks"}"#),
            Some(r#"{"reason":"agent_backend_unavailable"}"#),
            true,
        )
        .await;
    let _ = repos
        .add_agent_message(
            task_id,
            AgentMessageRole::Assistant,
            "I created the task and set up the local privacy/tool policy. The backend agent runtime endpoint is not configured yet, so I paused execution before taking desktop actions.",
        )
        .await;
    let _ = repos
        .update_agent_task_status_if_in(
            task_id,
            AgentTaskStatus::Paused,
            Some("Paused until the backend agent runtime is configured."),
            Some("Backend agent orchestration is not configured in this build."),
            &[AgentTaskStatus::Running],
        )
        .await;
}

async fn hydrate_agent_task_from_hermes(
    app: &AppHandle,
    repos: &Repositories,
    task_id: &str,
) -> Result<(), AppError> {
    let task = repos.get_agent_task(task_id).await?;
    let paths = app_paths(app)?;
    let hermes_db_path = paths.data_dir.join("hermes").join("state.db");
    if !hermes_db_path.exists() {
        return Ok(());
    }
    let pool = hermes_state_pool(&hermes_db_path).await?;

    let session_id = match task.hermes_session_id.clone() {
        Some(session_id) if !session_id.trim().is_empty() => Some(session_id),
        _ => match_hermes_session_for_task(repos, &pool, &task).await?,
    };

    let Some(session_id) = session_id else {
        return Ok(());
    };

    let rows = query(
        "SELECT CAST(id AS TEXT) AS id, content, timestamp
         FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND active = 1
           AND content IS NOT NULL
           AND trim(content) != ''
         ORDER BY timestamp ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;

    // A task only counts as answered when the assistant replied AFTER the
    // latest user message. Assistant messages from earlier turns must not
    // complete a task that was re-queued by a newer user message.
    let latest_user_message_at = task
        .messages
        .iter()
        .filter(|message| message.role == AgentMessageRole::User)
        .map(|message| message.created_at.clone())
        .max();
    let mut assistant_replied_to_latest_turn = false;

    for row in rows {
        let hermes_message_id: String = row.get("id");
        let content: String = row.get("content");
        let timestamp: f64 = row.get("timestamp");
        let created_at = unix_timestamp_to_rfc3339(timestamp);
        // Both timestamps are RFC3339 UTC with millisecond precision, so
        // string ordering matches chronological ordering.
        if latest_user_message_at
            .as_deref()
            .map(|user_at| created_at.as_str() > user_at)
            .unwrap_or(true)
        {
            assistant_replied_to_latest_turn = true;
        }
        let external_id = format!("hermes:{session_id}:{hermes_message_id}");
        repos
            .add_agent_message_if_absent(
                task_id,
                AgentMessageRole::Assistant,
                content.trim(),
                &created_at,
                &external_id,
            )
            .await?;
    }
    if assistant_replied_to_latest_turn
        && matches!(
            task.status,
            AgentTaskStatus::Queued | AgentTaskStatus::Running
        )
    {
        repos
            .update_agent_task_status_if_in(
                task_id,
                AgentTaskStatus::Completed,
                Some("Completed."),
                None,
                &[AgentTaskStatus::Queued, AgentTaskStatus::Running],
            )
            .await?;
    }
    Ok(())
}

/// How close (in seconds) a Hermes session's `started_at` must be to the
/// task's creation time for heuristic title matching to bind them.
const HERMES_SESSION_MATCH_WINDOW_SECONDS: f64 = 300.0;

/// Heuristically binds a Hermes session to a task by title. Titles are
/// derived from the first 64 characters of the prompt, so identical prompts
/// collide; only bind when exactly one session with this title started near
/// the task's creation time and it is not already bound to another task.
/// When the match is ambiguous, skip hydration for this poll instead of
/// persisting a guess.
async fn match_hermes_session_for_task(
    repos: &Repositories,
    pool: &SqlitePool,
    task: &AgentTaskDto,
) -> Result<Option<String>, AppError> {
    let Ok(task_started_at) = chrono::DateTime::parse_from_rfc3339(&task.created_at)
        .map(|value| value.timestamp_millis() as f64 / 1000.0)
    else {
        return Ok(None);
    };
    let rows = query(
        "SELECT id
         FROM sessions
         WHERE title = ?
           AND ABS(started_at - ?) <= ?
         LIMIT 2",
    )
    .bind(&task.title)
    .bind(task_started_at)
    .bind(HERMES_SESSION_MATCH_WINDOW_SECONDS)
    .fetch_all(pool)
    .await
    .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let session_id: String = rows[0].get("id");
    if repos
        .hermes_session_bound_to_other_task(&task.id, &session_id)
        .await?
    {
        return Ok(None);
    }
    repos
        .set_agent_task_hermes_session(&task.id, &session_id)
        .await?;
    Ok(Some(session_id))
}

/// Cached read pool for the Hermes `state.db`, re-opened only if the path
/// changes, so per-task polling does not open a fresh pool every second.
static HERMES_STATE_POOL: tokio::sync::Mutex<Option<(PathBuf, SqlitePool)>> =
    tokio::sync::Mutex::const_new(None);

async fn hermes_state_pool(path: &Path) -> Result<SqlitePool, AppError> {
    let mut cached = HERMES_STATE_POOL.lock().await;
    if let Some((cached_path, pool)) = cached.as_ref() {
        if cached_path == path && !pool.is_closed() {
            return Ok(pool.clone());
        }
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;
    *cached = Some((path.to_path_buf(), pool.clone()));
    Ok(pool)
}

fn unix_timestamp_to_rfc3339(timestamp: f64) -> String {
    let seconds = timestamp.trunc() as i64;
    let nanos = ((timestamp.fract() * 1_000_000_000.0).round() as u32).min(999_999_999);
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Cached app repositories pool. The database path is derived from the app
/// data dir and never changes within a process, so the pool (and its
/// migrations) are initialized once instead of on every Tauri command.
static REPOSITORIES: OnceCell<Repositories> = OnceCell::const_new();

pub(crate) async fn repositories(app: &AppHandle) -> Result<Repositories, AppError> {
    let paths = app_paths(app)?;
    REPOSITORIES
        .get_or_try_init(|| async {
            let options = SqliteConnectOptions::from_str(&format!(
                "sqlite://{}",
                paths.database_path.display()
            ))
            .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
            .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(5)
                .connect_with(options)
                .await
                .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
            run_migrations(&pool)
                .await
                .map_err(|error| AppError::new("migration_failed", error.to_string()))?;
            Ok(Repositories::new(pool))
        })
        .await
        .cloned()
}

pub(crate) fn app_paths(app: &AppHandle) -> Result<AppPaths, AppError> {
    let data_dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    AppPaths::from_data_dir(data_dir)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_system_audio_permission_probe_result, assemble_recording_source_readiness,
        recovery_validation_expected_duration_ms, should_probe_system_audio_permission,
    };
    use crate::domain::types::{
        AppError, RecordingSource, RecordingSourceMode, SourceReadinessDto,
    };

    #[test]
    fn skips_system_audio_permission_probe_while_capture_is_active() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            true
        ));
    }

    #[test]
    fn probes_system_audio_permission_only_when_available_and_idle() {
        assert!(should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            false
        ));
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            false,
            false
        ));
    }

    #[test]
    fn system_audio_permission_probe_is_skipped_for_microphone_only() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophoneOnly,
            true,
            false
        ));
    }

    #[test]
    fn microphone_only_readiness_still_reports_the_system_source() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );
        let system = readiness
            .sources
            .iter()
            .find(|source| source.source == RecordingSource::System)
            .expect("system readiness");

        assert_eq!(system.permission_state, "unsupported");
        assert!(!system.required);
    }

    #[test]
    fn microphone_only_readiness_stays_ready_when_system_is_unsupported() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );

        assert!(readiness.ready);
    }

    #[test]
    fn microphone_plus_system_keeps_the_system_source_required() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophonePlusSystem,
        );
        let system = readiness
            .sources
            .iter()
            .find(|source| source.source == RecordingSource::System)
            .expect("system readiness");

        assert!(system.required);
        assert!(!readiness.ready);
    }

    #[test]
    fn successful_system_audio_permission_probe_reports_granted() {
        let readiness = apply_system_audio_permission_probe_result(system_readiness(), Ok(()));

        assert!(readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(readiness.capture_available);
    }

    #[test]
    fn failed_system_audio_permission_probe_blocks_capture() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_permission_denied",
                "Grant access.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "denied");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.message.as_deref(), Some("Grant access."));
    }

    #[test]
    fn failed_system_audio_capture_probe_keeps_permission_granted() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_capture_unavailable",
                "Failed to create audio format for system tap.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.recovery_action.as_deref(), Some("restartApp"));
        assert_eq!(
            readiness.message.as_deref(),
            Some("Failed to create audio format for system tap.")
        );
    }

    #[test]
    fn recovered_wav_duration_overrides_stale_stored_duration() {
        let (_dir, path) = write_one_second_wav();

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1_000);
        assert_eq!(recovery_validation_expected_duration_ms(&path, 1), 1_000);
    }

    fn system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: true,
            permission_state: "unknown".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: Some("openSystemAudioSettings".to_string()),
            message: None,
        }
    }

    fn unsupported_system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: Some("upgradeMacos".to_string()),
            message: Some("System audio capture requires macOS 14.2 or later.".to_string()),
        }
    }

    fn microphone_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::Microphone,
            required: true,
            ready: true,
            permission_state: "granted".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: None,
            message: None,
        }
    }

    #[test]
    fn recovered_wav_duration_reads_flush_only_wav() {
        let (_dir, path) = write_one_second_flushed_wav();

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1_000);
    }

    #[test]
    fn recovered_wav_duration_repairs_stale_header_before_deriving() {
        use std::io::{Seek, SeekFrom, Write};

        // 10s of samples with a SIGKILL-stale header claiming ~1s. Without an
        // up-front repair the expectation would be ~1s while validation's own
        // repaired duration is 10s, failing the source as stale-long audio.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..160_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.finalize().expect("finalize");

        let stale_data_size: u32 = 16_000 * 2;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        // data chunk size field sits at byte 40 for a canonical 16-bit PCM WAV;
        // RIFF size at byte 4.
        file.seek(SeekFrom::Start(4)).expect("seek");
        file.write_all(&(36 + stale_data_size).to_le_bytes())
            .expect("write riff size");
        file.seek(SeekFrom::Start(40)).expect("seek");
        file.write_all(&stale_data_size.to_le_bytes())
            .expect("write data size");
        file.flush().expect("flush");
        drop(file);

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 10_000);
    }

    #[test]
    fn recovered_wav_duration_preserves_persisted_expected_duration() {
        let (_dir, path) = write_one_second_wav();

        assert_eq!(
            recovery_validation_expected_duration_ms(&path, 10_000),
            10_000
        );
    }

    #[test]
    fn recovered_duration_falls_back_to_stored_duration_for_unreadable_audio() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        std::fs::write(&path, b"not wav").expect("write");

        assert_eq!(
            recovery_validation_expected_duration_ms(&path, 2_500),
            2_500
        );
        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1);
    }

    fn write_one_second_wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..16_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.finalize().expect("finalize");
        (dir, path)
    }

    fn write_one_second_flushed_wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..16_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.flush().expect("flush");
        std::mem::forget(writer);
        (dir, path)
    }
}
