//! Cloned voices (ADR-0077).
//!
//! A person makes a voice once from a short sample of their own, and speaks
//! with it for weeks. The provider's `vv_…` handle lives seven days at most
//! (and not even that across an operator restart), so the voice is the
//! **sample, kept on this device**, and the handle is a cache on its row:
//! reused while it has a day left, reminted from the sample otherwise, and
//! reminted on demand when the backend answers that it is gone.
//!
//! The samples live in `$APPDATA/cloned-voices/`, apart from the Studio
//! gallery (`studio-media/`), which the account sync scans: a voice is
//! biometric, and it stays here. The `cloned_voices` table is likewise not
//! one of the sync tables.

use crate::domain::types::AppError;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::{media, settings};

/// Where the samples are kept, inside the app data directory.
const SAMPLES_DIR: &str = "cloned-voices";
/// Formats kept as they are; anything else is converted to WAV first, so a
/// voice memo or an m4a from the microphone test is accepted too.
const KEPT_AS_IS: [&str; 3] = ["mp3", "wav", "flac"];
/// Long enough for any sample worth cloning, short enough to stay a sample.
const MAX_SAMPLE_SECONDS: f64 = 60.0;
/// A sample larger than this is not a short sample (base64 in the IPC).
const MAX_SAMPLE_BYTES: usize = 20 * 1024 * 1024;
/// A handle with less than this left is reminted before use.
const HANDLE_MARGIN_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClonedVoiceDto {
    pub id: String,
    pub name: String,
    pub model: String,
    pub created_at: String,
    pub consented_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClonedVoiceRequest {
    pub name: String,
    pub model: String,
    /// The sample's bytes, base64.
    pub sample_base64: String,
    /// Its extension as the person's file had it (`m4a`, `wav`...).
    pub extension: String,
    /// The person confirmed the sample is their own voice, or one they have
    /// permission to use. Nothing is uploaded without it.
    pub consent: bool,
}

fn samples_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?
        .join(SAMPLES_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?;
    Ok(dir)
}

/// A file name this module wrote: `<uuid>.<ext>`, nothing that walks out of
/// the samples directory.
fn safe_sample_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && !name.contains("..")
        && name.split_once('.').is_some()
}

fn normalized_extension(extension: &str) -> String {
    extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect()
}

/// Whether a cached handle is still worth using at `now`.
fn handle_is_fresh(expires_at: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> bool {
    expires_at
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .is_some_and(|at| {
            (at.with_timezone(&chrono::Utc) - now).num_seconds() > HANDLE_MARGIN_SECONDS
        })
}

/// The cloning statement the catalog publishes for `model`, or why it cannot
/// clone (a model that does not, or one this account no longer offers).
async fn cloning_of(model: &str) -> Result<(f64, i64), AppError> {
    let catalog = media::carpe_diem_media_catalog().await?;
    let cloning = catalog
        .models
        .iter()
        .find(|entry| entry.id == model && entry.media_type == "tts")
        .and_then(|entry| entry.constraints.as_ref())
        .and_then(|constraints| constraints.get("voice_cloning"))
        .cloned()
        .ok_or_else(|| {
            AppError::new(
                "cloned_voice_invalid",
                "This voice engine does not make voices from a sample.",
            )
        })?;
    let min_seconds = cloning["min_sample_seconds"].as_f64().unwrap_or(5.0);
    let retention_days = cloning["retention_days"].as_i64().unwrap_or(7).max(1);
    Ok((min_seconds, retention_days))
}

/// Upload a kept sample; answers the handle and when it expires.
async fn upload(
    model: &str,
    sample: &Path,
    retention_days: i64,
) -> Result<(String, String), AppError> {
    let Some((credential_base, key)) = settings::credentials() else {
        return Err(AppError::new(
            "media_no_api_key",
            "No API key is stored yet.",
        ));
    };
    let bytes = tokio::fs::read(sample)
        .await
        .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?;
    let file_name = sample
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sample.wav")
        .to_string();
    let mime = match normalized_extension(
        sample
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or(""),
    )
    .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        _ => "audio/wav",
    };
    let request_bytes = bytes.len() as u64;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|error| AppError::new("cloned_voice_upload", error.to_string()))?;
    let form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part("file", part);
    let url = format!(
        "{}/audio/voices",
        settings::catalog_base_url_of(&credential_base)
    );
    let started = std::time::Instant::now();
    let response = media::media_http_client()
        .post(&url)
        .bearer_auth(key.expose_str())
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            eprintln!("cloned voice upload failed: {error}");
            AppError::new(
                "cloned_voice_upload",
                "Couldn't reach the voice service. Check your connection and try again.",
            )
        })?;
    let status = response.status();
    // The sample leaving the device is exactly what the egress log is for.
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(&url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "voice sample".into(),
        method: "POST".into(),
        request_bytes,
        response_bytes: 0,
        status: Some(status.as_u16()),
        duration_ms: started.elapsed().as_millis() as u64,
        model: Some(model.to_string()),
        note_id: None,
    });
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        // The operator names the reason (a format, a length); kept for the
        // log, while the person reads one sentence they can act on.
        eprintln!(
            "cloned voice upload refused ({status}): {}",
            body["error"].as_str().unwrap_or("")
        );
        return Err(AppError::new(
            "cloned_voice_upload",
            "The voice service refused this sample. Try a clear recording of one speaker, without music.",
        ));
    }
    let handle = body["id"]
        .as_str()
        .filter(|id| id.starts_with("vv_"))
        .ok_or_else(|| AppError::new("cloned_voice_upload", "The voice service sent no voice."))?
        .to_string();
    let expires_at = body["expires_at"]
        .as_str()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|at| at.with_timezone(&chrono::Utc))
        .unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::days(retention_days));
    Ok((handle, expires_at.to_rfc3339()))
}

