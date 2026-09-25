//! Typed deployment configuration; only the application loads environment settings.
use figment::{
    Figment,
    providers::{Env, Format, Toml},
};
use serde::{Deserialize, Serialize};
use subrosa_domain::Secret;
use url::Url;
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    pub bind: String,
    pub public_url: String,
    #[serde(default)]
    pub development: bool,
    pub database_url: Secret,
    pub oidc: Oidc,
    pub storage: Storage,
    #[serde(default)]
    pub deletion_ledger: Option<Ledger>,
    #[serde(default = "quota")]
    pub account_quota_bytes: i64,
    /// Addresses of the reverse proxies whose `X-Forwarded-For` may be believed.
    ///
    /// Empty means the peer address *is* the client, which is right when nothing
    /// sits in front. It is wrong the moment an ingress does: every request then
    /// arrives from the same loopback address and the per-address budget becomes
    /// one shared budget for the whole Internet, which is a denial of service
    /// against the account rather than a defence of it. A proxy that is not
    /// listed here is never believed, so a forged header from the outside buys
    /// nothing.
    #[serde(default)]
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// Release certificate fingerprints for Android Credential Manager origins.
    /// Keep this aligned with the domain's assetlinks.json. Add a separate
    /// Play signing certificate here if Play re-signs the installable app.
    #[serde(default = "android_certificates")]
    pub passkey_android_cert_fingerprints: Vec<String>,
}
fn android_certificates() -> Vec<String> {
    vec!["13:B7:E7:F8:0D:99:67:A0:02:53:C9:23:0F:89:54:B4:39:12:B2:BE:81:7D:9B:B9:F5:F7:B5:18:AD:D6:DC:49".into()]
}
pub fn fingerprint_bytes(value: &str) -> Option<[u8; 32]> {
    let mut bytes = [0u8; 32];
    let mut parts = value.split(':');
    for byte in &mut bytes {
        let part = parts.next()?;
        if part.len() != 2 {
            return None;
        }
        *byte = u8::from_str_radix(part, 16).ok()?;
    }
    parts.next().is_none().then_some(bytes)
}
fn quota() -> i64 {
    5 * 1024 * 1024 * 1024
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Oidc {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Secret,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Storage {
    pub kind: String,
    #[serde(default)]
    pub directory: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub access_key: Option<Secret>,
    #[serde(default)]
    pub secret_key: Option<Secret>,
    /// A conditional write is the safety net that stops one id ever holding two different
    /// ciphertexts. Not every S3-compatible bucket implements it: Backblaze answers 501, and
    /// the retry that follows costs an upload its whole transaction. Where the bucket cannot
    /// do it, the provider checks for the object first and compares digests instead, which is
    /// sound here because the repository already refuses a second digest under a known id.
    #[serde(default = "enabled")]
    pub conditional_writes: bool,
}
fn enabled() -> bool {
    true
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Ledger {
    pub storage: Storage,
    pub active_key_id: String,
    pub signing_keys: std::collections::BTreeMap<String, Secret>,
}
impl Config {
    pub fn load() -> Result<Self, Box<figment::Error>> {
        Figment::new()
            .merge(Toml::file("config.toml"))
            .merge(Env::prefixed("SUBROSA_CLOUD_").split("__"))
            .extract()
            .map_err(Box::new)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        let public = Url::parse(&self.public_url).map_err(|_| "invalid public URL")?;
        let issuer = Url::parse(&self.oidc.issuer).map_err(|_| "invalid OIDC issuer")?;
        if self.development
            && !matches!(public.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        {
            return Err("development mode is restricted to a loopback public origin");
        }
        for url in [&public, &issuer] {
            let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if url.scheme() != "https" && !(self.development && loopback && url.scheme() == "http")
            {
                return Err("HTTPS required except explicit loopback development");
            }
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("URLs must not contain credentials, query or fragment");
            }
        }
        if public.path() != "/" || self.public_url.ends_with('/') {
            return Err("public_url must be an origin without trailing slash");
        }
        if self.oidc.client_id.is_empty()
            || self.oidc.client_secret.expose().is_empty()
            || self.account_quota_bytes < 1024 * 1024
        {
            return Err("invalid client ID or quota");
        }
        // An unspecified address matches nothing in a peer comparison, so listing
        // one is never what the operator meant: it reads as "trust anybody" and
        // silently trusts nobody. Refuse it rather than let it look configured.
        if self
            .trusted_proxies
            .iter()
            .any(std::net::IpAddr::is_unspecified)
        {
            return Err("a trusted proxy must be a specific address");
        }
        if self
            .passkey_android_cert_fingerprints
            .iter()
            .any(|value| fingerprint_bytes(value).is_none())
        {
            return Err("Android passkey certificate fingerprint must be SHA-256 hex bytes");
        }
        if self.storage.kind != "s3" && !(self.development && self.storage.kind == "local") {
            return Err("production requires S3 storage");
        }
        if let Some(endpoint) = &self.storage.endpoint {
            let u = Url::parse(endpoint).map_err(|_| "invalid storage endpoint")?;
            if u.scheme() != "https" {
                return Err("S3 endpoint requires HTTPS");
            }
        }
        if !self.development && self.deletion_ledger.is_none() {
            return Err("production requires an independent deletion ledger");
        }
        if let Some(ledger) = &self.deletion_ledger {
            if !ledger.signing_keys.contains_key(&ledger.active_key_id)
                || ledger.active_key_id.is_empty()
            {
                return Err("ledger signing key is required");
            }
            if ledger
                .signing_keys
                .values()
                .any(|key| key.expose().len() < 43 || key.expose().starts_with("REPLACE_"))
            {
                return Err("ledger signing keys must encode at least 256 random bits");
            }
            if !self.development
                && (ledger.storage.kind != "s3"
                    || ledger.storage.bucket == self.storage.bucket
                    || ledger.storage.bucket.is_empty())
            {
                return Err("deletion ledger requires a distinct private S3 bucket");
            }
            // The ledger is append-only because the bucket refuses a write onto a key that
            // exists. Turn that off and every record becomes forgeable in silence, so the
            // relaxation the ciphertext bucket is allowed must never reach this one.
            if !self.development && !ledger.storage.conditional_writes {
                return Err("deletion ledger requires conditional writes");
            }
            if let Some(endpoint) = &ledger.storage.endpoint {
                let url = Url::parse(endpoint).map_err(|_| "invalid ledger endpoint")?;
                if url.scheme() != "https" {
                    return Err("ledger endpoint requires HTTPS");
                }
            }
            if self.development
                && ledger.storage.kind == "local"
                && ledger.storage.directory == self.storage.directory
            {
                return Err("deletion ledger requires separate storage");
            }
        }
        Ok(())
    }
    pub fn session_cookie(&self) -> &'static str {
        if self.development {
            "subrosa_session"
        } else {
            "__Host-subrosa_session"
        }
    }
    pub fn flow_cookie(&self) -> &'static str {
        if self.development {
            "subrosa_login"
        } else {
            "__Host-subrosa_login"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn development() -> Config {
        Config {
            bind: "127.0.0.1:8088".into(),
            public_url: "http://127.0.0.1:1430".into(),
            development: true,
            database_url: Secret("test-only".into()),
            oidc: Oidc {
                issuer: "http://127.0.0.1:8788".into(),
                client_id: "test".into(),
                client_secret: Secret("test-only".into()),
            },
            storage: Storage {
                kind: "local".into(),
                directory: "test-blobs".into(),
                bucket: String::new(),
                region: String::new(),
                endpoint: None,
                access_key: None,
                secret_key: None,
                conditional_writes: true,
            },
            deletion_ledger: None,
            account_quota_bytes: 1024 * 1024,
            trusted_proxies: Vec::new(),
            passkey_android_cert_fingerprints: android_certificates(),
        }
    }

    /// The header is only ever read from an address the operator named, and an
    /// unspecified address is a configuration that looks permissive and is not.
    #[test]
    fn a_trusted_proxy_must_be_a_specific_address() {
        let mut config = development();
        config.trusted_proxies = vec![std::net::IpAddr::from([172, 18, 0, 1])];
        assert!(config.validate().is_ok());
        config.trusted_proxies = vec![std::net::IpAddr::from([0, 0, 0, 0])];
        assert!(config.validate().is_err());
    }
    #[test]
    fn development_cookie_and_storage_exceptions_cannot_escape_loopback() {
        let mut config = development();
        assert!(config.validate().is_ok());
        config.public_url = "https://account.example.invalid".into();
        assert!(config.validate().is_err());
        config.development = false;
        assert!(config.validate().is_err());
        config.public_url = "http://127.0.0.1:1430".into();
        assert!(config.validate().is_err());
    }

    /// The ciphertext bucket may relax the conditional write because the repository refuses a
    /// second digest under a known id. The ledger has no such second opinion.
    #[test]
    fn the_ledger_may_not_relax_the_conditional_write() {
        let mut ledger = Ledger {
            active_key_id: "v1".into(),
            signing_keys: [(
                "v1".to_string(),
                Secret("0123456789012345678901234567890123456789012".into()),
            )]
            .into_iter()
            .collect(),
            storage: Storage {
                kind: "s3".into(),
                directory: String::new(),
                bucket: "ledger".into(),
                region: "eu-west-1".into(),
                endpoint: Some("https://s3.eu-west-1.amazonaws.com".into()),
                access_key: None,
                secret_key: None,
                conditional_writes: true,
            },
        };
        let production = |ledger: &Ledger| {
            let mut config = development();
            config.development = false;
            config.public_url = "https://account.example.invalid".into();
            config.oidc.issuer = "https://id.example.invalid".into();
            config.storage = Storage {
                kind: "s3".into(),
                directory: String::new(),
                bucket: "ciphertext".into(),
                region: "eu-central-003".into(),
                endpoint: Some("https://s3.eu-central-003.backblazeb2.com".into()),
                access_key: None,
                secret_key: None,
                conditional_writes: false,
            };
            config.deletion_ledger = Some(ledger.clone());
            config.validate()
        };
        assert!(production(&ledger).is_ok(), "the bulk bucket may relax it");
        ledger.storage.conditional_writes = false;
        assert!(production(&ledger).is_err(), "the ledger may not");
    }
}
