//! WebCrypto-compatible, versioned authenticated envelopes. Recovery material
//! is uniformly random 256-bit entropy, never a human password.
use crate::domain::types::AppError;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub v: u8,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn random_key() -> Zeroizing<[u8; 32]> {
    Zeroizing::new(rand::random())
}
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn decode_key(value: &str) -> Result<Zeroizing<[u8; 32]>, AppError> {
    let raw = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value.trim())
            .map_err(|_| invalid())?,
    );
    let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| invalid())?;
    Ok(Zeroizing::new(key))
}
fn invalid() -> AppError {
    AppError::new(
        "vault_invalid",
        "The encrypted data or recovery key could not be verified.",
    )
}
pub fn seal(key: &[u8; 32], aad: &str, bytes: &[u8]) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    let nonce: [u8; 12] = rand::random();
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: bytes,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| invalid())?;
    serde_json::to_string(&Envelope {
        v: 1,
        nonce: encode(&nonce),
        ciphertext: encode(&ciphertext),
    })
    .map_err(|_| invalid())
}
pub fn open(key: &[u8; 32], aad: &str, envelope: &str) -> Result<Zeroizing<Vec<u8>>, AppError> {
    if envelope.len() > 8 * 1024 * 1024 {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_str(envelope).map_err(|_| invalid())?;
    if envelope.v != 1 {
        return Err(invalid());
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&envelope.nonce)
        .map_err(|_| invalid())?;
    if nonce.len() != 12 {
        return Err(invalid());
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| invalid())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| invalid())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decrypts_webcrypto_interoperability_fixture() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/account-vault-v1.json"))
                .unwrap();
        let key = decode_key(f["key"].as_str().unwrap()).unwrap();
        let clear = open(&key, f["aad"].as_str().unwrap(), &f["envelope"].to_string()).unwrap();
        assert_eq!(
            std::str::from_utf8(&clear).unwrap(),
            f["plaintext"].as_str().unwrap()
        );
    }
    #[test]
    fn authentication_binds_context_and_randomizes_ciphertext() {
        let key = random_key();
        let a = seal(&key, "account:note:id", b"private").unwrap();
        let b = seal(&key, "account:note:id", b"private").unwrap();
        assert_ne!(a, b);
        assert_eq!(
            open(&key, "account:note:id", &a).unwrap().as_slice(),
            b"private"
        );
        assert!(open(&key, "other:note:id", &a).is_err());
        assert!(open(&random_key(), "account:note:id", &a).is_err());
        let mut envelope: Envelope = serde_json::from_str(&a).unwrap();
        envelope.ciphertext.push('A');
        assert!(open(
            &key,
            "account:note:id",
            &serde_json::to_string(&envelope).unwrap()
        )
        .is_err());
    }
    #[test]
    fn recovery_requires_256_bit_random_material() {
        assert!(decode_key("password").is_err());
        assert_eq!(*decode_key(&encode(&[42; 32])).unwrap(), [42; 32]);
    }
}
