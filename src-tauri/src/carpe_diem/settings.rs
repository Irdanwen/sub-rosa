//! Carpe Diem settings storage + IPC.
//!
//! Two pieces of configuration drive the fork:
//! - `base_url` (NOT secret) — persisted as JSON in the app config dir.
//! - `api_key` (`cdm_…`, secret) — stored in the OS keychain via the `keyring`
//!   crate, never written to disk in plaintext and never returned to the
//!   frontend once saved (only a `has_api_key` boolean is exposed).
//!
//! The `june-api` sidecar ([`super::sidecar`]) reads [`base_url`] and
//! [`api_key`] at spawn time to point the backend at Carpe Diem.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

use super::branding;

const SETTINGS_FILE: &str = "carpe-diem.json";
const KEYCHAIN_ACCOUNT: &str = "api-key";
// Dedicated keychain service (separate from the dormant OS Accounts store) so
// the Carpe Diem key is clearly scoped. Debug builds use a `-dev` service to
// keep development credentials isolated from a release install.
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa.carpe-diem";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa-dev.carpe-diem";
const MAX_API_KEY_CHARS: usize = 4_096;
const MAX_BASE_URL_CHARS: usize = 2_048;
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

static SETTINGS: OnceLock<Mutex<CarpeDiemSettings>> = OnceLock::new();

/// Non-secret settings persisted to `carpe-diem.json`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CarpeDiemSettings {
    #[serde(default = "default_base_url")]
    pub base_url: String,
}

impl Default for CarpeDiemSettings {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
        }
    }
}

/// What the frontend sees. The API key itself is never included — only whether
/// one is stored.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CarpeDiemSettingsDto {
    pub base_url: String,
    pub default_base_url: String,
    /// The two endpoint choices the Settings UI offers instead of a free-form
    /// URL, both built from the current base's operator root:
    /// - `router_base_url` — the `/router` best-price aggregator (chat routed to
    ///   the cheapest market, may leave Carpe Diem's confidential network);
    /// - `v1_base_url` — the `/v1` private rail (every request stays inside
    ///   Carpe Diem's confidential network, standard price).
    ///
    /// The UI stores whichever the user picks via `carpe_diem_set_base_url`.
    pub router_base_url: String,
    pub v1_base_url: String,
    pub has_api_key: bool,
}

/// Result of the "Test connection" button — success plus an actionable message.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_count: Option<usize>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Live balance shown in the sidebar footer. `price_multiplier` is the
/// current Carpe Diem fraction of the upstream Venice rate (a global daily
/// factor that resets at 00:00 UTC); it is `None` when the public pricing
/// endpoint can't be read — the balance still shows without it. When the
/// stored key is a Venice key (no `cdm_` prefix) the balance comes from
/// Venice, converted to credits (1 credit = $0.01), and the factor is a
/// fixed 1.0 since Venice bills at full rate.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarpeDiemCreditsDto {
    pub available_credits: f64,
    pub escrow_credits: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_multiplier: Option<f64>,
    /// The rail this balance is FOR (`"credits"` | `"prepaid"`), so the footer
    /// shows the balance that actually pays — not always the credits pool. The
    /// prepaid figure is the account's USDC converted to credits (1 credit =
    /// $0.01). `None` for Venice keys (no rails).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail: Option<String>,
    /// When the ACTIVE rail is out of funds but the OTHER rail holds money, the
    /// rail to propose switching to (`"credits"` | `"prepaid"`). Lets the app
    /// offer a one-click switch instead of letting the request 402. `None` when
    /// the active rail can pay, or nothing is elsewhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggest_switch_to: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBaseUrlRequest {
    pub base_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiKeyRequest {
    pub api_key: String,
}

