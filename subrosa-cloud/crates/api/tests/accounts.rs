//! Real `PostgreSQL` + signed OIDC wiremock tests. No production authentication bypass.
#![allow(clippy::too_many_lines)]
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
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
use std::sync::Arc;
use subrosa_config::{Config, Oidc, Storage};
use subrosa_domain::{Operation, Secret};
use subrosa_persistence::Repository;
use subrosa_providers::{OidcProvider, StorageProvider};
use subrosa_services::{Service, hash};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

#[path = "support/oidc.rs"]
mod oidc;

#[derive(Serialize, Deserialize)]
struct TestConfig {
    database_url: String,
}
struct Fixture {
    app: Router,
    idp: MockServer,
    service: Service,
    pool: sqlx::PgPool,
    signing: oidc::EphemeralSigningKey,
}
struct Browser {
    cookie: String,
    csrf: String,
}
impl Fixture {
    async fn new() -> Result<Self> {
        let settings: TestConfig = Figment::from(Serialized::defaults(TestConfig {
            database_url: "postgres://postgres@127.0.0.1:55439/postgres".into(),
        }))
        .merge(Env::prefixed("SUBROSA_TEST_"))
        .extract()?;
        let admin = sqlx::PgPool::connect(&settings.database_url)
            .await
            .context("run scripts/test-integration.sh to start PostgreSQL")?;
        let name = format!("subrosa_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await?;
        let mut url = Url::parse(&settings.database_url)?;
        url.set_path(&name);
        let pool = sqlx::PgPool::connect(url.as_str()).await?;
        let repo = Repository::connect(url.as_str()).await?;
        repo.migrate().await?;
        let idp = MockServer::start().await;
        Mock::given(method("GET")).and(path("/.well-known/openid-configuration")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"issuer":idp.uri(),"authorization_endpoint":format!("{}/authorize",idp.uri()),"token_endpoint":format!("{}/token",idp.uri()),"jwks_uri":format!("{}/jwks",idp.uri())}))).mount(&idp).await;
        let config = Config {
            bind: "127.0.0.1:0".into(),
            public_url: "http://127.0.0.1:8787".into(),
            development: true,
            database_url: Secret(url.to_string()),
            oidc: Oidc {
                issuer: idp.uri(),
                client_id: "test-client".into(),
                client_secret: Secret("test-only-client-secret".into()),
            },
            deletion_ledger: None,
            storage: Storage {
                kind: "local".into(),
                directory: std::env::temp_dir()
                    .join(name)
                    .to_string_lossy()
                    .into_owned(),
                bucket: String::new(),
                region: String::new(),
                endpoint: None,
                access_key: None,
                secret_key: None,
                conditional_writes: true,
            },
            account_quota_bytes: 1024 * 1024,
        };
        config.validate().map_err(anyhow::Error::msg)?;
        let provider = Arc::new(OidcProvider::discover(config.clone()).await?);
        let storage = Arc::new(StorageProvider::new(&config)?);
        let service = Service::new(config, repo, provider, storage);
        let app = subrosa_api::router(service.clone());
        Ok(Self {
            app,
            idp,
            service,
            pool,
            signing: oidc::EphemeralSigningKey::generate()?,
        })
    }
    async fn call(&self, request: Request<Body>) -> Result<Response> {
        Ok(self.app.clone().oneshot(request).await?)
    }
    async fn login(&self, subject: &str) -> Result<Browser> {
        let r = self
            .call(Request::builder().uri("/auth/login").body(Body::empty())?)
            .await?;
        assert_eq!(r.status(), StatusCode::SEE_OTHER);
        let flow = r
            .headers()
            .get(header::SET_COOKIE)
            .context("flow cookie")?
            .to_str()?
            .split(';')
            .next()
            .context("cookie pair")?
            .to_owned();
        let url = Url::parse(
            r.headers()
                .get(header::LOCATION)
                .context("redirect")?
                .to_str()?,
        )?;
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("code_challenge_method"), Some(&"S256".into()));
        let state = query.get("state").context("state")?;
        let nonce = query.get("nonce").context("nonce")?;
        Mock::given(method("GET"))
            .and(path("/jwks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&self.signing.jwks))
            .mount(&self.idp)
            .await;
        let now = Utc::now().timestamp();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let token = encode(
            &header,
            &json!({"iss":self.idp.uri(),"aud":"test-client","sub":subject,"email":format!("{subject}@example.test"),"email_verified":true,"nonce":nonce,"iat":now,"exp":now+300,"auth_time":now}),
            &self.signing.encoding_key,
        )?;
        let code = Uuid::new_v4().to_string();
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(wiremock::matchers::body_string_contains(format!(
                "code={code}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id_token":token})))
            .mount(&self.idp)
            .await;
        let r = self
            .call(
                Request::builder()
                    .uri(format!("/auth/callback?state={state}&code={code}"))
                    .header(header::COOKIE, &flow)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(r.status(), StatusCode::SEE_OTHER);
        let cookies: Vec<String> = r
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| {
                v.to_str()
                    .unwrap_or("")
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .to_owned()
            })
            .collect();
        let session = cookies
            .iter()
            .find(|c| c.starts_with("subrosa_session="))
            .context("session")?;
        let csrf = cookies
            .iter()
            .find_map(|c| c.strip_prefix("subrosa_csrf="))
            .context("csrf")?
            .to_owned();
        let replay = self
            .call(
                Request::builder()
                    .uri(format!("/auth/callback?state={state}&code={code}"))
                    .header(header::COOKIE, &flow)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        Ok(Browser {
            cookie: format!("{session}; subrosa_csrf={csrf}"),
            csrf,
        })
    }
    async fn json(
        &self,
        method: &str,
        path: &str,
        browser: &Browser,
        body: Value,
    ) -> Result<(StatusCode, Value)> {
        let r = self
            .call(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::COOKIE, &browser.cookie)
                    .header(header::ORIGIN, "http://127.0.0.1:8787")
                    .header("x-csrf-token", &browser.csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&body)?))?,
            )
            .await?;
        decode_response(r).await
    }
}
async fn decode_response(r: Response) -> Result<(StatusCode, Value)> {
    let status = r.status();
    let bytes = to_bytes(r.into_body(), 40 * 1024 * 1024).await?;
    Ok((status, serde_json::from_slice(&bytes)?))
}
fn operation(object: Uuid, parent: Option<Uuid>, body: &str) -> Operation {
    Operation {
        resolved_revisions: Vec::new(),
        operation_id: Uuid::new_v4(),
        object_id: object,
        parent_revision: parent,
        kind: "note".into(),
        ciphertext: body.into(),
        deleted: false,
    }
}

