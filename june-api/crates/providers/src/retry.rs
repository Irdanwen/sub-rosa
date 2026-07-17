use june_domain::DomainError;
use reqwest::StatusCode;
use std::time::Duration;

/// Total attempts per upstream call: the original request plus one retry.
/// Mirrors the bounded charge retry in `os_accounts.rs` — enough to absorb a
/// connection reset or a momentary 429/5xx without blowing the desktop
/// client's request budget.
pub(crate) const UPSTREAM_ATTEMPTS: u32 = 2;
pub(crate) const UPSTREAM_RETRY_BACKOFF: Duration = Duration::from_millis(300);

/// A single failed upstream attempt, classified so the caller knows whether
/// another attempt is worth making.
pub(crate) struct UpstreamAttemptError {
    pub(crate) error: DomainError,
    pub(crate) retryable: bool,
}

impl UpstreamAttemptError {
    pub(crate) fn fatal(error: DomainError) -> Self {
        Self {
            error,
            retryable: false,
        }
    }
}

/// Classify a non-success upstream status into the domain error the client
/// should see. Two statuses carry a signal the user can act on and must not
/// collapse into the generic `upstream_provider_failed`:
/// - **402** means the account behind the configured upstream key cannot pay
///   for the request — in this fork that key is the user's own Carpe Diem key,
///   so it surfaces as `insufficient_credits`.
/// - **429** means the upstream provider is momentarily rate-limited/at
///   capacity — a transient "busy, retry shortly" condition, surfaced as
///   `upstream_rate_limited` (a retryable 429 with `Retry-After` at the
///   boundary) rather than an opaque 502.
///
/// Every other status stays a genuine provider failure.
pub(crate) fn error_for_status(status: StatusCode) -> DomainError {
    match status {
        StatusCode::PAYMENT_REQUIRED => DomainError::InsufficientCredits,
        StatusCode::TOO_MANY_REQUESTS => DomainError::UpstreamRateLimited,
        _ => DomainError::UpstreamProvider,
    }
}

/// Transient HTTP statuses worth one more attempt: request timeout, rate
/// limit, and any 5xx. Everything else (4xx) is deterministic and must not
/// be replayed.
pub(crate) fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// Transport errors worth retrying (connection refused/reset, broken pipe).
/// Timeouts are excluded on purpose: the per-attempt timeout already consumes
/// most of the caller's budget, so a second attempt would land after the
/// client has given up. Builder errors are deterministic and excluded too.
pub(crate) fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    !error.is_timeout() && !error.is_builder()
}

#[cfg(test)]
mod tests {
    use super::{error_for_status, is_retryable_status};
    use june_domain::DomainError;
    use reqwest::StatusCode;

    #[test]
    fn payment_required_maps_to_insufficient_credits() {
        assert_eq!(
            error_for_status(StatusCode::PAYMENT_REQUIRED),
            DomainError::InsufficientCredits
        );
        assert_eq!(
            error_for_status(StatusCode::INTERNAL_SERVER_ERROR),
            DomainError::UpstreamProvider
        );
        assert_eq!(
            error_for_status(StatusCode::UNAUTHORIZED),
            DomainError::UpstreamProvider
        );
    }

    #[test]
    fn too_many_requests_maps_to_rate_limited_not_provider_failure() {
        // Regression: an upstream 429 (provider momentarily rate-limited) used
        // to collapse into DomainError::UpstreamProvider -> a 502
        // upstream_provider_failed the user could not act on. It must stay a
        // distinct, retryable rate-limit signal.
        assert_eq!(
            error_for_status(StatusCode::TOO_MANY_REQUESTS),
            DomainError::UpstreamRateLimited
        );
        // A 429 is still worth one more attempt before it surfaces.
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
    }

    #[test]
    fn server_errors_and_rate_limits_are_retryable() {
        assert!(is_retryable_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::REQUEST_TIMEOUT));
    }

    #[test]
    fn deterministic_client_errors_are_not_retryable() {
        assert!(!is_retryable_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(StatusCode::PAYLOAD_TOO_LARGE));
        assert!(!is_retryable_status(StatusCode::UNPROCESSABLE_ENTITY));
    }
}
