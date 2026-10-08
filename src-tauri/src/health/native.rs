//! The phone's health store: HealthKit through `native/health-kit/HealthBridge.m`
//! on the iPhone, Health Connect through `HealthConnect.kt` on Android. Both
//! answer the same JSON, one [`HealthDay`] per measure and day. A computer has
//! no store and answers nothing.

use super::{HealthDay, Metric};
use crate::domain::types::AppError;
use chrono::NaiveDate;
#[cfg(any(target_os = "ios", target_os = "android"))]
use serde::Deserialize;

#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Deserialize)]
struct ReadAnswer {
    #[serde(default)]
    days: Vec<HealthDay>,
    #[serde(default)]
    error: Option<String>,
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn unavailable() -> AppError {
    AppError::new(
        "health_unavailable",
        "Health data cannot be read on this device.",
    )
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn read_failed() -> AppError {
    AppError::new(
        "health_read_failed",
        "Health data could not be read. Try again.",
    )
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn keys(metrics: &[Metric]) -> Vec<&'static str> {
    metrics.iter().map(|metric| metric.key()).collect()
}

// --- iPhone ------------------------------------------------------------------

#[cfg(target_os = "ios")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};
    use tokio::sync::oneshot;

    unsafe extern "C" {
        fn subrosa_health_available() -> i32;
        fn subrosa_health_request(
            metrics_json: *const c_char,
            context: *mut c_void,
            callback: extern "C" fn(*mut c_void, *const c_char),
        );
        fn subrosa_health_read(
            request_json: *const c_char,
            context: *mut c_void,
            callback: extern "C" fn(*mut c_void, *const c_char),
        );
    }

    extern "C" fn receive(context: *mut c_void, json: *const c_char) {
        if context.is_null() {
            return;
        }
        // Called exactly once, from whatever queue finished. Reclaim the
        // sender even when nobody waits any more (a timed-out read).
        let sender = unsafe { Box::from_raw(context.cast::<oneshot::Sender<String>>()) };
        let answer = if json.is_null() {
            String::from(r#"{"error":"no_answer"}"#)
        } else {
            unsafe { CStr::from_ptr(json) }
                .to_string_lossy()
                .into_owned()
        };
        let _ = sender.send(answer);
    }

    async fn call(
        entry: unsafe extern "C" fn(
            *const c_char,
            *mut c_void,
            extern "C" fn(*mut c_void, *const c_char),
        ),
        payload: serde_json::Value,
        wait: std::time::Duration,
    ) -> Result<String, AppError> {
        let payload = CString::new(payload.to_string()).map_err(|_| read_failed())?;
        let (sender, receiver) = oneshot::channel::<String>();
        let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
        // The Objective-C side parses the payload before it returns.
        unsafe { entry(payload.as_ptr(), context, receive) };
        match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(answer)) => Ok(answer),
            _ => Err(read_failed()),
        }
    }

    pub fn source() -> &'static str {
        "healthkit"
    }

    pub async fn availability() -> String {
        if unsafe { subrosa_health_available() } != 0 {
            "available".into()
        } else {
            "unavailable".into()
        }
    }

    pub async fn request(metrics: &[Metric]) -> Result<(), AppError> {
        // The system sheet waits for the person, so the wait is long.
        let answer = call(
            subrosa_health_request,
            serde_json::json!(keys(metrics)),
            std::time::Duration::from_secs(600),
        )
        .await?;
        let answer: ReadAnswer = serde_json::from_str(&answer).map_err(|_| read_failed())?;
        match answer.error {
            Some(error) => {
                tracing::warn!(%error, "HealthKit authorization failed");
                Err(unavailable())
            }
            None => Ok(()),
        }
    }

    pub async fn read(
        metrics: &[Metric],
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<HealthDay>, AppError> {
        let answer = call(
            subrosa_health_read,
            serde_json::json!({
                "metrics": keys(metrics),
                "from": super::super::day_text(from),
                "to": super::super::day_text(to),
            }),
            std::time::Duration::from_secs(30),
        )
        .await?;
        let answer: ReadAnswer = serde_json::from_str(&answer).map_err(|_| read_failed())?;
        if let Some(error) = answer.error {
            tracing::warn!(%error, "HealthKit read failed");
            return Err(read_failed());
        }
        Ok(answer.days)
    }
}

// --- Android -----------------------------------------------------------------

#[cfg(target_os = "android")]
mod platform {
    use super::*;

    #[derive(Deserialize)]
    struct Availability {
        status: String,
    }

    async fn blocking<T: serde::de::DeserializeOwned + Send + 'static>(
        command: &'static str,
        payload: serde_json::Value,
    ) -> Result<T, AppError> {
        tokio::task::spawn_blocking(move || crate::android::invoke::<T>(command, payload))
            .await
            .map_err(|_| read_failed())?
    }

    pub fn source() -> &'static str {
        "health_connect"
    }

    pub async fn availability() -> String {
        match blocking::<Availability>("healthAvailability", serde_json::json!({})).await {
            Ok(answer) => answer.status,
            Err(_) => "unavailable".into(),
        }
    }

    pub async fn request(metrics: &[Metric]) -> Result<(), AppError> {
        let answer: ReadAnswer = blocking(
            "healthRequest",
            serde_json::json!({ "types": keys(metrics) }),
        )
        .await?;
        match answer.error {
            Some(error) => {
                tracing::warn!(%error, "Health Connect permission request failed");
                Err(unavailable())
            }
            None => Ok(()),
        }
    }

    pub async fn read(
        metrics: &[Metric],
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<HealthDay>, AppError> {
        let answer: ReadAnswer = blocking(
            "healthDaily",
            serde_json::json!({
                "types": keys(metrics),
                "from": super::super::day_text(from),
                "to": super::super::day_text(to),
            }),
        )
        .await?;
        if let Some(error) = answer.error {
            tracing::warn!(%error, "Health Connect read failed");
            return Err(read_failed());
        }
        Ok(answer.days)
    }
}

// --- A computer ---------------------------------------------------------------

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::*;

    pub fn source() -> &'static str {
        "none"
    }

    pub async fn availability() -> String {
        "elsewhere".into()
    }

    pub async fn request(_metrics: &[Metric]) -> Result<(), AppError> {
        Ok(())
    }

    pub async fn read(
        _metrics: &[Metric],
        _from: NaiveDate,
        _to: NaiveDate,
    ) -> Result<Vec<HealthDay>, AppError> {
        Ok(Vec::new())
    }
}

pub(super) use platform::{availability, read, request, source};
