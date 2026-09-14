//! Ephemeral signing material shared by integration tests and the local QA issuer.
//! Keys exist only in memory for this process and are never production inputs.
use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::EncodingKey;
use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct EphemeralSigningKey {
    pub encoding_key: EncodingKey,
    pub jwks: Value,
}

impl EphemeralSigningKey {
    pub fn generate() -> Result<Self> {
        let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)?;
        let jwks = json!({"keys": [{
            "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "test-key",
            "n": URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
            "e": URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())
        }]});
        let der = key.to_pkcs1_der()?;
        Ok(Self {
            encoding_key: EncodingKey::from_rsa_der(der.as_bytes()),
            jwks,
        })
    }
}