/// Keep the sample under the samples directory: as it came when the provider
/// takes that format, else converted to WAV. Answers the kept file and the
/// sample's length in seconds.
fn keep_sample(
    dir: &Path,
    id: &str,
    bytes: &[u8],
    extension: &str,
) -> Result<(PathBuf, f64), AppError> {
    let incoming = dir.join(format!("{id}.incoming.{extension}"));
    std::fs::write(&incoming, bytes)
        .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?;
    let decoded_path = dir.join(format!("{id}.decoded.wav"));
    let decoded = crate::audio::decode::decode_to_transcription_wav(&incoming, &decoded_path);
    let decoded = match decoded {
        Ok(decoded) => decoded,
        Err(_) => {
            let _ = std::fs::remove_file(&incoming);
            let _ = std::fs::remove_file(&decoded_path);
            return Err(AppError::new(
                "cloned_voice_invalid",
                "This file could not be read as audio. Use an MP3, WAV, FLAC or M4A recording.",
            ));
        }
    };
    let seconds = decoded.duration_ms as f64 / 1000.0;
    let kept = if KEPT_AS_IS.contains(&extension) {
        let _ = std::fs::remove_file(&decoded_path);
        let kept = dir.join(format!("{id}.{extension}"));
        std::fs::rename(&incoming, &kept)
            .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?;
        kept
    } else {
        let _ = std::fs::remove_file(&incoming);
        let kept = dir.join(format!("{id}.wav"));
        std::fs::rename(&decoded_path, &kept)
            .map_err(|error| AppError::new("cloned_voice_storage", error.to_string()))?;
        kept
    };
    Ok((kept, seconds))
}

async fn pool(app: &AppHandle) -> Result<sqlx_sqlite::SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool)
}

fn dto(row: &sqlx_sqlite::SqliteRow) -> ClonedVoiceDto {
    ClonedVoiceDto {
        id: row.get("id"),
        name: row.get("name"),
        model: row.get("model"),
        created_at: row.get("created_at"),
        consented_at: row.get("consented_at"),
    }
}

#[tauri::command]
pub async fn cloned_voice_list(app: AppHandle) -> Result<Vec<ClonedVoiceDto>, AppError> {
    let rows = query(
        "SELECT id, name, model, created_at, consented_at FROM cloned_voices ORDER BY created_at DESC",
    )
    .fetch_all(&pool(&app).await?)
    .await?;
    Ok(rows.iter().map(dto).collect())
}

/// Make a voice: keep the sample, upload it once (so a sample the provider
/// refuses never becomes a voice that cannot speak), store the row.
#[tauri::command]
pub async fn cloned_voice_create(
    app: AppHandle,
    request: CreateClonedVoiceRequest,
) -> Result<ClonedVoiceDto, AppError> {
    if !request.consent {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "Confirm the sample is your own voice, or one you have permission to use.",
        ));
    }
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "Give the voice a name of up to 60 characters.",
        ));
    }
    let extension = normalized_extension(&request.extension);
    if extension.is_empty() {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "This file has no audio extension.",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.sample_base64.as_bytes())
        .map_err(|_| AppError::new("cloned_voice_invalid", "The sample could not be read."))?;
    if bytes.is_empty() || bytes.len() > MAX_SAMPLE_BYTES {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "Use a short sample, under 20 MB.",
        ));
    }
    let (min_seconds, retention_days) = cloning_of(&request.model).await?;

    let id = uuid::Uuid::new_v4().to_string();
    let dir = samples_dir(&app)?;
    let (kept, seconds) = keep_sample(&dir, &id, &bytes, &extension)?;
    // Fixed sentences, so the person reads them in their language.
    let refuse = |error: AppError| {
        let _ = std::fs::remove_file(&kept);
        Err(error)
    };
    if seconds < min_seconds {
        return refuse(AppError::new(
            "cloned_voice_invalid",
            "The sample is too short. Record 5 to 10 seconds of clear speech.",
        ));
    }
    if seconds > MAX_SAMPLE_SECONDS {
        return refuse(AppError::new(
            "cloned_voice_invalid",
            "The sample is too long. Keep it under a minute: 5 to 10 seconds of clear speech is enough.",
        ));
    }
    let (handle, expires_at) = match upload(&request.model, &kept, retention_days).await {
        Ok(minted) => minted,
        Err(error) => {
            let _ = std::fs::remove_file(&kept);
            return Err(error);
        }
    };
    let now = chrono::Utc::now().to_rfc3339();
    let sample_file = kept
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    query(
        "INSERT INTO cloned_voices (id, name, model, sample_file, consented_at, handle, handle_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&request.model)
    .bind(&sample_file)
    .bind(&now)
    .bind(&handle)
    .bind(&expires_at)
    .bind(&now)
    .execute(&pool(&app).await?)
    .await?;
    Ok(ClonedVoiceDto {
        id,
        name: name.to_string(),
        model: request.model,
        created_at: now.clone(),
        consented_at: now,
    })
}

