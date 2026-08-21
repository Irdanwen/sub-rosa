use june_config::{ModelPriceConfig, ModelType, PriceUnit};
use june_domain::{Credits, ModelKind, TokenUsage};
use std::collections::BTreeMap;
use thiserror::Error;

const RATE_SCALE: u64 = 1_000_000;

/// The catalogue of models this backend will route to, and their rates.
///
/// The name says pricing, but in the Sub Rosa distribution its two LIVE roles
/// are neither of them a bill:
///
/// 1. **An allowlist.** `ensure_model_kind` runs from `require_priced_model` in
///    the API layer BEFORE any upstream call, and a model missing from this
///    table is refused `model_not_priced`. That is the rejection a user
///    actually meets, and it is why a catalogue model with no published rate
///    disappears from the app rather than merely costing an unknown amount.
/// 2. **The price line in the model picker.** `/v1/models` renders these rates
///    into the string the picker shows, which is the one place a user reads a
///    rate before choosing a model.
///
/// What it does NOT do here is settle money. The desktop runs the backend as a
/// local sidecar with `JUNE__LOCAL_DEV__ENABLED`, so `charge` always returns a
/// receipt of zero credits, and no frontend component reads `credits_charged`.
/// The user's real balance comes from the operator (`GET /v1/credits`), and the
/// authoritative per-request cost is the operator's own
/// `X-Carpe-Cost-Usdc-Micro`. Keep `price_token_usage` correct — it is the
/// upstream metering contract and costs nothing to keep right — but do not
/// mistake its result for something a user sees.
#[derive(Clone, Debug)]
pub struct PricingTable {
    models: BTreeMap<String, ModelPriceConfig>,
}

impl PricingTable {
    pub fn new(models: BTreeMap<String, ModelPriceConfig>) -> Self {
        Self { models }
    }

    pub fn price_audio_seconds(
        &self,
        model_id: &str,
        seconds: u64,
    ) -> Result<Credits, PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if model.unit != PriceUnit::Seconds {
            return Err(PricingError::WrongUnit);
        }
        let rate = model
            .credits_per_million_seconds
            .ok_or(PricingError::MissingRate)?;
        Self::price_scaled([(seconds, rate)])
    }

    /// Prices one settled turn.
    ///
    /// In this distribution the result is metered into a receipt that is always
    /// zero and that nothing reads (see the type docs). It is kept exact
    /// anyway: it is the upstream contract, and a wrong number here would be
    /// wrong the day something does read it.
    pub fn price_token_usage(
        &self,
        model_id: &str,
        usage: TokenUsage,
    ) -> Result<Credits, PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if model.unit != PriceUnit::Tokens {
            return Err(PricingError::WrongUnit);
        }
        let input_rate = model
            .input_credits_per_million_tokens
            .ok_or(PricingError::MissingRate)?;
        let output_rate = model
            .output_credits_per_million_tokens
            .ok_or(PricingError::MissingRate)?;
        // Cached prompt tokens bill at the operator's cache rate when the model
        // publishes one. Most models do not, and for those the cached share is
        // simply worth the plain input rate — which reproduces the old
        // two-component price exactly, so an un-cached deployment is unaffected.
        // The two prompt halves sum to `prompt_tokens` by construction
        // (`TokenUsage` guarantees it), so nothing is billed twice or dropped.
        //
        // The cache WRITE premium is deliberately not modelled. Whether
        // `cache_creation_input_tokens` is a subset of `prompt_tokens` or an
        // addition to it is not pinned down on this rail, so pricing it would
        // risk billing the same tokens twice; the field is captured and carried
        // so the premium can be added once the operator states the semantics.
        // Most models publish no write premium at all.
        let cache_rate = model
            .cache_input_credits_per_million_tokens
            .unwrap_or(input_rate);
        Self::price_scaled([
            (usage.uncached_prompt_tokens(), input_rate),
            (usage.billable_cached_tokens(), cache_rate),
            (usage.completion_tokens, output_rate),
        ])
    }

    pub fn has_model(&self, model_id: &str) -> bool {
        self.models.contains_key(model_id)
    }

    pub fn ensure_model_kind(&self, model_id: &str, kind: ModelKind) -> Result<(), PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if !model_type_matches_kind(model.model_type, kind) {
            return Err(PricingError::WrongUnit);
        }
        match kind {
            ModelKind::Asr => {
                if model.unit != PriceUnit::Seconds {
                    return Err(PricingError::WrongUnit);
                }
                model
                    .credits_per_million_seconds
                    .ok_or(PricingError::MissingRate)?;
            }
            ModelKind::Text => {
                if model.unit != PriceUnit::Tokens {
                    return Err(PricingError::WrongUnit);
                }
                model
                    .input_credits_per_million_tokens
                    .ok_or(PricingError::MissingRate)?;
                model
                    .output_credits_per_million_tokens
                    .ok_or(PricingError::MissingRate)?;
            }
        }
        Ok(())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &ModelPriceConfig)> {
        self.models.iter()
    }

    pub fn priced_models(&self, kind: Option<ModelKind>) -> Vec<(&String, &ModelPriceConfig)> {
        self.models
            .iter()
            .filter(|(_, model)| {
                kind.is_none_or(|kind| model_type_matches_kind(model.model_type, kind))
            })
            .collect()
    }

    fn price_scaled<const N: usize>(components: [(u64, u64); N]) -> Result<Credits, PricingError> {
        let numerator = components
            .into_iter()
            .try_fold(0_u64, |sum, (units, rate)| {
                let subtotal = units.checked_mul(rate).ok_or(PricingError::Overflow)?;
                sum.checked_add(subtotal).ok_or(PricingError::Overflow)
            })?;
        let credits = if numerator == 0 {
            0
        } else {
            numerator
                .checked_add(RATE_SCALE - 1)
                .ok_or(PricingError::Overflow)?
                / RATE_SCALE
        };
        Ok(Credits(credits))
    }
}

