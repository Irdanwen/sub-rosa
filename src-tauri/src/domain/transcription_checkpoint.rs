//! The chunk loop of a single-source transcription, and the rows that let it
//! continue where it stopped (ADR-0071).
//!
//! A recording longer than one chunk is cut into fixed slices and transcribed
//! in order, each slice handed the text of the slices before it. On a phone
//! that loop is exactly what the system interrupts: the screen locks, iOS
//! suspends the app after its background window and may kill it later. When
//! the text lived only in this loop, the sweep that picked the note back up
//! started again at chunk zero and paid for every chunk a second time.
//!
//! Every finished chunk is now written to `transcription_chunks` before the
//! next one starts, and a run that finds rows for the same cut replays them
//! instead of asking again. A replayed chunk goes through the very same
//! bookkeeping as a fresh one, so the context the next chunk receives, and the
//! transcript the run returns, are identical to an uninterrupted run.
//!
//! The rows are best effort. A database that refuses a write costs a resume
//! its head start, never the transcription in progress.
//!
//! A child of `processing` (through `#[path]`) so it reaches the pipeline's
//! private helpers without widening them, and so the loop it took over stops
//! weighing on a file that sits against the size ratchet.

use super::*;
use sqlx::query::query;
use sqlx::row::Row as _;

/// Where a run keeps its chunks: the note they feed and the audio they cut.
pub(super) struct ChunkCheckpoint {
    pub(super) repos: Repositories,
    pub(super) note_id: String,
    pub(super) audio_artifact_id: String,
}

/// What one chunk came back as.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ChunkOutcome {
    /// The provider's reply, already trimmed. Possibly empty.
    Text {
        text: String,
        language: Option<String>,
        provider: String,
    },
    /// Judged silent locally, or reported as no speech by the provider.
    Silent,
}

/// Names the cut a set of rows belongs to. Two runs over the same prepared
/// audio with the same ceiling, model and language cut the same chunks in the
/// same order, so their rows are interchangeable. Anything else is not.
fn fingerprint(
    audio_path: &Path,
    max_chunk_ms: i64,
    chunk_count: usize,
    provider: &str,
    language: Option<&str>,
) -> String {
    let bytes = std::fs::metadata(audio_path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    format!(
        "v1|{bytes}|{max_chunk_ms}|{chunk_count}|{provider}|{}",
        language.unwrap_or("auto")
    )
}

impl ChunkCheckpoint {
    /// The chunks already finished for this cut. Rows left by a different cut
    /// are dropped on the way, since their indices no longer mean the same
    /// slice of audio.
    async fn load(&self, fingerprint: &str) -> HashMap<usize, ChunkOutcome> {
        let pool = &self.repos.pool;
        let stale = query(
            "DELETE FROM transcription_chunks WHERE audio_artifact_id = ?1 AND fingerprint != ?2",
        )
        .bind(&self.audio_artifact_id)
        .bind(fingerprint)
        .execute(pool)
        .await;
        if let Err(error) = stale {
            tracing::warn!(note_id = %self.note_id, error = %error, "could not drop stale transcription chunks");
        }
        let rows = match query(
            "SELECT chunk_index, outcome, text, language, provider FROM transcription_chunks
             WHERE audio_artifact_id = ?1 AND fingerprint = ?2",
        )
        .bind(&self.audio_artifact_id)
        .bind(fingerprint)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(note_id = %self.note_id, error = %error, "could not read transcription chunks");
                return HashMap::new();
            }
        };
        rows.into_iter()
            .filter_map(|row| {
                let index = usize::try_from(row.get::<i64, _>("chunk_index")).ok()?;
                let outcome = match row.get::<String, _>("outcome").as_str() {
                    "silent" => ChunkOutcome::Silent,
                    "text" => ChunkOutcome::Text {
                        text: row.get("text"),
                        language: row.get("language"),
                        provider: row.get("provider"),
                    },
                    _ => return None,
                };
                Some((index, outcome))
            })
            .collect()
    }

    async fn save(&self, fingerprint: &str, index: usize, outcome: &ChunkOutcome) {
        let (kind, text, language, provider) = match outcome {
            ChunkOutcome::Text {
                text,
                language,
                provider,
            } => (
                "text",
                text.as_str(),
                language.as_deref(),
                provider.as_str(),
            ),
            ChunkOutcome::Silent => ("silent", "", None, ""),
        };
        let written = query(
            "INSERT OR REPLACE INTO transcription_chunks
               (audio_artifact_id, chunk_index, note_id, fingerprint, outcome, text, language, provider, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(&self.audio_artifact_id)
        .bind(index as i64)
        .bind(&self.note_id)
        .bind(fingerprint)
        .bind(kind)
        .bind(text)
        .bind(language)
        .bind(provider)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.repos.pool)
        .await;
        if let Err(error) = written {
            tracing::warn!(note_id = %self.note_id, chunk = index, error = %error, "could not keep a transcription chunk");
        }
    }
}

