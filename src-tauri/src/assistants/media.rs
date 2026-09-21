//! A model can prepare a generation, but only the native UI command can buy it.
//! A compare-and-set consumes each proposal once, BEFORE the network request.
//! An interrupted submission is uncertain, never automatically submitted again.
use crate::carpe_diem::{jobs, media};
use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{query::query, row::Row};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "subrosa://assistant-media";
static LIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn live() -> std::sync::MutexGuard<'static, HashSet<String>> {
    LIVE.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaProposal {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub model: String,
    pub prompt: String,
    pub parameters: Value,
    pub cost_credits: Option<f64>,
    pub status: String,
    pub queue_id: Option<String>,
    pub artifact_file_name: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    backend: String,
}

fn invalid() -> AppError {
    AppError::new(
        "assistant_media_invalid",
        "Choose a supported model and generation settings.",
    )
}

fn family(kind: &str) -> Option<&'static str> {
    match kind {
        "image" => Some("image"),
        "edit" => Some("imageEdit"),
        "upscale" => Some("upscale"),
        "video" => Some("video"),
        "music" => Some("music"),
        "speech" => Some("tts"),
        _ => None,
    }
}

/// Only data settings can enter the persisted request. No endpoint, credential,
/// arbitrary image URL, output path or tool argument is accepted here.
fn parameters(kind: &str, input: &Value) -> Result<Value, AppError> {
    let mut out = serde_json::Map::new();
    if !input.is_null() && !input.is_object() {
        return Err(invalid());
    }
    if let Some(input) = input.as_object() {
        for (key, value) in input {
            let valid = match (kind, key.as_str()) {
                ("image", "width" | "height") => value
                    .as_u64()
                    .is_some_and(|v| (256..=2048).contains(&v) && v % 64 == 0),
                ("image", "seed") => value.as_u64().is_some_and(|v| v <= u32::MAX as u64),
                ("image" | "video", "aspect_ratio") => value.as_str().is_some_and(|v| {
                    matches!(
                        v,
                        "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "21:9"
                    )
                }),
                ("video", "duration" | "resolution") => value.as_str().is_some_and(|v| {
                    !v.is_empty()
                        && v.len() <= 20
                        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
                }),
                ("music", "duration_seconds") => {
                    value.as_f64().is_some_and(|v| (1.0..=300.0).contains(&v))
                }
                ("music", "force_instrumental") => value.is_boolean(),
                ("music", "lyrics_prompt") => value.as_str().is_some_and(|v| v.len() <= 5000),
                ("speech", "voice") => value
                    .as_str()
                    .is_some_and(|v| !v.is_empty() && v.len() <= 100),
                ("speech", "speed") => value.as_f64().is_some_and(|v| (0.25..=4.0).contains(&v)),
                ("edit" | "upscale", "reference_id") => value
                    .as_str()
                    .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok()),
                ("upscale", "scale") => value.as_u64().is_some_and(|v| (2..=4).contains(&v)),
                _ => false,
            };
            if !valid {
                return Err(invalid());
            }
            out.insert(key.clone(), value.clone());
        }
    }
    if matches!(kind, "edit" | "upscale") && !out.contains_key("reference_id") {
        return Err(invalid());
    }
    Ok(Value::Object(out))
}

fn select_model<'a>(
    models: &'a [media::MediaModelDto],
    kind: &str,
    requested: &str,
) -> Result<&'a media::MediaModelDto, AppError> {
    let family = family(kind).ok_or_else(invalid)?;
    let candidates = models.iter().filter(|m| {
        !m.offline
            && m.media_type == family
            && (kind != "video" || super::media_settings::prompt_video(&m.id))
    });
    if requested.is_empty() {
        candidates
            .min_by(|a, b| {
                a.cost_credits
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(&b.cost_credits.unwrap_or(f64::INFINITY))
            })
            .ok_or_else(invalid)
    } else {
        candidates
            .into_iter()
            .find(|m| m.id == requested)
            .ok_or_else(invalid)
    }
}

