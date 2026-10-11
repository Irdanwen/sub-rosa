//! The partner identity toward Carpe Diem (ADR 0069, `docs/carpe-diem-partner-contract.md`).
//!
//! Two signed statements leave this module and nothing else: an issuance
//! assertion the app carries to Carpe Diem itself, bound to an ephemeral key the
//! service never sees, and a revocation this service sends. No response body is
//! trusted beyond its status, and no key or balance ever comes back here.
use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;
use std::time::Duration;
use subrosa_config::Config;
use subrosa_domain::{
    BrowserBound, CarpeDiemPartner, Error, IssuanceAssertion, IssuanceClaims, PendingRevocation,
    Result, RevocationFailure, Secret,
};
use uuid::Uuid;

/// How long an assertion may be carried. Long enough for one round trip from a
/// phone on a slow network, short enough that a copy found in a log is dead.
const LIFETIME_SECONDS: i64 = 120;
/// Wire value of the JWS `typ`; Carpe Diem refuses anything else, so an ID
/// token or an access token can never be replayed as an assertion.
pub const ASSERTION_TYPE: &str = "partner-assertion+jwt";

pub struct CarpeDiemPartnerProvider {
    client: reqwest::Client,
    key: EncodingKey,
    kid: String,
    issuer: String,
    audience: String,
    revoke_url: String,
    browser: BrowserBound,
}

#[derive(Serialize)]
struct Confirmation<'a> {
    jkt: &'a str,
}
#[derive(Serialize)]
struct IssuanceBody<'a> {
    iss: &'a str,
    aud: &'a str,
    sub: Uuid,
    email: &'a str,
    email_verified: bool,
    device_id: Uuid,
    device_name: &'a str,
    scope: &'static str,
    cnf: Confirmation<'a>,
    /// Absent for an app, so every assertion Carpe Diem already accepts reads
    /// exactly as before. `browser` asks for the bound below (ADR 0096).
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bound: Option<BrowserBound>,
    jti: Uuid,
    iat: i64,
    exp: i64,
}
#[derive(Serialize)]
struct RevocationBody<'a> {
    iss: &'a str,
    aud: &'a str,
    sub: Uuid,
    scope: &'static str,
    device_id: Option<Uuid>,
    reason: &'static str,
    jti: Uuid,
    iat: i64,
    exp: i64,
}

impl CarpeDiemPartnerProvider {
    /// `None` when the deployment has no partner section. A key that does not
    /// sign is refused here, at startup, rather than on a person's first try.
    pub fn new(config: &Config) -> Result<Option<Self>> {
        let Some(partner) = &config.carpe_diem else {
            return Ok(None);
        };
        let key = EncodingKey::from_ec_pem(partner.signing_key.expose().as_bytes())
            .map_err(|_| Error::Unavailable)?;
        let provider = Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Unavailable)?,
            key,
            kid: partner.kid.clone(),
            issuer: config.public_url.clone(),
            audience: partner.audience.clone(),
            revoke_url: format!("{}/partner/keys/revoke", partner.operator_url()),
            browser: BrowserBound {
                daily_cap_credits: partner.browser_daily_cap_credits,
                valid_seconds: partner.browser_key_days * 86_400,
            },
        };
        provider.sign(&serde_json::json!({"probe": true}))?;
        Ok(Some(provider))
    }
    fn sign<T: Serialize>(&self, body: &T) -> Result<Secret> {
        let mut header = Header::new(Algorithm::ES256);
        header.typ = Some(ASSERTION_TYPE.into());
        header.kid = Some(self.kid.clone());
        encode(&header, body, &self.key)
            .map(Secret)
            .map_err(|_| Error::Unavailable)
    }
    fn window() -> (DateTime<Utc>, DateTime<Utc>) {
        let now = Utc::now();
        (now, now + TimeDelta::seconds(LIFETIME_SECONDS))
    }
}