/// Managed state: only the on-disk path. The live values live in [`SETTINGS`]
/// (base URL) and the OS keychain (API key).
pub struct CarpeDiemState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    let loaded = load_from_disk(path.as_ref());
    set_mirror(loaded);
    app.manage(CarpeDiemState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

// --- Values read by the sidecar --------------------------------------------

/// Current Carpe Diem base URL — the **inference rail** (falls back to the
/// default when unset/empty). This is what chat, embeddings, and audio
/// transcription hit, so a `/router` base routes them through the best-price
/// aggregator. Endpoints absent from `/router` derive their base from
/// [`catalog_base_url`] / [`operator_root`] instead.
pub fn base_url() -> String {
    let guard = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    let value = guard.base_url.trim().trim_end_matches('/').to_string();
    drop(guard);
    if value.is_empty() {
        default_base_url()
    } else {
        value
    }
}

/// Operator root: [`base_url`] minus a trailing `/router` or `/v1` rail segment
/// (e.g. `https://carpe-diem.xyz/api/operator`). Carpe Diem serves public
/// `/pricing` at this root, one level above either rail.
pub fn operator_root() -> String {
    operator_root_of(&base_url())
}

/// The `/v1` catalog rail, for endpoints Carpe Diem does NOT expose under the
/// `/router` best-price aggregator: the model catalog (`/models`), image/video
/// generation and the media proxy (`/image/*`, `/video/*`), and billing
/// (`/credits`, `/prepaid/*`). When the stored base targets `/router` this
/// rewrites it to `/v1`; a `/v1` base, a Venice-direct base, or a suffix-less
/// base is returned unchanged.
pub fn catalog_base_url() -> String {
    catalog_base_url_of(&base_url())
}

/// The catalog (`/v1`) form of the *default* base URL — the standard Carpe Diem
/// endpoint every account has. Used to decide whether a customized base must be
/// forwarded to side services that bill on `/v1` (Videomaker).
pub fn default_catalog_base_url() -> String {
    catalog_base_url_of(&default_base_url())
}

/// Pure core of [`operator_root`] (see it for semantics). Split out so it is
/// testable without touching the process-global settings mirror.
fn operator_root_of(base: &str) -> String {
    let base = base.trim_end_matches('/');
    base.strip_suffix("/router")
        .or_else(|| base.strip_suffix("/v1"))
        .unwrap_or(base)
        .to_string()
}

/// Pure core of [`catalog_base_url`] (see it for semantics).
fn catalog_base_url_of(base: &str) -> String {
    let base = base.trim_end_matches('/');
    match base.strip_suffix("/router") {
        Some(root) => format!("{root}/v1"),
        None => base.to_string(),
    }
}

/// The stored Carpe Diem API key, if any. Reads the OS keychain synchronously
/// (fine for the sidecar's setup path, which is not on the async runtime).
pub fn api_key() -> Option<String> {
    // Debug convenience: inject the key via env for `pnpm tauri:dev` without
    // touching the OS keychain (mirrors June's OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE
    // escape hatch). Never compiled into release builds.
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("SUBROSA_DEV_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Whether the app has enough configuration to run (a key is present).
pub fn is_configured() -> bool {
    api_key().is_some()
}

// --- IPC commands ----------------------------------------------------------

#[tauri::command]
pub fn carpe_diem_get_settings() -> CarpeDiemSettingsDto {
    dto()
}

#[tauri::command]
pub fn carpe_diem_set_base_url(
    app: AppHandle,
    state: State<'_, CarpeDiemState>,
    request: SetBaseUrlRequest,
) -> Result<CarpeDiemSettingsDto, AppError> {
    let base_url = validate_base_url(&request.base_url)?;
    persist(
        &state.config_path,
        &CarpeDiemSettings {
            base_url: base_url.clone(),
        },
    )?;
    replace_mirror(CarpeDiemSettings { base_url });
    super::sidecar::on_settings_changed(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_set_api_key(
    app: AppHandle,
    request: SetApiKeyRequest,
) -> Result<CarpeDiemSettingsDto, AppError> {
    let key = normalize_api_key(&request.api_key)?;
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .and_then(|entry| entry.set_password(&key))
    })
    .await
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?;
    super::sidecar::on_settings_changed(&app);
    // Videomaker bills whatever key is registered server-side; keep it in
    // sync with a rotated key (best-effort, desktop-only surface).
    #[cfg(desktop)]
    crate::videomaker::on_carpe_diem_key_changed(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_clear_api_key(app: AppHandle) -> Result<CarpeDiemSettingsDto, AppError> {
    tokio::task::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            // Absent entry is not an error — clearing an unset key is a no-op.
            let _ = entry.delete_credential();
        }
    })
    .await
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?;
    super::sidecar::on_settings_changed(&app);
    // A removed key should stop billing entirely: delete Videomaker's
    // server-side copy too (best-effort, desktop-only surface).
    #[cfg(desktop)]
    crate::videomaker::on_carpe_diem_key_cleared(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_test_connection() -> Result<TestConnectionResult, AppError> {
    let base = base_url();
    let Some(key) = api_key() else {
        return Ok(TestConnectionResult {
            ok: false,
            model_count: None,
            message: "No API key set yet. Enter your Carpe Diem key (cdm_…) first.".to_string(),
            code: Some("no_api_key".to_string()),
        });
    };

    let client = reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("carpe_diem_http_client", error.to_string()))?;
    let base = base.trim_end_matches('/').to_string();
    // The catalog lives only on the `/v1` rail; the chat probe below uses the
    // inference rail (`base`) so the test exercises whatever chat actually hits.
    let catalog = catalog_base_url();

    // 1) Reachability + catalog size (public on Carpe Diem, so proves the URL).
    let model_count = match client
        .get(format!("{catalog}/models"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("data")
                    .and_then(|data| data.as_array())
                    .map(|models| models.len())
            }),
        Ok(_) => None,
        Err(error) => {
            return Ok(unreachable_result(&base, error.is_timeout(), None));
        }
    };

    // 2) A minimal authenticated completion validates the key AND credits.
    let body = serde_json::json!({
        "model": crate::providers::DEFAULT_GENERATION_MODEL,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });
    match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Ok(TestConnectionResult {
            ok: true,
            model_count,
            message: match model_count {
                Some(count) => format!("Connected. {count} models available."),
                None => "Connected.".to_string(),
            },
            code: None,
        }),
        Ok(response) => {
            let (code, message) = match response.status().as_u16() {
                401 | 403 => (
                    "invalid_key",
                    "The API key was rejected. Check that you pasted the full cdm_ key.",
                ),
                402 => (
                    "insufficient_credits",
                    "The key is valid but has no credits. Add credits in the Carpe Diem dashboard.",
                ),
                404 => (
                    "endpoint_or_model",
                    "Endpoint or model not found. Check that the base URL is correct.",
                ),
                429 => ("rate_limited", "Rate limited. Try again in a moment."),
                _ => (
                    "upstream_error",
                    "The endpoint returned an error. Try again.",
                ),
            };
            Ok(TestConnectionResult {
                ok: false,
                model_count,
                message: message.to_string(),
                code: Some(code.to_string()),
            })
        }
        Err(error) => Ok(unreachable_result(&base, error.is_timeout(), model_count)),
    }
}

#[tauri::command]
pub async fn carpe_diem_get_credits() -> Result<CarpeDiemCreditsDto, AppError> {
    let Some(key) = api_key() else {
        return Err(AppError::new(
            "carpe_diem_no_api_key",
            "No Carpe Diem API key is stored yet.",
        ));
    };

    let client = reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("carpe_diem_http_client", error.to_string()))?;
    // Billing (`/credits`, `/prepaid/*`, `/api_keys/rate_limits`) and pricing
    // live only on the `/v1` rail, never `/router`.
    let base = catalog_base_url();

    // Route by key prefix (the fork's rule): `cdm_` keys talk to Carpe Diem;
    // any other key is a Venice key pointed straight at api.venice.ai, which
    // bills at full rate — hence the fixed ×1.00 factor on that path.
    if key.starts_with("cdm_") {
        carpe_diem_credits(&client, &base, &key).await
    } else {
        venice_credits(&client, &base, &key).await
    }
}

