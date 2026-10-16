use crate::{
    app_paths::AppPaths,
    audio::{
        live_preview::{
            start_live_transcript_preview, start_system_live_transcript_preview,
            LivePreviewController, LivePreviewSink, SystemLivePreviewController,
        },
        system::{SystemAudioCapture, SystemLaneStatus},
    },
    domain::types::{
        AppError, AudioLevelDto, RecordingSessionDto, RecordingSource, RecordingSourceMode,
        RecordingState, RecordingStatusDto, SourceState, SourceStatusDto, SourceWarningDto,
    },
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    collections::VecDeque,
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const DEFAULT_SILENCE_THRESHOLD: f32 = 0.012;
const RECOVERY_SNAPSHOT_INTERVAL_MS: i64 = 500;
const MICROPHONE_STALL_THRESHOLD: Duration = Duration::from_secs(3);
const MICROPHONE_STREAM_WARNING_MESSAGE: &str =
    "Microphone input stopped unexpectedly. Audio after this point may be missing.";
/// How long the computer may stay completely silent before the recorder says
/// so. Long enough for a call to connect; short enough to fix a wrong output
/// device before much of the call is lost.
const SYSTEM_SILENCE_WARNING_AFTER_MS: i64 = 20_000;
const SYSTEM_SILENCE_WARNING_MESSAGE: &str =
    "No sound from the computer yet. Check that the call or video plays on this computer.";

static ACTIVE_RECORDING: LazyLock<Mutex<Option<ActiveRecording>>> =
    LazyLock::new(|| Mutex::new(None));

pub struct StartedRecording {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
    pub sources: Vec<StartedSource>,
    pub device_label: Option<String>,
    pub status: RecordingStatusDto,
}

pub struct FinishedRecording {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub final_path: PathBuf,
    pub sources: Vec<FinishedSource>,
    pub elapsed_ms: i64,
    pub recording: RecordingSessionDto,
}

pub struct StartedSource {
    pub source: RecordingSource,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
}

pub struct FinishedSource {
    pub source: RecordingSource,
    pub final_path: PathBuf,
    pub elapsed_ms: i64,
    pub capture_issue: Option<MicrophoneStreamIssue>,
}

pub struct CaptureRecoverySnapshot {
    pub status: RecordingStatusDto,
    pub should_persist: bool,
}

struct ActiveRecording {
    session_id: String,
    note_id: String,
    /// The primary lane's final path: the microphone's whenever it records,
    /// else the computer's (`RecordingSourceMode::primary_source`).
    final_path: PathBuf,
    source_mode: RecordingSourceMode,
    /// Absent in a computer-only recording: the microphone is never opened.
    microphone: Option<MicrophoneLane>,
    system_final_path: Option<PathBuf>,
    system_capture: Option<SystemAudioCapture>,
    started: Instant,
    active_since: Option<Instant>,
    accumulated_active: Duration,
    paused: bool,
    paused_flag: Arc<AtomicBool>,
    last_recovery_snapshot_elapsed_ms: i64,
    system_live_preview: Option<SystemLivePreviewController>,
    live_preview_enabled: bool,
    #[cfg(target_os = "android")]
    _android_recording: crate::android::RecordingGuard,
}

/// The microphone's half of a recording: its stream, its WAV writer and the
/// health signals read from its callbacks.
struct MicrophoneLane {
    partial_path: PathBuf,
    final_path: PathBuf,
    writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: Arc<Mutex<CaptureStats>>,
    stream_error: Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    last_callback_at: Arc<Mutex<Option<Instant>>>,
    // First stall ever observed, kept until finish: a transient stall whose
    // callbacks later resume must still leave a capture_stream_error trail.
    stall_latch: Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    live_preview: Option<LivePreviewController>,
    stream: cpal::Stream,
}

/// One status read of the microphone lane.
struct MicrophoneSnapshot {
    level: AudioLevelDto,
    bytes_written: i64,
    silence_warning: bool,
    issue: Option<MicrophoneStreamIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicrophoneStreamIssue {
    pub code: String,
    pub message: String,
    pub elapsed_ms: i64,
}

// The MVP permits only one active recording and guards it behind a process-wide
// mutex. CPAL's CoreAudio stream is intentionally conservative about Send across
// platforms; on macOS it is safe for this usage because commands only hold/drop
// the stream through this single recorder lifecycle.
unsafe impl Send for ActiveRecording {}

#[derive(Debug, Default)]
struct CaptureStats {
    peak: f32,
    sum_square: f64,
    samples: u64,
    recent_peaks: VecDeque<f32>,
    bytes_written: i64,
}

// One cfg block per platform, each returning: a cfg block cannot be the
// tail expression, so the `return`s are needed.
#[allow(clippy::needless_return)]
pub fn microphone_permission_state() -> (String, Option<String>) {
    // iOS has a real permission API; device presence is meaningless there
    // (the microphone always enumerates, granted or not).
    #[cfg(target_os = "ios")]
    {
        return match super::ios_session::record_permission() {
            "granted" => ("granted".to_string(), None),
            "denied" => ("denied".to_string(), Some(microphone_permission_hint())),
            _ => ("unknown".to_string(), None),
        };
    }
    #[cfg(target_os = "android")]
    {
        return crate::android::microphone_permission_state();
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let host = cpal::default_host();
        if host.default_input_device().is_some() {
            ("granted".to_string(), None)
        } else {
            ("denied".to_string(), Some(microphone_permission_hint()))
        }
    }
}

pub fn microphone_device_available() -> bool {
    cpal::default_host().default_input_device().is_some()
}

pub fn microphone_device_hint() -> String {
    "No microphone input device is available.".to_string()
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn microphone_permission_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        "Enable microphone access in macOS Privacy & Security settings.".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "Enable microphone access in Windows privacy settings.".to_string()
    }
    #[cfg(target_os = "ios")]
    {
        "Enable microphone access in Settings for this app.".to_string()
    }
    #[cfg(all(
        not(target_os = "macos"),
        not(target_os = "windows"),
        not(target_os = "ios")
    ))]
    {
        "Enable microphone access in your system privacy settings.".to_string()
    }
}

