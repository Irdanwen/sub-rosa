//! Browser QA fixture, never included in the production binary or Docker image.
//! Runs a real account API against a loopback-only, test-only OIDC issuer and database.
use anyhow::{Context, Result};
use axum::{
    Form, Json, Router,
    extract::{Query, State},
    response::{Html, Redirect},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use figment::{
    Figment,
    providers::{Env, Serialized},
};
use jsonwebtoken::{Algorithm, Header, encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use subrosa_config::{Config, Oidc, Storage};
use subrosa_domain::Secret;
use subrosa_persistence::Repository;
use subrosa_providers::{OidcProvider, StorageProvider};
use subrosa_services::{Service, hash};
use uuid::Uuid;

#[path = "../tests/support/oidc.rs"]
mod oidc;

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    database_url: String,
    public_url: String,
}
#[derive(Clone)]
struct Issuer {
    public_url: String,
    codes: Arc<Mutex<HashMap<String, Authorize>>>,
    signing: oidc::EphemeralSigningKey,
}
#[derive(Clone, Deserialize)]
struct Authorize {
    state: String,
    nonce: String,
    code_challenge: String,
    redirect_uri: String,
    client_id: String,
    code_challenge_method: String,
}
async fn authorize(
    State(s): State<Issuer>,
    Query(q): Query<Authorize>,
) -> std::result::Result<Html<String>, axum::http::StatusCode> {
    if q.redirect_uri != format!("{}/auth/callback", s.public_url)
        || q.client_id != "test-client"
        || q.code_challenge_method != "S256"
        || [&q.state, &q.nonce, &q.code_challenge].iter().any(|v| {
            v.len() != 43
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
    {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    let code = Uuid::new_v4().to_string();
    s.codes
        .lock()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .insert(code.clone(), q);
    Ok(Html(format!(
        "<!doctype html><html lang=\"fr\"><meta charset=\"utf-8\"><title>Identité de test Sub Rosa</title><body style=\"font:18px system-ui;max-width:38rem;margin:12vh auto;padding:2rem\"><h1>Identité de test locale</h1><p>Ce fournisseur sert uniquement aux essais locaux. Aucun compte réel n'est créé.</p><form action=\"/approve\" method=\"post\"><input name=\"code\" type=\"hidden\" value=\"{code}\"><button style=\"font:inherit;padding:1rem\">Continuer avec qa@example.test</button></form></body></html>"
    )))
}
#[derive(Deserialize)]
struct Approval {
    code: String,
}
async fn approve(
    State(s): State<Issuer>,
    Form(q): Form<Approval>,
) -> std::result::Result<Redirect, axum::http::StatusCode> {
    let codes = s
        .codes
        .lock()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let auth = codes
        .get(&q.code)
        .ok_or(axum::http::StatusCode::BAD_REQUEST)?;
    Ok(Redirect::to(&format!(
        "{}?state={}&code={}",
        auth.redirect_uri, auth.state, q.code
    )))
}
#[derive(Deserialize)]
struct Token {
    code: String,
    code_verifier: String,
    redirect_uri: String,
    grant_type: String,
}
async fn token(
    State(s): State<Issuer>,
    Form(q): Form<Token>,
) -> std::result::Result<Json<Value>, axum::http::StatusCode> {
    let auth = s
        .codes
        .lock()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .remove(&q.code)
        .ok_or(axum::http::StatusCode::BAD_REQUEST)?;
    if auth.code_challenge != URL_SAFE_NO_PAD.encode(hash(&q.code_verifier))
        || q.redirect_uri != auth.redirect_uri
        || q.grant_type != "authorization_code"
    {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test-key".into());
    let now = Utc::now().timestamp();
    let token=encode(&header,&json!({"iss":"http://127.0.0.1:8788","sub":"local-qa-user","aud":"test-client","email":"qa@example.test","email_verified":true,"nonce":auth.nonce,"iat":now,"exp":now+300,"auth_time":now}),&s.signing.encoding_key).map_err(|_|axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"id_token":token,"token_type":"Bearer"})))
}
#[tokio::main]
async fn main() -> Result<()> {
    let settings: Settings = Figment::from(Serialized::defaults(Settings {
        database_url: "postgres://postgres@127.0.0.1:55439/postgres".into(),
        public_url: "http://127.0.0.1:1430".into(),
    }))
    .merge(Env::prefixed("SUBROSA_TEST_"))
    .extract()?;
    let public = url::Url::parse(&settings.public_url)?;
    anyhow::ensure!(
        public.scheme() == "http" && public.host_str() == Some("127.0.0.1"),
        "QA fixture must remain on loopback"
    );
    let issuer = Issuer {
        public_url: settings.public_url.clone(),
        codes: Arc::default(),
        signing: oidc::EphemeralSigningKey::generate()?,
    };
    let oidc=Router::new().route("/.well-known/openid-configuration",get(||async{Json(json!({"issuer":"http://127.0.0.1:8788","authorization_endpoint":"http://127.0.0.1:8788/authorize","token_endpoint":"http://127.0.0.1:8788/token","jwks_uri":"http://127.0.0.1:8788/jwks"}))})).route("/jwks",get(|State(s): State<Issuer>|async move {Json(s.signing.jwks)})).route("/authorize",get(authorize)).route("/approve",post(approve)).route("/token",post(token)).with_state(issuer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8788").await?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, oidc).await;
    });
    let admin = sqlx::PgPool::connect(&settings.database_url)
        .await
        .context("start test PostgreSQL first")?;
    if !sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='subrosa_browser_qa')",
    )
    .fetch_one(&admin)
    .await?
    {
        sqlx::query("CREATE DATABASE subrosa_browser_qa")
            .execute(&admin)
            .await?;
    }
    let mut url = url::Url::parse(&settings.database_url)?;
    url.set_path("subrosa_browser_qa");
    let repo = Repository::connect(url.as_str()).await?;
    repo.migrate().await?;
    let config = Config {
        bind: "127.0.0.1:8088".into(),
        public_url: settings.public_url,
        development: true,
        database_url: Secret(url.into()),
        oidc: Oidc {
            issuer: "http://127.0.0.1:8788".into(),
            client_id: "test-client".into(),
            client_secret: Secret("test-only".into()),
        },
        deletion_ledger: None,
        storage: Storage {
            kind: "local".into(),
            directory: std::env::temp_dir()
                .join("subrosa-browser-qa-blobs")
                .to_string_lossy()
                .into_owned(),
            bucket: String::new(),
            region: String::new(),
            endpoint: None,
            access_key: None,
            secret_key: None,
            conditional_writes: true,
        },
        account_quota_bytes: 1024 * 1024 * 1024,
        trusted_proxies: Vec::new(),
    };
    config.validate().map_err(anyhow::Error::msg)?;
    let storage = Arc::new(StorageProvider::new(&config)?);
    let provider = Arc::new(OidcProvider::discover(config.clone()).await?);
    let service = Service::new(config, repo, provider, storage);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8088").await?;
    axum::serve(
        listener,
        subrosa_api::router(service).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
