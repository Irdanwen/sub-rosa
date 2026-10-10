//! A browser admitted as a device (ADR 0096).
//!
//! The browser holds a P-256 key it generated non-extractable, so no script,
//! not even this site's own, can copy it out. Each request that acts as the
//! device carries a short JWS signed by that key, bound to the method, the
//! exact URL and the exact body it was sent with (`ath`). The service keeps
//! the public half; a stolen session cookie without the browser that holds
//! the key is not a device, and a proof lifted from one request cannot carry
//! a different body, such as another admission or another key's thumbprint.
use super::{Service, hash};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use serde::Deserialize;
use subrosa_domain::{Device, Error, Result, RevocationReason, Session};
use subrosa_persistence::{Admission, NewBrowserDevice};
use uuid::Uuid;

/// Wire value of the proof's JWS `typ`. Nothing else is accepted, so neither
/// a `DPoP` proof meant for Carpe Diem nor any other token can stand in for it.
pub const DEVICE_PROOF_TYPE: &str = "subrosa-device+jwt";
/// The header a browser device signs its requests with.
pub const DEVICE_PROOF_HEADER: &str = "subrosa-device-proof";
/// Accepted distance between the proof's `iat` and this service's clock.
const CLOCK_SKEW_SECONDS: i64 = 60;
/// How many admissions one account may attempt per minute.
const ADMISSIONS_PER_MINUTE: i32 = 5;
pub const ADMIT_PATH: &str = "/api/v1/browser-devices";
pub const RENOUNCE_PATH: &str = "/api/v1/browser-devices/renounce";
pub const ASSERTION_PATH: &str = "/api/v1/carpe-diem/assertion";

/// A proof as it arrived: the header's value and the raw body it must be
/// bound to. The body is hashed byte for byte, before any parsing, so what the
/// browser signed is exactly what the handler reads.
#[derive(Clone, Copy)]
pub struct DeviceProof<'a> {
    pub token: &'a str,
    pub body: &'a [u8],
}

/// How a browser says it was admitted out of band.
pub enum AdmissionRequest<'a> {
    Pairing(Uuid),
    /// base64url of the 32 bytes the browser derived from the recovery key.
    Recovery(&'a str),
}

#[derive(Deserialize)]
struct ProofHeader {
    alg: String,
    typ: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    jwk: Option<PublicJwk>,
    #[serde(default)]
    crit: Option<serde_json::Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}
#[derive(Deserialize)]
struct ProofClaims {
    htm: String,
    htu: String,
    iat: i64,
    jti: String,
    #[serde(default)]
    ath: Option<String>,
}

/// A proof whose shape and signature were checked; what it is for is the
/// caller's question.
struct Proof {
    kid: Option<Uuid>,
    jwk: Option<(String, String)>,
    signing_input: String,
    signature: String,
    claims: ProofClaims,
}

fn coordinate(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32)
}
/// RFC 7638 thumbprint of a P-256 public key, base64url.
pub fn thumbprint(x: &str, y: &str) -> String {
    URL_SAFE_NO_PAD.encode(hash(format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#
    )))
}
/// `ath`: base64url of the SHA-256 of the request body, byte for byte.
fn ath(body: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(hash(body))
}

fn parse(token: &str) -> Result<Proof> {
    if token.len() > 4096 {
        return Err(Error::DeviceProof);
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Error::DeviceProof);
    };
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| Error::DeviceProof);
    let h: ProofHeader =
        serde_json::from_slice(&decode(header)?).map_err(|_| Error::DeviceProof)?;
    let claims: ProofClaims =
        serde_json::from_slice(&decode(payload)?).map_err(|_| Error::DeviceProof)?;
    if h.alg != "ES256" || h.typ != DEVICE_PROOF_TYPE || h.crit.is_some() {
        return Err(Error::DeviceProof);
    }
    let jwk = match h.jwk {
        Some(k) if k.kty == "EC" && k.crv == "P-256" && coordinate(&k.x) && coordinate(&k.y) => {
            Some((k.x, k.y))
        }
        Some(_) => return Err(Error::DeviceProof),
        None => None,
    };
    let kid = match h.kid {
        Some(k) => Some(Uuid::parse_str(&k).map_err(|_| Error::DeviceProof)?),
        None => None,
    };
    // Exactly one way to name the key: by the device it belongs to, or, when
    // the device does not exist yet, by carrying it.
    if kid.is_some() == jwk.is_some() {
        return Err(Error::DeviceProof);
    }
    Ok(Proof {
        kid,
        jwk,
        signing_input: format!("{header}.{payload}"),
        signature: signature.to_owned(),
        claims,
    })
}

impl Service {
    /// Checks `proof` against the key `(x, y)` for this method, URL and body,
    /// then burns its identifier.
    async fn verify_proof(
        &self,
        proof: &Proof,
        (x, y): (&str, &str),
        path: &str,
        body: &[u8],
    ) -> Result<()> {
        let key =
            jsonwebtoken::DecodingKey::from_ec_components(x, y).map_err(|_| Error::DeviceProof)?;
        let signed = jsonwebtoken::crypto::verify(
            &proof.signature,
            proof.signing_input.as_bytes(),
            &key,
            jsonwebtoken::Algorithm::ES256,
        )
        .unwrap_or(false);
        let c = &proof.claims;
        if !signed
            || c.htm != "POST"
            || c.htu != format!("{}{path}", self.config.public_url)
            || (Utc::now().timestamp() - c.iat).abs() > CLOCK_SKEW_SECONDS
            || c.jti.len() < 16
            || c.jti.len() > 128
            || c.ath.as_deref() != Some(ath(body).as_str())
        {
            return Err(Error::DeviceProof);
        }
        self.repository
            .consume_device_proof(&hash(format!("{}:{}", thumbprint(x, y), c.jti)))
            .await
    }