/// A capture start that panicked (a platform audio backend failing in a way it
/// does not report as an error) is a bug to log, not a sentence for the screen.
pub fn start_task_failed(error: tokio::task::JoinError) -> AppError {
    tracing::error!(%error, "recording start task failed");
    AppError::new(
        "recording_start_failed",
        "The microphone could not start. Try again, and restart the app if it keeps happening.",
    )
}

pub fn start_capture(
    app: tauri::AppHandle,
    paths: &AppPaths,
    note_id: String,
    source_mode: RecordingSourceMode,
) -> Result<StartedRecording, AppError> {
    let mut active = ACTIVE_RECORDING
        .lock()
        .map_err(|_| AppError::new("recording_lock_failed", "Recording state is unavailable."))?;
    if active.is_some() {
        return Err(AppError::new(
            "recording_already_active",
            "A previous recording is still active. Sub Rosa attempted to save it locally; please try again.",
        ));
    }

    // iOS: raise the system microphone prompt if the user was never asked
    // (and fail cleanly on denial), then put the shared AVAudioSession in a
    // recording category and activate it before cpal opens the input stream,
    // or capture yields silence.
    #[cfg(target_os = "ios")]
    {
        super::ios_session::ensure_record_permission()?;
        super::ios_session::configure_for_recording()?;
    }

    #[cfg(target_os = "android")]
    let android_recording = crate::android::RecordingGuard::start()?;

    let session_id = Uuid::new_v4().to_string();
    let note_dir = paths
        .recording_session_dir(&note_id, &session_id)
        .map_err(|error| AppError::new("invalid_recording_path", error.to_string()))?;
    std::fs::create_dir_all(&note_dir)
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let paused_flag = Arc::new(AtomicBool::new(false));
    let live_preview_available =
        crate::june_api::configured() && crate::os_accounts::cached_signed_in();
    let (microphone, device_label) = if source_mode.includes_microphone() {
        let (lane, device_label) = MicrophoneLane::open(
            &app,
            &note_dir,
            &note_id,
            &session_id,
            source_mode,
            &paused_flag,
            live_preview_available,
        )?;
        (Some(lane), device_label)
    } else {
        (None, None)
    };
    let system_partial_path = source_mode
        .includes_system()
        .then(|| note_dir.join("system.partial.wav"));
    let system_final_path = source_mode
        .includes_system()
        .then(|| note_dir.join("system.wav"));
    let mut system_live_preview = None;
    let system_capture = if let (Some(system_partial_path), Some(system_final_path)) =
        (system_partial_path.clone(), system_final_path.clone())
    {
        match SystemAudioCapture::start(
            system_partial_path.clone(),
            system_final_path.clone(),
            Duration::ZERO,
        ) {
            Ok(capture) => {
                if live_preview_available {
                    system_live_preview = Some(start_system_live_transcript_preview(
                        app.clone(),
                        note_id.clone(),
                        session_id.clone(),
                        source_mode,
                        system_partial_path,
                    ));
                }
                Some(capture)
            }
            Err(error) => {
                if let Some(microphone) = microphone {
                    microphone.discard();
                }
                return Err(error);
            }
        }
    } else {
        None
    };
    if let Some(lane) = microphone.as_ref() {
        if let Err(error) = lane.play() {
            if let Some(system_live_preview) = system_live_preview {
                system_live_preview.cancel();
            }
            // Stopping finalizes the helper's file; nothing references it yet.
            let _ = system_capture.map(SystemAudioCapture::stop);
            if let Some(microphone) = microphone {
                microphone.discard();
            }
            return Err(error);
        }
    }
    let live_preview_enabled = microphone
        .as_ref()
        .is_some_and(|lane| lane.live_preview.is_some())
        || system_live_preview.is_some();
    let (partial_path, final_path) = match (&microphone, &system_partial_path, &system_final_path) {
        (Some(lane), _, _) => (lane.partial_path.clone(), lane.final_path.clone()),
        (None, Some(partial), Some(final_path)) => (partial.clone(), final_path.clone()),
        _ => (
            note_dir.join("microphone.partial.wav"),
            note_dir.join("microphone.wav"),
        ),
    };
    // The recording clock starts once every lane runs: it feeds elapsed()
    // and the finish-time duration validation, which must not count stream
    // or helper setup time.
    let started = Instant::now();
    let recording = ActiveRecording {
        session_id: session_id.clone(),
        note_id: note_id.clone(),
        final_path: final_path.clone(),
        source_mode,
        microphone,
        system_final_path,
        system_capture,
        started,
        active_since: Some(started),
        accumulated_active: Duration::ZERO,
        paused: false,
        paused_flag,
        last_recovery_snapshot_elapsed_ms: 0,
        system_live_preview,
        live_preview_enabled,
        #[cfg(target_os = "android")]
        _android_recording: android_recording,
    };
    let status = recording.status();
    *active = Some(recording);

    Ok(StartedRecording {
        session_id,
        note_id,
        source_mode,
        partial_path,
        final_path,
        sources: started_sources(source_mode, &note_dir),
        device_label,
        status,
    })
}

