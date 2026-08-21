//! Embeddable composition root for the June API server.
//!
//! Historically the dependency-injection wiring lived in the `june` binary.
//! It moved here so two consumers can share it verbatim:
//!
//! - the `june` CLI binary (the desktop sidecar and server deployments),
//!   which loads config from `config.toml` + `JUNE__*` env vars; and
//! - the Sub Rosa mobile app, where subprocesses are forbidden (iOS) and the
//!   server instead runs on a Tokio task inside the app process, configured
//!   programmatically through [`EmbedOptions`].

use june_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo};
use june_config::{
    AppConfig, ModelPriceConfig, ModelProvider, OPENAI_API_KEY_PLACEHOLDER,
    VENICE_API_KEY_PLACEHOLDER,
};
use june_providers::{
    JwksTokenVerifier, LocalDevOsAccountsClient, LocalDevTokenVerifier, LogIssueReportSink,
    MultiFormatDurationProbe, NominatimPlaces, OsAccountsHttpClient, OsPlatformIssueReportSink,
    RoutingTranscriber, VeniceAgentChat, VeniceAugment, VeniceCleaner, VeniceGenerator,
    VeniceImageGenerator, VeniceModelCatalog, client_with_timeout, default_client, jwks_client,
};
use june_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps, ImageService,
    ImageServiceDeps, NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeService,
    NoteTranscribeServiceDeps, PlacesService, PricingTable, WebAugmentService,
    WebAugmentServiceDeps,
};
use std::{collections::BTreeMap, future::Future, net::SocketAddr, sync::Arc, time::Duration};

/// The repository's canonical pricing/model catalog, baked into the binary so
/// the embedded server never depends on a working directory or bundled
/// resource path (there is none inside an iOS app sandbox).
const EMBEDDED_CONFIG_TOML: &str = include_str!("../../../config.toml");

/// Runtime parameters for an in-process June API server. Mirrors what the
/// desktop sidecar manager passes to the `june-api` child process through
/// `JUNE__*` env vars.
#[derive(Debug, Clone)]
pub struct EmbedOptions {
    /// Loopback port to bind (the caller picks a free one).
    pub port: u16,
    /// Local-dev bearer token the client must present on every request.
    pub bearer_token: String,
    /// Local-dev user id (`usr_…`).
    pub user_id: String,
    /// OpenAI-compatible upstream (Carpe Diem) base URL.
    pub upstream_base_url: String,
    /// Upstream API key (`cdm_…`), read from the OS keychain by the caller.
    pub upstream_api_key: String,
}

/// Assemble the embedded server config: baked-in catalog defaults plus the
/// caller's runtime overrides, in local-dev mode on loopback.
pub fn embedded_config(options: &EmbedOptions) -> anyhow::Result<AppConfig> {
    let mut config = june_config::load_from_toml_str(EMBEDDED_CONFIG_TOML)?;
    config.server.host = "127.0.0.1".to_string();
    config.server.port = options.port;
    // Vision chat sends base64 images inside the completions JSON; the
    // catalog default (512 KiB) rejects them with 413. The embedded server
    // only listens on loopback for one local client, so a roomier cap is
    // safe.
    config.server.max_json_bytes = config.server.max_json_bytes.max(16 * 1024 * 1024);
    config.local_dev.enabled = true;
    config
        .local_dev
        .bearer_token
        .clone_from(&options.bearer_token);
    config.local_dev.user_id.clone_from(&options.user_id);
    config
        .upstreams
        .venice
        .base_url
        .clone_from(&options.upstream_base_url);
    config
        .upstreams
        .venice
        .api_key
        .clone_from(&options.upstream_api_key);
    june_config::validate_config(&config)?;
    Ok(config)
}

/// Run an in-process June API server on loopback until `shutdown` resolves.
///
/// Binding errors surface as `Err` before the server starts; the caller keeps
/// the returned future on a Tokio task and resolves `shutdown` to stop it.
pub async fn serve(
    options: EmbedOptions,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let config = embedded_config(&options)?;
    serve_config(&config, shutdown).await
}

