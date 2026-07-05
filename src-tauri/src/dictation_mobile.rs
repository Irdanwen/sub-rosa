//! In-app dictation for mobile.
//!
//! The desktop dictation stack (global hotkeys, Swift helper, HUD window,
//! paste injection) has no equivalent on iOS, so mobile dictation is a plain
//! in-app mode: a button starts a short microphone capture into a temp WAV,
//! stopping it sends the audio through the same `/v1/dictate` +
//! `/v1/dictate/cleanup` pipeline the desktop uses, and the polished text
//! comes back to the UI for copy/share. History rows share the desktop's
//! `dictation_history` table.

use crate::{
    domain::{processing::build_dictionary_context, types::AppError},
    june_api::{
        cleanup_text, dictate_transcribe, DictateCleanupRequestParams, DictateTranscribeRequest,
    },
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    time::Instant,
};
use tauri::AppHandle;

static ACTIVE_DICTATION: LazyLock<Mutex<Option<ActiveDictation>>> =
    LazyLock::new(|| Mutex::new(None));

struct ActiveDictation {
    session_id: String,
    path: PathBuf,
    started: Instant,
    writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    peak: Arc<Mutex<f32>>,
    _stream: cpal::Stream,
}

// Single dictation at a time behind a process-wide mutex; the stream is only
// held/dropped through this lifecycle (same rationale as audio::capture).
unsafe impl Send for ActiveDictation {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictationStatusDto {
    pub session_id: String,
    pub elapsed_ms: i64,
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictationResultDto {
    pub text: String,
    pub raw_text: String,
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictationStopRequest {
    /// Cleanup style: "standard", "casualLowercase", or "formal".
    pub style: Option<String>,
    pub language: Option<String>,
}

#[tauri::command]
pub async fn mobile_dictation_start() -> Result<MobileDictationStatusDto, AppError> {
    // The iOS permission prompt (ensure_record_permission) blocks until the
    // user answers; keep that wait off the async runtime.
    tokio::task::spawn_blocking(start_dictation_capture)
        .await
        .map_err(|error| AppError::new("dictation_start_failed", error.to_string()))?
}

fn start_dictation_capture() -> Result<MobileDictationStatusDto, AppError> {
    let mut active = ACTIVE_DICTATION
        .lock()
        .map_err(|_| AppError::new("dictation_lock_failed", "Dictation state is unavailable."))?;
    if active.is_some() {
        return Err(AppError::new(
            "dictation_already_active",
            "A dictation is already recording.",
        ));
    }

    #[cfg(target_os = "ios")]
    {
        crate::audio::ios_session::ensure_record_permission()?;
        crate::audio::ios_session::configure_for_recording()?;
    }

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        AppError::new(
            "microphone_unavailable",
            "No microphone input device is available.",
        )
    })?;
    let config = device
        .default_input_config()
        .map_err(|error| AppError::new("microphone_unavailable", error.to_string()))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let session_id = uuid::Uuid::new_v4().to_string();
    let path = std::env::temp_dir().join(format!("subrosa-dictation-{session_id}.wav"));
    let writer = WavWriter::create(
        &path,
        WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    )
    .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let peak = Arc::new(Mutex::new(0.0f32));

    let err_fn = |error| eprintln!("dictation stream error: {error}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            {
                let writer = Arc::clone(&writer);
                let peak = Arc::clone(&peak);
                move |data: &[f32], _| {
                    write_dictation_samples(&writer, &peak, data.iter().copied());
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            {
                let writer = Arc::clone(&writer);
                let peak = Arc::clone(&peak);
                move |data: &[i16], _| {
                    write_dictation_samples(
                        &writer,
                        &peak,
                        data.iter()
                            .map(|sample| f32::from(*sample) / f32::from(i16::MAX)),
                    );
                }
            },
            err_fn,
            None,
        ),
        other => {
            return Err(AppError::new(
                "microphone_unavailable",
                format!("Unsupported sample format: {other:?}"),
            ))
        }
    }
    .map_err(|error| AppError::new("recording_start_failed", error.to_string()))?;
    stream
        .play()
        .map_err(|error| AppError::new("recording_start_failed", error.to_string()))?;

