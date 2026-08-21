use crate::{envelope::ApiResponse, error::ApiError, state::ApiState};
use axum::{
    Json,
    extract::{Query, State},
};
use june_config::ModelPriceConfig;
use june_domain::ModelKind;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub(crate) struct ModelsQuery {
    #[serde(rename = "type")]
    model_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub description: Option<String>,
    pub privacy: Option<String>,
    pub pricing: Option<serde_json::Value>,
    pub context_tokens: Option<i64>,
    pub traits: Vec<String>,
    pub capabilities: Vec<String>,
    pub price_unit: String,
    pub price_description: String,
    pub credits_per_million_seconds: Option<u64>,
    pub input_credits_per_million_tokens: Option<u64>,
    pub output_credits_per_million_tokens: Option<u64>,
    /// What prompt tokens cost when the operator serves them from its prompt
    /// cache. Absent for the models that publish no cache rate, which is most
    /// of the catalogue — absent means "bills like input", not "free".
    pub cache_input_credits_per_million_tokens: Option<u64>,
}

pub(crate) async fn list_models(
    State(state): State<ApiState>,
    Query(query): Query<ModelsQuery>,
) -> Result<Json<ApiResponse<Vec<ModelDto>>>, ApiError> {
    let kind = query
        .model_type
        .as_deref()
        .map(parse_model_kind)
        .transpose()?;
    let models = state
        .pricing()
        .priced_models(kind)
        .into_iter()
        .map(|(id, model)| to_dto(id, model))
        .collect();
    Ok(Json(ApiResponse::ok(models)))
}

fn parse_model_kind(value: &str) -> Result<ModelKind, ApiError> {
    match value {
        "asr" => Ok(ModelKind::Asr),
        "text" => Ok(ModelKind::Text),
        _ => Err(ApiError::unprocessable("model_type_invalid")),
    }
}

fn to_dto(id: &str, model: &ModelPriceConfig) -> ModelDto {
    ModelDto {
        provider: model.provider.as_str().to_string(),
        id: id.to_string(),
        name: model.display_name.clone(),
        model_type: model.model_type.as_str().to_string(),
        description: model.description.clone(),
        privacy: model.privacy.clone(),
        pricing: model.pricing.clone(),
        context_tokens: model.context_tokens,
        traits: model.traits.clone(),
        capabilities: model.capabilities.clone(),
        price_unit: model.unit.as_str().to_string(),
        price_description: price_description(model),
        credits_per_million_seconds: model.credits_per_million_seconds,
        input_credits_per_million_tokens: model.input_credits_per_million_tokens,
        output_credits_per_million_tokens: model.output_credits_per_million_tokens,
        cache_input_credits_per_million_tokens: model.cache_input_credits_per_million_tokens,
    }
}