impl MicrophoneLane {
    /// Opens the default input device and builds its stream without
    /// starting it, writing to `microphone.partial.wav` in `note_dir`.
    fn open(
        app: &tauri::AppHandle,
        note_dir: &Path,
        note_id: &str,
        session_id: &str,
        source_mode: RecordingSourceMode,
        paused_flag: &Arc<AtomicBool>,
        live_preview_available: bool,
    ) -> Result<(Self, Option<String>), AppError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or_else(|| {
            AppError::new(
                "microphone_unavailable",
                "No microphone input device is available.",
            )
        })?;
        let device_label = device.name().ok();
        let config = device
            .default_input_config()
            .map_err(|error| AppError::new("microphone_unavailable", error.to_string()))?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        let partial_path = note_dir.join("microphone.partial.wav");
        let final_path = note_dir.join("microphone.wav");
        let writer = WavWriter::create(
            &partial_path,
            WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;

        let writer = Arc::new(Mutex::new(Some(writer)));
        let stats = Arc::new(Mutex::new(CaptureStats::default()));
        let stream_error = Arc::new(Mutex::new(None));
        let last_callback_at = Arc::new(Mutex::new(None));
        let stall_latch = Arc::new(Mutex::new(None));
        let writer_for_callback = Arc::clone(&writer);
        let stats_for_callback = Arc::clone(&stats);
        let last_callback_for_callback = Arc::clone(&last_callback_at);
        let paused_for_callback = Arc::clone(paused_flag);
        let live_preview = if live_preview_available {
            Some(start_live_transcript_preview(
                app.clone(),
                note_id.to_string(),
                session_id.to_string(),
                source_mode,
                RecordingSource::Microphone,
                sample_rate,
                channels,
            ))
        } else {
            None
        };
        let preview_for_callback = live_preview.as_ref().map(LivePreviewController::sink);
        // Diagnostic anchor only, captured before stream construction so err_fn
        // can attribute early errors.
        let capture_setup_started = Instant::now();
        let stream_error_for_callback = Arc::clone(&stream_error);
        let err_fn = move |error| {
            // Always leave a raw trace, then record the first structured issue.
            // A blocking lock is required: this is CPAL's error callback (not the
            // realtime data callback), and a try_lock could silently drop the one
            // error whenever a status poll holds the mutex at that instant.
            eprintln!("audio stream error: {error}");
            let mut issue = match stream_error_for_callback.lock() {
                Ok(issue) => issue,
                Err(poisoned) => poisoned.into_inner(),
            };
            if issue.is_none() {
                *issue = Some(MicrophoneStreamIssue {
                    code: "microphone_stream_error".to_string(),
                    message: format!("Microphone input stopped unexpectedly: {error}"),
                    elapsed_ms: capture_setup_started
                        .elapsed()
                        .as_millis()
                        .min(i64::MAX as u128) as i64,
                });
            }
        };

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[f32], _| {
                    write_input_data(
                        data.iter().copied(),
                        &writer_for_callback,
                        &stats_for_callback,
                        &last_callback_for_callback,
                        &paused_for_callback,
                        preview_for_callback.as_ref(),
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[i16], _| {
                    write_input_data(
                        data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                        &writer_for_callback,
                        &stats_for_callback,
                        &last_callback_for_callback,
                        &paused_for_callback,
                        preview_for_callback.as_ref(),
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[u16], _| {
                    write_input_data(
                        data.iter()
                            .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                        &writer_for_callback,
                        &stats_for_callback,
                        &last_callback_for_callback,
                        &paused_for_callback,
                        preview_for_callback.as_ref(),
                    )
                },
                err_fn,
                None,
            ),
            _ => {
                return Err(AppError::new(
                    "microphone_unavailable",
                    "Unsupported microphone sample format.",
                ))
            }
        }
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
        Ok((
            Self {
                partial_path,
                final_path,
                writer,
                stats,
                stream_error,
                last_callback_at,
                stall_latch,
                live_preview,
                stream,
            },
            device_label,
        ))
    }

    fn play(&self) -> Result<(), AppError> {
        self.stream
            .play()
            .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))
    }