async fn carpe_diem_credits(
    client: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<CarpeDiemCreditsDto, AppError> {
    let credits = client
        .get(format!("{base}/credits"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| AppError::new("carpe_diem_credits_unreachable", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("carpe_diem_credits_failed", error.to_string()))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| AppError::new("carpe_diem_credits_failed", error.to_string()))?;

    // `availableCredits` (escrow − pending − holds) is the only spendable
    // figure; `escrowCredits` includes charges the user can't spend against.
    let pool_available = credits
        .get("availableCredits")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| {
            AppError::new(
                "carpe_diem_credits_failed",
                "The credits response is missing availableCredits.",
            )
        })?;
    let pool_escrow = credits
        .get("escrowCredits")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(pool_available);
    let pool_usdc = credits
        .get("availableUsdc")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(pool_available / 100.0);

    // Rail-aware: the footer must show the balance that ACTUALLY pays, not always
    // the credits pool — a prepaid rail spends the prepaid account, and showing
    // the (unused) pool there is exactly what hid the empty-rail 402. Best-effort:
    // default to the pool if the rail endpoints are absent.
    let rail_json = billing_get_json(client, &format!("{base}/prepaid/rail"), key)
        .await
        .ok();
    let raw_rail = rail_json
        .as_ref()
        .and_then(|value| value.get("rail").and_then(serde_json::Value::as_str))
        .unwrap_or("credits");
    let has_prepaid = rail_json
        .as_ref()
        .and_then(|value| {
            value
                .get("hasPrepaidAccount")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    let rail = effective_rail(raw_rail, has_prepaid);

    // Always read the prepaid balance: it's the active balance on the prepaid
    // rail AND the "funds elsewhere" signal that drives the switch proposal.
    let prepaid_usdc = billing_get_json(client, &format!("{base}/prepaid/status"), key)
        .await
        .ok()
        .and_then(|value| parse_decimal(value.get("usdcBalance")))
        .unwrap_or(0.0);

    let (available_credits, escrow_credits) = if rail == "prepaid" {
        // Prepaid account USDC → credits-equivalent (1 credit = $0.01).
        let credits_equiv = prepaid_usdc * 100.0;
        (credits_equiv, credits_equiv)
    } else {
        (pool_available, pool_escrow)
    };

    // Proactive: when the active rail can't pay but the other rail holds money,
    // tell the app which rail to offer switching to — instead of a bare 402.
    let suggest_switch_to = suggest_switch(rail, prepaid_usdc, pool_usdc).map(str::to_string);

    // Pricing is public and lives at the operator root (the base URL minus its
    // /v1 suffix). The multiplier is global for the day, so any entry is
    // representative.
    let pricing_base = base.strip_suffix("/v1").unwrap_or(base);
    let price_multiplier = match client.get(format!("{pricing_base}/pricing")).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|pricing| first_multiplier(&pricing)),
        _ => None,
    };

    Ok(CarpeDiemCreditsDto {
        available_credits,
        escrow_credits,
        price_multiplier,
        rail: Some(rail.to_string()),
        suggest_switch_to,
    })
}

/// The rail that actually pays: `"auto"` resolves to the prepaid account when
/// one is registered, else the credits pool. Mirrors `deriveBilling` in the
/// frontend so the footer balance and the Payment panel agree.
fn effective_rail(rail: &str, has_prepaid_account: bool) -> &'static str {
    match rail {
        "prepaid" => "prepaid",
        "credits" => "credits",
        _ if has_prepaid_account => "prepaid",
        _ => "credits",
    }
}