/// Called exclusively by the restricted assistant tool dispatcher.
pub async fn propose(app: &AppHandle, task_id: &str, args: &Value) -> Result<Value, AppError> {
    let kind = args["kind"].as_str().ok_or_else(invalid)?;
    family(kind).ok_or_else(invalid)?;
    let definition = super::runtime::session_definition(app, task_id).await?;
    let permission = if matches!(kind, "edit" | "upscale") {
        "image"
    } else {
        kind
    };
    if !definition.tools.iter().any(|tool| tool == permission) {
        return Err(invalid());
    }
    let prompt = args["prompt"].as_str().unwrap_or("").trim();
    if (prompt.is_empty() && kind != "upscale") || prompt.len() > 5000 {
        return Err(invalid());
    }
    let mut params = parameters(kind, &args["parameters"])?;
    let catalog = media::carpe_diem_media_catalog().await?;
    let model = select_model(&catalog.models, kind, args["model"].as_str().unwrap_or(""))?;
    super::media_settings::prepare(kind, &model.id, model.constraints.as_ref(), &mut params)?;
    if kind == "speech" {
        if let Some(voice) = params["voice"].as_str() {
            if !model.voices.is_empty() && !model.voices.iter().any(|v| v == voice) {
                return Err(invalid());
            }
        } else if let Some(voice) = model.voices.first() {
            params["voice"] = json!(voice);
        }
    }
    let repos = crate::commands::repositories(app).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO assistant_media (id,task_id,kind,model,prompt,parameters,backend,cost_credits,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(task_id).bind(kind).bind(&model.id).bind(prompt).bind(params.to_string())
        .bind(&catalog.backend).bind(model.cost_credits).bind(&now).bind(&now).execute(&repos.pool).await?;
    let _ = app.emit(EVENT, &id);
    Ok(
        json!({"proposal_id":id,"status":"proposed","message":"Show this proposal. Only the user's Generate button can start it.","block":format!("```subrosa:media\n{}\n```", json!({"v":1,"proposalId":id}))}),
    )
}

fn row(r: sqlx_sqlite::SqliteRow) -> MediaProposal {
    MediaProposal {
        id: r.get("id"),
        task_id: r.get("task_id"),
        kind: r.get("kind"),
        model: r.get("model"),
        prompt: r.get("prompt"),
        parameters: serde_json::from_str(r.get::<&str, _>("parameters")).unwrap_or(Value::Null),
        backend: r.get("backend"),
        cost_credits: r.get("cost_credits"),
        status: r.get("status"),
        queue_id: r.get("queue_id"),
        artifact_file_name: r.get("artifact_file_name"),
        error: r.get("error"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

#[tauri::command]
pub async fn assistant_media_list(
    app: AppHandle,
    task_id: String,
) -> Result<Vec<MediaProposal>, AppError> {
    reconcile(&app).await?;
    let repos = crate::commands::repositories(&app).await?;
    Ok(
        query("SELECT * FROM assistant_media WHERE task_id=? ORDER BY created_at")
            .bind(task_id)
            .fetch_all(&repos.pool)
            .await?
            .into_iter()
            .map(row)
            .collect(),
    )
}

#[tauri::command]
pub async fn assistant_media_get(app: AppHandle, id: String) -> Result<MediaProposal, AppError> {
    reconcile(&app).await?;
    load(&app, &id).await
}

async fn load(app: &AppHandle, id: &str) -> Result<MediaProposal, AppError> {
    let repos = crate::commands::repositories(app).await?;
    query("SELECT * FROM assistant_media WHERE id=?")
        .bind(id)
        .fetch_optional(&repos.pool)
        .await?
        .map(row)
        .ok_or_else(|| {
            AppError::new(
                "assistant_media_missing",
                "This generation is not available on this device.",
            )
        })
}

// This durable transition is the only admission to a paid submission. It
// remains single-use across competing callers and process restarts.
async fn claim(pool: &sqlx_sqlite::SqlitePool, id: &str) -> Result<bool, AppError> {
    Ok(query("UPDATE assistant_media SET status='submitting',updated_at=? WHERE id=? AND status='proposed'")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected() == 1)
}

#[tauri::command]
pub async fn assistant_media_execute(
    app: AppHandle,
    id: String,
) -> Result<MediaProposal, AppError> {
    let proposal = load(&app, &id).await?;
    if proposal.status != "proposed" {
        return Ok(proposal);
    }
    // Applying a new assistant revision uses this same claim. Keep its
    // permissions stable until the durable paid submission is admitted.
    let _turn_claim = crate::agent_lite::TurnClaim::try_hold(&proposal.task_id)
        .ok_or_else(|| AppError::new("agent_lite_running", "This chat is already running."))?;
    let definition = super::runtime::session_definition(&app, &proposal.task_id).await?;
    let permission = if matches!(proposal.kind.as_str(), "edit" | "upscale") {
        "image"
    } else {
        &proposal.kind
    };
    if !definition.tools.iter().any(|tool| tool == permission) {
        return Err(invalid());
    }
    let repos = crate::commands::repositories(&app).await?;
    let inserted = live().insert(id.clone());
    if !inserted {
        return load(&app, &id).await;
    }
    // Claim even concurrent clicks atomically before a single paid byte leaves.
    let claimed = match claim(&repos.pool, &id).await {
        Ok(value) => value,
        Err(error) => {
            live().remove(&id);
            return Err(error);
        }
    };
    if claimed {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _background = crate::ios_background::BackgroundTask::begin("assistant-media");
            if let Err(error) = submit(&app, &proposal).await {
                // A known provider id is recoverable: never demote a queued
                // job when only its local handoff failed.
                let queued = load(&app, &proposal.id)
                    .await
                    .is_ok_and(|p| p.queue_id.is_some());
                if !queued {
                    let _ = settle(&app, &proposal.id, "uncertain", Some(&error.message)).await;
                }
            }
            live().remove(&proposal.id);
            let _ = app.emit(EVENT, &proposal.id);
        });
    } else {
        live().remove(&id);
    }
    load(&app, &id).await
}

async fn request(path: &str, body: Value) -> Result<media::MediaResponseDto, AppError> {
    media::carpe_diem_media_request(media::MediaRequestDto {
        method: "POST".into(),
        path: path.into(),
        body: Some(body),
    })
    .await
}

fn route(p: &MediaProposal) -> (&'static str, &'static str, &'static str) {
    match p.kind.as_str() {
        "image" if p.backend == "venice" => ("/image/generate", "", "png"),
        "edit" if p.backend == "venice" => ("/image/edit", "", "png"),
        "image" => ("/image/generate/queue", "/image/generate/retrieve", "png"),
        "edit" => ("/image/edit/queue", "/image/edit/retrieve", "png"),
        "video" => ("/video/queue", "/video/retrieve", "mp4"),
        "music" if p.backend == "carpe-diem" => {
            ("/audio/music/queue", "/audio/music/retrieve", "mp3")
        }
        "music" => ("/audio/queue", "/audio/retrieve", "mp3"),
        "speech" => ("/audio/speech", "", "mp3"),
        _ => ("/image/upscale", "", "png"),
    }
}

async fn submit(app: &AppHandle, p: &MediaProposal) -> Result<(), AppError> {
    let mut body = p.parameters.clone();
    body["model"] = json!(p.model);
    if p.kind == "speech" {
        body["input"] = json!(p.prompt);
        body["response_format"] = json!("mp3");
    } else if p.kind != "upscale" {
        body["prompt"] = json!(p.prompt);
    }
    if p.kind == "image" {
        body["variants"] = json!(1);
        body["format"] = json!("png");
    }
    if matches!(p.kind.as_str(), "edit" | "upscale") {
        let reference = body["reference_id"]
            .as_str()
            .ok_or_else(invalid)?
            .to_string();
        body.as_object_mut()
            .ok_or_else(invalid)?
            .remove("reference_id");
        let data = snapshot_image(app, &p.task_id, &reference).await?;
        body["image"] = json!(if p.kind == "upscale" {
            data.split_once(',')
                .map_or(data.as_str(), |(_, b)| b)
                .to_string()
        } else {
            data
        });
        if p.kind == "upscale" && body.get("scale").is_none() {
            body["scale"] = json!(2);
        }
    }
    let (path, _, extension) = route(p);
    let response = request(path, body).await?;
    if !response.ok {
        // A transport/server failure cannot prove the provider did not bill.
        let status = if (400..500).contains(&response.status) {
            "failed"
        } else {
            "uncertain"
        };
        return settle(
            app,
            &p.id,
            status,
            Some(&format!(
                "Generation request returned status {}.",
                response.status
            )),
        )
        .await;
    }
    let inline = response.body_base64.or_else(|| {
        response
            .json
            .as_ref()
            .and_then(media::image_result)
            .map(str::to_owned)
    });
    if let Some(base64) = inline {
        let artifact = media::carpe_diem_media_save_artifact(
            app.clone(),
            media::SaveArtifactRequest {
                base64,
                extension: extension.into(),
            },
        )
        .await?;
        let repos = crate::commands::repositories(app).await?;
        query("UPDATE assistant_media SET status='completed',artifact_file_name=?,updated_at=? WHERE id=?")
            .bind(artifact.file_name).bind(chrono::Utc::now().to_rfc3339()).bind(&p.id).execute(&repos.pool).await?;
        return Ok(());
    }
    let payload = response.json.ok_or_else(invalid)?;
    let queue = payload["queue_id"]
        .as_str()
        .or_else(|| payload["id"].as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let repos = crate::commands::repositories(app).await?;
    // Persist the provider id before handing off. A crash here only repeats the free poll.
    query("UPDATE assistant_media SET status='queued',queue_id=?,updated_at=? WHERE id=?")
        .bind(queue)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&p.id)
        .execute(&repos.pool)
        .await?;
    let mut queued = p.clone();
    queued.queue_id = Some(queue.into());
    handoff(app, &queued).await
}

async fn snapshot_image(
    app: &AppHandle,
    task_id: &str,
    reference_id: &str,
) -> Result<String, AppError> {
    use base64::Engine;
    let repos = crate::commands::repositories(app).await?;
    let snapshot = super::runtime::snapshot_for_task(&repos.pool, task_id)
        .await?
        .ok_or_else(invalid)?;
    let reference = snapshot
        .references
        .iter()
        .find(|r| r.id == reference_id)
        .ok_or_else(invalid)?;
    let mime = match reference.format.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return Err(invalid()),
    };
    let path = super::reference_file(
        &super::references_dir(app)?,
        reference.file_name.as_deref().ok_or_else(invalid)?,
    )?;
    if tokio::fs::metadata(&path)
        .await
        .map_err(|_| invalid())?
        .len()
        > 20 * 1024 * 1024
    {
        return Err(invalid());
    }
    let bytes = tokio::fs::read(path).await.map_err(|_| invalid())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

async fn handoff(app: &AppHandle, p: &MediaProposal) -> Result<(), AppError> {
    let Some(queue_id) = p.queue_id.as_ref() else {
        return Err(invalid());
    };
    let repos = crate::commands::repositories(app).await?;
    if repos.get_media_job(queue_id).await?.is_some() {
        return Ok(());
    }
    let (_, retrieve, extension) = route(p);
    jobs::media_job_start(
        app.clone(),
        jobs::StartMediaJobRequest {
            queue_id: queue_id.clone(),
            kind: if p.kind == "edit" {
                "image".into()
            } else {
                p.kind.clone()
            },
            model: p.model.clone(),
            prompt: p.prompt.clone(),
            extension: extension.into(),
            retrieve_path: retrieve.into(),
            retrieve_body: json!({"id":queue_id,"queue_id":queue_id,"model":p.model}),
            url_fields: vec![
                "url".into(),
                "video_url".into(),
                "audio_url".into(),
                "image_url".into(),
            ],
            parent_artifact_id: None,
            parent_handoff_seconds: None,
            cost_credits: p.cost_credits,
            source: Some("assistant".into()),
        },
    )
    .await?;
    Ok(())
}

async fn settle(
    app: &AppHandle,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    query("UPDATE assistant_media SET status=?,error=?,updated_at=? WHERE id=?")
        .bind(status)
        .bind(error)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&repos.pool)
        .await?;
    Ok(())
}

async fn reconcile(app: &AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let rows = query("SELECT * FROM assistant_media WHERE status IN ('submitting','queued')")
        .fetch_all(&repos.pool)
        .await?;
    for p in rows.into_iter().map(row) {
        let running = live().contains(&p.id);
        if p.status == "submitting" && !running {
            settle(app,&p.id,"uncertain",Some("The submission was interrupted. Check your usage before starting another generation.")).await?;
        } else if let Some(queue_id) = p.queue_id.as_ref() {
            if let Some(job) = repos.get_media_job(queue_id).await? {
                match job.status {
                    crate::domain::types::MediaJobStatus::Completed => {
                        query("UPDATE assistant_media SET status='completed',artifact_file_name=?,updated_at=? WHERE id=?")
                            .bind(job.artifact_file_name).bind(job.updated_at).bind(&p.id).execute(&repos.pool).await?;
                    }
                    crate::domain::types::MediaJobStatus::Failed => {
                        settle(app, &p.id, "failed", job.error.as_deref()).await?
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

pub async fn resume(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    if let Ok(rows) = query("SELECT * FROM assistant_media WHERE status='queued'")
        .fetch_all(&repos.pool)
        .await
    {
        for p in rows.into_iter().map(row) {
            let _ = handoff(app, &p).await;
        }
    }
    let _ = reconcile(app).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_image_envelopes_are_delivered_without_requeueing() {
        assert_eq!(
            media::image_result(&json!({"images":["aGVsbG8="]})),
            Some("aGVsbG8=")
        );
        assert_eq!(
            media::image_result(&json!({"status":"completed","images":[{"b64_json":"aGVsbG8="}]})),
            Some("aGVsbG8=")
        );
        assert_eq!(
            media::image_result(&json!({"status":"queued","id":"q"})),
            None
        );
        assert_eq!(media::image_result(&json!({"images":[""]})), None);
    }
    #[test]
    fn parameters_cannot_smuggle_paths_urls_or_spending_multipliers() {
        for p in [
            json!({"url":"https://example.com"}),
            json!({"variants":100}),
            json!({"path":"/video/queue"}),
            json!({"width":999999}),
        ] {
            assert!(parameters("image", &p).is_err());
        }
        assert!(parameters("image", &json!({"width":1024,"height":1024})).is_ok());
        assert!(parameters("speech", &json!({"speed":0})).is_err());
        assert!(parameters("edit", &json!({})).is_err());
    }
    #[tokio::test]
    async fn paid_claim_is_single_use_and_survives_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(directory.path().join("claims.sqlite"))
            .create_if_missing(true);
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options.clone())
            .await
            .unwrap();
        for statement in include_str!("../../migrations/029_assistant_media.sql")
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            query(statement).execute(&pool).await.unwrap();
        }
        query("INSERT INTO assistant_media(id,task_id,kind,model,prompt,parameters,backend,created_at,updated_at) VALUES('p','t','image','m','p','{}','carpe-diem','','')").execute(&pool).await.unwrap();
        let (first, second, third) =
            tokio::join!(claim(&pool, "p"), claim(&pool, "p"), claim(&pool, "p"));
        let winners = [first.unwrap(), second.unwrap(), third.unwrap()]
            .into_iter()
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(winners, 1);
        pool.close().await;

        let reopened = sqlx_sqlite::SqlitePoolOptions::new()
            .connect_with(options)
            .await
            .unwrap();
        assert!(!claim(&reopened, "p").await.unwrap());
        reopened.close().await;
    }
}
