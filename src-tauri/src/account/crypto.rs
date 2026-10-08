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
/// What the vault stores so the recovery key can later admit a browser as a
/// device (ADR-0096): base64url SHA-256 of
/// `HKDF-SHA256(recovery secret, salt = empty, info = "subrosa:admission:v1:{account}")`.
/// One-way: it opens nothing, and it is bound to the account. The browser
/// derives the same proof with WebCrypto (`website/src/lib/vault.ts`).
pub fn admission_verifier(account_id: &str, recovery: &[u8; 32]) -> String {
    use sha2::{Digest, Sha256};
    let proof = Zeroizing::new(hkdf_sha256_32(
        recovery,
        format!("subrosa:admission:v1:{account_id}").as_bytes(),
    ));
    encode(&Sha256::digest(proof.as_slice()))
}

/// RFC 5869 with an empty salt and one block of output, which is all the
/// verifier needs. Written out because the HKDF crates in the tree are built
/// on a different `sha2` than this crate's.
fn hkdf_sha256_32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = Zeroizing::new(hmac_sha256(&[0u8; 32], ikm));
    let mut block = Vec::with_capacity(info.len() + 1);
    block.extend_from_slice(info);
    block.push(1);
    hmac_sha256(prk.as_slice(), &block)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    // Keys here are 32 bytes, under the 64 byte block, so they are padded,
    // never hashed first.
    debug_assert!(key.len() <= 64);
    let mut padded = Zeroizing::new([0u8; 64]);
    padded[..key.len()].copy_from_slice(key);
    let mut inner = Sha256::new();
    inner.update(padded.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(padded.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
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
    #[test]
    fn hkdf_matches_rfc_5869_with_an_empty_salt() {
        // RFC 5869 test case 3: IKM 22 bytes of 0x0b, no salt, no info.
        let okm = hkdf_sha256_32(&[0x0b; 22], b"");
        assert_eq!(
            okm.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
        );
    }
    #[test]
    fn the_admission_verifier_is_the_one_webcrypto_derives() {
        // Computed with WebCrypto, the derivation `website/src/lib/vault.ts` uses.
        assert_eq!(
            admission_verifier("0191d1a4-0000-7000-8000-000000000000", &[7; 32]),
            "GxpCp4mXtbThnU4jYUg_6cxEBblYbbmvjcSmG-I8NN8"
        );
        assert_ne!(
            admission_verifier("0191d1a4-0000-7000-8000-000000000001", &[7; 32]),
            "GxpCp4mXtbThnU4jYUg_6cxEBblYbbmvjcSmG-I8NN8"
        );
    }
}
