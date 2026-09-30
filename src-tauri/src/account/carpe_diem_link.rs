//! The account's one statement to Carpe Diem: "this device of this account
//! holds the key with this thumbprint" (ADR-0069).
//!
//! The service signs it only for a native session on a device, and only while
//! the sign-in is less than five minutes old. A renewed session, which a stolen
//! device secret could mint, is never recent, so it cannot create a key.
use super::*;

/// What the screen does with a refusal it can recover from.
fn reauth() -> AppError {
    AppError::new(
        "carpe_diem_reauth_required",
        "Sign in again to create this device's key. It takes a moment, and nothing else changes.",
    )
}

fn unavailable() -> AppError {
    AppError::new(
        "carpe_diem_issue_unavailable",
        "Creating a key from your account is not available yet. Paste a Carpe Diem key instead.",
    )
}

/// Pure: the assertion out of the service's answer, or why not.
pub(crate) fn parse_assertion(value: &Value) -> Result<Redacted<String>, AppError> {
    let assertion = value["assertion"].as_str().unwrap_or("");
    // Three base64url parts, bounded: anything else is not what was asked for.
    let parts = assertion.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || assertion.len() > 8192
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    {
        return Err(error("account_response_invalid"));
    }
    Ok(Redacted::new(assertion.to_string()))
}

/// Maps the service's refusals to the two that the key screen acts on.
pub(crate) fn map_refusal(failure: AppError) -> AppError {
    match failure.code.as_str() {
        "recent_auth_required" => reauth(),
        // `request` folds every 404 into this code; here a 404 means the
        // service has no Carpe Diem section configured.
        "vault_not_found" => unavailable(),
        // `request` folds the service's `slow_down` into the device sign-in
        // code; here it is the per-account limit on assertions.
        "authorization_pending" => AppError::new(
            "carpe_diem_issue_slow_down",
            "Too many attempts in a row. Wait a minute, then try again.",
        ),
        _ => failure,
    }
}

pub(crate) async fn assertion(app: &AppHandle, jkt: &str) -> Result<Redacted<String>, AppError> {
    if jkt.len() != 43 {
        return Err(error("account_request_failed"));
    }
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let value = call(
        &s,
        reqwest::Method::POST,
        "/api/v1/carpe-diem/assertion",
        Some(json!({ "jkt": jkt })),
    )
    .await
    .map_err(map_refusal)?;
    parse_assertion(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_compact_jws_is_taken() {
        assert!(parse_assertion(&json!({"assertion":"aGVh.Y2xh.c2ln"})).is_ok());
        for bad in [
            json!({}),
            json!({"assertion":"a.b"}),
            json!({"assertion":"a..c"}),
            json!({"assertion":"a.b.c d"}),
            json!({"assertion":"a.b.c=="}),
        ] {
            assert!(parse_assertion(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_stale_sign_in_asks_for_a_fresh_one() {
        assert_eq!(
            map_refusal(error("recent_auth_required")).code,
            "carpe_diem_reauth_required"
        );
        assert_eq!(
            map_refusal(error("vault_not_found")).code,
            "carpe_diem_issue_unavailable"
        );
        assert_eq!(
            map_refusal(error("authorization_pending")).code,
            "carpe_diem_issue_slow_down"
        );
        assert_eq!(
            map_refusal(error("account_offline")).code,
            "account_offline"
        );
    }
}