fn price_description(model: &ModelPriceConfig) -> String {
    if let Some(display) = model
        .pricing
        .as_ref()
        .and_then(|pricing| pricing.get("display"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return display.to_string();
    }
    match model.unit {
        june_config::PriceUnit::Seconds => format!(
            "{} per second audio",
            model.credits_per_million_seconds.map_or_else(
                || "$0.00".to_string(),
                |credits| format_credits_as_usd_per_unit(credits, 1_000_000)
            )
        ),
        june_config::PriceUnit::Tokens => format!(
            "{} input / {} output per 1M tokens{}",
            format_credits_as_usd(model.input_credits_per_million_tokens.unwrap_or_default()),
            format_credits_as_usd(model.output_credits_per_million_tokens.unwrap_or_default()),
            cache_price_suffix(model)
        ),
    }
}

/// The cache clause of a token model's price line.
///
/// A warm conversation re-sends the same standing instructions every turn, and
/// the operator serves most of that from its cache at this rate — so on the
/// model this app ships with, the number a user should read next to "$1.40
/// input" is "$0.26 cached", not nothing. Empty for the models that publish no
/// cache rate: silence says "bills like input", which is the truth.
fn cache_price_suffix(model: &ModelPriceConfig) -> String {
    model
        .cache_input_credits_per_million_tokens
        .map(|credits| format!(" ({} cached input)", format_small_credits_as_usd(credits)))
        .unwrap_or_default()
}

/// Like [`format_credits_as_usd`], but keeps sub-cent rates legible.
///
/// A cache rate is up to ten times smaller than the input rate it discounts, so
/// the two-decimal form collapses the cheapest models to "$0.00" and tells the
/// user the cache is free. Below a cent, show micro-dollars instead.
fn format_small_credits_as_usd(credits: u64) -> String {
    if credits >= 10 {
        return format_credits_as_usd(credits);
    }
    // 1 credit is $0.001, so micro-dollars are credits x 1000.
    let micro = credits.saturating_mul(1_000);
    let text = format!("$0.{micro:06}");
    text.trim_end_matches('0').to_string()
}

fn format_credits_as_usd(credits: u64) -> String {
    let cents = (u128::from(credits) + 5) / 10;
    format!("${}.{:02}", cents / 100, cents % 100)
}

fn format_credits_as_usd_per_unit(credits: u64, units: u64) -> String {
    if units == 0 {
        return "$0.00".to_string();
    }
    let micro_usd = (u128::from(credits) * 1_000 + (u128::from(units) / 2)) / u128::from(units);
    if micro_usd >= 1_000_000 {
        let cents = (micro_usd + 5_000) / 10_000;
        format!("${}.{:02}", cents / 100, cents % 100)
    } else {
        let decimals = format!("{micro_usd:06}");
        format!("$0.{}", decimals.trim_end_matches('0'))
    }
}

#[cfg(test)]
mod tests {
    use super::{format_small_credits_as_usd, price_description};
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use pretty_assertions::assert_eq;

    fn text_model(input: u64, output: u64, cache: Option<u64>) -> ModelPriceConfig {
        ModelPriceConfig {
            unit: PriceUnit::Tokens,
            credits_per_million_seconds: None,
            input_credits_per_million_tokens: Some(input),
            output_credits_per_million_tokens: Some(output),
            cache_input_credits_per_million_tokens: cache,
            provider: ModelProvider::Venice,
            model_type: ModelType::Text,
            display_name: "model".to_string(),
            description: None,
            privacy: None,
            pricing: None,
            context_tokens: None,
            traits: Vec::new(),
            capabilities: Vec::new(),
        }
    }

    /// The picker's price line is the one place a user reads a rate before
    /// choosing a model, and on a warm conversation the cache rate is what most
    /// of the prompt actually costs. The shipped default: $1.40 against $0.26.
    #[test]
    fn a_model_with_a_cache_rate_says_so_on_its_price_line() {
        let description = price_description(&text_model(1_400, 5_500, Some(260)));

        assert_eq!(
            description,
            "$1.40 input / $5.50 output per 1M tokens ($0.26 cached input)"
        );
    }

    /// Most of the catalogue publishes no cache rate. Those price lines must
    /// read exactly as they did before: an empty clause would say "free".
    #[test]
    fn a_model_without_a_cache_rate_keeps_its_old_price_line() {
        let description = price_description(&text_model(70, 300, None));

        assert_eq!(description, "$0.07 input / $0.30 output per 1M tokens");
    }

    /// A cache rate is up to ten times smaller than the input rate it
    /// discounts, so two decimals would tell the user a cheap model caches for
    /// nothing.
    #[test]
    fn a_sub_cent_cache_rate_does_not_collapse_to_zero() {
        assert_eq!(format_small_credits_as_usd(1), "$0.001");
        assert_eq!(format_small_credits_as_usd(3), "$0.003");
        assert_eq!(format_small_credits_as_usd(9), "$0.009");
        // At a cent and above the ordinary two-decimal form takes over.
        assert_eq!(format_small_credits_as_usd(10), "$0.01");
        assert_eq!(format_small_credits_as_usd(260), "$0.26");
    }
}