    fn snapshot(
        &self,
        elapsed_ms: i64,
        state: RecordingState,
        since_start: Duration,
    ) -> MicrophoneSnapshot {
        let stats = self.stats.lock().ok();
        let (peak, rms, recent_peaks, bytes_written) = if let Some(stats) = stats.as_ref() {
            let rms = if stats.samples == 0 {
                0.0
            } else {
                (stats.sum_square / stats.samples as f64).sqrt() as f32
            };
            (
                stats.peak,
                rms,
                stats.recent_peaks.iter().copied().collect(),
                stats.bytes_written,
            )
        } else {
            (0.0, 0.0, Vec::new(), 0)
        };
        drop(stats);
        let issue = microphone_stream_issue(
            elapsed_ms,
            state,
            &self.stream_error,
            &self.last_callback_at,
        );
        latch_stall(&self.stall_latch, issue.as_ref());
        // A dead stream must not keep animating the last healthy peaks: the
        // waveform reads level, not silence_warning, so zero it on an issue.
        let level = if issue.is_some() {
            AudioLevelDto {
                peak: 0.0,
                rms: 0.0,
                recent_peaks: Vec::new(),
            }
        } else {
            AudioLevelDto {
                peak,
                rms,
                recent_peaks,
            }
        };
        MicrophoneSnapshot {
            level,
            bytes_written,
            silence_warning: since_start >= Duration::from_secs(10)
                && rms < DEFAULT_SILENCE_THRESHOLD,
            issue,
        }
    }

    fn flush_for_recovery(&self) {
        let Ok(mut writer_guard) = self.writer.lock() else {
            return;
        };
        if let Some(writer) = writer_guard.as_mut() {
            let _ = writer.flush();
        }
    }

    /// Stops the stream and commits `microphone.wav` by atomic rename
    /// (ADR-0005).
    fn finalize(self, elapsed_ms: i64) -> Result<FinishedSource, AppError> {
        let Self {
            partial_path,
            final_path,
            writer,
            stream_error,
            last_callback_at,
            stall_latch,
            live_preview,
            stream,
            ..
        } = self;
        if let Some(live_preview) = live_preview {
            live_preview.cancel();
        }
        drop(stream);
        if let Some(writer) = writer
            .lock()
            .map_err(|_| AppError::new("audio_finalization_failed", "Audio writer lock failed."))?
            .take()
        {
            writer
                .finalize()
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        std::fs::rename(&partial_path, &final_path)
            .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        Ok(FinishedSource {
            source: RecordingSource::Microphone,
            final_path,
            elapsed_ms,
            capture_issue: microphone_stream_issue(
                elapsed_ms,
                RecordingState::Validating,
                &stream_error,
                &last_callback_at,
            )
            .or_else(|| stall_latch.lock().ok().and_then(|latch| latch.clone())),
        })
    }

    /// Abandons a lane whose recording never started: no file is left behind.
    fn discard(self) {
        if let Some(live_preview) = self.live_preview {
            live_preview.cancel();
        }
        drop(self.stream);
        if let Ok(mut writer_guard) = self.writer.lock() {
            let _ = writer_guard.take();
        }
        let _ = std::fs::remove_file(&self.partial_path);
    }
}

/// Whether a recording session currently holds the audio pipeline. The iOS
/// playback-session command checks this so releasing the session after media
/// playback never tears it down under a live capture.
pub fn has_active_capture() -> bool {
    ACTIVE_RECORDING
        .lock()
        .map(|active| active.is_some())
        .unwrap_or(false)
}

/// Pause the active recording regardless of its session id. Used by the iOS
/// audio-interruption observer (incoming call, Siri): the interruption also
/// silences the input stream, so pausing keeps elapsed time honest and the
/// UI in a resumable state instead of recording dead air.
pub fn pause_active_capture_for_interruption() {
    let session_id = {
        let Ok(active) = ACTIVE_RECORDING.lock() else {
            return;
        };
        let Some(recording) = active.as_ref() else {
            return;
        };
        if recording.paused {
            return;
        }
        recording.session_id.clone()
    };
    let _ = pause_capture(&session_id);
}

pub fn pause_capture(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if !recording.paused {
        if let Some(active_since) = recording.active_since.take() {
            recording.accumulated_active += active_since.elapsed();
        }
        recording.paused = true;
        recording.paused_flag.store(true, Ordering::Release);
        if let Some(system) = recording.system_capture.as_mut() {
            system.pause();
        }
    }
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Force))
}

pub fn resume_capture(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if recording.paused {
        recording.active_since = Some(Instant::now());
        recording.paused = false;
        recording.paused_flag.store(false, Ordering::Release);
        if let Some(system) = recording.system_capture.as_mut() {
            system.resume();
        }
    }
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Force))
}

pub fn capture_status(session_id: &str) -> Result<RecordingStatusDto, AppError> {
    let active = lock_active()?;
    let recording = active_for_session(active.as_ref(), session_id)?;
    Ok(recording.status())
}

pub fn capture_status_for_recovery(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Throttled))
}

