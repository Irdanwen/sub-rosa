//! The one call a reflex makes: `POST {catalog}/decisions`.
//!
//! A direct call, like the embeddings one (ADR-0009), not a sidecar route: the
//! decision endpoint is a Carpe Diem path with no OpenAI shape for June API to
//! proxy, and every line in `june-api/` is a line the upstream sync re-merges
//! forever (ADR-0027). It goes to the **catalog** base (`/v1`) whatever the
//! inference rail says, because no external market serves it and the `/router`
//! rail would only rewrite it back.
//!
//! A reflex is an optimisation, never a dependency. Everything here fails
//! fast: a short timeout, and a breaker that stops asking for a while after a
//! few failures in a row, so a provider outage costs each caller one timeout
//! and then nothing until it passes.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::question::{parse_answers, Answer, Batch};
use crate::domain::types::AppError;

pub const MODEL: &str = "jev-latest";
/// Measured at 0.9 s for three questions; a screen of a couple of dozen
/// passages is larger. Long enough for that, short enough that a caller
/// waiting on it before a model call does not notice a dead provider twice.
const TIMEOUT: Duration = Duration::from_secs(8);
const FAILURES_TO_OPEN: u32 = 3;
const OPEN_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Default)]
struct Breaker {
    failures: u32,
    open_until: Option<Instant>,
}

impl Breaker {
    fn allows(&mut self, now: Instant) -> bool {
        match self.open_until {
            Some(until) if now < until => false,
            Some(_) => {
                // Half-open: one attempt decides whether it stays closed.
                self.open_until = None;
                self.failures = FAILURES_TO_OPEN - 1;
                true
            }
            None => true,
        }
    }

    fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            self.failures = 0;
            self.open_until = None;
        } else {
            self.failures = self.failures.saturating_add(1);
            if self.failures >= FAILURES_TO_OPEN {
                self.open_until = Some(now + OPEN_FOR);
            }
        }
    }
}

fn breaker() -> &'static Mutex<Breaker> {
    static BREAKER: OnceLock<Mutex<Breaker>> = OnceLock::new();
    BREAKER.get_or_init(|| Mutex::new(Breaker::default()))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::http_client::build(crate::http_client::credentialed(TIMEOUT), "reflex")
    })
}

/// Asks `batch` and returns the answers by question id.
///
/// `Err` means "no reflex this time" and every caller treats it the same way:
/// it keeps the path it had before reflexes existed. The error is for logs.
pub async fn decide(batch: &Batch) -> Result<BTreeMap<String, Answer>, AppError> {
    if !super::settings().enabled {
        return Err(AppError::new("reflex_off", "Quick decisions are off."));
    }
    if batch.is_empty() {
        return Ok(BTreeMap::new());
    }
    if !batch.fits() {
        return Err(AppError::new("reflex_too_large", "The batch is too large."));
    }
    let allowed = breaker()
        .lock()
        .map(|mut b| b.allows(Instant::now()))
        .unwrap_or(true);
    if !allowed {
        return Err(AppError::new(
            "reflex_paused",
            "Quick decisions are paused.",
        ));
    }
    let Some((base, key)) = crate::carpe_diem::settings::credentials() else {
        return Err(AppError::new(
            "reflex_no_key",
            "No Carpe Diem API key is stored yet.",
        ));
    };
    let base = crate::carpe_diem::settings::catalog_base_url_of(&base);
    let body = batch.to_body(MODEL)?;
    let result = send(&base, key.expose_str(), &body).await;
    if let Ok(mut b) = breaker().lock() {
        b.record(result.is_ok(), Instant::now());
    }
    result
}

async fn send(
    base: &str,
    key: &str,
    body: &serde_json::Value,
) -> Result<BTreeMap<String, Answer>, AppError> {
    let request_bytes = body.to_string().len() as u64;
    let started = Instant::now();
    let sent = client()
        .post(format!("{base}/decisions"))
        .bearer_auth(key)
        .json(body)
        .send()
        .await;
    // A direct call, so it joins the egress ledger here (ADR-0043): the
    // shape of the request, never the passages it carried. The purpose is
    // the caller's when it scoped one ("ask"), "reflex" otherwise.
    let context = crate::egress_ledger::current_context();
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(base)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "(unconfigured)".to_string()),
        purpose: match &context {
            Some(context) => format!("{} (reflex)", context.purpose),
            None => "reflex".to_string(),
        },
        method: "POST".to_string(),
        request_bytes,
        response_bytes: sent
            .as_ref()
            .ok()
            .and_then(reqwest::Response::content_length)
            .unwrap_or(0),
        status: sent.as_ref().ok().map(|r| r.status().as_u16()),
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        model: Some(MODEL.to_string()),
        note_id: context.and_then(|context| context.note_id),
    });
    let response = sent.map_err(|error| AppError::new("reflex_unreachable", error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "reflex_failed",
            format!(
                "The decision endpoint returned status {}.",
                response.status()
            ),
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AppError::new("reflex_invalid", error.to_string()))?;
    Ok(parse_answers(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_breaker_opens_after_repeated_failures_and_half_opens_later() {
        let mut breaker = Breaker::default();
        let t0 = Instant::now();
        for _ in 0..FAILURES_TO_OPEN {
            assert!(breaker.allows(t0));
            breaker.record(false, t0);
        }
        assert!(!breaker.allows(t0 + Duration::from_secs(1)));
        let later = t0 + OPEN_FOR + Duration::from_secs(1);
        assert!(breaker.allows(later), "one attempt after the pause");
        breaker.record(false, later);
        assert!(
            !breaker.allows(later),
            "a failed probe opens it again at once"
        );
    }

    #[test]
    fn a_success_resets_the_count() {
        let mut breaker = Breaker::default();
        let now = Instant::now();
        breaker.record(false, now);
        breaker.record(false, now);
        breaker.record(true, now);
        breaker.record(false, now);
        assert!(breaker.allows(now));
    }
}