/// Run a June API server for an already-validated config until `shutdown`
/// resolves. The `june` CLI binary calls this with a never-resolving future.
pub async fn serve_config(
    config: &AppConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let address: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    let http = default_client();
    let upstream_http = client_with_timeout(Duration::from_secs(
        config.server.request_timeout_secs.max(1),
    ));
    let pricing = load_pricing(config, upstream_http.clone()).await;
    let app = build_router(config, &http, &upstream_http, pricing);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "june-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

/// Merge the Venice model catalog into the configured pricing table (skipped
/// when the Venice upstream key is not configured).
pub async fn load_pricing(
    config: &AppConfig,
    http: reqwest::Client,
) -> BTreeMap<String, ModelPriceConfig> {
    let mut pricing = config.pricing.clone();
    if !provider_is_configured(config, ModelProvider::Venice) {
        tracing::info!("Venice API key is not configured; skipping Venice model catalog");
        return pricing;
    }
    match VeniceModelCatalog::from_config(http, &config.upstreams.venice)
        .priced_models()
        .await
    {
        Ok(models) => {
            let count = models.len();
            pricing.extend(models);
            tracing::info!(count, "loaded Venice model catalog");
        }
        Err(error) => {
            tracing::warn!(%error, "failed to load Venice model catalog; using configured model pricing only");
        }
    }
    pricing
}

// The dependency-injection composition root: it wires every provider and
// service into the router, so its length grows by a line or two with each new
// capability (image generation is the latest). Splitting it further would scatter
// the wiring without making it clearer.
#[allow(clippy::too_many_lines)]
pub fn build_router(
    config: &AppConfig,
    http: &reqwest::Client,
    upstream_http: &reqwest::Client,
    mut pricing_config: BTreeMap<String, ModelPriceConfig>,
) -> axum::Router {
    if config.local_dev.enabled {
        pricing_config = filter_unconfigured_provider_models(config, pricing_config);
    }

    let openai_model_ids = pricing_config
        .iter()
        .filter(|(_, model)| model.provider == ModelProvider::Openai)
        .map(|(model_id, _)| model_id.clone())
        .collect::<Vec<_>>();

    let pricing = Arc::new(PricingTable::new(pricing_config));
    let os_accounts = build_os_accounts_client(config, http);
    let transcriber: Arc<dyn june_domain::Transcriber> = Arc::new(RoutingTranscriber::from_config(
        upstream_http.clone(),
        &config.upstreams,
        openai_model_ids,
    ));
    let generator: Arc<dyn june_domain::Generator> = Arc::new(VeniceGenerator::from_config(
        upstream_http.clone(),
        &config.upstreams.venice,
    ));
    let cleaner: Arc<dyn june_domain::Cleaner> = Arc::new(VeniceCleaner::from_config(
        upstream_http.clone(),
        &config.upstreams.venice,
    ));
    let agent_chat_completer: Arc<dyn june_domain::AgentChatCompleter> = Arc::new(
        VeniceAgentChat::from_config(upstream_http.clone(), &config.upstreams.venice),
    );
    // One client backs both web traits (search + fetch) over the same Venice
    // credential and base URL.
    let web_augment = Arc::new(VeniceAugment::from_config(
        upstream_http.clone(),
        &config.upstreams.venice,
    ));
    let duration_probe: Arc<dyn june_domain::AudioDurationProbe> =
        Arc::new(MultiFormatDurationProbe);
    let token_verifier = build_token_verifier(config);
    let issue_reports = build_issue_report_sink(config, http);

    let flat_estimate_credits = config.os_accounts.flat_estimate_credits;

    let note_transcribe = Arc::new(NoteTranscribeService::new(NoteTranscribeServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        transcriber: transcriber.clone(),
        duration_probe: duration_probe.clone(),
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_transcribe_secs,
        flat_estimate_credits,
        preview_max_audio_seconds: config.os_accounts.note_transcribe_preview_max_audio_secs,
    }));
    let note_generate = Arc::new(NoteGenerateService::new(NoteGenerateServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        generator,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_generate_secs,
        flat_estimate_credits,
    }));
    let agent_chat = Arc::new(AgentChatService::new(AgentChatServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        chat_completer: agent_chat_completer,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_generate_secs,
        flat_estimate_credits,
    }));
    let web = Arc::new(WebAugmentService::new(WebAugmentServiceDeps {
        os_accounts: os_accounts.clone(),
        searcher: web_augment.clone() as Arc<dyn june_domain::WebSearcher>,
        fetcher: web_augment as Arc<dyn june_domain::WebFetcher>,
        search_credits: config.os_accounts.web_search_credits,
        fetch_credits: config.os_accounts.web_fetch_credits,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_web_secs,
    }));
    // Keyless places search (OSM/Nominatim): no metering, no key — the
    // provider enforces the public instance's UA + rate-limit obligations
    // itself. The UA identifies the app per Nominatim's usage policy.
    let places = Arc::new(PlacesService::new(Arc::new(NominatimPlaces::new(
        None,
        "SubRosa-june-api/1.0 (+https://github.com/Irdanwen/sub-rosa)",
    ))));
    let image = Arc::new(ImageService::new(ImageServiceDeps {
        os_accounts: os_accounts.clone(),
        generator: build_image_generator(upstream_http, &config.upstreams.venice),
        pricing: config.image_pricing.clone(),
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_image_secs,
    }));
    let dictate = Arc::new(DictateService::new(DictateServiceDeps {
        pricing: pricing.clone(),
        os_accounts,
        transcriber,
        cleaner,
        duration_probe,
        transcribe_hold_ttl_seconds: config
            .os_accounts
            .authorize_hold_ttl_dictate_transcribe_secs,
        cleanup_hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_dictate_cleanup_secs,
        flat_estimate_credits,
    }));

    let state = ApiState::new(ApiStateParams {
        pricing,
        token_verifier,
        note_transcribe,
        note_generate,
        agent_chat,
        dictate,
        web,
        places,
        image,
        issue_reports,
        limits: ApiLimits {
            max_audio_bytes: config.server.max_audio_bytes,
            max_json_bytes: config.server.max_json_bytes,
            request_timeout_secs: config.server.request_timeout_secs,
        },
        attestation: AttestationInfo {
            source_commit: config.attestation.source_commit.clone(),
            source_repo_url: config.attestation.source_repo_url.clone(),
            image_repo: config.attestation.image_repo.clone(),
            trust_center_url: config.attestation.trust_center_url.clone(),
        },
    });
    june_api::router(state)
}

