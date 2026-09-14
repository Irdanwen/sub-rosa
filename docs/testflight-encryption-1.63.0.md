# Encryption description for Sub Rosa 1.63.0

Prepared on 14 September 2026 from the shipped source, for completing the
App Store Connect encryption questionnaire. This document records technical
facts; it is not an export approval or a claim of exemption.

## Product and purpose

Sub Rosa is a note-taking and AI assistant application. Its optional account
feature synchronises supported user notes, conversations, completed files and
Carpe Diem settings between the user's authorised devices. Encryption protects
that information before it is sent to the account service.

## Implemented cryptography

| Function | Implementation |
| --- | --- |
| Vault and synchronised content | Standard AES-256-GCM, implemented by RustCrypto `aes-gcm` 0.10 inside the native app. This is additional to transport encryption and is not implemented solely by the operating system. |
| Keys and nonces | Random 256-bit keys, fresh random 96-bit nonces, 128-bit authentication tags. Recovery material is separately generated 256-bit randomness, not a user password. |
| Device pairing and recovery | The same AES-256-GCM primitive protects the vault key using a separate recovery or transfer secret. |
| Integrity and authentication support | SHA-256 for content digests and S256 device authorisation challenges. |
| Network transport | HTTPS; the native `reqwest` client enables `rustls-tls`. The app must not be described as using only Apple's built-in TLS. |
| Local credential storage | Apple's Keychain through the native keyring backend. |
| Companion website | Browser WebCrypto AES-GCM with the same envelope format. The website is not part of the iOS binary. |

The vault uses standard cryptographic algorithms, with an application-specific
envelope format and authenticated context. It does not define a new cipher.
The account service stores encrypted vault contents and does not receive the
plaintext vault or recovery key through this protocol. Revocation blocks
service access but does not erase data or keys already copied to a device.

Source: [native cryptography](../src-tauri/src/account/crypto.rs),
[native dependencies](../src-tauri/Cargo.toml),
[protocol](accounts-sync-contract.md).

## Apple status and remaining declaration

Build `1.63.0` is uploaded and `VALID`. Apple reports
`MISSING_EXPORT_COMPLIANCE` for both internal and external distribution.
The previous `ITSAppUsesNonExemptEncryption=false` value was removed.

The account holder still needs to establish the applicable declaration using
the actual distribution territories and any existing accepted documentation.
The [Apple API check at 13:14 UTC](https://github.com/Irdanwen/sub-rosa/actions/runs/34847985711)
returned zero existing encryption declarations for this app, with no next page.
No approval reference or exemption has been supplied for this release. If
Apple requires a declaration document or approval code, it must come from
that process before the build is distributed.

[Apple's documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
and [release evidence](release-1.63.0.md).
