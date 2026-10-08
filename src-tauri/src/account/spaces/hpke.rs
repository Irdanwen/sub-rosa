//! RFC 9180 HPKE, base mode, single shot, one suite only:
//! DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM (0x0020, 0x0001,
//! 0x0002). This is the "sealed box" a space key is wrapped to a member with
//! (docs/security/spaces-protocol.md, section "Wrapping a space key").
//!
//! Written out rather than taken from the `hpke` crate because the browser
//! has to do exactly the same thing with WebCrypto (`website/src/client/spaces/`),
//! and one short, readable derivation on each side is easier to review than
//! two libraries. The tests open what this seals with the `hpke` crate, so a
//! derivation that drifts from the RFC fails there.
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const KEM_ID: u16 = 0x0020;
const KDF_ID: u16 = 0x0001;
const AEAD_ID: u16 = 0x0002;

#[derive(Debug, PartialEq, Eq)]
pub struct HpkeError;

/// HMAC-SHA256 for a key of any length (RFC 2104).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = Zeroizing::new([0u8; 64]);
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// HKDF-Extract (RFC 5869). An empty salt is a string of zeros, which HMAC
/// already treats it as.
pub fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(hmac_sha256(salt, ikm))
}

/// HKDF-Expand (RFC 5869), at most 255 blocks.
pub fn hkdf_expand(prk: &[u8], info: &[u8], length: usize) -> Zeroizing<Vec<u8>> {
    assert!(length <= 255 * 32, "HKDF output too long");
    let mut out = Zeroizing::new(Vec::with_capacity(length));
    let mut previous: Vec<u8> = Vec::new();
    let mut counter = 1u8;
    while out.len() < length {
        let mut message = previous.clone();
        message.extend_from_slice(info);
        message.push(counter);
        let block = hmac_sha256(prk, &message);
        let take = (length - out.len()).min(32);
        out.extend_from_slice(&block[..take]);
        previous = block.to_vec();
        counter = counter.wrapping_add(1);
    }
    out
}

/// HKDF-SHA256 with an empty salt and 32 bytes of output.
pub fn hkdf32(ikm: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let prk = hkdf_extract(&[], ikm);
    let okm = hkdf_expand(prk.as_slice(), info, 32);
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&okm);
    key
}

fn kem_suite() -> Vec<u8> {
    let mut id = b"KEM".to_vec();
    id.extend_from_slice(&KEM_ID.to_be_bytes());
    id
}
fn hpke_suite() -> Vec<u8> {
    let mut id = b"HPKE".to_vec();
    id.extend_from_slice(&KEM_ID.to_be_bytes());
    id.extend_from_slice(&KDF_ID.to_be_bytes());
    id.extend_from_slice(&AEAD_ID.to_be_bytes());
    id
}
fn labeled_extract(suite: &[u8], salt: &[u8], label: &[u8], ikm: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut input = Zeroizing::new(b"HPKE-v1".to_vec());
    input.extend_from_slice(suite);
    input.extend_from_slice(label);
    input.extend_from_slice(ikm);
    hkdf_extract(salt, &input)
}
fn labeled_expand(
    suite: &[u8],
    prk: &[u8],
    label: &[u8],
    info: &[u8],
    length: u16,
) -> Zeroizing<Vec<u8>> {
    let mut labeled = length.to_be_bytes().to_vec();
    labeled.extend_from_slice(b"HPKE-v1");
    labeled.extend_from_slice(suite);
    labeled.extend_from_slice(label);
    labeled.extend_from_slice(info);
    hkdf_expand(prk, &labeled, usize::from(length))
}

pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::x25519(*secret, x25519_dalek::X25519_BASEPOINT_BYTES)
}

