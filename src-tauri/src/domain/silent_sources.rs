//! Silent computer lanes, decided before any paid work.
//!
//! A child of `processing` (`#[path]`), so the pipeline and its tests keep
//! reaching these items as they did when they lived in `processing.rs`.

use crate::{
    db::repositories::Repositories,
    domain::types::{AppError, RecordingSource},
};
use std::path::PathBuf;

pub(super) struct DroppedSource {
    pub(super) artifact_id: String,
    pub(super) source: String,
    pub(super) max_rms: f32,
}

pub(super) struct SilentSystemDropOutcome {
    pub(super) kept: Vec<(String, String, PathBuf)>,
    pub(super) dropped: Vec<DroppedSource>,
    /// The take's only lane is a computer that made no sound. Kept in `kept`
    /// so nothing upstream changes shape, and reported here so the pipeline
    /// stops before transcribing silence it would be billed for.
    pub(super) only_source_silent: Option<DroppedSource>,
}

/// Remove system-audio sources whose track is effectively silent, but only when
/// another source remains to carry the recording. A lone silent system source
/// is kept and reported in `only_source_silent` instead.
///
/// A system track counts as silent only below what the system lane's turn
/// detection could still find (`SYSTEM_DETECTION_MIN_RMS`). A higher floor
/// would strand quiet-but-real tracks before the full-source fallback ever runs,
/// transcribing mic-only.
pub(super) fn partition_silent_system_sources(
    sources: Vec<(String, String, PathBuf)>,
) -> SilentSystemDropOutcome {
    let system = RecordingSource::System.as_db();
    let has_other_source = sources
        .iter()
        .any(|(_, source, _)| source.as_str() != system);
    if !has_other_source {
        let only_source_silent = match sources.as_slice() {
            [(artifact_id, source, path)] => {
                silent_system_rms(source, path).map(|max_rms| DroppedSource {
                    artifact_id: artifact_id.clone(),
                    source: source.clone(),
                    max_rms,
                })
            }
            _ => None,
        };
        return SilentSystemDropOutcome {
            kept: sources,
            dropped: Vec::new(),
            only_source_silent,
        };
    }
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for (artifact_id, source, path) in sources {
        if let Some(max_rms) = silent_system_rms(&source, &path) {
            tracing::info!(
                %source,
                path = %path.display(),
                max_rms,
                "skipping silent system source — no transcribable audio"
            );
            dropped.push(DroppedSource {
                artifact_id,
                source,
                max_rms,
            });
        } else {
            kept.push((artifact_id, source, path));
        }
    }
    SilentSystemDropOutcome {
        kept,
        dropped,
        only_source_silent: None,
    }
}

/// The loudest RMS of a system track that falls below the detection floor;
/// `None` for any other source, a track with sound, or one that cannot be
/// read (an unreadable file is kept, as it always was).
fn silent_system_rms(source: &str, path: &std::path::Path) -> Option<f32> {
    if source != RecordingSource::System.as_db() {
        return None;
    }
    crate::audio::turns::source_max_rms(path)
        .filter(|rms| *rms < crate::audio::turns::SYSTEM_DETECTION_MIN_RMS)
}

/// Leaves the trail a dropped lane leaves, and answers the error the note
/// fails with: the computer played nothing, so there is nothing to
/// transcribe and nothing to pay for.
pub(super) async fn fail_silent_computer_take(
    repos: &Repositories,
    session_id: &str,
    silent: &DroppedSource,
) -> Result<AppError, AppError> {
    repos
        .add_source_checkpoint(
            session_id,
            Some(silent.artifact_id.as_str()),
            Some(silent.source.as_str()),
            "silent_source_dropped",
            Some(
                serde_json::json!({
                    "source": silent.source,
                    "maxRms": silent.max_rms,
                    "onlySource": true,
                })
                .to_string(),
            ),
        )
        .await?;
    Ok(AppError::new(
        "system_audio_silent",
        "The computer played no sound during this recording, so there is nothing to transcribe. Check that the call or video plays on this computer, then record again.",
    ))
}
