use crate::{
    auth::{authenticated_user, provider_credentials},
    error::ApiError,
    handlers::notes::require_priced_model,
    state::ApiState,
    validation,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use june_domain::{ModelId, ModelKind, TokenUsage};
use june_services::AgentChatParams;

/// Per-turn metering, republished as response headers.
///
/// The same numbers are already inside the body (Carpe Diem puts them in
/// `usage`, on the buffered JSON and in the final SSE billing frame alike), but
/// the desktop shell forwards that body to the agent runtime as a stream and
/// must not buffer or re-parse it to learn what a turn cost. Headers let the
/// shell keep its ledger without touching the payload.
///
/// Additive only: nothing reads these but Sub Rosa's own shell, and a client
/// that ignores them behaves exactly as before.
const PROMPT_TOKENS_HEADER: HeaderName = HeaderName::from_static("x-june-prompt-tokens");
const COMPLETION_TOKENS_HEADER: HeaderName = HeaderName::from_static("x-june-completion-tokens");
const CACHED_TOKENS_HEADER: HeaderName = HeaderName::from_static("x-june-cached-tokens");
const CACHE_CREATION_TOKENS_HEADER: HeaderName =
    HeaderName::from_static("x-june-cache-creation-tokens");
const CACHE_SAVED_HEADER: HeaderName = HeaderName::from_static("x-june-cache-saved-usdc-micro");
const COST_HEADER: HeaderName = HeaderName::from_static("x-june-cost-usdc-micro");

/// Builds the metering headers for one settled turn. Every field is emitted,
/// including the zeros: a client accumulating a hit rate needs the misses as
/// much as the hits, and an absent header would be ambiguous between "no cache"
/// and "not reported".
fn usage_headers(usage: TokenUsage) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(6);
    for (name, value) in [
        (PROMPT_TOKENS_HEADER, usage.prompt_tokens),
        (COMPLETION_TOKENS_HEADER, usage.completion_tokens),
        (CACHED_TOKENS_HEADER, usage.cached_tokens),
        (
            CACHE_CREATION_TOKENS_HEADER,
            usage.cache_creation_input_tokens,
        ),
        (CACHE_SAVED_HEADER, usage.cache_saved_usdc_micro),
        (COST_HEADER, usage.cost_usdc_micro),
    ] {
        headers.insert(name, HeaderValue::from(value));
    }
    headers
}

pub(crate) async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;
    let model_id = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("model_required"))?
        .to_string();
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    validation::validate_agent_chat_body(&body)?;
    require_priced_model(&state, &model_id, ModelKind::Text)?;
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(model_id.clone()),
        );
    }
    let output = state
        .agent_chat()
        .complete(AgentChatParams {
            user_id,
            model_id: ModelId(model_id),
            body,
            provider_credentials,
        })
        .await?;
    let mut response_headers = usage_headers(output.completion.usage);
    // `content_type` is a runtime string (it mirrors whatever the upstream
    // sent), so it cannot be a const header value like the metering ones.
    let content_type = HeaderValue::from_str(&output.completion.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/json"));
    response_headers.insert(CONTENT_TYPE, content_type);
    Ok((StatusCode::OK, response_headers, output.completion.body).into_response())
}

#[cfg(test)]
mod tests {
    use super::{CACHE_SAVED_HEADER, CACHED_TOKENS_HEADER, PROMPT_TOKENS_HEADER, usage_headers};
    use june_domain::TokenUsage;
    use pretty_assertions::assert_eq;

    #[test]
    fn publishes_every_metering_field_including_the_zeros() {
        let headers = usage_headers(TokenUsage {
            prompt_tokens: 8_000,
            completion_tokens: 20,
            cached_tokens: 7_500,
            cache_creation_input_tokens: 0,
            cache_saved_usdc_micro: 41_000,
            cost_usdc_micro: 9_100,
        });

        assert_eq!(headers.len(), 6);
        assert_eq!(headers[&PROMPT_TOKENS_HEADER], "8000");
        assert_eq!(headers[&CACHED_TOKENS_HEADER], "7500");
        assert_eq!(headers[&CACHE_SAVED_HEADER], "41000");
    }

    #[test]
    fn a_cold_turn_still_publishes_zeros_so_a_hit_rate_has_a_denominator() {
        let headers = usage_headers(TokenUsage {
            prompt_tokens: 1_200,
            completion_tokens: 40,
            ..TokenUsage::default()
        });

        assert_eq!(headers[&PROMPT_TOKENS_HEADER], "1200");
        assert_eq!(headers[&CACHED_TOKENS_HEADER], "0");
    }
}
