//! GitHub signs in with the device flow, then uses GitHub's remote MCP
//! server with that token as its bearer. Both against a mock: the device
//! endpoints answer as GitHub documents them (RFC 8628), the MCP side
//! refuses anything but the token the flow handed out.

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn device_handler(base: &str, request: &Req, polls: &AtomicUsize) -> Resp {
    match request.path.as_str() {
        "/login/device/code" => {
            let form = request.form();
            assert_eq!(form.get("client_id").map(String::as_str), Some("Iv1.test"));
            assert!(form
                .get("scope")
                .is_some_and(|scope| scope.contains("repo")));
            json_resp(json!({
                "device_code": "dev-123",
                "user_code": "WDJB-MJHT",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 0,
            }))
        }
        "/login/oauth/access_token" => {
            let form = request.form();
            assert_eq!(
                form.get("grant_type").map(String::as_str),
                Some("urn:ietf:params:oauth:grant-type:device_code")
            );
            assert_eq!(form.get("device_code").map(String::as_str), Some("dev-123"));
            // No secret is ever sent: the flow needs none.
            assert!(!form.contains_key("client_secret"));
            // GitHub answers 200 with an error while it waits.
            if polls.fetch_add(1, Ordering::SeqCst) == 0 {
                json_resp(json!({"error": "authorization_pending"}))
            } else {
                json_resp(
                    json!({"access_token": "gho_device", "token_type": "bearer", "scope": "repo,read:org"}),
                )
            }
        }
        _ => mcp_handler(base, request, Some("gho_device")),
    }
}

#[tokio::test]
async fn github_signs_in_with_a_typed_code_and_uses_the_token_on_its_mcp_server() {
    let polls = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = polls.clone();
    let (base, log) = serve(move |base, request| device_handler(base, request, &counter)).await;
    let device_code = format!("{base}/login/device/code");
    let token = format!("{base}/login/oauth/access_token");
    let endpoints = github::Endpoints {
        device_code: &device_code,
        token: &token,
    };

    let code = github::request_code(&endpoints, "Iv1.test").await.unwrap();
    assert_eq!(code.start.user_code, "WDJB-MJHT");
    assert_eq!(
        code.start.verification_uri,
        "https://github.com/login/device"
    );
    // The device code stays in Rust: what the webview gets has no field for it.
    let shown = serde_json::to_value(&code.start).unwrap();
    assert!(!shown.to_string().contains("dev-123"));

    let tokens = github::wait_for_token(&endpoints, "Iv1.test", &code)
        .await
        .unwrap();
    assert_eq!(tokens.access_token.expose_str(), "gho_device");
    assert_eq!(
        polls.load(Ordering::SeqCst),
        2,
        "one pending answer, then the token"
    );

    let pool = pool().await;
    let row = Connector {
        id: "github-mock".into(),
        name: "GitHub".into(),
        url: format!("{base}/mcp"),
        catalog_id: github::ID.into(),
        auth: github::ID.into(),
        enabled: true,
        tool_policy: Default::default(),
    };
    insert(&pool, &row).await.unwrap();
    assert!(!has_credential(&row));
    oauth::save_tokens(&row.id, &tokens).unwrap();
    assert!(has_credential(&row));
    let tools = runtime::refresh_tools(&pool, &row).await.unwrap();
    assert_eq!(tools.len(), 3);
    let result = runtime::call_tool(&pool, &row, "search", &json!({"query": "rust"}))
        .await
        .unwrap();
    assert!(mcp::result_text(&result, 100).starts_with("search found rust"));
    let bearer_sent = log
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.path.starts_with("/mcp"))
        .all(|request| request.header("authorization") == Some("Bearer gho_device"));
    assert!(bearer_sent, "every MCP request carries the device token");
}

#[test]
fn the_device_answers_are_read_as_the_rfc_says() {
    let endpoints = github::GITHUB;
    let now = 1_000;
    for (error, expected) in [
        ("authorization_pending", "Pending"),
        ("slow_down", "SlowDown"),
        ("expired_token", "Expired"),
        ("access_denied", "Denied"),
        ("unsupported_grant_type", "Failed"),
    ] {
        let poll = github::parse_poll(&json!({"error": error}), &endpoints, "id", now);
        assert_eq!(format!("{poll:?}"), expected);
    }
    let done = github::parse_poll(
        &json!({"access_token": "gho_x", "token_type": "bearer"}),
        &endpoints,
        "id",
        now,
    );
    let github::Poll::Done(tokens) = done else {
        panic!("a token is the end of the wait");
    };
    // GitHub's OAuth app tokens do not expire and have no refresh token.
    assert_eq!(tokens.expires_at, None);
    assert!(tokens.refresh_token.is_none());

    // A code that would send the person somewhere other than https is refused.
    assert!(github::parse_device_code(&json!({
        "device_code": "d", "user_code": "U", "verification_uri": "http://evil.example"
    }))
    .is_err());
    let code = github::parse_device_code(&json!({
        "device_code": "d", "user_code": "U", "verification_uri": "https://github.com/login/device",
        "expires_in": 999_999, "interval": 0
    }))
    .unwrap();
    assert_eq!(code.start.expires_in, 15 * 60, "the wait is bounded");
    assert_eq!(code.interval, 1, "never a busy loop");
}

#[test]
fn github_is_listed_and_offered_only_with_its_client_id() {
    // CI builds may carry SUBROSA_GITHUB_CLIENT_ID (desktop.yml), local ones
    // do not: the listing tells the truth either way, and an absent id is
    // shown as not available rather than hidden.
    let listed = builtins();
    let entry = listed
        .iter()
        .find(|builtin| builtin.id == github::ID)
        .expect("GitHub is always listed");
    assert_eq!(entry.available, github::available());
    let request = ConnectorAddRequest {
        catalog_id: Some(github::ID.into()),
        name: None,
        url: None,
        auth: None,
    };
    if github::available() {
        assert_eq!(connector_for(&request).unwrap().auth, github::ID);
    } else {
        assert_eq!(
            connector_for(&request).unwrap_err().code,
            "connector_unavailable"
        );
    }
    // Its hosts are on the Privacy screen.
    for host in ["api.githubcopilot.com", "github.com"] {
        assert!(crate::egress::DECLARED_EGRESS
            .iter()
            .any(|declared| declared.host == host));
    }
    assert_eq!(
        mcp::validate_endpoint(github::MCP_URL).unwrap().host_str(),
        Some("api.githubcopilot.com")
    );
}

#[test]
fn only_the_latest_device_sign_in_may_finish() {
    let first = github::claim_wait("github-gen");
    let second = github::claim_wait("github-gen");
    assert!(!github::is_current("github-gen", first));
    assert!(github::is_current("github-gen", second));
}