pub fn is_capture_active() -> bool {
    ACTIVE_RECORDING
        .lock()
        .map(|active| active.is_some())
        .unwrap_or(false)
}

pub fn finish_active_capture() -> Result<Option<FinishedRecording>, AppError> {
    let mut active = lock_active()?;
    let Some(recording) = active.take() else {
        return Ok(None);
    };
    finalize_recording(recording).map(Some)
}

/// Snapshot of whatever recording is currently active, regardless of session
/// id. The meeting HUD supervisor mirrors the live recording without holding
/// the session id the way the React layer does, so it can't go through
/// [`capture_status`]. Returns `None` when nothing is recording.
pub fn current_status() -> Option<RecordingStatusDto> {
    let active = lock_active().ok()?;
    active.as_ref().map(|recording| recording.status())
}

pub fn finish_capture(session_id: &str) -> Result<FinishedRecording, AppError> {
    let mut active = lock_active()?;
    let Some(recording) = active.take() else {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    };
    if recording.session_id != session_id {
        let status = recording.status();
        *active = Some(recording);
        return Err(AppError::new(
            "recording_not_found",
            format!(
                "Active recording is {}, not {}",
                status.session_id, session_id
            ),
        ));
    }
    finalize_recording(recording)
}

fn finalize_recording(recording: ActiveRecording) -> Result<FinishedRecording, AppError> {
    let status = recording.status_with_state(RecordingState::Validating);
    let recording_dto = RecordingSessionDto {
        id: recording.session_id.clone(),
        note_id: recording.note_id.clone(),
        source_mode: recording.source_mode,
        state: status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: status.elapsed_ms,
        device_label: None,
        level: status.level,
        live_preview_enabled: recording.live_preview_enabled,
        sources: status.sources,
        warnings: status.warnings,
    };
    // A system error the helper reported at any point during the take is
    // that lane's capture issue, as a stall is the microphone's.
    let system_issue = recording
        .system_capture
        .as_ref()
        .map(SystemAudioCapture::status)
        .and_then(|system| system.last_error)
        .map(|message| MicrophoneStreamIssue {
            code: "system_stream_error".to_string(),
            message,
            elapsed_ms: recording_dto.elapsed_ms,
        });
    let ActiveRecording {
        session_id,
        note_id,
        final_path,
        source_mode,
        microphone,
        system_capture,
        system_final_path,
        paused_flag,
        system_live_preview,
        ..
    } = recording;
    paused_flag.store(true, Ordering::Release);
    if let Some(system_live_preview) = system_live_preview {
        system_live_preview.cancel();
    }
    let microphone_finished = microphone.map(|lane| lane.finalize(recording_dto.elapsed_ms));
    // Stop the system-audio capture even when microphone finalization failed:
    // dropping `SystemAudioCapture` without `stop()` would leave it recording
    // in the background.
    let system_stopped = system_capture.map(SystemAudioCapture::stop);
    let mut sources = Vec::new();
    if let Some(microphone) = microphone_finished {
        sources.push(microphone?);
    }
    if let Some(system_path) = system_stopped {
        let system_path = system_path?;
        sources.push(FinishedSource {
            source: RecordingSource::System,
            final_path: system_final_path.unwrap_or(system_path.clone()),
            elapsed_ms: recording_dto.elapsed_ms,
            capture_issue: system_issue,
        });
    }
    // Recording is over: release the audio session so other apps' audio
    // resumes and iOS stops keeping us alive in the background.
    #[cfg(target_os = "ios")]
    super::ios_session::deactivate();
    Ok(FinishedRecording {
        session_id,
        note_id,
        source_mode,
        final_path,
        sources,
        elapsed_ms: recording_dto.elapsed_ms,
        recording: recording_dto,
    })
}

fn write_input_data<I>(
    data: I,
    writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: &Arc<Mutex<CaptureStats>>,
    last_callback_at: &Arc<Mutex<Option<Instant>>>,
    paused: &Arc<AtomicBool>,
    preview: Option<&LivePreviewSink>,
) where
    I: Iterator<Item = f32>,
{
    if let Ok(mut last_callback_at) = last_callback_at.try_lock() {
        *last_callback_at = Some(Instant::now());
    }
    if paused.load(Ordering::Acquire) {
        return;
    }
    let Ok(mut writer_guard) = writer.lock() else {
        return;
    };
    let Some(writer) = writer_guard.as_mut() else {
        return;
    };
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    let mut preview_samples = preview.map(|_| Vec::new());
    {
        let mut callback_peak = 0.0_f32;
        let mut saw_sample = false;
        for sample in data {
            saw_sample = true;
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm_sample = (clamped * i16::MAX as f32) as i16;
            let normalized = clamped.abs();
            callback_peak = callback_peak.max(normalized);
            stats.peak = stats.peak.max(normalized);
            stats.sum_square += (normalized as f64).powi(2);
            stats.samples += 1;
            stats.bytes_written += 2;
            let _ = writer.write_sample(pcm_sample);
            if let Some(samples) = preview_samples.as_mut() {
                samples.push(pcm_sample);
            }
        }
        if saw_sample {
            if stats.recent_peaks.len() == 24 {
                stats.recent_peaks.pop_front();
            }
            stats.recent_peaks.push_back(callback_peak);
        }
    }
    drop(stats);
    drop(writer_guard);
    if let (Some(preview), Some(samples)) = (preview, preview_samples) {
        preview.try_send(samples);
    }
}