fn build_image_generator(
    upstream_http: &reqwest::Client,
    venice: &june_config::UpstreamConfig,
) -> Arc<dyn june_domain::ImageGenerator> {
    Arc::new(VeniceImageGenerator::from_config(
        upstream_http.clone(),
        venice,
    ))
}

fn build_os_accounts_client(
    config: &AppConfig,
    http: &reqwest::Client,
) -> Arc<dyn june_domain::OsAccountsClient> {
    if config.local_dev.enabled {
        tracing::warn!("local dev mode enabled; OS Accounts metering is disabled");
        Arc::new(LocalDevOsAccountsClient)
    } else {
        Arc::new(OsAccountsHttpClient::from_config(
            http.clone(),
            &config.os_accounts,
        ))
    }
}

fn build_token_verifier(config: &AppConfig) -> Arc<dyn june_domain::TokenVerifier> {
    if config.local_dev.enabled {
        Arc::new(LocalDevTokenVerifier::new(
            config.local_dev.bearer_token.clone(),
            config.local_dev.user_id.clone(),
        ))
    } else {
        Arc::new(JwksTokenVerifier::from_config(
            jwks_client(),
            &config.os_accounts,
        ))
    }
}

fn filter_unconfigured_provider_models(
    config: &AppConfig,
    pricing_config: BTreeMap<String, ModelPriceConfig>,
) -> BTreeMap<String, ModelPriceConfig> {
    let original_len = pricing_config.len();
    let filtered = pricing_config
        .into_iter()
        .filter(|(_, model)| provider_is_configured(config, model.provider))
        .collect::<BTreeMap<_, _>>();
    let removed = original_len.saturating_sub(filtered.len());
    if removed > 0 {
        tracing::info!(
            removed,
            remaining = filtered.len(),
            "filtered models whose provider API keys are not configured"
        );
    }
    filtered
}

fn provider_is_configured(config: &AppConfig, provider: ModelProvider) -> bool {
    match provider {
        ModelProvider::Openai => {
            provider_key_is_configured(&config.upstreams.openai.api_key, OPENAI_API_KEY_PLACEHOLDER)
        }
        ModelProvider::Venice => {
            provider_key_is_configured(&config.upstreams.venice.api_key, VENICE_API_KEY_PLACEHOLDER)
        }
    }
}

fn provider_key_is_configured(api_key: &str, placeholder: &str) -> bool {
    let api_key = api_key.trim();
    !api_key.is_empty() && api_key != placeholder
}

fn build_issue_report_sink(
    config: &AppConfig,
    http: &reqwest::Client,
) -> Arc<dyn june_domain::IssueReportSink> {
    if let Some(sink) = OsPlatformIssueReportSink::from_config(http.clone(), &config.issue_reports)
    {
        tracing::info!("issue reports will be filed as os-platform issues");
        Arc::new(sink)
    } else {
        tracing::info!("no issue report sink configured; reports will be logged only");
        Arc::new(LogIssueReportSink)
    }
}