/// If the ACTIVE rail can't cover even a trivial request (< 1 cent) but the
/// OTHER rail holds funds, which rail to propose switching to — else `None`.
/// Both balances are in USDC.
fn suggest_switch(rail: &str, prepaid_usdc: f64, pool_usdc: f64) -> Option<&'static str> {
    const MIN_SPENDABLE_USDC: f64 = 0.01;
    let (active, other, other_rail) = if rail == "prepaid" {
        (prepaid_usdc, pool_usdc, "credits")
    } else {
        (pool_usdc, prepaid_usdc, "prepaid")
    };
    if active < MIN_SPENDABLE_USDC && other >= MIN_SPENDABLE_USDC {
        Some(other_rail)
    } else {
        None
    }
}

async fn venice_credits(
    client: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<CarpeDiemCreditsDto, AppError> {
    // `/billing/balance` needs an ADMIN key, so read the balances off
    // `/api_keys/rate_limits`, which any INFERENCE key may call.
    let rate_limits = client
        .get(format!("{base}/api_keys/rate_limits"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| AppError::new("carpe_diem_credits_unreachable", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("carpe_diem_credits_failed", error.to_string()))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| AppError::new("carpe_diem_credits_failed", error.to_string()))?;

    let available_credits = venice_available_credits(&rate_limits).ok_or_else(|| {
        AppError::new(
            "carpe_diem_credits_failed",
            "The rate-limits response is missing balances.",
        )
    })?;

    Ok(CarpeDiemCreditsDto {
        available_credits,
        escrow_credits: available_credits,
        price_multiplier: Some(1.0),
        rail: None,
        suggest_switch_to: None,
    })
}

/// Rail-aware payment view for the Settings › Carpe Diem "Payment" panel.
///
/// Carpe Diem bills through one of two rails the user owns: a self-custodial
/// **prepaid account** (USDC, withdrawable) and a non-refundable **credits**
/// pool (1 credit = $0.01), plus x402 for agents. `rail` = `"auto"` prefers the
/// prepaid account when one is registered; and when `rail_fallback` is false, an
/// **empty active rail returns 402 even if the other rail has funds**. Surfacing
/// all of this is the whole point of the panel: an empty prepaid account while
/// credits sit unused is exactly what silently 402s a request while the balance
/// *looks* fine (the sidebar footer shows the credits pool, not the active
/// rail). Carpe Diem keys only — Venice keys have no rails.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarpeDiemBillingDto {
    /// The shared, non-refundable credits pool.
    pub available_credits: f64,
    /// The same pool in dollars (`availableUsdc`).
    pub available_usdc: f64,
    /// The separate self-custodial prepaid account (USDC).
    pub prepaid_registered: bool,
    pub prepaid_usdc_balance: f64,
    /// Active rail: `"auto" | "credits" | "prepaid"`.
    pub rail: String,
    /// Whether an empty active rail falls back to the other one.
    pub rail_fallback: bool,
    pub has_prepaid_account: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRailRequest {
    pub rail: String,
}

/// Aggregate the rail-aware billing view (credits pool + prepaid account +
/// active rail). Carpe Diem keys only.
#[tauri::command]
pub async fn carpe_diem_get_billing() -> Result<CarpeDiemBillingDto, AppError> {
    let (base, key, client) = billing_ctx()?;
    fetch_billing(&client, &base, &key).await
}

/// Switch the active payment rail (`auto` / `credits` / `prepaid`) and return
/// the refreshed billing view. This is the in-app escape hatch for the "empty
/// prepaid, unused credits" trap: force `credits` to spend the pool.
#[tauri::command]
pub async fn carpe_diem_set_rail(request: SetRailRequest) -> Result<CarpeDiemBillingDto, AppError> {
    let rail = request.rail.trim();
    if !matches!(rail, "auto" | "credits" | "prepaid") {
        return Err(AppError::new(
            "carpe_diem_invalid_rail",
            "Rail must be auto, credits, or prepaid.",
        ));
    }
    let (base, key, client) = billing_ctx()?;
    client
        .post(format!("{base}/prepaid/rail"))
        .bearer_auth(&key)
        .json(&serde_json::json!({ "rail": rail }))
        .send()
        .await
        .map_err(|error| AppError::new("carpe_diem_billing_unreachable", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("carpe_diem_set_rail_failed", error.to_string()))?;
    fetch_billing(&client, &base, &key).await
}

/// Shared setup for the billing commands: the base URL, a `cdm_` key, and an
/// HTTP client. Rejects Venice keys (no payment rails there).
fn billing_ctx() -> Result<(String, String, reqwest::Client), AppError> {
    let Some(key) = api_key() else {
        return Err(AppError::new(
            "carpe_diem_no_api_key",
            "No Carpe Diem API key is stored yet.",
        ));
    };
    if !key.starts_with("cdm_") {
        return Err(AppError::new(
            "carpe_diem_billing_unsupported",
            "Payment rails apply to Carpe Diem keys only.",
        ));
    }
    // Billing endpoints (`/credits`, `/prepaid/*`) live only on the `/v1` rail.
    let base = catalog_base_url();
    let client = reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("carpe_diem_http_client", error.to_string()))?;
    Ok((base, key, client))
}

async fn fetch_billing(
    client: &reqwest::Client,
    base: &str,
    key: &str,
) -> Result<CarpeDiemBillingDto, AppError> {
    // The credits pool is authoritative — a shape change here is a real error.
    let credits = billing_get_json(client, &format!("{base}/credits"), key).await?;
    let available_credits = credits
        .get("availableCredits")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| {
            AppError::new(
                "carpe_diem_billing_failed",
                "The credits response is missing availableCredits.",
            )
        })?;
    let available_usdc = credits
        .get("availableUsdc")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(available_credits / 100.0);

    // Rail + prepaid status are best-effort: a partial account (no prepaid) must
    // still render a credits-only picture, never break the panel.
    let rail_json = billing_get_json(client, &format!("{base}/prepaid/rail"), key)
        .await
        .ok();
    let (rail, rail_fallback, has_prepaid_account) = rail_json
        .as_ref()
        .map(|value| {
            (
                value
                    .get("rail")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("auto")
                    .to_string(),
                value
                    .get("fallback")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                value
                    .get("hasPrepaidAccount")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            )
        })
        .unwrap_or_else(|| ("credits".to_string(), false, false));

    let status_json = billing_get_json(client, &format!("{base}/prepaid/status"), key)
        .await
        .ok();
    let prepaid_registered = status_json
        .as_ref()
        .and_then(|value| value.get("registered").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    let prepaid_usdc_balance = status_json
        .as_ref()
        .and_then(|value| parse_decimal(value.get("usdcBalance")))
        .unwrap_or(0.0);

    Ok(CarpeDiemBillingDto {
        available_credits,
        available_usdc,
        prepaid_registered,
        prepaid_usdc_balance,
        rail,
        rail_fallback,
        has_prepaid_account,
    })
}

async fn billing_get_json(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<serde_json::Value, AppError> {
    client
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| AppError::new("carpe_diem_billing_unreachable", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("carpe_diem_billing_failed", error.to_string()))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| AppError::new("carpe_diem_billing_failed", error.to_string()))
}

/// Carpe Diem returns on-chain USDC amounts as 6-decimal STRINGS
/// (e.g. `"4.642904"`); tolerate a bare number too.
fn parse_decimal(value: Option<&serde_json::Value>) -> Option<f64> {
    let value = value?;
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<f64>().ok())
    })
}