fn lock_active() -> Result<std::sync::MutexGuard<'static, Option<ActiveRecording>>, AppError> {
    ACTIVE_RECORDING
        .lock()
        .map_err(|_| AppError::new("recording_lock_failed", "Recording state is unavailable."))
}

fn active_for_session<'a, T>(active: Option<T>, session_id: &str) -> Result<T, AppError>
where
    T: AsRecording<'a>,
{
    let Some(recording) = active else {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    };
    if recording.session_id() != session_id {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    }
    Ok(recording)
}

trait AsRecording<'a> {
    fn session_id(&self) -> &str;
}

impl<'a> AsRecording<'a> for &'a ActiveRecording {
    fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl<'a> AsRecording<'a> for &'a mut ActiveRecording {
    fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl ActiveRecording {
    fn elapsed(&self) -> Duration {
        if self.paused {
            self.accumulated_active
        } else {
            self.accumulated_active
                + self
                    .active_since
                    .map(|instant| instant.elapsed())
                    .unwrap_or_default()
        }
    }

    fn status(&self) -> RecordingStatusDto {
        self.status_with_state(if self.paused {
            RecordingState::Paused
        } else {
            RecordingState::Recording
        })
    }

    fn status_with_state(&self, state: RecordingState) -> RecordingStatusDto {
        let elapsed_ms = self.elapsed().as_millis() as i64;
        let microphone = self
            .microphone
            .as_ref()
            .map(|lane| lane.snapshot(elapsed_ms, state, self.started.elapsed()));
        let system = self.system_capture.as_ref().map(SystemAudioCapture::status);
        // The top-level reading describes the primary lane, so the HUD, the
        // sidebar and the inactivity prompt read a computer-only take the way
        // they read a microphone one.
        let (level, bytes_written, silence_warning) = match (&microphone, &system) {
            (Some(microphone), _) => (
                microphone.level.clone(),
                microphone.bytes_written,
                microphone.silence_warning,
            ),
            (None, Some(system)) => (
                system.level.clone(),
                system.bytes_written,
                system_never_heard(elapsed_ms, system),
            ),
            (None, None) => (AudioLevelDto::default(), 0, false),
        };
        RecordingStatusDto {
            session_id: self.session_id.clone(),
            note_id: Some(self.note_id.clone()),
            source_mode: self.source_mode,
            state,
            elapsed_ms,
            level,
            silence_warning,
            bytes_written,
            live_preview_enabled: self.live_preview_enabled,
            sources: source_statuses(state, elapsed_ms, microphone.as_ref(), system.as_ref()),
            warnings: source_warnings(
                microphone
                    .as_ref()
                    .and_then(|microphone| microphone.issue.as_ref()),
                system
                    .as_ref()
                    .is_some_and(|system| system_never_heard(elapsed_ms, system)),
            ),
        }
    }

    fn recovery_snapshot(&mut self, mode: RecoverySnapshotMode) -> CaptureRecoverySnapshot {
        let status = self.status();
        let should_persist = match mode {
            RecoverySnapshotMode::Force => true,
            RecoverySnapshotMode::Throttled => {
                status.elapsed_ms - self.last_recovery_snapshot_elapsed_ms
                    >= RECOVERY_SNAPSHOT_INTERVAL_MS
            }
        };
        if should_persist {
            self.last_recovery_snapshot_elapsed_ms = status.elapsed_ms;
            if let Some(microphone) = self.microphone.as_ref() {
                microphone.flush_for_recovery();
            }
        }
        CaptureRecoverySnapshot {
            status,
            should_persist,
        }
    }
}

enum RecoverySnapshotMode {
    Throttled,
    Force,
}

fn started_sources(source_mode: RecordingSourceMode, note_dir: &Path) -> Vec<StartedSource> {
    source_mode
        .required_sources()
        .into_iter()
        .map(|source| StartedSource {
            source,
            partial_path: note_dir.join(format!("{}.partial.wav", source.as_db())),
            final_path: note_dir.join(format!("{}.wav", source.as_db())),
        })
        .collect()
}

/// The computer has not made a sound since the take started. Not "it is
/// quiet now": a call has pauses, and a person presenting hears nothing
/// back for minutes. Only a lane that was never heard is worth a warning.
fn system_never_heard(elapsed_ms: i64, system: &SystemLaneStatus) -> bool {
    elapsed_ms >= SYSTEM_SILENCE_WARNING_AFTER_MS && system.max_level < DEFAULT_SILENCE_THRESHOLD
}