    /// Makes the browser behind `session` a device of its account, after a
    /// recent sign-in and an out-of-band admission. `proof` is signed by the
    /// new device key, carries its public half and binds the body that holds
    /// `name` and `admission`.
    pub async fn admit_browser_device(
        &self,
        session: &Session,
        proof: DeviceProof<'_>,
        name: &str,
        admission: AdmissionRequest<'_>,
    ) -> Result<Device> {
        if !session.browser {
            return Err(Error::Forbidden);
        }
        Self::recent(session)?;
        self.repository
            .rate_limit(
                &hash(format!("browser-admission:{}", session.account.id)),
                ADMISSIONS_PER_MINUTE,
            )
            .await?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(Error::Invalid);
        }
        let parsed = parse(proof.token)?;
        let Some((x, y)) = parsed.jwk.clone() else {
            return Err(Error::DeviceProof);
        };
        let proof_hash;
        let admission = match admission {
            AdmissionRequest::Pairing(id) => Admission::Pairing(id),
            AdmissionRequest::Recovery(value) => {
                let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| Error::Invalid)?;
                if bytes.len() != 32 {
                    return Err(Error::Invalid);
                }
                proof_hash = hash(bytes);
                Admission::Recovery(&proof_hash)
            }
        };
        self.verify_proof(&parsed, (&x, &y), ADMIT_PATH, proof.body)
            .await?;
        let jkt = thumbprint(&x, &y);
        self.repository
            .admit_browser_device(NewBrowserDevice {
                session,
                name,
                x: &x,
                y: &y,
                jkt: &jkt,
                admission,
            })
            .await
    }

    /// The browser device of `session` that signed `proof` for `path` and its
    /// body. Only a live browser device of the same account passes.
    pub(crate) async fn browser_device(
        &self,
        session: &Session,
        proof: DeviceProof<'_>,
        path: &str,
    ) -> Result<Uuid> {
        if !session.browser {
            return Err(Error::DeviceProof);
        }
        let parsed = parse(proof.token)?;
        let id = parsed.kid.ok_or(Error::DeviceProof)?;
        let (x, y) = self
            .repository
            .browser_device_key(session.account.id, id)
            .await?;
        self.verify_proof(&parsed, (&x, &y), path, proof.body)
            .await?;
        Ok(id)
    }

    /// The browser signing itself out. No step-up, because it only takes away,
    /// and its Carpe Diem key goes on the outbox like an app's (ADR 0069).
    pub async fn renounce_browser_device(
        &self,
        session: &Session,
        proof: DeviceProof<'_>,
    ) -> Result<()> {
        let id = self.browser_device(session, proof, RENOUNCE_PATH).await?;
        self.repository
            .revoke_device(session.account.id, id, RevocationReason::SignedOut)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::{DEVICE_PROOF_TYPE, parse, thumbprint};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    fn token(header: &serde_json::Value, claims: &serde_json::Value) -> String {
        format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string()),
            URL_SAFE_NO_PAD.encode([0u8; 64])
        )
    }
    const X: &str = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    const Y: &str = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";

    /// The public key of RFC 7515 appendix A.3. The expected value was
    /// computed outside this code base; the website test pins the same one,
    /// so the browser and the service can never disagree on a thumbprint.
    #[test]
    fn a_thumbprint_hashes_the_canonical_member_order() {
        assert_eq!(
            thumbprint(X, Y),
            "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U"
        );
    }

    /// The body hash both sides compute: SHA-256 of the exact bytes, base64url
    /// without padding. The website test pins the same two values.
    #[test]
    fn ath_hashes_the_exact_body_bytes() {
        assert_eq!(
            super::ath(b""),
            "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        );
        assert_eq!(
            super::ath(br#"{"jkt":"x"}"#),
            URL_SAFE_NO_PAD.encode(super::hash(br#"{"jkt":"x"}"#))
        );
        assert_ne!(super::ath(b"{}"), super::ath(b"{ }"));
    }

    #[test]
    fn a_proof_names_its_key_exactly_one_way() {
        let claims = json!({"htm":"POST","htu":"u","iat":0,"jti":"0123456789abcdef"});
        let jwk = json!({"kty":"EC","crv":"P-256","x":X,"y":Y});
        let kid = "0191d1a4-0000-7000-8000-000000000000";
        let ok = |h: serde_json::Value| parse(&token(&h, &claims)).is_ok();
        assert!(ok(json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE,"jwk":jwk})));
        assert!(ok(json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE,"kid":kid})));
        assert!(!ok(
            json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE,"kid":kid,"jwk":jwk})
        ));
        assert!(!ok(json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE})));
        assert!(!ok(json!({"alg":"ES256","typ":"dpop+jwt","jwk":jwk})));
        assert!(!ok(
            json!({"alg":"HS256","typ":DEVICE_PROOF_TYPE,"jwk":jwk})
        ));
        assert!(!ok(
            json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE,"jwk":jwk,"crit":["x"]})
        ));
        let private = json!({"kty":"EC","crv":"P-256","x":X,"y":Y,"d":X});
        assert!(!ok(
            json!({"alg":"ES256","typ":DEVICE_PROOF_TYPE,"jwk":private})
        ));
        assert!(parse("a.b").is_err());
        assert!(parse(&"a".repeat(5000)).is_err());
    }
}