// --- internals -------------------------------------------------------------

fn first_multiplier(pricing: &serde_json::Value) -> Option<f64> {
    ["models", "fixedCost"].iter().find_map(|section| {
        pricing
            .get(section)?
            .as_array()?
            .iter()
            .find_map(|entry| entry.get("multiplier").and_then(serde_json::Value::as_f64))
    })
}

/// Venice balances are dollar-denominated (USD prepaid + DIEM, which is ≈ USD);
/// 1 credit = $0.01, so the spendable total converts at ×100. `DIEM` is null
/// when the account isn't staking — treat each missing bucket as zero, but
/// require at least one so a shape change surfaces as an error, not "0 credits".
fn venice_available_credits(rate_limits: &serde_json::Value) -> Option<f64> {
    let balances = rate_limits.get("data")?.get("balances")?;
    let usd = balances.get("USD").and_then(serde_json::Value::as_f64);
    let diem = balances.get("DIEM").and_then(serde_json::Value::as_f64);
    if usd.is_none() && diem.is_none() {
        return None;
    }
    Some((usd.unwrap_or(0.0) + diem.unwrap_or(0.0)) * 100.0)
}

fn unreachable_result(
    base: &str,
    timeout: bool,
    model_count: Option<usize>,
) -> TestConnectionResult {
    let message = if timeout {
        format!("{base} timed out. Check your connection and the base URL.")
    } else {
        format!("Couldn't reach {base}. Check the base URL and your connection.")
    };
    TestConnectionResult {
        ok: false,
        model_count,
        message,
        code: Some("unreachable".to_string()),
    }
}

