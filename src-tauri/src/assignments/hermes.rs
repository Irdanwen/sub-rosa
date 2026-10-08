//! A run on the desktop: one Hermes cron job per run, through the routines
//! machinery.
//!
//! The job is a one-shot due a minute from now, never a recurring schedule.
//! Hermes's gateway is launchd-managed and outlives the app on purpose (cron
//! routines, messaging), so a recurring job would keep firing with the app
//! quit, which is exactly what an assignment must not do: it runs while an
//! app is open, and the menu bar counts. The app owns the clock
//! (`schedule.rs`), and each slot it decides is due becomes one job, which
//! Hermes removes after it has run. The run's answer is read back from the
//! session the scheduler wrote (`cron_<job>_<time>`).

use serde_json::Value;
use tauri::{AppHandle, Manager as _};

use super::lite::Outcome;
use super::ASSIGNMENT_JOB_TAG;
use crate::domain::types::AppError;
use crate::hermes_bridge::{CreateHermesCronJobRequest, HermesBridge, UpdateHermesCronJobRequest};

/// A job still listed this long after it started has not finished and is
/// not going to.
const RUN_TIMEOUT_HOURS: i64 = 3;

/// The job name for a run of the assignment titled `title`.
pub fn job_name(title: &str) -> String {
    format!("{ASSIGNMENT_JOB_TAG}{}", title.trim())
}

/// Whether a run can start now. When the runtime is not up yet (the app has
/// just launched), the slot stays due and the next tick takes it.
pub async fn available(app: &AppHandle) -> bool {
    let Some(bridge) = app.try_state::<HermesBridge>() else {
        return false;
    };
    crate::hermes_bridge::hermes_bridge_status(bridge)
        .await
        .is_ok_and(|status| status.running)
}

/// Create the run's job. Returns the job id, which is the run's handle.
pub async fn start(
    app: &AppHandle,
    title: &str,
    prompt: &str,
    toolsets: Vec<String>,
) -> Result<String, AppError> {
    let bridge = app.try_state::<HermesBridge>().ok_or_else(|| {
        AppError::new(
            "assignment_runtime_missing",
            "The assistant is not running on this computer.",
        )
    })?;
    crate::hermes_bridge::ensure_hermes_bridge_gateway(bridge.clone()).await?;
    let created = crate::hermes_bridge::create_hermes_bridge_cron_job(
        bridge.clone(),
        CreateHermesCronJobRequest {
            prompt: prompt.to_string(),
            schedule: "1m".into(),
            name: Some(job_name(title)),
            deliver: Some("local".into()),
        },
    )
    .await?;
    let job_id = job_id(&created).ok_or_else(|| {
        AppError::new(
            "assignment_runtime_missing",
            "The assistant did not accept the run.",
        )
    })?;
    // The tools are set explicitly on every run, never left to the cron
    // default, so what the run may do is what the assignment says.
    crate::hermes_bridge::update_hermes_bridge_cron_job(
        bridge,
        UpdateHermesCronJobRequest {
            job_id: job_id.clone(),
            updates: serde_json::json!({ "enabled_toolsets": toolsets }),
        },
    )
    .await?;
    Ok(job_id)
}

fn job_id(created: &Value) -> Option<String> {
    created
        .get("id")
        .or_else(|| created.pointer("/job/id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn list<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .as_array()
        .or_else(|| value.get(key).and_then(Value::as_array))
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

/// The session a one-shot job wrote, by the id the scheduler mints for it.
pub fn session_of_job<'a>(sessions: &'a Value, job_id: &str) -> Option<&'a str> {
    let prefix = format!("cron_{job_id}_");
    list(sessions, "sessions")
        .into_iter()
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .find(|id| id.starts_with(&prefix))
}

pub async fn poll(app: &AppHandle, job_id: &str, started_at: &str) -> Outcome {
    let Some(bridge) = app.try_state::<HermesBridge>() else {
        return Outcome::Pending;
    };
    let Ok(jobs) = crate::hermes_bridge::hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        "/api/cron/jobs?profile=default",
        None,
    )
    .await
    else {
        return Outcome::Pending;
    };
    let listed = list(&jobs, "jobs")
        .into_iter()
        .any(|job| job.get("id").and_then(Value::as_str) == Some(job_id));
    if listed {
        let started = chrono::DateTime::parse_from_rfc3339(started_at).ok();
        let stale = started.is_some_and(|at| {
            chrono::Utc::now().signed_duration_since(at)
                > chrono::Duration::hours(RUN_TIMEOUT_HOURS)
        });
        if stale {
            let _ = crate::hermes_bridge::delete_hermes_bridge_cron_job(
                bridge,
                crate::hermes_bridge::HermesCronJobRequest {
                    job_id: job_id.to_string(),
                },
            )
            .await;
            return Outcome::Failed("The run did not finish in time.".into());
        }
        return Outcome::Pending;
    }
    // Gone from the list: Hermes removes a one-shot once it has run.
    let Ok(sessions) = crate::hermes_bridge::hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        "/api/sessions?limit=100&offset=0&archived=include&min_messages=0&order=recent",
        None,
    )
    .await
    else {
        return Outcome::Pending;
    };
    let Some(session_id) = session_of_job(&sessions, job_id) else {
        return Outcome::Failed("The run left no answer.".into());
    };
    let Ok(messages) = crate::hermes_bridge::hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        &format!("/api/sessions/{}/messages", urlencoding::encode(session_id)),
        None,
    )
    .await
    else {
        return Outcome::Pending;
    };
    crate::account::conversations::hermes_visible_turns(&messages)
        .into_iter()
        .rev()
        .find(|(role, text)| role == "assistant" && !text.trim().is_empty())
        .map(|(_, text)| Outcome::Answer(text))
        .unwrap_or_else(|| Outcome::Failed("The run left no answer.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_finds_the_session_its_job_wrote() {
        let sessions = serde_json::json!({ "sessions": [
            { "id": "cron_abc123_20261008_070100" },
            { "id": "cron_def456_20261008_070100" },
            { "id": "chat-1" }
        ]});
        assert_eq!(
            session_of_job(&sessions, "def456"),
            Some("cron_def456_20261008_070100")
        );
        assert_eq!(session_of_job(&sessions, "zzz"), None);
        assert_eq!(
            job_id(&serde_json::json!({ "job": { "id": "x1" } })),
            Some("x1".into())
        );
    }
}
