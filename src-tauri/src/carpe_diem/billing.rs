//! Buying credits by card (ADR-0069, `docs/carpe-diem-partner-contract.md` §5).
//!
//! Sub Rosa sells nothing: Carpe Diem is the merchant. The app asks Carpe Diem
//! for a checkout ticket with the device's own key, opens the pay page it
//! names in the browser, and then only watches the balance. The card, the
//! amount charged and the tax never pass through this process; the credits
//! land on the account's balance, which every device key of the account
//! draws on.
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::{issued::partner_root, settings};
use crate::{domain::types::AppError, redacted::Redacted};

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreditTier {
    pub id: String,
    pub usd_cents: u64,
    pub credits: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreditTiers {
    pub currency: String,
    pub tiers: Vec<CreditTier>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOpened {
    pub expires_at: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub id: String,
    /// `"purchase"` or `"refund"`.
    pub kind: String,
    pub usd: f64,
    pub credits: f64,
    pub at: String,
}

fn unavailable() -> AppError {
    AppError::new(
        "carpe_diem_fiat_unavailable",
        "Buying credits by card is not available yet.",
    )
}
fn unreachable() -> AppError {
    AppError::new(
        "carpe_diem_billing_unreachable",
        "Carpe Diem could not be reached. Check your connection and try again.",
    )
}
fn rejected() -> AppError {
    AppError::new(
        "carpe_diem_billing_rejected",
        "Carpe Diem could not prepare the payment. Try again in a moment.",
    )
}

fn key_and_root() -> Result<(String, Redacted<String>), AppError> {
    let Some((base, key)) = settings::credentials() else {
        return Err(AppError::new(
            "carpe_diem_no_api_key",
            "No Carpe Diem API key is stored yet.",
        ));
    };
    if !key.expose_str().starts_with("cdm_") {
        return Err(AppError::new(
            "carpe_diem_billing_unsupported",
            "Payment rails apply to Carpe Diem keys only.",
        ));
    }
    Ok((partner_root(&base), key))
}

async fn read_json(mut response: reqwest::Response) -> Result<(u16, Value), AppError> {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(rejected());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

fn client() -> Result<reqwest::Client, AppError> {
    crate::http_client::credentialed(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unreachable())
}

// --- Pure parsing, tested without a network -------------------------------------

pub(crate) fn parse_tiers(status: u16, body: &Value) -> Result<CreditTiers, AppError> {
    if status == 404 {
        return Err(unavailable());
    }
    if status != 200 || body["currency"].as_str() != Some("usd") {
        return Err(rejected());
    }
    let tiers = body["tiers"]
        .as_array()
        .ok_or_else(rejected)?
        .iter()
        .take(12)
        .filter_map(|tier| {
            let id = tier["id"].as_str()?;
            let usd_cents = tier["usdCents"].as_u64()?;
            let credits = tier["credits"].as_u64()?;
            (!id.is_empty()
                && id.len() <= 32
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && usd_cents > 0
                && usd_cents <= 1_000_000)
                .then(|| CreditTier {
                    id: id.to_string(),
                    usd_cents,
                    credits,
                })
        })
        .collect::<Vec<_>>();
    if tiers.is_empty() {
        return Err(unavailable());
    }
    Ok(CreditTiers {
        currency: "usd".into(),
        tiers,
    })
}

/// The pay page must be Carpe Diem's own, on the same host the key talks to,
/// over HTTPS (HTTP only for a loopback operator in a debug build). A ticket
/// answer that names anything else is not opened.
pub(crate) fn checked_pay_url(root: &str, url: &str) -> Option<String> {
    let root = reqwest::Url::parse(root).ok()?;
    let target = reqwest::Url::parse(url).ok()?;
    let loopback = matches!(target.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let scheme_ok = target.scheme() == "https"
        || (cfg!(debug_assertions) && loopback && target.scheme() == "http");
    let same_site = match (root.host_str(), target.host_str()) {
        (Some(a), Some(b)) => a == b || (loopback && cfg!(debug_assertions)),
        _ => false,
    };
    (scheme_ok
        && same_site
        && target.username().is_empty()
        && target.password().is_none()
        && target.path().trim_end_matches('/') == "/pay"
        && target.fragment().is_none())
    .then(|| target.to_string())
}

pub(crate) fn parse_ticket(
    root: &str,
    status: u16,
    body: &Value,
) -> Result<(String, String), AppError> {
    let code = body["code"].as_str().unwrap_or("");
    match status {
        201 | 200 => {
            let url = body["url"]
                .as_str()
                .and_then(|url| checked_pay_url(root, url))
                .ok_or_else(rejected)?;
            let expires_at = body["expiresAt"].as_str().unwrap_or("").to_string();
            Ok((url, expires_at))
        }
        404 => Err(unavailable()),
        403 if code == "PURCHASE_BLOCKED" => Err(AppError::new(
            "carpe_diem_purchase_blocked",
            "Card purchases are paused on this account after a refund or a dispute. Contact Carpe Diem to lift it.",
        )),
        403 if code == "PURCHASE_LIMIT" => Err(AppError::new(
            "carpe_diem_purchase_limit",
            "A new account can buy up to 50 dollars a day and 100 a week. Try a smaller amount, or again later.",
        )),
        451 => Err(AppError::new(
            "carpe_diem_purchase_region",
            "Carpe Diem does not sell credits in your region.",
        )),
        429 => Err(AppError::new(
            "carpe_diem_purchase_slow_down",
            "Too many payment attempts in a row. Wait a few minutes, then try again.",
        )),
        401 => Err(AppError::new(
            "carpe_diem_key_invalid",
            "The service did not accept this key.",
        )),
        _ => Err(rejected()),
    }
}

pub(crate) fn parse_purchases(status: u16, body: &Value) -> Result<Vec<Purchase>, AppError> {
    if status == 404 {
        return Ok(Vec::new());
    }
    if status != 200 {
        return Err(rejected());
    }
    Ok(body["purchases"]
        .as_array()
        .map(|list| {
            list.iter()
                .take(50)
                .filter_map(|p| {
                    let kind = p["kind"].as_str()?;
                    if kind != "purchase" && kind != "refund" {
                        return None;
                    }
                    Some(Purchase {
                        id: p["id"].as_str()?.chars().take(120).collect(),
                        kind: kind.to_string(),
                        usd: p["usd"].as_f64()?,
                        credits: p["credits"].as_f64()?,
                        at: p["at"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

// --- Commands ---------------------------------------------------------------------

#[tauri::command]
pub async fn carpe_diem_credit_tiers() -> Result<CreditTiers, AppError> {
    let root = partner_root(&settings::base_url());
    let client = crate::http_client::anonymous(TIMEOUT)
        .build()
        .map_err(|_| unreachable())?;
    let response = client
        .get(format!("{root}/v1/billing/tiers"))
        .send()
        .await
        .map_err(|_| unreachable())?;
    let (status, body) = read_json(response).await?;
    parse_tiers(status, &body)
}

/// Asks Carpe Diem for a checkout and opens its pay page in the browser. The
/// app then watches the balance; the page itself sends the person back.
#[tauri::command]
pub async fn carpe_diem_open_checkout(tier: Option<String>) -> Result<CheckoutOpened, AppError> {
    if let Some(tier) = tier.as_deref() {
        if tier.is_empty()
            || tier.len() > 32
            || !tier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(rejected());
        }
    }
    let (root, key) = key_and_root()?;
    let response = client()?
        .post(format!("{root}/v1/billing/checkout-ticket"))
        .bearer_auth(key.expose_str())
        .json(&json!({"tier": tier, "returnTo": "subrosa"}))
        .send()
        .await
        .map_err(|_| unreachable())?;
    let (status, body) = read_json(response).await?;
    let (url, expires_at) = parse_ticket(&root, status, &body)?;
    crate::os_accounts::open_in_browser(&url)?;
    Ok(CheckoutOpened { expires_at })
}

#[tauri::command]
pub async fn carpe_diem_purchases() -> Result<Vec<Purchase>, AppError> {
    let (root, key) = key_and_root()?;
    let response = client()?
        .get(format!("{root}/v1/billing/purchases"))
        .bearer_auth(key.expose_str())
        .send()
        .await
        .map_err(|_| unreachable())?;
    let (status, body) = read_json(response).await?;
    parse_purchases(status, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "https://carpe-diem.xyz/api/operator";

    #[test]
    fn tiers_are_read_from_carpe_diem_and_bounded() {
        let tiers = parse_tiers(
            200,
            &json!({"currency":"usd","tiers":[
                {"id":"usd_5","usdCents":500,"credits":500},
                {"id":"bad id","usdCents":500,"credits":500},
                {"id":"usd_10","usdCents":1000,"credits":1000}
            ]}),
        )
        .unwrap();
        assert_eq!(
            tiers
                .tiers
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["usd_5", "usd_10"]
        );
        assert_eq!(
            parse_tiers(404, &json!({})).unwrap_err().code,
            "carpe_diem_fiat_unavailable"
        );
        assert!(parse_tiers(200, &json!({"currency":"eur","tiers":[]})).is_err());
    }

    #[test]
    fn only_carpe_diems_own_pay_page_is_opened() {
        assert_eq!(
            checked_pay_url(ROOT, "https://carpe-diem.xyz/pay?t=abc").as_deref(),
            Some("https://carpe-diem.xyz/pay?t=abc")
        );
        for other in [
            "http://carpe-diem.xyz/pay?t=abc",
            "https://evil.example/pay?t=abc",
            "https://carpe-diem.xyz/dashboard?t=abc",
            "https://user:pw@carpe-diem.xyz/pay?t=abc",
            "https://carpe-diem.xyz.evil.example/pay",
            "javascript:alert(1)",
        ] {
            assert!(checked_pay_url(ROOT, other).is_none(), "{other}");
        }
    }

    #[test]
    fn a_ticket_refusal_says_what_to_do() {
        let code = |status, body: Value| parse_ticket(ROOT, status, &body).unwrap_err().code;
        assert_eq!(
            code(403, json!({"code":"PURCHASE_BLOCKED"})),
            "carpe_diem_purchase_blocked"
        );
        assert_eq!(
            code(403, json!({"code":"PURCHASE_LIMIT"})),
            "carpe_diem_purchase_limit"
        );
        assert_eq!(code(451, json!({})), "carpe_diem_purchase_region");
        assert_eq!(
            code(404, json!({"code":"FIAT_DISABLED"})),
            "carpe_diem_fiat_unavailable"
        );
        assert_eq!(
            code(201, json!({"url":"https://evil.example/pay"})),
            "carpe_diem_billing_rejected"
        );
        let (url, expires) = parse_ticket(
            ROOT,
            201,
            &json!({"ticketId":"t","url":"https://carpe-diem.xyz/pay?t=t","expiresAt":"2030-01-01T00:00:00Z"}),
        )
        .unwrap();
        assert_eq!(url, "https://carpe-diem.xyz/pay?t=t");
        assert_eq!(expires, "2030-01-01T00:00:00Z");
    }

    #[test]
    fn purchases_keep_only_what_they_claim_to_be() {
        let list = parse_purchases(
            200,
            &json!({"purchases":[
                {"id":"cs:1","kind":"purchase","usd":10,"credits":1000,"at":"2026-09-30T10:00:00Z"},
                {"id":"x","kind":"gift","usd":1,"credits":1,"at":"2026-09-30T10:00:00Z"},
                {"id":"re:1","kind":"refund","usd":5,"credits":500,"at":"2026-09-30T11:00:00Z"}
            ]}),
        )
        .unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].kind, "refund");
        assert!(parse_purchases(404, &json!({})).unwrap().is_empty());
    }
}
