//! The Studio wallet: the app-managed secp256k1 keypair that *is* the user's
//! Videomaker account (see ADR-0010 and CONTEXT.md "Studio wallet").
//!
//! Identity only — it holds no funds, is generated silently on first
//! activation, lives in the OS keychain as a hex string, and is never shown
//! to or exportable by the user. This module is pure crypto/formatting:
//! keychain access and HTTP live in the sibling modules.

use crate::domain::types::AppError;
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::rand_core::OsRng;
use sha3::{Digest, Keccak256};

pub struct Wallet {
    key: SigningKey,
}

impl Wallet {
    pub fn generate() -> Self {
        Self {
            key: SigningKey::random(&mut OsRng),
        }
    }

    pub fn from_hex(raw: &str) -> Result<Self, AppError> {
        let raw = raw.trim().trim_start_matches("0x");
        let bytes = hex::decode(raw).map_err(|_| {
            AppError::new(
                "videomaker_wallet_invalid",
                "Stored wallet key is not valid hex.",
            )
        })?;
        let key = SigningKey::from_slice(&bytes).map_err(|_| {
            AppError::new(
                "videomaker_wallet_invalid",
                "Stored wallet key is not a valid secp256k1 key.",
            )
        })?;
        Ok(Self { key })
    }

    /// Hex serialization for keychain storage (no 0x prefix).
    pub fn to_hex(&self) -> String {
        hex::encode(self.key.to_bytes())
    }

    /// EIP-55 checksummed address (`0x…`), the account id Videomaker sees.
    pub fn address(&self) -> String {
        let point = self.key.verifying_key().to_encoded_point(false);
        // Uncompressed SEC1 = 0x04 || x || y; the address is the last 20
        // bytes of keccak256(x || y).
        let digest = Keccak256::digest(&point.as_bytes()[1..]);
        checksum_address(&digest[12..32])
    }

    /// EIP-191 `personal_sign`: keccak over the prefixed message, recoverable
    /// ECDSA, returned as the 65-byte `0x{r}{s}{v}` hex Ethereum tooling
    /// expects (v = 27 + recovery id).
    pub fn sign_personal(&self, message: &str) -> Result<String, AppError> {
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", message.len(), message);
        let digest = Keccak256::digest(prefixed.as_bytes());
        let (signature, recovery_id) = self
            .key
            .sign_prehash_recoverable(&digest)
            .map_err(|error| AppError::new("videomaker_wallet_sign", error.to_string()))?;
        let mut bytes = signature.to_bytes().to_vec();
        bytes.push(27 + recovery_id.to_byte());
        Ok(format!("0x{}", hex::encode(bytes)))
    }
}

/// EIP-55 mixed-case checksum encoding of a 20-byte address.
pub fn checksum_address(bytes: &[u8]) -> String {
    let lower = hex::encode(bytes);
    let digest = Keccak256::digest(lower.as_bytes());
    let checksummed: String = lower
        .chars()
        .enumerate()
        .map(|(i, c)| {
            let nibble = (digest[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
            if nibble >= 8 {
                c.to_ascii_uppercase()
            } else {
                c
            }
        })
        .collect();
    format!("0x{checksummed}")
}

/// The EIP-4361 (SIWE) message Videomaker's `/api/auth/verify` and
/// `/api/auth/token` expect: bound to the studio domain, the checksummed
/// address, and a single-use nonce, `Version: 1`.
pub fn siwe_message(
    domain: &str,
    address: &str,
    uri: &str,
    nonce: &str,
    issued_at: &str,
) -> String {
    format!(
        "{domain} wants you to sign in with your Ethereum account:\n\
         {address}\n\
         \n\
         Sub Rosa film studio\n\
         \n\
         URI: {uri}\n\
         Version: 1\n\
         Chain ID: 1\n\
         Nonce: {nonce}\n\
         Issued At: {issued_at}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Standard vector: the well-known docs key used across Ethereum tooling.
    const DOC_KEY: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    #[test]
    fn address_derivation_matches_known_vectors() {
        let wallet = Wallet::from_hex(DOC_KEY).unwrap();
        assert_eq!(
            wallet.address(),
            "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23"
        );

        // privkey 0x…01 is the canonical minimal-key vector.
        let one =
            Wallet::from_hex("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap();
        assert_eq!(one.address(), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    }

    #[test]
    fn personal_sign_matches_web3_vector() {
        // web3.eth.accounts.sign("Some data", DOC_KEY) from the web3.js docs.
        let wallet = Wallet::from_hex(DOC_KEY).unwrap();
        assert_eq!(
            wallet.sign_personal("Some data").unwrap(),
            "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c"
        );
    }

    #[test]
    fn checksum_address_matches_eip55_vectors() {
        let bytes = hex::decode("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").unwrap();
        assert_eq!(
            checksum_address(&bytes),
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
        );
        let bytes = hex::decode("fb6916095ca1df60bb79ce92ce3ea74c37c5d359").unwrap();
        assert_eq!(
            checksum_address(&bytes),
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"
        );
    }

    #[test]
    fn generated_wallet_round_trips_through_hex() {
        let wallet = Wallet::generate();
        let restored = Wallet::from_hex(&wallet.to_hex()).unwrap();
        assert_eq!(wallet.address(), restored.address());
    }

    #[test]
    fn from_hex_rejects_garbage() {
        assert!(Wallet::from_hex("not hex").is_err());
        assert!(Wallet::from_hex("00").is_err());
        // Zero is not a valid secp256k1 scalar.
        assert!(Wallet::from_hex(&"0".repeat(64)).is_err());
    }

    #[test]
    fn siwe_message_has_the_binding_fields() {
        let message = siwe_message(
            "studio.furetier.com",
            "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
            "https://studio.furetier.com",
            "abc123",
            "2026-07-11T00:00:00Z",
        );
        assert!(message.starts_with(
            "studio.furetier.com wants you to sign in with your Ethereum account:\n0x2c7536E3605D9C16a7a3D7b1898e529396a65c23\n"
        ));
        assert!(message.contains("\nURI: https://studio.furetier.com\n"));
        assert!(message.contains("\nVersion: 1\n"));
        assert!(message.contains("\nNonce: abc123\n"));
        assert!(message.ends_with("Issued At: 2026-07-11T00:00:00Z"));
    }
}
