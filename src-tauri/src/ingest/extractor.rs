//! The third rail: a platform page, through an extractor the user installed
//! themselves (ADR-0028).
//!
//! Nothing here is bundled, downloaded, installed or updated by this app. It
//! looks for `yt-dlp` where a person would have put it, and it only looks at
//! all once the user has switched the rail on. When it is absent the app says
//! what it *can* do instead of failing with a stack trace.
//!
//! Two things make this worth having beyond "it downloads the audio":
//!
//! - **Captions first.** If the source publishes captions, they are taken and
//!   nothing is transcribed: no cost, and the cues carry their own times, so
//!   the chapters are timestamped anyway.
//! - **A stream the decoder can open, without converting it.** Symphonia
//!   cannot read Opus
//!   ([ADR-0026](../../../docs/adr/0026-imported-media-is-decoded-in-process.md)),
//!   which is what these platforms serve by default, so this is the one path
//!   where the app gets to pick. It picks with a *format selector* rather than
//!   `-x --audio-format`, because that flag converts, and converting needs
//!   ffmpeg — which this app does not ship and the user may not have. The rail
//!   must depend on the extractor and nothing else.
//!
//! Desktop only, and not by omission: iOS cannot execute a bundled binary, let
//! alone one the user installed elsewhere.

#![cfg(desktop)]

use crate::domain::types::AppError;
use std::path::{Path, PathBuf};

/// Where a person actually installs `yt-dlp`, beyond whatever `PATH` says.
/// Checked in order; `PATH` wins when it has one.
const COMMON_PATHS: &[&str] = &[
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/opt/local/bin/yt-dlp",
];

/// How long an extraction may run. A three-hour talk over a slow link is
/// legitimately slow; a hung process is not.
const EXTRACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Settings for the rail. Off until the user says otherwise, because
/// switching it on is a statement about what they want their machine doing.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractorSettings {
    pub enabled: bool,
}

/// Beside `memory.json` in the app config dir, for the same reason: this is a
/// non-secret toggle, not something the keychain should hold.
fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("ingest.json"))
}

pub fn settings(app: &tauri::AppHandle) -> ExtractorSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &tauri::AppHandle, settings: &ExtractorSettings) -> Result<(), AppError> {
    let path = settings_path(app).ok_or_else(|| {
        AppError::new("ingest_settings_failed", "No config directory to write to.")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("ingest_settings_failed", error.to_string()))?;
    }
    let body = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("ingest_settings_failed", error.to_string()))?;
    std::fs::write(&path, body)
        .map_err(|error| AppError::new("ingest_settings_failed", error.to_string()))?;
    Ok(())
}

/// The extractor on this machine, if there is one.
pub fn find_extractor() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(if cfg!(windows) {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    COMMON_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

/// What the settings surface shows: whether the rail is on, and whether the
/// tool it needs is actually there.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorStatus {
    pub enabled: bool,
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn ingest_extractor_status(app: tauri::AppHandle) -> Result<ExtractorStatus, AppError> {
    let settings = settings(&app);
    let path = find_extractor();
    let version = path.as_ref().and_then(|path| extractor_version(path));
    Ok(ExtractorStatus {
        enabled: settings.enabled,
        available: path.is_some(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
        version,
    })
}

#[tauri::command]
pub async fn ingest_set_extractor_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<ExtractorStatus, AppError> {
    save_settings(&app, &ExtractorSettings { enabled })?;
    ingest_extractor_status(app).await
}

fn extractor_version(path: &Path) -> Option<String> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Whether the rail can be used right now: switched on *and* installed.
pub fn is_usable(app: &tauri::AppHandle) -> bool {
    settings(app).enabled && find_extractor().is_some()
}

/// What an extraction produced.
#[derive(Debug, Clone)]
pub struct Extracted {
    pub audio_path: PathBuf,
    pub title: Option<String>,
    /// Published captions, when the source had any. Their presence is what
    /// makes an extraction cost nothing to transcribe.
    pub cues: Vec<super::vtt::Cue>,
}

/// Run the extractor over `url`, into `work_dir`.
///
/// One process, one pass: audio as M4A plus captions if the source has them.
/// Everything is written under `work_dir`, which the caller owns and cleans.
pub async fn extract(
    app: &tauri::AppHandle,
    url: &str,
    work_dir: &Path,
) -> Result<Extracted, AppError> {
    if !settings(app).enabled {
        return Err(AppError::new(
            "ingest_extractor_disabled",
            "Fetching from streaming platforms is switched off. Turn it on in Settings if you have yt-dlp installed.",
        ));
    }
    let Some(extractor) = find_extractor() else {
        return Err(AppError::new(
            "ingest_extractor_missing",
            "yt-dlp is not installed on this machine. Install it, or download the audio yourself and drop the file in.",
        ));
    };
    std::fs::create_dir_all(work_dir)
        .map_err(|error| AppError::new("ingest_extract_failed", error.to_string()))?;

    let output_template = work_dir.join("media.%(ext)s");
    let mut command = tokio::process::Command::new(&extractor);
    command
        .arg("--no-playlist")
        .arg("--no-progress")
        .arg("--no-warnings")
        // Pick an audio stream the decoder can already open, rather than
        // asking for a conversion. `-x --audio-format m4a` would be tidier and
        // needs **ffmpeg**, which this app deliberately does not ship and the
        // user may well not have — the whole point of this rail is that it
        // depends on nothing beyond the extractor itself. A format selector
        // downloads a stream as published: M4A/AAC first (Symphonia reads it),
        // MP3 next, and anything audio-only as a last resort. Opus is what
        // these platforms serve by default and is the one thing the decoder
        // cannot read (ADR-0026), so it is asked for last and falls back to
        // the whole-file path if it is all there is.
        .arg("-f")
        .arg("bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[acodec^=mp4a]/bestaudio")
        // Captions when they exist, automatic ones when they do not. Free is
        // better than paid, and cues carry their own times. `vtt/best` rather
        // than a conversion, for the same ffmpeg reason.
        .arg("--write-subs")
        .arg("--write-auto-subs")
        .arg("--sub-format")
        .arg("vtt/best")
        .arg("-o")
        .arg(&output_template)
        .arg(url)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // No console window on Windows, like every other child this app spawns.
        command.creation_flags(0x0800_0000);
    }

    let output = tokio::time::timeout(EXTRACT_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            AppError::new(
                "ingest_extract_failed",
                "The extractor took too long and was stopped.",
            )
        })?
        .map_err(|error| AppError::new("ingest_extract_failed", error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::new(
            "ingest_extract_failed",
            extractor_failure_message(&String::from_utf8_lossy(&output.stderr)),
        ));
    }

    let produced = collect_outputs(work_dir)?;
    Ok(produced)
}

/// yt-dlp's stderr is long and mostly noise. Say the one line that matters.
fn extractor_failure_message(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("ERROR:") || line.contains("Unsupported URL"))
        .unwrap_or("");
    let line = line.trim_start_matches("ERROR:").trim();
    if line.is_empty() {
        return "The extractor could not read that link.".to_string();
    }
    if line.contains("Private video") || line.contains("members-only") {
        return "That video is private.".to_string();
    }
    if line.contains("Sign in") || line.contains("age") {
        return "That video needs a signed-in account, which this app does not have.".to_string();
    }
    if line.contains("Unsupported URL") {
        return "The extractor does not know that site.".to_string();
    }
    format!("The extractor could not read that link: {line}")
}