fn dh(secret: &[u8; 32], public: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>, HpkeError> {
    let shared = Zeroizing::new(x25519_dalek::x25519(*secret, *public));
    // RFC 9180 7.1.4: a low-order peer key gives the all-zero output.
    if shared.iter().all(|byte| *byte == 0) {
        return Err(HpkeError);
    }
    Ok(shared)
}

fn shared_secret(dh: &[u8; 32], enc: &[u8; 32], recipient: &[u8; 32]) -> Zeroizing<Vec<u8>> {
    let suite = kem_suite();
    let eae_prk = labeled_extract(&suite, b"", b"eae_prk", dh);
    let mut context = enc.to_vec();
    context.extend_from_slice(recipient);
    labeled_expand(&suite, eae_prk.as_slice(), b"shared_secret", &context, 32)
}

fn key_schedule(shared: &[u8], info: &[u8]) -> (Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>) {
    let suite = hpke_suite();
    let psk_id_hash = labeled_extract(&suite, b"", b"psk_id_hash", b"");
    let info_hash = labeled_extract(&suite, b"", b"info_hash", info);
    let mut context = vec![0u8];
    context.extend_from_slice(psk_id_hash.as_slice());
    context.extend_from_slice(info_hash.as_slice());
    let secret = labeled_extract(&suite, shared, b"secret", b"");
    (
        labeled_expand(&suite, secret.as_slice(), b"key", &context, 32),
        labeled_expand(&suite, secret.as_slice(), b"base_nonce", &context, 12),
    )
}

/// Seal with a given ephemeral secret. Only the test vectors pass one; every
/// real seal goes through [`seal`].
pub fn seal_with_ephemeral(
    ephemeral: &[u8; 32],
    recipient: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<([u8; 32], Vec<u8>), HpkeError> {
    let enc = public_key(ephemeral);
    let dh = dh(ephemeral, recipient)?;
    let shared = shared_secret(&dh, &enc, recipient);
    let (key, nonce) = key_schedule(&shared, info);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| HpkeError)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| HpkeError)?;
    Ok((enc, ciphertext))
}

pub fn seal(
    recipient: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<([u8; 32], Vec<u8>), HpkeError> {
    let ephemeral = Zeroizing::new(rand::random::<[u8; 32]>());
    seal_with_ephemeral(&ephemeral, recipient, info, aad, plaintext)
}

pub fn open(
    secret: &[u8; 32],
    enc: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, HpkeError> {
    let recipient = public_key(secret);
    let dh = dh(secret, enc)?;
    let shared = shared_secret(&dh, enc, &recipient);
    let (key, nonce) = key_schedule(&shared, info);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| HpkeError)?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| HpkeError)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpke::{aead::AesGcm256, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, OpModeR};

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hkdf_matches_rfc_5869_test_case_1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let prk = hkdf_extract(&salt, &ikm);
        assert_eq!(
            hex(prk.as_slice()),
            "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
        );
        let okm = hkdf_expand(prk.as_slice(), &info, 42);
        assert_eq!(
            hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn hmac_hashes_a_long_key_first() {
        // RFC 4231 test case 6: a 131 byte key.
        let key = [0xaa; 131];
        assert_eq!(
            hex(&hmac_sha256(
                &key,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn an_independent_hpke_implementation_opens_what_this_seals() {
        let secret: [u8; 32] = rand::random();
        let recipient = public_key(&secret);
        let info = b"subrosa:space-key:v1:space:1:account";
        let (enc, ciphertext) =
            seal(&recipient, info, b"", b"thirty-two bytes of space key!!").unwrap();
        let sk = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(&secret).unwrap();
        let encapped = <X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(&enc).unwrap();
        let clear = hpke::single_shot_open::<AesGcm256, HkdfSha256, X25519HkdfSha256>(
            &OpModeR::Base,
            &sk,
            &encapped,
            info,
            &ciphertext,
            b"",
        )
        .unwrap();
        assert_eq!(clear, b"thirty-two bytes of space key!!");
        assert_eq!(
            open(&secret, &enc, info, b"", &ciphertext)
                .unwrap()
                .as_slice(),
            b"thirty-two bytes of space key!!"
        );
    }

    #[test]
    fn the_info_binds_the_seal() {
        let secret: [u8; 32] = rand::random();
        let (enc, ciphertext) = seal(&public_key(&secret), b"a", b"", b"key").unwrap();
        assert!(open(&secret, &enc, b"b", b"", &ciphertext).is_err());
        assert!(open(&rand::random(), &enc, b"a", b"", &ciphertext).is_err());
    }

    #[test]
    fn a_low_order_point_is_refused() {
        assert_eq!(seal(&[0u8; 32], b"a", b"", b"key").unwrap_err(), HpkeError);
    }
}