/// A handle to speak with: the cached one while it has a day left, else a
/// fresh upload of the kept sample. `refresh` forces the upload, for when the
/// backend answered that the handle is gone (operator restart, retired key).
#[tauri::command]
pub async fn cloned_voice_handle(
    app: AppHandle,
    id: String,
    refresh: Option<bool>,
) -> Result<String, AppError> {
    let pool = pool(&app).await?;
    let row = query(
        "SELECT model, sample_file, handle, handle_expires_at FROM cloned_voices WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::new("cloned_voice_invalid", "This voice no longer exists."))?;
    let model: String = row.get("model");
    let sample_file: String = row.get("sample_file");
    let handle: Option<String> = row.get("handle");
    let expires_at: Option<String> = row.get("handle_expires_at");
    if !refresh.unwrap_or(false) && handle_is_fresh(expires_at.as_deref(), chrono::Utc::now()) {
        if let Some(handle) = handle {
            return Ok(handle);
        }
    }
    if !safe_sample_name(&sample_file) {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "This voice's sample is missing.",
        ));
    }
    let sample = samples_dir(&app)?.join(&sample_file);
    if !sample.is_file() {
        return Err(AppError::new(
            "cloned_voice_invalid",
            "This voice's sample is missing. Make the voice again.",
        ));
    }
    let (_, retention_days) = cloning_of(&model).await?;
    let (handle, expires_at) = upload(&model, &sample, retention_days).await?;
    query("UPDATE cloned_voices SET handle = ?, handle_expires_at = ? WHERE id = ?")
        .bind(&handle)
        .bind(&expires_at)
        .bind(&id)
        .execute(&pool)
        .await?;
    Ok(handle)
}

/// Forget a voice: its row and its sample. The provider's copy expires on
/// its own schedule.
#[tauri::command]
pub async fn cloned_voice_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    let sample: Option<String> = query("SELECT sample_file FROM cloned_voices WHERE id = ?")
        .bind(&id)
        .fetch_optional(&pool)
        .await?
        .map(|row| row.get("sample_file"));
    query("DELETE FROM cloned_voices WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await?;
    if let Some(sample) = sample.filter(|name| safe_sample_name(name)) {
        let _ = std::fs::remove_file(samples_dir(&app)?.join(sample));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handle_is_reused_only_while_it_has_a_day_left() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-07T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(handle_is_fresh(Some("2026-10-09T12:00:00Z"), now));
        assert!(!handle_is_fresh(Some("2026-10-08T11:00:00Z"), now));
        assert!(!handle_is_fresh(Some("not a date"), now));
        assert!(!handle_is_fresh(None, now));
    }

    #[test]
    fn a_sample_name_never_leaves_its_directory() {
        assert!(safe_sample_name("3f2a.wav"));
        assert!(!safe_sample_name("../notes.db"));
        assert!(!safe_sample_name("a/b.wav"));
        assert!(!safe_sample_name("noextension"));
        assert!(!safe_sample_name(""));
    }

    #[test]
    fn an_extension_is_reduced_to_what_a_file_name_can_hold() {
        assert_eq!(normalized_extension(".M4A"), "m4a");
        assert_eq!(normalized_extension("wav/../x"), "wavx");
        assert_eq!(normalized_extension(""), "");
    }

    #[test]
    fn a_short_wav_is_kept_as_it_came_and_measured() {
        let dir = std::env::temp_dir().join(format!("cloned-voice-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Six seconds of silence, 16 kHz mono.
        let path = dir.join("source.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..(16_000 * 6) {
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let (kept, seconds) = keep_sample(&dir, "v1", &bytes, "wav").unwrap();
        assert_eq!(kept.file_name().unwrap(), "v1.wav");
        assert!((seconds - 6.0).abs() < 0.1, "measured {seconds}");
        assert!(!dir.join("v1.decoded.wav").exists());
        assert!(!dir.join("v1.incoming.wav").exists());
        assert!(keep_sample(&dir, "v2", b"not audio", "mp3").is_err());
        assert!(!dir.join("v2.incoming.mp3").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