/// Pick the audio file and the best caption file out of what the extractor
/// wrote. It names them from a template, so this is a directory listing rather
/// than a guess at its output.
fn collect_outputs(work_dir: &Path) -> Result<Extracted, AppError> {
    let mut audio_path: Option<PathBuf> = None;
    let mut caption_paths: Vec<PathBuf> = Vec::new();
    let entries = std::fs::read_dir(work_dir)
        .map_err(|error| AppError::new("ingest_extract_failed", error.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        match extension.as_str() {
            "vtt" | "srt" => caption_paths.push(path),
            "part" | "ytdl" | "json" => {}
            // The first non-caption file is the audio: the template names it,
            // and yt-dlp cleans up its intermediates before exiting.
            _ if path.is_file() && audio_path.is_none() => audio_path = Some(path),
            _ => {}
        }
    }
    let audio_path = audio_path.ok_or_else(|| {
        AppError::new(
            "ingest_extract_failed",
            "The extractor produced no audio for that link.",
        )
    })?;

    // Prefer a hand-written caption track over an automatic one: yt-dlp names
    // automatic tracks with an `.orig` or a language it invented, and a real
    // track is always the better read.
    caption_paths.sort_by_key(|path| {
        let name = path.to_string_lossy().to_ascii_lowercase();
        (name.contains("auto"), name.len())
    });
    let cues = caption_paths
        .iter()
        .find_map(|path| {
            let body = std::fs::read_to_string(path).ok()?;
            super::vtt::parse_cues(&body).ok()
        })
        .unwrap_or_default();

    let title = audio_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| *stem != "media")
        .map(str::to_string);

    Ok(Extracted {
        audio_path,
        title,
        cues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("os-june-extract-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn picks_the_audio_and_the_hand_written_captions_out_of_the_output() {
        let dir = scratch("outputs");
        std::fs::write(dir.join("media.m4a"), b"not really audio").unwrap();
        std::fs::write(
            dir.join("media.en.vtt"),
            "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHand written.\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("media.en-auto.vtt"),
            "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nAutomatic.\n",
        )
        .unwrap();

        let extracted = collect_outputs(&dir).unwrap();

        assert!(extracted.audio_path.ends_with("media.m4a"));
        assert_eq!(extracted.cues.len(), 1);
        assert_eq!(extracted.cues[0].text, "Hand written.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_extraction_with_no_captions_is_fine_and_simply_has_none() {
        let dir = scratch("no-captions");
        std::fs::write(dir.join("media.m4a"), b"x").unwrap();

        let extracted = collect_outputs(&dir).unwrap();

        assert!(extracted.cues.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_extraction_with_no_audio_at_all_is_an_error() {
        let dir = scratch("no-audio");
        std::fs::write(dir.join("media.en.vtt"), "WEBVTT\n").unwrap();

        assert_eq!(
            collect_outputs(&dir).unwrap_err().code,
            "ingest_extract_failed"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_failure_message_says_the_one_line_that_matters() {
        assert_eq!(
            extractor_failure_message(
                "[debug] noise\nERROR: Private video. Sign in if you've been granted access"
            ),
            "That video is private."
        );
        assert_eq!(
            extractor_failure_message("ERROR: Unsupported URL: https://example.com/x"),
            "The extractor does not know that site."
        );
        assert_eq!(
            extractor_failure_message("nothing useful here"),
            "The extractor could not read that link."
        );
    }
}