fn source_statuses(
    state: RecordingState,
    elapsed_ms: i64,
    microphone: Option<&MicrophoneSnapshot>,
    system: Option<&SystemLaneStatus>,
) -> Vec<SourceStatusDto> {
    let source_state = match state {
        RecordingState::Paused => SourceState::Paused,
        RecordingState::Validating | RecordingState::Finalizing => SourceState::Finalizing,
        RecordingState::Invalid => SourceState::Invalid,
        RecordingState::Failed => SourceState::Failed,
        RecordingState::Recoverable => SourceState::Recoverable,
        _ => SourceState::Recording,
    };
    let mut sources = Vec::new();
    if let Some(microphone) = microphone {
        sources.push(SourceStatusDto {
            source: RecordingSource::Microphone,
            state: source_state,
            elapsed_ms,
            bytes_written: microphone.bytes_written,
            level: microphone.level.clone(),
            silence_warning: microphone.silence_warning || microphone.issue.is_some(),
            path_finalized: false,
            last_error: microphone.issue.as_ref().map(|issue| issue.message.clone()),
        });
    }
    if let Some(system) = system {
        sources.push(SourceStatusDto {
            source: RecordingSource::System,
            state: source_state,
            elapsed_ms,
            bytes_written: system.bytes_written,
            level: system.level.clone(),
            silence_warning: system_never_heard(elapsed_ms, system),
            path_finalized: false,
            last_error: system.last_error.clone(),
        });
    }
    sources
}

fn latch_stall(
    latch: &Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    issue: Option<&MicrophoneStreamIssue>,
) {
    let Some(issue) = issue else { return };
    if let Ok(mut latch) = latch.lock() {
        if latch.is_none() {
            *latch = Some(issue.clone());
        }
    }
}

fn microphone_stream_issue(
    elapsed_ms: i64,
    state: RecordingState,
    stream_error: &Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    last_callback_at: &Arc<Mutex<Option<Instant>>>,
) -> Option<MicrophoneStreamIssue> {
    if let Ok(issue) = stream_error.lock() {
        if issue.is_some() {
            return issue.clone();
        }
    }
    if state == RecordingState::Paused {
        return None;
    }
    let last_callback_at = last_callback_at.lock().ok().and_then(|instant| *instant);
    let stalled = match last_callback_at {
        Some(at) => at.elapsed() > MICROPHONE_STALL_THRESHOLD,
        // No input callback ever fired: a stream that opened but never
        // delivers data is stalled too, measured from recording start.
        None => elapsed_ms > MICROPHONE_STALL_THRESHOLD.as_millis() as i64,
    };
    if !stalled {
        return None;
    }
    Some(MicrophoneStreamIssue {
        code: "microphone_stream_stalled".to_string(),
        message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
        elapsed_ms,
    })
}