fn dto() -> CarpeDiemSettingsDto {
    let root = operator_root();
    CarpeDiemSettingsDto {
        base_url: base_url(),
        default_base_url: default_base_url(),
        router_base_url: format!("{root}/router"),
        v1_base_url: format!("{root}/v1"),
        has_api_key: api_key().is_some(),
    }
}

fn default_base_url() -> String {
    branding::CARPE_DIEM_DEFAULT_BASE_URL.to_string()
}

fn mirror() -> &'static Mutex<CarpeDiemSettings> {
    SETTINGS.get_or_init(|| Mutex::new(CarpeDiemSettings::default()))
}

fn set_mirror(settings: CarpeDiemSettings) {
    replace_mirror(settings);
}

fn replace_mirror(settings: CarpeDiemSettings) {
    // Recover a poisoned lock so a prior panic can't silently drop settings
    // updates (which would diverge the in-memory mirror from disk).
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> CarpeDiemSettings {
    let Some(path) = path else {
        return CarpeDiemSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CarpeDiemSettings>(&raw).ok())
        .map(|settings| CarpeDiemSettings {
            base_url: {
                let trimmed = settings.base_url.trim().trim_end_matches('/');
                if trimmed.is_empty() {
                    default_base_url()
                } else {
                    trimmed.to_string()
                }
            },
        })
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &CarpeDiemSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))?;
    fs::write(path, serialized)
        .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))
}

