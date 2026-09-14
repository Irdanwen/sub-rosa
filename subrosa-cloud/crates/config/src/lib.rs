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
            },
            deletion_ledger: None,
            account_quota_bytes: 1024 * 1024,
        }
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
}