    let status = MobileDictationStatusDto {
        session_id: session_id.clone(),
        elapsed_ms: 0,
        peak: 0.0,
    };
    *active = Some(ActiveDictation {
        session_id,
        path,
        started: Instant::now(),
        writer,
        peak,
        _stream: stream,
    });
    Ok(status)
}

#[tauri::command]
pub fn mobile_dictation_status() -> Result<Option<MobileDictationStatusDto>, AppError> {
    let active = ACTIVE_DICTATION
        .lock()
        .map_err(|_| AppError::new("dictation_lock_failed", "Dictation state is unavailable."))?;
    Ok(active.as_ref().map(|dictation| {
        let peak = dictation
            .peak
            .lock()
            .map(|mut peak| std::mem::take(&mut *peak))
            .unwrap_or(0.0);
        MobileDictationStatusDto {
            session_id: dictation.session_id.clone(),
            elapsed_ms: dictation
                .started
                .elapsed()
                .as_millis()
                .min(i64::MAX as u128) as i64,
            peak,
        }
    }))
}

#[tauri::command]
pub fn mobile_dictation_cancel() -> Result<(), AppError> {
    if let Some(dictation) = take_active()? {
        let _ = std::fs::remove_file(&dictation.path);
        #[cfg(target_os = "ios")]
        crate::audio::ios_session::deactivate();
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_dictation_stop(
    app: AppHandle,
    request: MobileDictationStopRequest,
) -> Result<MobileDictationResultDto, AppError> {
    let Some(dictation) = take_active()? else {
        return Err(AppError::new(
            "dictation_not_active",
            "No dictation is recording.",
        ));
    };
    // Finalize the WAV (drop the writer to flush the header) and release the
    // audio session before the network round-trips.
    if let Ok(mut writer) = dictation.writer.lock() {
        if let Some(writer) = writer.take() {
            let _ = writer.finalize();
        }
    }
    #[cfg(target_os = "ios")]
    crate::audio::ios_session::deactivate();

    let repos = crate::commands::repositories(&app).await?;
    let dictionary_entries = repos.list_dictionary_entries().await?;
    let dictionary_context = build_dictionary_context(&dictionary_entries);
    let utterance_id = uuid::Uuid::new_v4().to_string();

    let transcript = dictate_transcribe(DictateTranscribeRequest {
        audio_path: dictation.path.clone(),
        context: dictionary_context.clone(),
        language: request
            .language
            .clone()
            .filter(|value| !value.trim().is_empty()),
        session_id: dictation.session_id.clone(),
        utterance_id: utterance_id.clone(),
    })
    .await;
    let _ = std::fs::remove_file(&dictation.path);
    let transcript = transcript?;

    let raw_text = transcript.text.trim().to_string();
    if raw_text.is_empty() {
        return Err(AppError::new(
            "dictation_empty",
            "No speech was detected in the recording.",
        ));
    }
    let style = request
        .style
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "standard".to_string());
    // Cleanup is best-effort polish; if the model is unavailable the raw
    // transcript is still a useful result.
    let text = cleanup_text(DictateCleanupRequestParams {
        text: raw_text.clone(),
        dictionary_context,
        style,
        session_id: dictation.session_id,
        utterance_id,
    })
    .await
    .unwrap_or_else(|_| raw_text.clone());

    let _ = repos
        .create_dictation_history_item(&text, transcript.language.clone(), &transcript.provider)
        .await;

    Ok(MobileDictationResultDto {
        text,
        raw_text,
        language: transcript.language,
    })
}

fn take_active() -> Result<Option<ActiveDictation>, AppError> {
    ACTIVE_DICTATION
        .lock()
        .map(|mut active| active.take())
        .map_err(|_| AppError::new("dictation_lock_failed", "Dictation state is unavailable."))
}

fn write_dictation_samples<I>(
    writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    peak: &Arc<Mutex<f32>>,
    samples: I,
) where
    I: Iterator<Item = f32>,
{
    let Ok(mut writer_guard) = writer.lock() else {
        return;
    };
    let Some(writer) = writer_guard.as_mut() else {
        return;
    };
    let mut frame_peak = 0.0f32;
    for sample in samples {
        frame_peak = frame_peak.max(sample.abs());
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
        let _ = writer.write_sample(value);
    }
    if let Ok(mut peak) = peak.lock() {
        *peak = peak.max(frame_peak);
    }
}

/// Dictation history for the mobile shell — same table and retention as the
/// desktop dictation module (which is not compiled on mobile).
#[tauri::command]
pub async fn mobile_list_dictation_history(
    app: AppHandle,
) -> Result<crate::domain::types::ListDictationHistoryResponse, AppError> {
    crate::commands::repositories(&app)
        .await?
        .list_dictation_history(200)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn mobile_delete_dictation_history_item(
    app: AppHandle,
    id: String,
) -> Result<(), AppError> {
    crate::commands::repositories(&app)
        .await?
        .delete_dictation_history_item(&id)
        .await
        .map_err(AppError::from)
}
