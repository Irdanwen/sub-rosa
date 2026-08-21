use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
        price_settled_work,
    },
    error::ServiceError,
    pricing::PricingTable,
    util::sha256_hex,
};
use june_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Credits, ModelId,
    ModelKind, OsAccountsClient, ProviderCredentials, Receipt, UserId,
};
use std::sync::Arc;

pub struct AgentChatServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub chat_completer: Arc<dyn AgentChatCompleter>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct AgentChatService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    chat_completer: Arc<dyn AgentChatCompleter>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl AgentChatService {
    pub fn new(deps: AgentChatServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            chat_completer: deps.chat_completer,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn complete(&self, params: AgentChatParams) -> Result<AgentChatOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_digest = body_digest(&params.body);
        let completion = self
            .chat_completer
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        // The completion already ran upstream: `price_settled_work` keeps a
        // pricing failure from throwing away an answer the user has paid for.
        // `ensure_model_kind` above proved the model carries both token rates,
        // so what remains is an overflow on absurd counts, or a rate the
        // pre-check cannot cover (the cache rate is optional by design).
        let actual = price_settled_work(
            self.pricing
                .price_token_usage(&params.model_id.0, completion.usage),
            ActionSlug::AgentChat,
            &params.model_id.0,
            completion.usage.total().unwrap_or(u64::MAX),
        );
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: format!(
                "agent_chat:{}:{}:{}",
                params.user_id.0, params.model_id.0, body_digest
            ),
        })
        .await?;
        log_settled(
            ActionSlug::AgentChat,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(AgentChatOutput {
            completion,
            receipt,
        })
    }
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct AgentChatOutput {
    pub completion: AgentChatCompletion,
    pub receipt: Receipt,
}

fn body_digest(body: &serde_json::Value) -> String {
    sha256_hex(body.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{AgentChatParams, AgentChatService, AgentChatServiceDeps, body_digest};
    use crate::pricing::PricingTable;
    use async_trait::async_trait;
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::{
        AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Authorization, AuthorizeRequest,
        ChargeRequest, Credits, DomainError, ModelId, OsAccountsClient, ProviderCredentials,
        Receipt, TokenUsage, UserId,
    };
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    #[test]
    fn body_digest_is_stable_full_sha256_hex() {
        let body = json!({
            "model": "text-model",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        let digest = body_digest(&body);

        assert_eq!(
            digest,
            "8791c5ca4cef8d9ea68549494f84e20e5f8224958d7b7aebc484dedb7b48e4ce"
        );
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    /// An OS Accounts double that always allows and charges what it is asked.
    struct AllowingOsAccounts;

    #[async_trait]
    impl OsAccountsClient for AllowingOsAccounts {
        async fn authorize(
            &self,
            _request: AuthorizeRequest,
        ) -> Result<Authorization, DomainError> {
            Ok(Authorization {
                allowed: true,
                action_token: Some("agt_test".to_string()),
                cap_credits: None,
                reason: None,
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    /// A completer that succeeds while reporting the usage it is handed, so a
    /// test can drive the pricing step into a specific failure.
    struct CompleterReporting(TokenUsage);

    #[async_trait]
    impl AgentChatCompleter for CompleterReporting {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            Ok(AgentChatCompletion {
                body: b"{\"choices\":[]}".to_vec(),
                content_type: "application/json".to_string(),
                provider: "test".to_string(),
                usage: self.0,
            })
        }
    }

    fn text_model_table() -> PricingTable {
        let mut models = BTreeMap::new();
        models.insert(
            "priced-text".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(70),
                output_credits_per_million_tokens: Some(300),
                cache_input_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Text,
                display_name: "priced-text".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        PricingTable::new(models)
    }

    fn service(usage: TokenUsage) -> AgentChatService {
        AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(text_model_table()),
            os_accounts: Arc::new(AllowingOsAccounts),
            chat_completer: Arc::new(CompleterReporting(usage)),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1,
        })
    }

    fn params() -> AgentChatParams {
        AgentChatParams {
            user_id: UserId("user_1".to_string()),
            model_id: ModelId("priced-text".to_string()),
            body: json!({ "model": "priced-text", "messages": [] }),
            provider_credentials: ProviderCredentials::default(),
        }
    }

    /// The completion already ran and billed upstream, so a pricing failure
    /// must not take the answer down with it. `u64::MAX` prompt tokens overflow
    /// `price_scaled`, which is the one pricing failure `ensure_model_kind`
    /// cannot rule out ahead of the call.
    #[tokio::test]
    async fn a_successful_completion_survives_a_pricing_failure() {
        let usage = TokenUsage {
            prompt_tokens: u64::MAX,
            completion_tokens: 10,
            ..TokenUsage::default()
        };

        let output = service(usage)
            .complete(params())
            .await
            .expect("a completed turn is returned even when it cannot be priced");

        assert_eq!(output.completion.body, b"{\"choices\":[]}".to_vec());
        assert_eq!(output.receipt.credits_charged, Credits(0));
    }

    /// The guard must not swallow real prices: a normal turn still settles.
    #[tokio::test]
    async fn a_priced_turn_still_charges_what_it_costs() {
        let usage = TokenUsage {
            prompt_tokens: 1_000_000,
            completion_tokens: 1_000_000,
            ..TokenUsage::default()
        };

        let output = service(usage).complete(params()).await.expect("completes");

        assert_eq!(output.receipt.credits_charged, Credits(370));
    }
}
