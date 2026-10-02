//! Tests for [`super`]: an interrupted transcription resumes at the chunk it
//! stopped on, and the run it resumes into is indistinguishable from one that
//! was never interrupted.

use super::*;
use std::sync::Mutex;

const CHUNK_SAMPLES: usize = 16_000 * 30;

/// `(chunk index, context)` for every request that reached the provider.
type Calls = Arc<Mutex<Vec<(usize, Option<String>)>>>;

async fn repos_with_note() -> (Repositories, String) {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    let repos = Repositories::new(pool);
    let note = repos.create_note(None).await.unwrap();
    (repos, note.id)
}

/// A 16 kHz mono WAV of `segments` 30-second chunks, `true` meaning audible.
fn chunked_wav(dir: &Path, segments: &[bool]) -> PathBuf {
    let path = dir.join("prepared.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec).unwrap();
    for audible in segments {
        let amplitude: i16 = if *audible { 20_000 } else { 0 };
        for index in 0..CHUNK_SAMPLES {
            writer
                .write_sample(if index % 2 == 0 {
                    amplitude
                } else {
                    -amplitude
                })
                .unwrap();
        }
    }
    writer.finalize().unwrap();
    path
}

fn chunk_index(request: &TranscriptionRequest) -> usize {
    request
        .operation_id()
        .rsplit("-chunk-")
        .next()
        .and_then(|index| index.parse().ok())
        .expect("a chunk request names its index")
}

/// A provider that answers "words of chunk N", reports `no_speech_at` as
/// silent, and fails every chunk from `fail_from` on, recording each call.
fn provider(
    calls: &Calls,
    fail_from: Option<usize>,
    no_speech_at: Option<usize>,
) -> TurnTranscriber {
    let calls = Arc::clone(calls);
    Arc::new(move |request: TranscriptionRequest| {
        let calls = Arc::clone(&calls);
        Box::pin(async move {
            let index = chunk_index(&request);
            calls.lock().unwrap().push((index, request.context.clone()));
            if Some(index) == no_speech_at {
                return Err(AppError::new("no_speech", "no_speech"));
            }
            if fail_from.is_some_and(|from| index >= from) {
                return Err(AppError::new(
                    "upstream_provider_failed",
                    "the line dropped",
                ));
            }
            Ok(TranscriptionProviderResult {
                text: format!("words of chunk {index}"),
                language: Some("fr".to_string()),
                provider: "test".to_string(),
            })
        }) as TranscriptionFuture
    }) as TurnTranscriber
}

fn request(
    repos: &Repositories,
    note_id: &str,
    artifact_id: &str,
    audio_path: PathBuf,
    temp_dir: &Path,
    provider: &str,
) -> TranscribePreparedAudioRequest {
    TranscribePreparedAudioRequest {
        provider: provider.to_string(),
        audio_path,
        temp_dir: temp_dir.join(artifact_id),
        chunk_stem: artifact_id.to_string(),
        title: "Meeting".to_string(),
        base_context: Some("Dictionary: Sub Rosa".to_string()),
        operation_id: note_id.to_string(),
        source: "microphone".to_string(),
        start_ms: None,
        end_ms: None,
        turn_index: None,
        max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
        counts_toward_note_progress: false,
        checkpoint: Some(ChunkCheckpoint {
            repos: repos.clone(),
            note_id: note_id.to_string(),
            audio_artifact_id: artifact_id.to_string(),
        }),
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("os-june-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn a_resumed_run_asks_only_for_the_missing_chunks_with_the_same_context() {
    let (repos, note_id) = repos_with_note().await;
    let dir = scratch("checkpoint-resume");
    let audio = chunked_wav(&dir, &[true, true, true, true]);

    // The reference: the same audio, never interrupted.
    let reference_calls = Calls::default();
    let reference = transcribe_prepared_audio(
        provider(&reference_calls, None, None),
        request(
            &repos,
            &note_id,
            "reference",
            audio.clone(),
            &dir,
            "model-a",
        ),
    )
    .await
    .expect("an uninterrupted run transcribes");

    // The phone locks during chunk 2: chunks 0 and 1 landed, 2 failed.
    let first_calls = Calls::default();
    transcribe_prepared_audio(
        provider(&first_calls, Some(2), None),
        request(&repos, &note_id, "artifact", audio.clone(), &dir, "model-a"),
    )
    .await
    .expect_err("the interrupted run fails");

    let resumed_calls = Calls::default();
    let resumed = transcribe_prepared_audio(
        provider(&resumed_calls, None, None),
        request(&repos, &note_id, "artifact", audio, &dir, "model-a"),
    )
    .await
    .expect("the resumed run finishes");

    let resumed_calls = resumed_calls.lock().unwrap().clone();
    assert_eq!(
        resumed_calls
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        vec![2, 3],
        "chunks already transcribed are neither asked for nor paid for again"
    );
    let reference_calls = reference_calls.lock().unwrap().clone();
    assert_eq!(
        resumed_calls,
        reference_calls[2..].to_vec(),
        "the resumed chunks see exactly the context an uninterrupted run gives them"
    );
    assert_eq!(resumed, reference);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn silent_chunks_are_remembered_as_silent() {
    let (repos, note_id) = repos_with_note().await;
    let dir = scratch("checkpoint-silent");
    // Chunk 1 is silent locally, chunk 2 is "no speech" according to the
    // provider, chunk 3 is where the run breaks.
    let audio = chunked_wav(&dir, &[true, false, true, true]);

    let first_calls = Calls::default();
    transcribe_prepared_audio(
        provider(&first_calls, Some(3), Some(2)),
        request(&repos, &note_id, "artifact", audio.clone(), &dir, "model-a"),
    )
    .await
    .expect_err("the interrupted run fails");
    assert_eq!(
        first_calls
            .lock()
            .unwrap()
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        vec![0, 2, 3],
        "the locally silent chunk never reached the provider"
    );

    let resumed_calls = Calls::default();
    let resumed = transcribe_prepared_audio(
        provider(&resumed_calls, None, None),
        request(&repos, &note_id, "artifact", audio, &dir, "model-a"),
    )
    .await
    .expect("the resumed run finishes");

    assert_eq!(
        resumed_calls
            .lock()
            .unwrap()
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        vec![3],
        "a chunk the provider called empty is not asked about twice"
    );
    assert_eq!(resumed.text, "words of chunk 0\nwords of chunk 3");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_different_cut_starts_again_from_the_first_chunk() {
    let (repos, note_id) = repos_with_note().await;
    let dir = scratch("checkpoint-fingerprint");
    let audio = chunked_wav(&dir, &[true, true, true]);

    transcribe_prepared_audio(
        provider(&Calls::default(), Some(2), None),
        request(&repos, &note_id, "artifact", audio.clone(), &dir, "model-a"),
    )
    .await
    .expect_err("the interrupted run fails");

    // The user switched transcription model before retrying: the chunks of
    // the old model are not this run's chunks.
    let calls = Calls::default();
    transcribe_prepared_audio(
        provider(&calls, None, None),
        request(&repos, &note_id, "artifact", audio, &dir, "model-b"),
    )
    .await
    .expect("the run with the new model finishes");

    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_finished_note_leaves_no_chunks_behind() {
    let (repos, note_id) = repos_with_note().await;
    let dir = scratch("checkpoint-clear");
    let audio = chunked_wav(&dir, &[true, true, true]);

    transcribe_prepared_audio(
        provider(&Calls::default(), Some(2), None),
        request(&repos, &note_id, "artifact", audio.clone(), &dir, "model-a"),
    )
    .await
    .expect_err("the interrupted run fails");
    clear(&repos, "artifact").await;

    // A deliberate re-run of a finished note transcribes afresh.
    let calls = Calls::default();
    transcribe_prepared_audio(
        provider(&calls, None, None),
        request(&repos, &note_id, "artifact", audio, &dir, "model-a"),
    )
    .await
    .expect("the re-run finishes");
    assert_eq!(calls.lock().unwrap().len(), 3);
    let _ = std::fs::remove_dir_all(dir);
}
