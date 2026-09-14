//! External identity and opaque object storage adapters. No database dependency.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeZone, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use object_store::{ObjectStore, PutMode, PutOptions, path::Path};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use subrosa_config::Config;
use subrosa_domain::{BlobStore, Error, Identity, IdentityProvider, LoginAttempt, Result, Secret};
use subtle::ConstantTimeEq;
use url::Url;

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}
pub struct OidcProvider {
    client: reqwest::Client,
    config: Config,
    discovery: Discovery,
}
#[derive(Clone, Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: serde_json::Value,
    azp: Option<String>,
    email: String,
    email_verified: bool,
    nonce: String,
    iat: i64,
    auth_time: i64,
}
#[derive(Deserialize)]
struct TokenSet {
    id_token: Secret,
}
impl OidcProvider {
    pub async fn discover(config: Config) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Unavailable)?;
        let url = format!(
            "{}/.well-known/openid-configuration",
            config.oidc.issuer.trim_end_matches('/')
        );
        let discovery: Discovery = bounded_json(
            client
                .get(url)
                .send()
                .await
                .map_err(|_| Error::Unavailable)?,
        )
        .await?;
        if discovery.issuer != config.oidc.issuer {
            return Err(Error::Unavailable);
        }
        for endpoint in [
            &discovery.authorization_endpoint,
            &discovery.token_endpoint,
            &discovery.jwks_uri,
        ] {
            let url = Url::parse(endpoint).map_err(|_| Error::Unavailable)?;
            if url.scheme() != "https"
                && !(config.development
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
            {
                return Err(Error::Unavailable);
            }
            if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
                return Err(Error::Unavailable);
            }
        }
        Ok(Self {
            client,
            config,
            discovery,
        })
    }
}
#[async_trait]
impl IdentityProvider for OidcProvider {
    fn authorization_url(&self, attempt: &LoginAttempt, state: &str) -> Result<String> {
        let mut url =
            Url::parse(&self.discovery.authorization_endpoint).map_err(|_| Error::Unavailable)?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.config.oidc.client_id)
            .append_pair(
                "redirect_uri",
                &format!("{}/auth/callback", self.config.public_url),
            )
            .append_pair("scope", "openid email")
            .append_pair("state", state)
            .append_pair("nonce", attempt.nonce.expose())
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.expose())),
            )
            .append_pair("code_challenge_method", "S256")
            .append_pair("max_age", "0");
        Ok(url.into())
    }
    async fn exchange(&self, attempt: &LoginAttempt, code: &str) -> Result<Identity> {
        let token: TokenSet = bounded_json(
            self.client
                .post(&self.discovery.token_endpoint)
                .basic_auth(
                    &self.config.oidc.client_id,
                    Some(self.config.oidc.client_secret.expose()),
                )
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    (
                        "redirect_uri",
                        &format!("{}/auth/callback", self.config.public_url),
                    ),
                    ("code_verifier", attempt.verifier.expose()),
                ])
                .send()
                .await
                .map_err(|_| Error::Unavailable)?,
        )
        .await?;
        let header = decode_header(token.id_token.expose()).map_err(|_| Error::Unauthorized)?;
        if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
            return Err(Error::Unauthorized);
        }
        let kid = header.kid.ok_or(Error::Unauthorized)?;
        let keys: JwkSet = bounded_json(
            self.client
                .get(&self.discovery.jwks_uri)
                .send()
                .await
                .map_err(|_| Error::Unavailable)?,
        )
        .await?;
        let jwk = keys.find(&kid).ok_or(Error::Unauthorized)?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| Error::Unauthorized)?;
        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[&self.config.oidc.client_id]);
        validation.set_issuer(&[&self.config.oidc.issuer]);
        validation.leeway = 30;
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
        let c = decode::<Claims>(token.id_token.expose(), &key, &validation)
            .map_err(|_| Error::Unauthorized)?
            .claims;
        let multiple = c.aud.as_array().is_some_and(|a| a.len() > 1);
        let now = Utc::now().timestamp();
        if c.iss != self.config.oidc.issuer
            || c.sub.is_empty()
            || c.sub.len() > 255
            || !c.email_verified
            || c.email.is_empty()
            || c.email.len() > 320
            || c.iat > now + 30
            || c.auth_time > now + 30
            || c.auth_time < now - 300
            || (multiple && c.azp.is_none())
            || c.azp
                .as_ref()
                .is_some_and(|azp| azp != &self.config.oidc.client_id)
            || !bool::from(c.nonce.as_bytes().ct_eq(attempt.nonce.expose().as_bytes()))
        {
            return Err(Error::Unauthorized);
        }
        Ok(Identity {
            issuer: c.iss,
            subject: c.sub,
            email: c.email,
            authenticated_at: Utc
                .timestamp_opt(c.auth_time, 0)
                .single()
                .ok_or(Error::Unauthorized)?,
        })
    }
}
async fn bounded_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T> {
    if !response.status().is_success() {
        return Err(Error::Unauthorized);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Error::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Unavailable)
}
pub struct StorageProvider {
    store: Arc<dyn ObjectStore>,
}
impl StorageProvider {
    pub fn new(config: &Config) -> Result<Self> {
        let store: Arc<dyn ObjectStore> = if config.storage.kind == "local" && config.development {
            std::fs::create_dir_all(&config.storage.directory).map_err(|_| Error::Unavailable)?;
            Arc::new(
                object_store::local::LocalFileSystem::new_with_prefix(&config.storage.directory)
                    .map_err(|_| Error::Unavailable)?,
            )
        } else if config.storage.kind == "s3" {
            let mut builder = object_store::aws::AmazonS3Builder::new()
                .with_bucket_name(&config.storage.bucket)
                .with_region(&config.storage.region);
            if let Some(endpoint) = &config.storage.endpoint {
                builder = builder.with_endpoint(endpoint);
            }
            if let Some(key) = &config.storage.access_key {
                builder = builder.with_access_key_id(key.expose());
            }
            if let Some(key) = &config.storage.secret_key {
                builder = builder.with_secret_access_key(key.expose());
            }
            Arc::new(builder.build().map_err(|_| Error::Unavailable)?)
        } else {
            return Err(Error::Unavailable);
        };
        Ok(Self { store })
    }
}
#[async_trait]
impl BlobStore for StorageProvider {
    async fn put(&self, key: &str, content: Vec<u8>) -> Result<()> {
        let digest = Sha256::digest(&content);
        let path = Path::from(key);
        match self
            .store
            .put_opts(
                &path,
                content.into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(object_store::Error::AlreadyExists { .. }) => {
                let old = self.get(key).await?;
                if Sha256::digest(old) == digest {
                    Ok(())
                } else {
                    Err(Error::Conflict)
                }
            }
            Err(_) => Err(Error::Unavailable),
        }
    }
    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        self.store
            .get(&Path::from(key))
            .await
            .map_err(|_| Error::Unavailable)?
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|_| Error::Unavailable)
    }
    async fn delete(&self, key: &str) -> Result<()> {
        match self.store.delete(&Path::from(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(_) => Err(Error::Unavailable),
        }
    }
}

mod ledger;
pub use ledger::LedgerProvider;
