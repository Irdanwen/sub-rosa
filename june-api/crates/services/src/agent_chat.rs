use crate::{
    charge_flow::{
        AsyncChargeParams, AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap,
        log_settled, price_settled_work, settle_charge,
    },
    error::ServiceError,
    pricing::PricingTable,
    util::sha256_hex,
};
use june_domain::{
    ActionSlug, AgentChatByteStream, AgentChatCompleter, AgentChatCompletion, AgentChatRequest,
    AgentChatResponse, AgentChatUsage, Credits, ModelId, ModelKind, OsAccountsClient,
    ProviderCredentials, Receipt, UserId,
};
use std::{fmt, sync::Arc};

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
        let response = self
            .chat_completer
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let idempotency_key = format!(
            "agent_chat:{}:{}:{}",
            params.user_id.0, params.model_id.0, body_digest
        );
        let completion = match response {
            AgentChatResponse::Buffered(completion) => completion,
            AgentChatResponse::Streamed(stream) => {
                // The body goes back to the client now; the charge waits for
                // the usage, which only exists once the stream has ended
                // (ADR-0063). The task lives exactly as long as the stream.
                tokio::spawn(settle_streamed_turn(StreamedSettlement {
                    usage: stream.usage,
                    pricing: Arc::clone(&self.pricing),
                    os_accounts: Arc::clone(&self.os_accounts),
                    user_id: params.user_id,
                    model_id: params.model_id,
                    action_token: authorization.action_token,
                    cap_credits: authorization.cap_credits,
                    idempotency_key,
                }));
                return Ok(AgentChatOutput::Streaming {
                    body: stream.body,
                    content_type: stream.content_type,
                });
            }
        };
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
            idempotency_key,
        })
        .await?;
        log_settled(
            ActionSlug::AgentChat,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(AgentChatOutput::Settled {
            completion,
            receipt,
        })
    }
}

/// Everything needed to charge a streamed turn once its usage is known.
struct StreamedSettlement {
    usage: AgentChatUsage,
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    user_id: UserId,
    model_id: ModelId,
    action_token: String,
    cap_credits: Option<Credits>,
    idempotency_key: String,
}

/// Charges a streamed turn when its stream is over.
///
/// A stream the client abandoned is charged too, on the usage seen before it
/// left, which is usually nothing because the billing frame comes last. That
/// under-charges a turn the upstream may have partly billed, and it is the
/// right way round: the alternative is to keep reading a generation nobody
/// will see just to learn its price, or to guess one. A charge failure can no
/// longer reach the client, whose answer is already delivered; it is logged.
async fn settle_streamed_turn(settlement: StreamedSettlement) {
    let usage = settlement.usage.await;
    let actual = price_settled_work(
        settlement
            .pricing
            .price_token_usage(&settlement.model_id.0, usage),
        ActionSlug::AgentChat,
        &settlement.model_id.0,
        usage.total().unwrap_or(u64::MAX),
    );
    settle_charge(AsyncChargeParams {
        os_accounts: settlement.os_accounts,
        user_id: settlement.user_id,
        action: ActionSlug::AgentChat,
        model_id: Some(settlement.model_id.0),
        action_token: settlement.action_token,
        credits: clamp_to_cap(actual, settlement.cap_credits),
        idempotency_key: settlement.idempotency_key,
    })
    .await;
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
    pub provider_credentials: ProviderCredentials,
}

pub enum AgentChatOutput {
    /// A buffered completion, charged before it is returned.
    Settled {
        completion: AgentChatCompletion,
        receipt: Receipt,
    },
    /// A completion still being generated. Its charge settles on its own once
    /// the stream ends, so there is no receipt and no usage to report yet.
    Streaming {
        body: AgentChatByteStream,
        content_type: String,
    },
}

impl fmt::Debug for AgentChatOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Settled {
                completion,
                receipt,
            } => formatter
                .debug_struct("Settled")
                .field("completion", completion)
                .field("receipt", receipt)
                .finish(),
            Self::Streaming { content_type, .. } => formatter
                .debug_struct("Streaming")
                .field("content_type", content_type)
                .finish_non_exhaustive(),
        }
    }
}