#[async_trait]
impl CarpeDiemPartner for CarpeDiemPartnerProvider {
    fn issuance_assertion(&self, claims: &IssuanceClaims) -> Result<IssuanceAssertion> {
        let (issued, expires) = Self::window();
        let email = claims.email.to_lowercase();
        let assertion = self.sign(&IssuanceBody {
            iss: &self.issuer,
            aud: &self.audience,
            sub: claims.subject,
            email: &email,
            // The identity provider refuses an unverified address at sign-in,
            // so every account here has one. Said out loud because Carpe Diem
            // checks it rather than trusting that it was checked.
            email_verified: true,
            device_id: claims.device_id,
            device_name: &claims.device_name,
            scope: "key:issue",
            cnf: Confirmation { jkt: &claims.jkt },
            kind: claims.browser.map(|_| "browser"),
            bound: claims.browser,
            jti: Uuid::new_v4(),
            iat: issued.timestamp(),
            exp: expires.timestamp(),
        })?;
        Ok(IssuanceAssertion {
            assertion,
            expires_at: expires,
        })
    }
    fn browser_bound(&self) -> BrowserBound {
        self.browser
    }
    async fn revoke(
        &self,
        revocation: &PendingRevocation,
    ) -> std::result::Result<(), RevocationFailure> {
        let (issued, expires) = Self::window();
        let assertion = self
            .sign(&RevocationBody {
                iss: &self.issuer,
                aud: &self.audience,
                sub: revocation.subject,
                scope: "key:revoke",
                device_id: revocation.device_id,
                reason: revocation.reason.as_str(),
                jti: Uuid::new_v4(),
                iat: issued.timestamp(),
                exp: expires.timestamp(),
            })
            .map_err(|_| RevocationFailure::Signing)?;
        let response = self
            .client
            .post(&self.revoke_url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("PartnerAssertion {}", assertion.expose()),
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| RevocationFailure::Unreachable)?;
        // The status is the whole answer. The body is not read, so a hostile or
        // broken operator cannot make this service buffer anything.
        if response.status().is_success() {
            Ok(())
        } else {
            Err(RevocationFailure::Status(response.status().as_u16()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation, decode, decode_header};
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    use subrosa_domain::RevocationReason;

    fn provider() -> (CarpeDiemPartnerProvider, DecodingKey) {
        let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let pem = secret
            .to_pkcs8_pem(LineEnding::LF)
            .map(|pem| pem.to_string())
            .unwrap_or_default();
        let public = secret
            .public_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap_or_default();
        let key = EncodingKey::from_ec_pem(pem.as_bytes());
        let decoding = DecodingKey::from_ec_pem(public.as_bytes());
        let (Ok(key), Ok(decoding)) = (key, decoding) else {
            unreachable!("a freshly generated P-256 key always encodes")
        };
        (
            CarpeDiemPartnerProvider {
                client: reqwest::Client::new(),
                key,
                kid: "sr-test".into(),
                issuer: "https://account.example.invalid".into(),
                audience: "https://carpe-diem.example.invalid/api/operator".into(),
                revoke_url: "http://127.0.0.1:9/partner/keys/revoke".into(),
                browser: BrowserBound {
                    daily_cap_credits: 200,
                    valid_seconds: 7 * 86_400,
                },
            },
            decoding,
        )
    }

    /// Every claim Carpe Diem reads is checked against the contract, and the
    /// signature verifies under the public half alone, which is all Carpe Diem
    /// is ever given.
    #[test]
    fn the_issuance_assertion_says_exactly_what_the_contract_says() {
        let (provider, public) = provider();
        let subject = Uuid::new_v4();
        let device = Uuid::new_v4();
        let issued = provider.issuance_assertion(&IssuanceClaims {
            subject,
            email: "Alice@Example.Test".into(),
            device_id: device,
            device_name: "Alice's laptop".into(),
            jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I".into(),
            browser: None,
        });
        let Ok(issued) = issued else {
            unreachable!("signing with a valid key succeeds")
        };
        let token = issued.assertion.expose();
        let Ok(header) = decode_header(token) else {
            unreachable!("the assertion is a compact JWS")
        };
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.typ.as_deref(), Some(ASSERTION_TYPE));
        assert_eq!(header.kid.as_deref(), Some("sr-test"));
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_audience(&["https://carpe-diem.example.invalid/api/operator"]);
        validation.set_issuer(&["https://account.example.invalid"]);
        let Ok(claims) = decode::<serde_json::Value>(token, &public, &validation) else {
            unreachable!("the public half verifies the assertion")
        };
        let c = claims.claims;
        assert_eq!(c["sub"], subject.to_string());
        assert_eq!(c["email"], "alice@example.test");
        assert_eq!(c["email_verified"], true);
        assert_eq!(c["device_id"], device.to_string());
        assert_eq!(c["device_name"], "Alice's laptop");
        assert_eq!(c["scope"], "key:issue");
        assert_eq!(
            c["cnf"]["jkt"],
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
        );
        assert!(Uuid::parse_str(c["jti"].as_str().unwrap_or_default()).is_ok());
        let (Some(iat), Some(exp)) = (c["iat"].as_i64(), c["exp"].as_i64()) else {
            unreachable!("both times are numeric")
        };
        assert_eq!(exp - iat, LIFETIME_SECONDS);
        assert_eq!(issued.expires_at.timestamp(), exp);
        // Nothing beyond the contract, so nothing the service did not mean to say.
        let Some(object) = c.as_object() else {
            unreachable!("claims are an object")
        };
        let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "aud",
                "cnf",
                "device_id",
                "device_name",
                "email",
                "email_verified",
                "exp",
                "iat",
                "iss",
                "jti",
                "scope",
                "sub"
            ]
        );
    }