/// Forget an artifact's chunks once the note they fed is ready. A later,
/// deliberate re-run of a finished note is asking for a fresh transcription,
/// not for the one it already has.
pub(super) async fn clear(repos: &Repositories, audio_artifact_id: &str) {
    if let Err(error) = query("DELETE FROM transcription_chunks WHERE audio_artifact_id = ?1")
        .bind(audio_artifact_id)
        .execute(&repos.pool)
        .await
    {
        tracing::warn!(error = %error, "could not clear transcription chunks");
    }
}

/// Transcribe `audio_paths` in order, each chunk with the text of the earlier
/// ones as context, replaying whatever `request.checkpoint` already holds.
pub(super) async fn transcribe_chunks(
    transcriber: TurnTranscriber,
    request: TranscribePreparedAudioRequest,
    audio_paths: Vec<PathBuf>,
    request_language: Option<String>,
) -> Result<TranscriptionProviderResult, AppError> {
    let progress = request
        .counts_toward_note_progress
        .then(|| Progress::for_note(&request.operation_id));
    if let Some(progress) = &progress {
        progress.phase(ProcessingPhase::Transcribing);
        progress.total(audio_paths.len() as i64);
    }
    let fingerprint = fingerprint(
        &request.audio_path,
        request.max_chunk_ms,
        audio_paths.len(),
        &request.provider,
        request_language.as_deref(),
    );
    let mut cached = match &request.checkpoint {
        Some(checkpoint) => checkpoint.load(&fingerprint).await,
        None => HashMap::new(),
    };
    if !cached.is_empty() {
        if let Some(progress) = &progress {
            progress.resumed(cached.len() as i64);
        }
        tracing::info!(
            operation_id = %request.operation_id,
            reused = cached.len(),
            total = audio_paths.len(),
            "resuming a transcription from its saved chunks"
        );
    }

    let mut previous = Vec::new();
    let mut text_parts = Vec::new();
    let mut language = None;
    let mut provider_name = request.provider.clone();
    for (index, audio_path) in audio_paths.into_iter().enumerate() {
        if let Some(progress) = &progress {
            progress.check()?;
        }
        let outcome = match cached.remove(&index) {
            Some(outcome) => outcome,
            None => {
                let outcome = transcribe_one(
                    &transcriber,
                    &request,
                    audio_path,
                    index,
                    &previous,
                    &request_language,
                )
                .await?;
                if let Some(checkpoint) = &request.checkpoint {
                    checkpoint.save(&fingerprint, index, &outcome).await;
                }
                outcome
            }
        };
        report_chunk_done(&progress, index);
        let ChunkOutcome::Text {
            text,
            language: chunk_language,
            provider,
        } = outcome
        else {
            continue;
        };
        if language.is_none() {
            language = chunk_language;
        }
        provider_name = provider;
        previous.push(SourceTranscriptInput {
            source: request.source.clone(),
            text: text.clone(),
            valid: !text.is_empty(),
            warning: None,
            start_ms: request.start_ms,
            end_ms: request.end_ms,
            turn_index: request.turn_index,
        });
        if !text.is_empty() {
            text_parts.push(text);
        }
    }

    if text_parts.is_empty() {
        // Every chunk was silent. Report it as a no-speech turn - exactly like a
        // single silent turn - so it stays a non-blocking failure rather than a
        // generic error that would fail the whole note.
        return Err(AppError::new("no_speech", "no_speech"));
    }
    Ok(TranscriptionProviderResult {
        text: text_parts.join("\n"),
        language,
        provider: provider_name,
    })
}

/// Ask the provider about one chunk that no earlier run finished.
async fn transcribe_one(
    transcriber: &TurnTranscriber,
    request: &TranscribePreparedAudioRequest,
    audio_path: PathBuf,
    index: usize,
    previous: &[SourceTranscriptInput],
    request_language: &Option<String>,
) -> Result<ChunkOutcome, AppError> {
    // Skip clearly-silent chunks before any API call. Fixed-size splitting of
    // a long (or fully silent) source leaves quiet boundary chunks, and each
    // request authorizes a credit hold that a no-speech response never
    // settles - so sending every silent chunk of a silent source would strand
    // holds until TTL and can trip `authorization_denied` on later work.
    if crate::audio::turns::source_is_effectively_silent(&audio_path) {
        return Ok(ChunkOutcome::Silent);
    }
    let context = merge_transcription_context(
        request.base_context.as_deref(),
        build_transcription_context(previous).as_deref(),
    );
    match transcribe_with_transient_retries(
        transcriber,
        TranscriptionRequest {
            provider: request.provider.clone(),
            audio_path,
            title: request.title.clone(),
            context,
            language: request_language.clone(),
            operation_id: Some(format!("{}-chunk-{index}", request.operation_id)),
            preview: false,
        },
    )
    .await
    {
        Ok(transcript) => Ok(ChunkOutcome::Text {
            text: transcript.text.trim().to_string(),
            language: transcript.language,
            provider: transcript.provider,
        }),
        // Backstop for a chunk the local silence check judged audible but the
        // provider still reports as no-speech: skip it so earlier chunks' text
        // survives, rather than aborting and dropping the whole turn.
        Err(error) if is_no_speech_error(&error) => Ok(ChunkOutcome::Silent),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "transcription_checkpoint_tests.rs"]
mod tests;
