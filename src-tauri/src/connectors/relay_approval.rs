//! A tab's "yes", bound to the browser that gave it (ADR-0107 addendum).
//!
//! A relayed call to a tool whose rule here is "ask" runs only when the
//! person approved it where they asked. The row's `approved` flag alone was
//! a claim anyone able to write the row could make. Now the tab signs its
//! approval with its device key (ADR-0096, a non-extractable P-256 key the
//! account service holds the public half of), over the call itself:
//!
//! - the signed message is a compact JWS, `ES256`, typed
//!   [`APPROVAL_TYPE`], whose `kid` is the browser device's id;
//! - its claims name the call (`eid`, the row's id), what it does (`dig`,
//!   SHA-256 over the tool's name, a NUL byte and the arguments exactly as
//!   the row carries them, which is what this device runs) and when (`iat`);
//! - the JWS travels in the row's `message` while the call is `requested`
//!   (the column the answering device writes its reason into afterwards), so
//!   the row's shape is the one released apps already accept.
//!
//! This device runs the call only when the signature verifies against the
//! public key the account service lists for that browser device, the device
//! is live (not revoked) and of this account (the list is this account's),
//! the row says that device asked, and the time fits the call's lifetime.
//! Anything less is treated as not approved: the row comes back as `ask`.
//!
//! What it does not do: a tab whose page is compromised can still ask its
//! own device key to sign, so it can still approve calls (docs/threat-model.md).
//! The binding closes the row to everyone else who can write it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::{signature::Verifier as _, Signature, VerifyingKey};
use serde_json::Value;
use sha2::Digest as _;

use super::relay::{Errand, EXPIRY_SECS};

pub const APPROVAL_TYPE: &str = "subrosa-approval+jwt";
/// How far a signing clock may run ahead of this one.
pub const CLOCK_SKEW_SECS: i64 = 60;

/// `dig`: what the approval is of. The arguments are the row's own text,
/// byte for byte, so what was approved is what runs.
pub fn digest(tool: &str, arguments: &str) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update([0_u8]);
    hasher.update(arguments.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// A live browser device of this account and its public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserKey {
    pub device_id: String,
    pub x: String,
    pub y: String,
}

/// The browser devices the account service lists (`GET /api/v1/devices`,
/// this account's only) that are live and carry a public key.
pub fn browser_keys(devices: &Value) -> Vec<BrowserKey> {
    devices
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|device| device["kind"] == "browser" && device["revoked_at"].is_null())
                .filter_map(|device| {
                    Some(BrowserKey {
                        device_id: device["id"].as_str()?.to_string(),
                        x: device["public_key"]["x"].as_str()?.to_string(),
                        y: device["public_key"]["y"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn verifying_key(key: &BrowserKey) -> Option<VerifyingKey> {
    let x = URL_SAFE_NO_PAD.decode(&key.x).ok()?;
    let y = URL_SAFE_NO_PAD.decode(&key.y).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(4);
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1).ok()
}

fn json_part(part: &str) -> Option<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).ok()?).ok()
}

/// Whether `errand` carries an approval its asking browser signed, for
/// exactly this call, recently.
pub fn holds(errand: &Errand, keys: &[BrowserKey], now: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(approval) = errand.approval.as_deref() else {
        return false;
    };
    let parts: Vec<&str> = approval.split('.').collect();
    let [header, claims, signature] = parts[..] else {
        return false;
    };
    let (Some(header_value), Some(claims_value)) = (json_part(header), json_part(claims)) else {
        return false;
    };
    if header_value["alg"] != "ES256" || header_value["typ"] != APPROVAL_TYPE {
        return false;
    }
    let Some(kid) = header_value["kid"].as_str() else {
        return false;
    };
    // The row says who asked; the approval must be that device's.
    if kid.is_empty() || kid != errand.requested_by {
        return false;
    }
    let Some(key) = keys.iter().find(|key| key.device_id == kid) else {
        return false;
    };
    if claims_value["eid"] != errand.id.as_str()
        || claims_value["dig"] != digest(&errand.tool, &errand.arguments).as_str()
    {
        return false;
    }
    let Some(iat) = claims_value["iat"].as_i64() else {
        return false;
    };
    let now = now.timestamp();
    if iat > now + CLOCK_SKEW_SECS || now - iat > EXPIRY_SECS {
        return false;
    }
    let (Some(verifying), Ok(bytes)) = (verifying_key(key), URL_SAFE_NO_PAD.decode(signature))
    else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    verifying
        .verify(format!("{header}.{claims}").as_bytes(), &signature)
        .is_ok()
}