    /// Two assertions for the same device never share an identifier, so Carpe
    /// Diem's single-use check can never reject a legitimate second attempt.
    #[test]
    fn every_assertion_is_unique() {
        let (provider, public) = provider();
        let claims = IssuanceClaims {
            subject: Uuid::new_v4(),
            email: "a@example.test".into(),
            device_id: Uuid::new_v4(),
            device_name: "Phone".into(),
            jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I".into(),
            browser: None,
        };
        let mut validation = Validation::new(Algorithm::ES256);
        validation.validate_aud = false;
        let jti = |provider: &CarpeDiemPartnerProvider| {
            provider
                .issuance_assertion(&claims)
                .ok()
                .and_then(|a| {
                    decode::<serde_json::Value>(a.assertion.expose(), &public, &validation).ok()
                })
                .map(|d| d.claims["jti"].clone())
        };
        assert_ne!(jti(&provider), jti(&provider));
    }

    /// A browser device's assertion says so, and carries the bound Carpe Diem
    /// is asked to hold. Nothing else about the claims changes.
    #[test]
    fn a_browser_assertion_names_its_kind_and_bound() {
        let (provider, public) = provider();
        let bound = provider.browser_bound();
        let issued = provider.issuance_assertion(&IssuanceClaims {
            subject: Uuid::new_v4(),
            email: "a@example.test".into(),
            device_id: Uuid::new_v4(),
            device_name: "Browser - Firefox".into(),
            jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I".into(),
            browser: Some(bound),
        });
        let mut validation = Validation::new(Algorithm::ES256);
        validation.validate_aud = false;
        let claims = issued
            .ok()
            .and_then(|a| {
                decode::<serde_json::Value>(a.assertion.expose(), &public, &validation).ok()
            })
            .map(|d| d.claims)
            .unwrap_or_default();
        assert_eq!(claims["kind"], "browser");
        assert_eq!(claims["bound"]["daily_cap_credits"], 200);
        assert_eq!(claims["bound"]["valid_seconds"], 7 * 86_400);
        assert_eq!(claims["scope"], "key:issue");
    }

    /// A revocation that cannot be delivered is an error, so the outbox keeps it.
    #[tokio::test]
    async fn an_unreachable_operator_leaves_the_revocation_pending() {
        let (provider, _) = provider();
        let result = provider
            .revoke(&PendingRevocation {
                id: Uuid::new_v4(),
                subject: Uuid::new_v4(),
                device_id: None,
                reason: RevocationReason::AccountDeleted,
                attempts: 0,
            })
            .await;
        assert_eq!(result, Err(RevocationFailure::Unreachable));
    }
}