/// Warnings the recorder shows, most urgent first: a microphone that stopped
/// loses the person's words; a computer never heard may only be a call that
/// has not started yet.
fn source_warnings(
    microphone_stream_issue: Option<&MicrophoneStreamIssue>,
    system_never_heard: bool,
) -> Vec<SourceWarningDto> {
    let mut warnings = Vec::new();
    if let Some(issue) = microphone_stream_issue {
        warnings.push(SourceWarningDto {
            source: RecordingSource::Microphone,
            code: issue.code.clone(),
            message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
        });
    }
    if system_never_heard {
        warnings.push(SourceWarningDto {
            source: RecordingSource::System,
            code: "system_audio_silent".to_string(),
            message: SYSTEM_SILENCE_WARNING_MESSAGE.to_string(),
        });
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_state_at(
        elapsed_ms: i64,
        issue: Option<MicrophoneStreamIssue>,
        last_callback_at: Option<Instant>,
        state: RecordingState,
    ) -> Option<MicrophoneStreamIssue> {
        microphone_stream_issue(
            elapsed_ms,
            state,
            &Arc::new(Mutex::new(issue)),
            &Arc::new(Mutex::new(last_callback_at)),
        )
    }

    fn issue_state(
        issue: Option<MicrophoneStreamIssue>,
        last_callback_at: Option<Instant>,
        state: RecordingState,
    ) -> Option<MicrophoneStreamIssue> {
        issue_state_at(12_345, issue, last_callback_at, state)
    }

    #[test]
    fn stall_latch_keeps_first_stall_after_callbacks_resume() {
        let latch = Arc::new(Mutex::new(None));
        let stale_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD + Duration::from_secs(1));

        // A stall is observed and latched.
        let stalled = issue_state(None, Some(stale_callback), RecordingState::Recording)
            .expect("stale callback reports a stall");
        latch_stall(&latch, Some(&stalled));

        // Callbacks resume: the live issue clears, the latch does not.
        let recovered = issue_state(None, Some(Instant::now()), RecordingState::Recording);
        assert_eq!(recovered, None);
        latch_stall(&latch, recovered.as_ref());
        let latched = latch.lock().unwrap().clone().expect("latch persists");
        assert_eq!(latched.code, "microphone_stream_stalled");

        // A later different issue does not overwrite the first.
        let later = MicrophoneStreamIssue {
            code: "microphone_stream_error".to_string(),
            message: "later".to_string(),
            elapsed_ms: 99,
        };
        latch_stall(&latch, Some(&later));
        assert_eq!(
            latch.lock().unwrap().clone().unwrap().code,
            "microphone_stream_stalled"
        );
    }

    #[test]
    fn microphone_stream_error_appears_in_status_source_and_warnings() {
        let issue = MicrophoneStreamIssue {
            code: "microphone_stream_error".to_string(),
            message: "Microphone input stopped unexpectedly: device disconnected".to_string(),
            elapsed_ms: 2_000,
        };
        let microphone = MicrophoneSnapshot {
            level: AudioLevelDto::default(),
            bytes_written: 1_024,
            silence_warning: false,
            issue: Some(issue.clone()),
        };

        let sources = source_statuses(RecordingState::Recording, 2_000, Some(&microphone), None);
        let warnings = source_warnings(Some(&issue), false);

        let microphone = sources
            .iter()
            .find(|source| source.source == RecordingSource::Microphone)
            .expect("microphone source status exists");
        assert_eq!(microphone.last_error, Some(issue.message));
        assert!(microphone.silence_warning);
        assert_eq!(
            warnings,
            vec![SourceWarningDto {
                source: RecordingSource::Microphone,
                code: "microphone_stream_error".to_string(),
                message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
            }]
        );
    }

    #[test]
    fn computer_only_status_has_no_microphone_source() {
        let system = SystemLaneStatus {
            max_level: 0.3,
            bytes_written: 4_096,
            ..SystemLaneStatus::default()
        };

        let sources = source_statuses(RecordingState::Recording, 5_000, None, Some(&system));

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source, RecordingSource::System);
        assert_eq!(sources[0].bytes_written, 4_096);
    }

    #[test]
    fn started_sources_follow_the_source_mode() {
        let dir = Path::new("/recordings/session");
        let names = |mode| {
            started_sources(mode, dir)
                .into_iter()
                .map(|source| {
                    (
                        source.source,
                        source.partial_path.file_name().map(|name| name.to_owned()),
                    )
                })
                .collect::<Vec<_>>()
        };

        assert_eq!(
            names(RecordingSourceMode::MicrophoneOnly),
            vec![(
                RecordingSource::Microphone,
                Some("microphone.partial.wav".into())
            )]
        );
        assert_eq!(
            names(RecordingSourceMode::MicrophonePlusSystem),
            vec![
                (
                    RecordingSource::Microphone,
                    Some("microphone.partial.wav".into())
                ),
                (RecordingSource::System, Some("system.partial.wav".into())),
            ]
        );
        assert_eq!(
            names(RecordingSourceMode::SystemOnly),
            vec![(RecordingSource::System, Some("system.partial.wav".into()))]
        );
    }

    #[test]
    fn computer_warning_waits_and_only_fires_when_never_heard() {
        let silent = SystemLaneStatus::default();
        let heard_once = SystemLaneStatus {
            max_level: 0.4,
            ..SystemLaneStatus::default()
        };

        assert!(!system_never_heard(
            SYSTEM_SILENCE_WARNING_AFTER_MS - 1,
            &silent
        ));
        assert!(system_never_heard(SYSTEM_SILENCE_WARNING_AFTER_MS, &silent));
        // Quiet now after being heard is a pause in the call, not a fault.
        assert!(!system_never_heard(
            SYSTEM_SILENCE_WARNING_AFTER_MS * 10,
            &heard_once
        ));

        let warnings = source_warnings(None, true);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].source, RecordingSource::System);
        assert_eq!(warnings[0].code, "system_audio_silent");

        let sources = source_statuses(
            RecordingState::Recording,
            SYSTEM_SILENCE_WARNING_AFTER_MS,
            None,
            Some(&silent),
        );
        assert!(sources[0].silence_warning);
    }

    #[test]
    fn microphone_stall_requires_unpaused_recording_past_threshold_after_callback() {
        let recent_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD / 2);
        let stale_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD + Duration::from_secs(1));

        // Never-delivered first callback: healthy only within the startup
        // window, stalled once the recording elapsed passes the threshold.
        assert_eq!(
            issue_state_at(1_000, None, None, RecordingState::Recording),
            None
        );
        let never_started = issue_state_at(12_345, None, None, RecordingState::Recording)
            .expect("zero-callback stream past the threshold should report a stall");
        assert_eq!(never_started.code, "microphone_stream_stalled");
        assert_eq!(
            issue_state_at(12_345, None, None, RecordingState::Paused),
            None
        );
        assert_eq!(
            issue_state(None, Some(recent_callback), RecordingState::Recording),
            None
        );

        let stalled = issue_state(None, Some(stale_callback), RecordingState::Recording)
            .expect("stale active stream should report a stall");
        assert_eq!(stalled.code, "microphone_stream_stalled");
        assert_eq!(stalled.message, MICROPHONE_STREAM_WARNING_MESSAGE);
        assert_eq!(stalled.elapsed_ms, 12_345);
    }

    #[test]
    fn paused_recording_suppresses_microphone_stall_warning() {
        let stale_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD + Duration::from_secs(1));

        assert_eq!(
            issue_state(None, Some(stale_callback), RecordingState::Paused),
            None
        );
    }
}