fn model_type_matches_kind(model_type: ModelType, kind: ModelKind) -> bool {
    matches!(
        (model_type, kind),
        (ModelType::Asr, ModelKind::Asr) | (ModelType::Text, ModelKind::Text)
    )
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PricingError {
    #[error("model_not_priced")]
    NotPriced,
    #[error("price_unit_mismatch")]
    WrongUnit,
    #[error("missing_price_rate")]
    MissingRate,
    #[error("price_overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::{PricingError, PricingTable};
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::{ModelKind, TokenUsage};
    use pretty_assertions::assert_eq;
    use std::collections::BTreeMap;

    fn models<const N: usize>(
        values: [(&str, PriceUnit, u64, u64, ModelType); N],
    ) -> BTreeMap<String, ModelPriceConfig> {
        values
            .into_iter()
            .map(|(id, unit, input_rate, output_rate, model_type)| {
                (
                    id.to_string(),
                    ModelPriceConfig {
                        unit,
                        credits_per_million_seconds: (unit == PriceUnit::Seconds)
                            .then_some(input_rate),
                        input_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(input_rate),
                        output_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(output_rate),
                        cache_input_credits_per_million_tokens: None,
                        provider: ModelProvider::Openai,
                        model_type,
                        display_name: id.to_string(),
                        description: None,
                        privacy: None,
                        pricing: None,
                        context_tokens: None,
                        traits: Vec::new(),
                        capabilities: Vec::new(),
                    },
                )
            })
            .collect()
    }

    /// One text model whose cache rate is the thing under test.
    fn cached_model(
        input_rate: u64,
        output_rate: u64,
        cache_rate: Option<u64>,
    ) -> BTreeMap<String, ModelPriceConfig> {
        let mut models = models([(
            "cache-priced",
            PriceUnit::Tokens,
            input_rate,
            output_rate,
            ModelType::Text,
        )]);
        if let Some(model) = models.get_mut("cache-priced") {
            model.cache_input_credits_per_million_tokens = cache_rate;
        }
        models
    }

    #[test]
    fn prices_known_models() {
        let table = PricingTable::new(models([
            ("priced-asr", PriceUnit::Seconds, 250_000, 0, ModelType::Asr),
            ("priced-text", PriceUnit::Tokens, 70, 300, ModelType::Text),
        ]));

        assert_eq!(
            table
                .price_audio_seconds("priced-asr", 9)
                .map(|credits| credits.0),
            Ok(3)
        );
        assert_eq!(
            table
                .price_token_usage(
                    "priced-text",
                    TokenUsage {
                        prompt_tokens: 1_600,
                        completion_tokens: 50,
                        ..TokenUsage::default()
                    },
                )
                .map(|credits| credits.0),
            Ok(1)
        );
    }

    /// A model that publishes a cache rate bills its cached share at that rate.
    /// The numbers mirror the shipped default model: $1.40 input against $0.26
    /// cache input, a 0.19x ratio, on a prompt that is 94 % cache hit.
    #[test]
    fn a_cached_prompt_bills_its_cached_share_at_the_cache_rate() {
        let table = PricingTable::new(cached_model(1_400, 5_500, Some(260)));

        let cold = table
            .price_token_usage(
                "cache-priced",
                TokenUsage {
                    prompt_tokens: 100_000,
                    completion_tokens: 500,
                    ..TokenUsage::default()
                },
            )
            .map(|credits| credits.0);
        let warm = table
            .price_token_usage(
                "cache-priced",
                TokenUsage {
                    prompt_tokens: 100_000,
                    completion_tokens: 500,
                    cached_tokens: 94_000,
                    ..TokenUsage::default()
                },
            )
            .map(|credits| credits.0);

        // 100_000 * 1_400 + 500 * 5_500 = 142_750_000 -> 143 credits.
        assert_eq!(cold, Ok(143));
        // 6_000 * 1_400 + 94_000 * 260 + 500 * 5_500 = 35_540_000 -> 36 credits.
        assert_eq!(warm, Ok(36));
    }

    /// The catalogue is mostly models with no published cache rate. Those must
    /// keep pricing exactly as they did before the cache existed, whether or not
    /// the upstream reports a hit — otherwise a cache hit would silently make a
    /// turn cheaper than the operator actually charges for it.
    #[test]
    fn a_model_without_a_cache_rate_prices_a_hit_like_a_miss() {
        let table = PricingTable::new(cached_model(1_400, 5_500, None));

        let with_hit = table.price_token_usage(
            "cache-priced",
            TokenUsage {
                prompt_tokens: 100_000,
                completion_tokens: 500,
                cached_tokens: 94_000,
                ..TokenUsage::default()
            },
        );
        let without_hit = table.price_token_usage(
            "cache-priced",
            TokenUsage {
                prompt_tokens: 100_000,
                completion_tokens: 500,
                ..TokenUsage::default()
            },
        );

        assert_eq!(with_hit, without_hit);
        assert_eq!(with_hit.map(|credits| credits.0), Ok(143));
    }

    /// An upstream reporting more cached tokens than prompt tokens is nonsense,
    /// and the cheaper rate makes it the profitable kind of nonsense. The split
    /// clamps, so the turn can never be billed for more than its prompt.
    #[test]
    fn a_nonsensical_split_cannot_bill_more_than_the_prompt() {
        let table = PricingTable::new(cached_model(1_400, 5_500, Some(260)));

        let priced = table
            .price_token_usage(
                "cache-priced",
                TokenUsage {
                    prompt_tokens: 1_000,
                    completion_tokens: 0,
                    cached_tokens: 9_999_999,
                    ..TokenUsage::default()
                },
            )
            .map(|credits| credits.0);

        // 1_000 tokens, all of them at the cache rate: 260_000 -> 1 credit.
        assert_eq!(priced, Ok(1));
    }

    #[test]
    fn rejects_unknown_models() {
        let table = PricingTable::new(BTreeMap::new());
        assert_eq!(
            table.price_audio_seconds("missing", 1),
            Err(PricingError::NotPriced)
        );
    }

    #[test]
    fn catches_price_overflow() {
        let table = PricingTable::new(models([(
            "too-large",
            PriceUnit::Tokens,
            u64::MAX,
            u64::MAX,
            ModelType::Text,
        )]));
        assert_eq!(
            table.price_token_usage(
                "too-large",
                TokenUsage {
                    prompt_tokens: 2,
                    completion_tokens: 0,
                    ..TokenUsage::default()
                },
            ),
            Err(PricingError::Overflow)
        );
    }

    #[test]
    fn rejects_wrong_unit_for_audio_seconds() {
        let table = PricingTable::new(models([(
            "text-model",
            PriceUnit::Tokens,
            1,
            1,
            ModelType::Text,
        )]));
        assert_eq!(
            table.price_audio_seconds("text-model", 1),
            Err(PricingError::WrongUnit)
        );
    }

    #[test]
    fn rejects_wrong_unit_for_tokens() {
        let table = PricingTable::new(models([(
            "asr-model",
            PriceUnit::Seconds,
            1,
            0,
            ModelType::Asr,
        )]));
        assert_eq!(
            table.price_token_usage(
                "asr-model",
                TokenUsage {
                    prompt_tokens: 1,
                    completion_tokens: 0,
                    ..TokenUsage::default()
                },
            ),
            Err(PricingError::WrongUnit)
        );
    }

    #[test]
    fn ensures_model_kind_matches_pricing_metadata() {
        let table = PricingTable::new(models([
            ("asr-model", PriceUnit::Seconds, 1, 0, ModelType::Asr),
            ("text-model", PriceUnit::Tokens, 1, 1, ModelType::Text),
        ]));

        assert_eq!(table.ensure_model_kind("asr-model", ModelKind::Asr), Ok(()));
        assert_eq!(
            table.ensure_model_kind("text-model", ModelKind::Text),
            Ok(())
        );
        assert_eq!(
            table.ensure_model_kind("asr-model", ModelKind::Text),
            Err(PricingError::WrongUnit)
        );
        assert_eq!(
            table.ensure_model_kind("missing", ModelKind::Text),
            Err(PricingError::NotPriced)
        );
    }

    #[test]
    fn has_model_reports_known_ids() {
        let table = PricingTable::new(models([(
            "known",
            PriceUnit::Seconds,
            1,
            0,
            ModelType::Asr,
        )]));
        assert!(table.has_model("known"));
        assert!(!table.has_model("unknown"));
    }
}