fn validate_base_url(raw: &str) -> Result<String, AppError> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err(AppError::new(
            "carpe_diem_base_url_required",
            "Enter a base URL.",
        ));
    }
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        return Err(AppError::new(
            "carpe_diem_base_url_invalid",
            "The base URL must start with http:// or https://.",
        ));
    }
    if value.chars().count() > MAX_BASE_URL_CHARS
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::new(
            "carpe_diem_base_url_invalid",
            "That base URL is not valid.",
        ));
    }
    // Require a non-empty host after the scheme (rejects `http://` and `https:///…`).
    let host = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    if host.is_empty() {
        return Err(AppError::new(
            "carpe_diem_base_url_invalid",
            "The base URL is missing a host.",
        ));
    }
    Ok(value.to_string())
}

fn normalize_api_key(raw: &str) -> Result<String, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::new(
            "carpe_diem_api_key_required",
            "Enter your Carpe Diem API key (cdm_…).",
        ));
    }
    if value.chars().count() > MAX_API_KEY_CHARS || value.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            "carpe_diem_api_key_invalid",
            "That does not look like a valid API key.",
        ));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_switch_proposes_the_funded_rail_only_when_active_is_empty() {
        // Active prepaid empty, credits pool funded → propose credits (the trap).
        assert_eq!(suggest_switch("prepaid", 0.0, 10.0), Some("credits"));
        // Active credits empty, prepaid funded → propose prepaid.
        assert!(suggest_switch("credits", 0.0, 0.0).is_none());
        assert_eq!(suggest_switch("credits", 4.6, 0.0), Some("prepaid"));
        // Active rail can pay → no proposal.
        assert_eq!(suggest_switch("prepaid", 5.0, 10.0), None);
        // Both empty → nothing to propose.
        assert_eq!(suggest_switch("prepaid", 0.0, 0.0), None);
    }

    #[test]
    fn effective_rail_resolves_auto_to_prepaid_only_when_an_account_exists() {
        assert_eq!(effective_rail("auto", true), "prepaid");
        assert_eq!(effective_rail("auto", false), "credits");
        assert_eq!(effective_rail("credits", true), "credits");
        assert_eq!(effective_rail("prepaid", false), "prepaid");
        // Unknown value degrades like "auto".
        assert_eq!(effective_rail("weird", true), "prepaid");
    }

    #[test]
    fn parse_decimal_reads_string_and_number_usdc_amounts() {
        // Carpe Diem returns on-chain balances as 6-decimal strings.
        assert_eq!(
            parse_decimal(Some(&serde_json::json!("4.642904"))),
            Some(4.642904)
        );
        assert_eq!(parse_decimal(Some(&serde_json::json!("0"))), Some(0.0));
        // Tolerate a bare number too.
        assert_eq!(parse_decimal(Some(&serde_json::json!(1.5))), Some(1.5));
        // Junk / missing → None (never a silent 0).
        assert_eq!(parse_decimal(Some(&serde_json::json!("abc"))), None);
        assert_eq!(parse_decimal(None), None);
    }

    #[test]
    fn validate_base_url_trims_and_requires_scheme() {
        assert_eq!(
            validate_base_url("  https://carpe-diem.xyz/api/operator/v1/  ").unwrap(),
            "https://carpe-diem.xyz/api/operator/v1"
        );
        assert!(validate_base_url("carpe-diem.xyz").is_err());
        assert!(validate_base_url("   ").is_err());
        assert!(
            validate_base_url("http://").is_err(),
            "scheme-only has no host"
        );
        assert!(
            validate_base_url("https://a b/c").is_err(),
            "whitespace rejected"
        );
    }

    #[test]
    fn normalize_api_key_rejects_empty_and_control_chars() {
        assert_eq!(normalize_api_key("  cdm_abc  ").unwrap(), "cdm_abc");
        assert!(normalize_api_key("").is_err());
        assert!(normalize_api_key("cdm_\nabc").is_err());
    }

    #[test]
    fn settings_default_uses_carpe_diem_base_url() {
        assert_eq!(
            CarpeDiemSettings::default().base_url,
            branding::CARPE_DIEM_DEFAULT_BASE_URL
        );
    }

    #[test]
    fn catalog_and_operator_root_derive_the_v1_rail_from_router() {
        // `/router` → `/v1` for catalog/billing (absent from the router rail).
        assert_eq!(
            catalog_base_url_of("https://carpe-diem.xyz/api/operator/router"),
            "https://carpe-diem.xyz/api/operator/v1"
        );
        assert_eq!(
            operator_root_of("https://carpe-diem.xyz/api/operator/router/"),
            "https://carpe-diem.xyz/api/operator"
        );
        // A `/v1` base (existing installs) is unchanged; operator root strips it.
        assert_eq!(
            catalog_base_url_of("https://carpe-diem.xyz/api/operator/v1"),
            "https://carpe-diem.xyz/api/operator/v1"
        );
        assert_eq!(
            operator_root_of("https://carpe-diem.xyz/api/operator/v1"),
            "https://carpe-diem.xyz/api/operator"
        );
        // A Venice-direct base has no `/router` rail → catalog unchanged.
        assert_eq!(
            catalog_base_url_of("https://api.venice.ai/api/v1"),
            "https://api.venice.ai/api/v1"
        );
        // The default base URL resolves to the standard `/v1` endpoint.
        assert_eq!(
            default_catalog_base_url(),
            "https://carpe-diem.xyz/api/operator/v1"
        );
    }

    #[test]
    fn first_multiplier_prefers_models_then_fixed_cost() {
        let pricing = serde_json::json!({
            "models": [
                { "id": "no-multiplier" },
                { "id": "glm", "multiplier": 0.42 }
            ],
            "fixedCost": [{ "id": "z-image", "multiplier": 0.5 }]
        });
        assert_eq!(first_multiplier(&pricing), Some(0.42));

        let fixed_only = serde_json::json!({
            "models": [],
            "fixedCost": [{ "id": "z-image", "multiplier": 0.5 }]
        });
        assert_eq!(first_multiplier(&fixed_only), Some(0.5));

        assert_eq!(first_multiplier(&serde_json::json!({})), None);
    }

    #[test]
    fn venice_available_credits_sums_usd_and_diem_at_cent_rate() {
        let both = serde_json::json!({
            "data": { "balances": { "USD": 50.25, "DIEM": 100.0 } }
        });
        assert_eq!(venice_available_credits(&both), Some(15_025.0));

        // DIEM is null when the account isn't staking.
        let usd_only = serde_json::json!({
            "data": { "balances": { "USD": 4.75, "DIEM": null } }
        });
        assert_eq!(venice_available_credits(&usd_only), Some(475.0));

        // A response without any recognizable bucket is malformed, not zero.
        assert_eq!(
            venice_available_credits(&serde_json::json!({ "data": { "balances": {} } })),
            None
        );
        assert_eq!(venice_available_credits(&serde_json::json!({})), None);
    }

    #[test]
    fn load_from_disk_falls_back_to_default_when_missing() {
        let missing = PathBuf::from("/nonexistent/carpe-diem.json");
        assert_eq!(
            load_from_disk(Some(&missing)).base_url,
            branding::CARPE_DIEM_DEFAULT_BASE_URL
        );
    }
}