fn body_digest(body: &serde_json::Value) -> String {
    sha256_hex(body.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{
        AgentChatOutput, AgentChatParams, AgentChatService, AgentChatServiceDeps, body_digest,
    };
    use crate::pricing::PricingTable;
    use async_trait::async_trait;
    use bytes::Bytes;
    use futures_util::StreamExt;
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::{
        AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AgentChatResponse,
        AgentChatStream, Authorization, AuthorizeRequest, ChargeRequest, Credits, DomainError,
        ModelId, OsAccountsClient, ProviderCredentials, Receipt, TokenUsage, UserId,
    };
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use tokio::sync::{mpsc, oneshot};

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
        ) -> Result<AgentChatResponse, DomainError> {
            Ok(AgentChatCompletion {
                body: b"{\"choices\":[]}".to_vec(),
                content_type: "application/json".to_string(),
                provider: "test".to_string(),
                usage: self.0,
            }
            .into())
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

        let AgentChatOutput::Settled {
            completion,
            receipt,
        } = output
        else {
            panic!("a buffered completion is settled before it is returned");
        };
        assert_eq!(completion.body, b"{\"choices\":[]}".to_vec());
        assert_eq!(receipt.credits_charged, Credits(0));
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

        let AgentChatOutput::Settled { receipt, .. } = output else {
            panic!("a buffered completion is settled before it is returned");
        };
        assert_eq!(receipt.credits_charged, Credits(370));
    }

    /// An OS Accounts double that allows everything and reports each charge.
    struct RecordingOsAccounts {
        charges: mpsc::UnboundedSender<ChargeRequest>,
    }

    #[async_trait]
    impl OsAccountsClient for RecordingOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            AllowingOsAccounts.authorize(request).await
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            let credits = request.credits;
            let _ = self.charges.send(request);
            Ok(Receipt {
                credits_charged: credits,
                idempotent_replay: false,
            })
        }
    }

    /// A completer that hands back a stream the test feeds by hand, with a
    /// usage the test resolves when it decides the stream is over.
    struct StreamingCompleter {
        parts: Mutex<
            Option<(
                mpsc::UnboundedReceiver<Bytes>,
                oneshot::Receiver<TokenUsage>,
            )>,
        >,
    }

    #[async_trait]
    impl AgentChatCompleter for StreamingCompleter {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatResponse, DomainError> {
            let (mut chunks, usage) = self
                .parts
                .lock()
                .expect("lock")
                .take()
                .expect("one turn per test");
            let body =
                futures_util::stream::poll_fn(move |context| chunks.poll_recv(context)).map(Ok);
            Ok(AgentChatStream {
                body: Box::pin(body),
                content_type: "text/event-stream".to_string(),
                provider: "test".to_string(),
                usage: Box::pin(async move { usage.await.unwrap_or_default() }),
            }
            .into())
        }
    }

    /// A streamed turn goes back to the client before it is charged, and is
    /// charged once its usage is known, on that usage.
    #[tokio::test]
    async fn a_streamed_turn_is_charged_after_its_stream_ends() {
        let (chunk_tx, chunk_rx) = mpsc::unbounded_channel();
        let (usage_tx, usage_rx) = oneshot::channel();
        let (charge_tx, mut charges) = mpsc::unbounded_channel();
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(text_model_table()),
            os_accounts: Arc::new(RecordingOsAccounts { charges: charge_tx }),
            chat_completer: Arc::new(StreamingCompleter {
                parts: Mutex::new(Some((chunk_rx, usage_rx))),
            }),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1,
        });

        let output = service.complete(params()).await.expect("completes");
        let AgentChatOutput::Streaming {
            mut body,
            content_type,
        } = output
        else {
            panic!("a streamed completion is returned before it is settled");
        };
        assert_eq!(content_type, "text/event-stream");

        chunk_tx
            .send(Bytes::from_static(b"data: {}\n\n"))
            .expect("send");
        assert_eq!(
            body.next()
                .await
                .expect("a chunk")
                .expect("an unbroken stream"),
            Bytes::from_static(b"data: {}\n\n")
        );
        tokio::task::yield_now().await;
        assert!(
            charges.try_recv().is_err(),
            "nothing is charged while the stream is still running"
        );

        drop(chunk_tx);
        assert!(body.next().await.is_none());
        usage_tx
            .send(TokenUsage {
                prompt_tokens: 1_000_000,
                completion_tokens: 1_000_000,
                ..TokenUsage::default()
            })
            .expect("usage");
        let charge = tokio::time::timeout(std::time::Duration::from_secs(1), charges.recv())
            .await
            .expect("the charge settles once the usage is known")
            .expect("a charge");
        assert_eq!(charge.credits, Credits(370));
        assert_eq!(charge.action_token, "agt_test");
        assert!(
            charge
                .idempotency_key
                .starts_with("agent_chat:user_1:priced-text:")
        );
    }
}