#[tokio::test]
async fn oidc_csrf_device_pkce_and_revocation() -> Result<()> {
    let f = Fixture::new().await?;
    let browser = f.login("alice").await?;
    let no_auth = f
        .call(Request::builder().uri("/api/v1/me").body(Body::empty())?)
        .await?;
    assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
    let bad_origin = f
        .call(
            Request::builder()
                .method("POST")
                .uri("/auth/logout")
                .header(header::COOKIE, &browser.cookie)
                .header(header::ORIGIN, "https://attacker.test")
                .header("x-csrf-token", &browser.csrf)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);
    let missing_csrf = f
        .call(
            Request::builder()
                .method("POST")
                .uri("/auth/logout")
                .header(header::COOKIE, &browser.cookie)
                .header(header::ORIGIN, "http://127.0.0.1:8787")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);
    let verifier = "v".repeat(43);
    let (status, start) = f
        .json(
            "POST",
            "/api/v1/device-login",
            &browser,
            json!({"challenge":URL_SAFE_NO_PAD.encode(hash(&verifier)),"device_name":"Test phone"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let id = &start["data"]["request_id"];
    let (status, _) = f
        .json(
            "POST",
            "/api/v1/device-login/exchange",
            &browser,
            json!({"request_id":id,"verifier":verifier}),
        )
        .await?;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
    let (status, _) = f
        .json(
            "POST",
            "/api/v1/device-login/approve",
            &browser,
            json!({"user_code":start["data"]["user_code"]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f
        .json(
            "POST",
            "/api/v1/device-login/exchange",
            &browser,
            json!({"request_id":id,"verifier":"x".repeat(43)}),
        )
        .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE device_requests SET last_poll=now()-interval '6 seconds'")
        .execute(&f.pool)
        .await?;
    let (status, token) = f
        .json(
            "POST",
            "/api/v1/device-login/exchange",
            &browser,
            json!({"request_id":id,"verifier":verifier}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let bearer = token["data"]["access_token"].as_str().context("token")?;
    let native = f
        .call(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(native.status(), StatusCode::OK);
    let (status, _) = f
        .json(
            "POST",
            "/api/v1/device-login/exchange",
            &browser,
            json!({"request_id":id,"verifier":verifier}),
        )
        .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let device = token["data"]["device_id"].as_str().context("device")?;
    let (status, _) = f
        .json(
            "DELETE",
            &format!("/api/v1/devices/{device}"),
            &browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let revoked = f
        .call(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn journal_siblings_retries_isolation_vault_and_deletion() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bob = f.login("bob").await?;
    let object = Uuid::new_v4();
    let first = operation(object, None, "cipher-one");
    let (status, result) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[first]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let rev = Uuid::parse_str(
        result["data"]["results"][0]["revision"]
            .as_str()
            .context("revision")?,
    )?;
    let (_, retry) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[first]}),
        )
        .await?;
    assert_eq!(result, retry);
    let mut changed = first.clone();
    changed.ciphertext = "different-cipher".into();
    assert_eq!(
        f.json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[changed]})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    let left = operation(object, Some(rev), "cipher-left");
    let right = operation(object, Some(rev), "cipher-right");
    let (_, l) = f
        .json("POST", "/api/v1/sync", &alice, json!({"operations":[left]}))
        .await?;
    assert_eq!(l["data"]["results"][0]["conflict"], false);
    let (_, r) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[right]}),
        )
        .await?;
    assert_eq!(r["data"]["results"][0]["conflict"], true);
    let (_, journal) = f
        .json("GET", "/api/v1/sync?limit=2", &alice, json!({}))
        .await?;
    assert_eq!(
        journal["data"]["changes"]
            .as_array()
            .context("changes")?
            .len(),
        2
    );
    assert_eq!(journal["data"]["has_more"], true);
    let (_, other) = f.json("GET", "/api/v1/sync", &bob, json!({})).await?;
    assert_eq!(other["data"]["changes"], json!([]));
    let heads: i64 =
        sqlx::query_scalar("SELECT count(*) FROM revisions WHERE object_id=$1 AND is_head")
            .bind(object)
            .fetch_one(&f.pool)
            .await?;
    assert_eq!(heads, 2);
    let envelope = json!(r#"{"version":1,"nonce":"opaque","ciphertext":"opaque-client-envelope"}"#);
    assert_eq!(
        f.json(
            "PUT",
            "/api/v1/vault",
            &alice,
            json!({"expected_version":0,"envelope":envelope})
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.json(
            "PUT",
            "/api/v1/vault",
            &alice,
            json!({"expected_version":0,"envelope":envelope})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.json("GET", "/api/v1/vault", &bob, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("DELETE", "/api/v1/me", &alice, json!({})).await?.0,
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", "/api/v1/me", &alice, json!({})).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM revisions")
        .fetch_one(&f.pool)
        .await?;
    assert_eq!(count, 0);
    Ok(())
}

#[tokio::test]
async fn immutable_blobs_quota_and_durable_cleanup() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bob = f.login("bob").await?;
    let id = Uuid::new_v4();
    let path = format!("/api/v1/blobs/{id}");
    for (data, expected) in [
        ("encrypted-one", StatusCode::OK),
        ("encrypted-one", StatusCode::OK),
        ("different", StatusCode::CONFLICT),
    ] {
        let r = f
            .call(
                Request::builder()
                    .method("PUT")
                    .uri(&path)
                    .header(header::COOKIE, &alice.cookie)
                    .header(header::ORIGIN, "http://127.0.0.1:8787")
                    .header("x-csrf-token", &alice.csrf)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(Body::from(data))?,
            )
            .await?;
        assert_eq!(r.status(), expected);
    }
    assert_eq!(
        f.json("GET", &path, &bob, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    let huge = operation(Uuid::new_v4(), None, &"x".repeat(1024 * 1024));
    assert_eq!(
        f.json("POST", "/api/v1/sync", &alice, json!({"operations":[huge]}))
            .await?
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM revisions")
        .fetch_one(&f.pool)
        .await?;
    assert_eq!(count, 0);
    assert_eq!(
        f.json("DELETE", "/api/v1/me", &alice, json!({})).await?.0,
        StatusCode::OK
    );
    assert_eq!(f.service.repository.cleanup_keys().await?.len(), 1);
    f.service.maintenance().await?;
    assert!(f.service.repository.cleanup_keys().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn pairing_is_single_use_session_bound_and_expires() -> Result<()> {
    let f = Fixture::new().await?;
    let target = f.login("alice").await?;
    let trusted = f.login("alice").await?;
    let outsider = f.login("bob").await?;
    let id = Uuid::new_v4();
    let p = format!("/api/v1/pairing/{id}");
    assert_eq!(
        f.json("POST", "/api/v1/pairing", &target, json!({"request_id":id}))
            .await?
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", &p, &trusted, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("GET", &p, &outsider, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("{p}/approve"),
            &target,
            json!({"envelope":"opaque"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("{p}/approve"),
            &outsider,
            json!({"envelope":"opaque"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("{p}/approve"),
            &trusted,
            json!({"envelope":"opaque-authenticated-envelope"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("{p}/approve"),
            &trusted,
            json!({"envelope":"replacement"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.json("GET", &p, &target, json!({})).await?.1["data"]["envelope"],
        "opaque-authenticated-envelope"
    );
    sqlx::query("UPDATE pairing_requests SET expires_at=now()-interval '1 second'")
        .execute(&f.pool)
        .await?;
    assert_eq!(
        f.json("GET", &p, &target, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    f.service.maintenance().await?;
    assert_eq!(
        f.json("DELETE", &p, &target, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    Ok(())
}

#[tokio::test]
async fn simultaneous_offline_writes_keep_every_sibling_and_cursor() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let object = Uuid::new_v4();
    let one = operation(object, None, "one");
    let two = operation(object, None, "two");
    let (a, b) = tokio::join!(
        f.json("POST", "/api/v1/sync", &alice, json!({"operations":[one]})),
        f.json("POST", "/api/v1/sync", &alice, json!({"operations":[two]}))
    );
    let (sa, ra) = a?;
    let (sb, rb) = b?;
    assert_eq!(sa, StatusCode::OK);
    assert_eq!(sb, StatusCode::OK);
    assert_ne!(
        ra["data"]["results"][0]["sequence"],
        rb["data"]["results"][0]["sequence"]
    );
    assert_ne!(
        ra["data"]["results"][0]["conflict"],
        rb["data"]["results"][0]["conflict"]
    );
    let (_, j) = f.json("GET", "/api/v1/sync", &alice, json!({})).await?;
    assert_eq!(j["data"]["cursor"], 2);
    assert_eq!(j["data"]["changes"].as_array().context("changes")?.len(), 2);
    sqlx::query("UPDATE sessions SET authenticated_at=now()-interval '10 minutes'")
        .execute(&f.pool)
        .await?;
    let (status, error) = f.json("DELETE", "/api/v1/me", &alice, json!({})).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["error"]["code"], "recent_auth_required");
    Ok(())
}

#[tokio::test]
async fn oidc_rejects_substituted_browser_nonce_audience_and_signature() -> Result<()> {
    let f = Fixture::new().await?;
    for mutation in ["nonce", "aud", "email_verified", "signature", "auth_time"] {
        let response = f
            .call(Request::builder().uri("/auth/login").body(Body::empty())?)
            .await?;
        let flow = response
            .headers()
            .get(header::SET_COOKIE)
            .context("cookie")?
            .to_str()?
            .split(';')
            .next()
            .context("pair")?
            .to_owned();
        let url = Url::parse(
            response
                .headers()
                .get(header::LOCATION)
                .context("location")?
                .to_str()?,
        )?;
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let state = q.get("state").context("state")?;
        let wrong_browser = f
            .call(
                Request::builder()
                    .uri(format!("/auth/callback?state={state}&code=any"))
                    .header(header::COOKIE, "subrosa_login=wrong")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(wrong_browser.status(), StatusCode::UNAUTHORIZED);
        let mut claims = json!({"iss":f.idp.uri(),"sub":"alice","aud":"test-client","email":"alice@example.test","email_verified":true,"nonce":q.get("nonce"),"iat":Utc::now().timestamp(),"exp":Utc::now().timestamp()+300,"auth_time":Utc::now().timestamp()});
        if mutation == "nonce" {
            claims["nonce"] = json!("wrong");
        }
        if mutation == "aud" {
            claims["aud"] = json!("other-client");
        }
        if mutation == "email_verified" {
            claims["email_verified"] = json!(false);
        }
        if mutation == "auth_time" {
            claims["auth_time"] = json!(Utc::now().timestamp() - 600);
        }
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let mut token = encode(&header, &claims, &f.signing.encoding_key)?;
        if mutation == "signature" {
            let pos = token.rfind('.').context("signature")? + 1;
            token.replace_range(pos..=pos, if &token[pos..=pos] == "A" { "B" } else { "A" });
        }
        Mock::given(method("GET"))
            .and(path("/jwks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&f.signing.jwks))
            .mount(&f.idp)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(wiremock::matchers::body_string_contains(format!(
                "code={mutation}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id_token":token})))
            .mount(&f.idp)
            .await;
        let response = f
            .call(
                Request::builder()
                    .uri(format!("/auth/callback?state={state}&code={mutation}"))
                    .header(header::COOKIE, &flow)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "mutation {mutation}"
        );
    }
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&f.pool)
        .await?;
    assert_eq!(sessions, 0);
    Ok(())
}

#[tokio::test]
async fn filtered_sync_uses_snapshot_cursor_and_caps_serialized_bytes() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let (_, me) = f.json("GET", "/api/v1/me", &alice, json!({})).await?;
    let owner = Uuid::parse_str(me["data"]["id"].as_str().context("owner")?)?;
    sqlx::query("INSERT INTO revisions(account_id,sequence,operation_id,operation_hash,object_id,revision,kind,ciphertext,deleted,conflict) SELECT $1,i,md5('op'||i)::uuid,decode('00','hex'),md5('object'||i)::uuid,md5('revision'||i)::uuid,CASE WHEN i=12 THEN 'settings' ELSE 'note' END,repeat('x',900000),false,false FROM generate_series(1,12) AS i").bind(owner).execute(&f.pool).await?;
    sqlx::query("UPDATE accounts SET next_sequence=12 WHERE id=$1")
        .bind(owner)
        .execute(&f.pool)
        .await?;
    let (_, filtered) = f
        .json("GET", "/api/v1/sync?kind=settings", &alice, json!({}))
        .await?;
    assert_eq!(filtered["data"]["cursor"], 12);
    assert_eq!(
        filtered["data"]["changes"]
            .as_array()
            .context("changes")?
            .len(),
        1
    );
    assert_eq!(filtered["data"]["has_more"], false);
    let (_, empty) = f
        .json("GET", "/api/v1/sync?kind=usage", &alice, json!({}))
        .await?;
    assert_eq!(empty["data"]["cursor"], 12);
    assert_eq!(empty["data"]["changes"], json!([]));
    let (_, page) = f
        .json("GET", "/api/v1/sync?limit=500", &alice, json!({}))
        .await?;
    assert!(serde_json::to_vec(&page)?.len() < 8 * 1024 * 1024);
    assert_eq!(page["data"]["has_more"], true);
    let cursor = page["data"]["cursor"].as_i64().context("cursor")?;
    assert!(cursor > 0 && cursor < 12);
    let (_, tail) = f
        .json(
            "GET",
            &format!("/api/v1/sync?after={cursor}"),
            &alice,
            json!({}),
        )
        .await?;
    assert_eq!(tail["data"]["cursor"], 12);
    assert_eq!(tail["data"]["has_more"], false);
    assert_eq!(
        f.json("GET", "/api/v1/sync?kind=unknown", &alice, json!({}))
            .await?
            .0,
        StatusCode::BAD_REQUEST
    );
    Ok(())
}

async fn native_bundle(f: &Fixture, browser: &Browser) -> Result<Value> {
    let verifier = "r".repeat(43);
    let (_,start)=f.json("POST","/api/v1/device-login",browser,json!({"challenge":URL_SAFE_NO_PAD.encode(hash(&verifier)),"device_name":"Refresh test phone"})).await?;
    let (approved, _) = f
        .json(
            "POST",
            "/api/v1/device-login/approve",
            browser,
            json!({"user_code":start["data"]["user_code"]}),
        )
        .await?;
    assert_eq!(approved, StatusCode::OK);
    let (status, token) = f
        .json(
            "POST",
            "/api/v1/device-login/exchange",
            browser,
            json!({"request_id":start["data"]["request_id"],"verifier":verifier}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(token["data"].clone())
}
async fn bearer_status(f: &Fixture, token: &Value) -> Result<StatusCode> {
    Ok(f.call(
        Request::builder()
            .uri("/api/v1/me")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", token.as_str().context("access")?),
            )
            .body(Body::empty())?,
    )
    .await?
    .status())
}
#[tokio::test]
async fn refresh_rotation_replay_revokes_every_generation() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bundle = native_bundle(&f, &alice).await?;
    let expiry =
        chrono::DateTime::parse_from_rfc3339(bundle["expires_at"].as_str().context("expiry")?)?;
    assert!((850..=900).contains(&(expiry.timestamp() - Utc::now().timestamp())));
    let (status, rotated) = f
        .json(
            "POST",
            "/api/v1/session/refresh",
            &alice,
            json!({"refresh_token":bundle["refresh_token"]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(bundle["access_token"], rotated["data"]["access_token"]);
    assert_ne!(bundle["refresh_token"], rotated["data"]["refresh_token"]);
    assert_eq!(
        bundle["refresh_expires_at"],
        rotated["data"]["refresh_expires_at"]
    );
    assert_eq!(
        bearer_status(&f, &rotated["data"]["access_token"]).await?,
        StatusCode::OK
    );
    assert_eq!(
        f.json(
            "POST",
            "/api/v1/session/refresh",
            &alice,
            json!({"refresh_token":bundle["refresh_token"]})
        )
        .await?
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        bearer_status(&f, &bundle["access_token"]).await?,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        bearer_status(&f, &rotated["data"]["access_token"]).await?,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.json(
            "POST",
            "/api/v1/session/refresh",
            &alice,
            json!({"refresh_token":rotated["data"]["refresh_token"]})
        )
        .await?
        .0,
        StatusCode::UNAUTHORIZED
    );
    Ok(())
}
#[tokio::test]
async fn concurrent_refresh_is_detected_and_revokes_family() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bundle = native_bundle(&f, &alice).await?;
    let body = json!({"refresh_token":bundle["refresh_token"]});
    let (a, b) = tokio::join!(
        f.json("POST", "/api/v1/session/refresh", &alice, body.clone()),
        f.json("POST", "/api/v1/session/refresh", &alice, body)
    );
    let a = a?;
    let b = b?;
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::UNAUTHORIZED)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::UNAUTHORIZED)
    );
    let issued = if a.0 == StatusCode::OK { a.1 } else { b.1 };
    assert_eq!(
        bearer_status(&f, &issued["data"]["access_token"]).await?,
        StatusCode::UNAUTHORIZED
    );
    Ok(())
}
#[tokio::test]
async fn explicit_resolution_closes_known_heads_but_preserves_unseen_heads() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let object = Uuid::new_v4();
    let (_, first) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[operation(object,None,"one"),operation(object,None,"two")]}),
        )
        .await?;
    let left = Uuid::parse_str(
        first["data"]["results"][0]["revision"]
            .as_str()
            .context("left")?,
    )?;
    let right = Uuid::parse_str(
        first["data"]["results"][1]["revision"]
            .as_str()
            .context("right")?,
    )?;
    let mut resolution = operation(object, Some(left), "user-approved-resolution");
    resolution.resolved_revisions = vec![right];
    let (status, resolved) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[resolution]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved["data"]["results"][0]["conflict"], false);
    let heads: i64 =
        sqlx::query_scalar("SELECT count(*) FROM revisions WHERE object_id=$1 AND is_head")
            .bind(object)
            .fetch_one(&f.pool)
            .await?;
    assert_eq!(heads, 1);
    let (_, unseen) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[operation(object,Some(right),"offline-unseen")]}),
        )
        .await?;
    assert_eq!(unseen["data"]["results"][0]["conflict"], true);
    let mut stale = operation(object, Some(left), "stale-resolution");
    stale.resolved_revisions = vec![right];
    let (_, stale) = f
        .json(
            "POST",
            "/api/v1/sync",
            &alice,
            json!({"operations":[stale]}),
        )
        .await?;
    assert_eq!(stale["data"]["results"][0]["conflict"], true);
    let (_, journal) = f.json("GET", "/api/v1/sync", &alice, json!({})).await?;
    assert_eq!(
        journal["data"]["changes"][2]["resolved_revisions"],
        json!([right])
    );
    Ok(())
}
#[tokio::test]
async fn independent_signed_ledger_reapplies_erasure_after_database_restore() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let (_, account) = f.json("GET", "/api/v1/me", &alice, json!({})).await?;
    let owner = Uuid::parse_str(account["data"]["id"].as_str().context("owner")?)?;
    let mut config = (*f.service.config).clone();
    let ledger_dir = std::env::temp_dir().join(format!("subrosa-ledger-{}", Uuid::new_v4()));
    config.deletion_ledger = Some(subrosa_config::Ledger {
        storage: Storage {
            kind: "local".into(),
            directory: ledger_dir.to_string_lossy().into_owned(),
            bucket: String::new(),
            region: String::new(),
            endpoint: None,
            access_key: None,
            secret_key: None,
            conditional_writes: true,
        },
        active_key_id: "test-v1".into(),
        signing_keys: std::collections::BTreeMap::from([(
            "test-v1".into(),
            Secret(URL_SAFE_NO_PAD.encode([42u8; 32])),
        )]),
    });
    config.validate().map_err(anyhow::Error::msg)?;
    let ledger = subrosa_providers::LedgerProvider::new(&config)?.context("ledger")?;
    let service = f
        .service
        .clone()
        .with_deletion_ledger(Some(Arc::new(ledger)));
    let app = subrosa_api::router(service.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/me")
                .header(header::COOKIE, &alice.cookie)
                .header(header::ORIGIN, "http://127.0.0.1:8787")
                .header("x-csrf-token", &alice.csrf)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    // Simulate restoring the old database backup, independently of the deletion bucket.
    sqlx::query(
        "INSERT INTO accounts(id,issuer,subject,email) VALUES($1,$2,'alice','alice@example.test')",
    )
    .bind(owner)
    .bind(f.idp.uri())
    .execute(&f.pool)
    .await?;
    service.maintenance().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=$1)")
        .bind(owner)
        .fetch_one(&f.pool)
        .await?;
    assert!(!exists);
    // Tampered ledger content fails closed instead of silently trusting object storage.
    let path = ledger_dir.join("deletions").join(format!("{owner}.json"));
    let mut record: Value = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    record["record"]["account_id"] = json!(Uuid::new_v4());
    tokio::fs::write(path, serde_json::to_vec(&record)?).await?;
    assert!(service.maintenance().await.is_err());
    Ok(())
}

#[tokio::test]
async fn native_pairing_survives_access_rotation_and_restore_invalidates_sessions() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bundle = native_bundle(&f, &alice).await?;
    let id = Uuid::new_v4();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/pairing")
        .header(
            header::AUTHORIZATION,
            format!(
                "Bearer {}",
                bundle["access_token"].as_str().context("access")?
            ),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"request_id":id}).to_string()))?;
    assert_eq!(f.call(request).await?.status(), StatusCode::OK);
    let (status, rotated) = f
        .json(
            "POST",
            "/api/v1/session/refresh",
            &alice,
            json!({"refresh_token":bundle["refresh_token"]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        f.json(
            "POST",
            &format!("/api/v1/pairing/{id}/approve"),
            &alice,
            json!({"envelope":"ciphertext"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    let request = Request::builder()
        .uri(format!("/api/v1/pairing/{id}"))
        .header(
            header::AUTHORIZATION,
            format!(
                "Bearer {}",
                rotated["data"]["access_token"].as_str().context("access")?
            ),
        )
        .body(Body::empty())?;
    assert_eq!(f.call(request).await?.status(), StatusCode::OK);
    f.service.repository.invalidate_restored_sessions().await?;
    assert_eq!(
        bearer_status(&f, &rotated["data"]["access_token"]).await?,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.json("GET", "/api/v1/me", &alice, json!({})).await?.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.json(
            "POST",
            "/api/v1/session/refresh",
            &alice,
            json!({"refresh_token":rotated["data"]["refresh_token"]})
        )
        .await?
        .0,
        StatusCode::UNAUTHORIZED
    );
    Ok(())
}

#[tokio::test]
async fn account_context_header_prevents_cross_tab_vault_contamination() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bob = f.login("bob").await?;
    let (_, a) = f.json("GET", "/api/v1/me", &alice, json!({})).await?;
    let (_, b) = f.json("GET", "/api/v1/me", &bob, json!({})).await?;
    let alice_id = a["data"]["id"].as_str().context("alice")?;
    let bob_id = b["data"]["id"].as_str().context("bob")?;
    for (expected, status) in [
        (alice_id, StatusCode::OK),
        (bob_id, StatusCode::CONFLICT),
        ("invalid", StatusCode::CONFLICT),
    ] {
        let r = f
            .call(
                Request::builder()
                    .uri("/api/v1/me")
                    .header(header::COOKIE, &alice.cookie)
                    .header("x-subrosa-account-id", expected)
                    .body(Body::empty())?,
            )
            .await?;
        let (actual, body) = decode_response(r).await?;
        assert_eq!(actual, status);
        if status == StatusCode::CONFLICT {
            assert_eq!(body["error"]["code"], "account_mismatch");
        }
    }
    // Cookies have switched to Bob in another tab while this tab still holds Alice's vault key.
    let r = f
        .call(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/vault")
                .header(header::COOKIE, &bob.cookie)
                .header(header::ORIGIN, "http://127.0.0.1:8787")
                .header("x-csrf-token", &bob.csrf)
                .header("x-subrosa-account-id", alice_id)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"expected_version":0,"envelope":"ciphertext-under-alice-key"})
                        .to_string(),
                ))?,
        )
        .await?;
    let (status, body) = decode_response(r).await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "account_mismatch");
    assert_eq!(
        f.json("GET", "/api/v1/vault", &alice, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("GET", "/api/v1/vault", &bob, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    let bundle = native_bundle(&f, &alice).await?;
    let r = f
        .call(
            Request::builder()
                .uri("/api/v1/me")
                .header(
                    header::AUTHORIZATION,
                    format!(
                        "Bearer {}",
                        bundle["access_token"].as_str().context("access")?
                    ),
                )
                .header("x-subrosa-account-id", bob_id)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(
        bearer_status(&f, &bundle["access_token"]).await?,
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", "/api/v1/me", &alice, json!({})).await?.0,
        StatusCode::OK
    );
    Ok(())
}
