//! Connectors against a real socket: a small MCP server with an OAuth
//! authorization server beside it, answering JSON and event streams, handing
//! out a session id, and refusing a missing or stale token the way the
//! protocol says, so the client, the sign-in and the refresh are tested end
//! to end rather than asserted in comments.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sqlx_sqlite::SqlitePool;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

use super::mcp::{self, McpError, Session};
use super::*;

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Req {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
    fn form(&self) -> HashMap<String, String> {
        url_pairs(&self.body)
    }
}

fn url_pairs(raw: &str) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://x/?{raw}"))
        .unwrap()
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn json_resp(value: Value) -> Resp {
    Resp {
        status: 200,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: value.to_string(),
    }
}

fn status_resp(status: u16) -> Resp {
    Resp {
        status,
        headers: Vec::new(),
        body: String::new(),
    }
}

type Log = Arc<Mutex<Vec<Req>>>;

/// A server that answers every request with `handler(base, request)` and
/// keeps what it was sent.
async fn serve<F>(handler: F) -> (String, Log)
where
    F: Fn(&str, &Req) -> Resp + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log: Log = Arc::default();
    let handler = Arc::new(handler);
    let (task_base, task_log) = (base.clone(), log.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let (handler, base, log) = (handler.clone(), task_base.clone(), task_log.clone());
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 4096];
                let head_end = loop {
                    let Ok(read) = socket.read(&mut chunk).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                        break at;
                    }
                };
                let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                let mut lines = head.lines();
                let first: Vec<&str> = lines.next().unwrap_or_default().split(' ').collect();
                let headers: HashMap<String, String> = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
                    .collect();
                let length: usize = headers
                    .get("content-length")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let mut body = buffer[head_end + 4..].to_vec();
                while body.len() < length {
                    let Ok(read) = socket.read(&mut chunk).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..read]);
                }
                let request = Req {
                    method: first.first().unwrap_or(&"").to_string(),
                    path: first.get(1).unwrap_or(&"").to_string(),
                    headers,
                    body: String::from_utf8_lossy(&body).to_string(),
                };
                let response = handler(&base, &request);
                log.lock().unwrap().push(request);
                let mut out = format!(
                    "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    response.status,
                    response.body.len()
                );
                for (key, value) in &response.headers {
                    out.push_str(&format!("{key}: {value}\r\n"));
                }
                out.push_str("\r\n");
                out.push_str(&response.body);
                let _ = socket.write_all(out.as_bytes()).await;
                let _ = socket.flush().await;
            });
        }
    });
    (base, log)
}

fn tool_json(name: &str, read_only: bool) -> Value {
    json!({
        "name": name,
        "description": format!("The {name} tool."),
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
        "annotations": {"readOnlyHint": read_only},
    })
}

/// The MCP side: initialize with a session id, a paginated tool list, a
/// tool call answered as an event stream with a notification first, a
/// resource, and a token check when `token` is set.
fn mcp_handler(base: &str, request: &Req, token: Option<&str>) -> Resp {
    if request.method == "DELETE" {
        return status_resp(200);
    }
    if !request.path.starts_with("/mcp") {
        return auth_handler(base, request);
    }
    if let Some(token) = token {
        let expected = format!("Bearer {token}");
        if request.header("authorization") != Some(expected.as_str()) {
            return Resp {
                status: 401,
                headers: vec![(
                    "WWW-Authenticate".into(),
                    format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"read write\""),
                )],
                body: String::new(),
            };
        }
    }
    let message = request.json();
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method != "initialize" && request.header("mcp-session-id") != Some("sess-1") {
        return status_resp(400);
    }
    match method {
        "initialize" => {
            let mut response = json_resp(json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": "2025-06-18",
                "serverInfo": {"name": "mock", "version": "1"},
                "capabilities": {"tools": {}, "resources": {"subscribe": true}},
            }}));
            response
                .headers
                .push(("Mcp-Session-Id".into(), "sess-1".into()));
            response
        }
        "notifications/initialized" => status_resp(202),
        "tools/list" => {
            let page = if message.pointer("/params/cursor").is_some() {
                json!({"tools": [tool_json("create_issue", false)]})
            } else {
                let mut view = tool_json("show_board", true);
                view["_meta"] = json!({"ui": {"resourceUri": "ui://board"}});
                json!({"tools": [tool_json("search", true), view], "nextCursor": "p2"})
            };
            json_resp(json!({"jsonrpc": "2.0", "id": id, "result": page}))
        }
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let query = message
                .pointer("/params/arguments/query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let result = json!({"jsonrpc": "2.0", "id": id, "result": {
                "content": [
                    {"type": "text", "text": format!("{name} found {query}")},
                    {"type": "resource_link", "name": "Issue 7", "uri": "https://tracker.example.com/7"}
                ],
                "structuredContent": {"issues": [{"id": 7, "title": "First"}, {"id": 8, "title": "Second"}]},
            }});
            let progress = json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}});
            Resp {
                status: 200,
                headers: vec![("Content-Type".into(), "text/event-stream".into())],
                body: format!(
                    "event: message\ndata: {progress}\n\nevent: message\ndata: {result}\n\n"
                ),
            }
        }
        "resources/read" => json_resp(json!({"jsonrpc": "2.0", "id": id, "result": {
            "contents": [{"uri": "ui://board", "mimeType": "text/html;profile=mcp-app", "text": "<html><head></head><body>board</body></html>"}]
        }})),
        _ => json_resp(
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no such method"}}),
        ),
    }
}

/// The OAuth side: resource metadata, server metadata with S256,
/// registration, and a token endpoint that checks PKCE.
fn auth_handler(base: &str, request: &Req) -> Resp {
    match request.path.as_str() {
        "/.well-known/oauth-protected-resource/mcp" => json_resp(json!({
            "resource": format!("{base}/mcp"),
            "authorization_servers": [base],
            "scopes_supported": ["read"],
        })),
        "/.well-known/oauth-authorization-server" => json_resp(json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
            "code_challenge_methods_supported": ["S256"],
        })),
        "/register" => {
            let body = request.json();
            assert_eq!(body["redirect_uris"][0], oauth::REDIRECT_URI);
            assert_eq!(body["token_endpoint_auth_method"], "none");
            json_resp(json!({"client_id": "client-123"}))
        }
        "/token" => {
            let form = request.form();
            match form.get("grant_type").map(String::as_str) {
                Some("authorization_code") => {
                    if form.get("code").map(String::as_str) != Some("the-code")
                        || !form.contains_key("code_verifier")
                    {
                        return Resp {
                            status: 400,
                            headers: vec![("Content-Type".into(), "application/json".into())],
                            body: json!({"error": "invalid_grant"}).to_string(),
                        };
                    }
                    json_resp(
                        json!({"access_token": "good", "refresh_token": "r1", "expires_in": 3600, "token_type": "Bearer"}),
                    )
                }
                Some("refresh_token")
                    if form.get("refresh_token").map(String::as_str) == Some("r1") =>
                {
                    json_resp(
                        json!({"access_token": "good2", "expires_in": 3600, "token_type": "bearer"}),
                    )
                }
                _ => Resp {
                    status: 400,
                    headers: vec![("Content-Type".into(), "application/json".into())],
                    body: json!({"error": "invalid_grant"}).to_string(),
                },
            }
        }
        _ => status_resp(404),
    }
}

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn connector(id: &str, url: &str, auth: &str) -> Connector {
    Connector {
        id: id.into(),
        name: "Tracker".into(),
        url: url.into(),
        catalog_id: String::new(),
        auth: auth.into(),
        enabled: true,
        tool_policy: Default::default(),
    }
}

// --- The transport ---------------------------------------------------------------

#[tokio::test]
async fn a_session_initializes_lists_across_pages_and_reads_an_event_stream() {
    let (base, log) = serve(|base, request| mcp_handler(base, request, None)).await;
    let endpoint = mcp::validate_endpoint(&format!("{base}/mcp")).unwrap();
    let mut session = Session::open(&endpoint, None).await.unwrap();
    assert_eq!(session.session_id(), Some("sess-1"));
    assert_eq!(session.server.name, "mock");
    assert!(session.supports_subscribe());

    let tools = session.list_tools().await.unwrap();
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names, ["search", "show_board", "create_issue"]);

    let result = session
        .call_tool("search", &json!({"query": "bugs"}))
        .await
        .unwrap();
    assert_eq!(
        mcp::result_text(&result, 1000).lines().next(),
        Some("search found bugs")
    );
    // The notification that rode ahead of the response was kept, not taken
    // for the answer.
    assert_eq!(session.notifications.len(), 1);
    session.close().await;

    let log = log.lock().unwrap();
    let posts: Vec<&Req> = log
        .iter()
        .filter(|request| request.method == "POST")
        .collect();
    assert!(posts.len() >= 5);
    for request in &posts[1..] {
        assert_eq!(request.header("mcp-session-id"), Some("sess-1"));
        assert_eq!(request.header("mcp-protocol-version"), Some("2025-06-18"));
    }
    assert!(posts.iter().all(
        |request| request
            .header("accept")
            .is_some_and(|accept| accept.contains("text/event-stream")
                && accept.contains("application/json"))
    ));
    assert!(log.iter().any(|request| request.method == "DELETE"));
}

#[tokio::test]
async fn a_missing_token_is_the_start_of_a_sign_in_not_an_error() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, Some("good"))).await;
    let endpoint = mcp::validate_endpoint(&format!("{base}/mcp")).unwrap();
    let error = Session::open(&endpoint, None).await.err().unwrap();
    assert_eq!(
        error,
        McpError::Unauthorized {
            resource_metadata: Some(format!("{base}/.well-known/oauth-protected-resource/mcp")),
            scope: Some("read write".into()),
        }
    );
}

#[test]
fn www_authenticate_is_read_with_quoted_commas() {
    let (metadata, scope) = mcp::parse_www_authenticate(
        "Bearer error=\"invalid_token\", scope=\"a, b\", resource_metadata=\"https://x.example.com/.well-known/oauth-protected-resource\"",
    );
    assert_eq!(
        metadata.as_deref(),
        Some("https://x.example.com/.well-known/oauth-protected-resource")
    );
    assert_eq!(scope.as_deref(), Some("a, b"));
    assert_eq!(mcp::parse_www_authenticate("Basic realm=x"), (None, None));
}

#[test]
fn events_are_assembled_across_chunk_boundaries() {
    let mut events = mcp::SseEvents::default();
    assert!(events.push(b"event: message\ndata: {\"a\":").is_empty());
    assert!(events.push(b"1}\n").is_empty());
    assert_eq!(
        events.push(b"\ndata: x\r\ndata: y\r\n\r\n"),
        ["{\"a\":1}", "x\ny"]
    );
    assert_eq!(events.push(b"data: tail"), Vec::<String>::new());
    assert_eq!(events.finish(), ["tail"]);
}

#[test]
fn a_response_is_matched_by_id_and_errors_are_kept_apart() {
    let ok = json!({"jsonrpc": "2.0", "id": 3, "result": {"x": 1}});
    assert_eq!(mcp::rpc_outcome(&ok, 3), Some(Ok(json!({"x": 1}))));
    assert_eq!(mcp::rpc_outcome(&ok, 4), None);
    let batch = json!([{"jsonrpc": "2.0", "method": "notifications/x"}, {"jsonrpc": "2.0", "id": 4, "error": {"code": -1, "message": "no"}}]);
    assert!(matches!(
        mcp::rpc_outcome(&batch, 4),
        Some(Err(McpError::Rpc { code: -1, .. }))
    ));
    // A server's request carrying the same id is not our response.
    assert_eq!(
        mcp::rpc_outcome(&json!({"id": 3, "method": "ping"}), 3),
        None
    );
}

#[test]
fn only_https_or_this_machine_is_an_endpoint() {
    assert!(mcp::validate_endpoint("https://mcp.example.com/mcp").is_ok());
    assert!(mcp::validate_endpoint("http://127.0.0.1:8080/mcp").is_ok());
    assert!(mcp::validate_endpoint("http://localhost:3000/mcp").is_ok());
    for bad in [
        "http://mcp.example.com/mcp",
        "https://user:pass@mcp.example.com/mcp",
        "https://mcp.example.com/mcp#frag",
        "ftp://mcp.example.com",
        "not a url",
    ] {
        assert!(mcp::validate_endpoint(bad).is_err(), "{bad}");
    }
}

#[test]
fn tool_hints_choose_a_default_and_views_are_found() {
    let read = mcp::tool_info(&tool_json("search", true)).unwrap();
    assert!(read.read_only && !read.destructive);
    let unknown = mcp::tool_info(&json!({"name": "do_it"})).unwrap();
    assert!(
        !unknown.read_only && unknown.destructive,
        "no hint means it may change things"
    );
    assert_eq!(unknown.input_schema["type"], "object");
    let view = mcp::tool_info(
        &json!({"name": "v", "_meta": {"openai/outputTemplate": "ui://widget/x.html"}}),
    )
    .unwrap();
    assert_eq!(view.ui_resource.as_deref(), Some("ui://widget/x.html"));
    let not_ui = mcp::tool_info(
        &json!({"name": "v", "_meta": {"ui": {"resourceUri": "https://evil.example.com"}}}),
    )
    .unwrap();
    assert_eq!(not_ui.ui_resource, None);
    assert!(mcp::tool_info(&json!({"name": ""})).is_none());
}

#[test]
fn a_result_reads_as_bounded_text() {
    let result = json!({"isError": true, "content": [
        {"type": "text", "text": "abcdefghij"},
        {"type": "image", "data": "...", "mimeType": "image/png"},
        {"type": "resource", "resource": {"uri": "ui://x", "text": "<html>"}}
    ]});
    let text = mcp::result_text(&result, 1000);
    assert!(text.starts_with("The tool reported an error: abcdefghij"));
    assert!(text.contains("[image omitted]") && !text.contains("<html>"));
    assert!(mcp::result_text(&result, 10).ends_with("[truncated]"));
    assert_eq!(
        mcp::result_text(&json!({}), 100),
        "The tool returned nothing."
    );
    assert_eq!(
        mcp::embedded_ui(&result),
        Some(("ui://x".to_string(), "<html>".to_string()))
    );
}

// --- Sign-in ----------------------------------------------------------------------

#[test]
fn pkce_matches_the_rfc_example_and_is_fresh_each_time() {
    // RFC 7636, appendix B.
    assert_eq!(
        oauth::challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let (one, two) = (oauth::pkce(), oauth::pkce());
    assert_ne!(one.verifier.expose_str(), two.verifier.expose_str());
    assert_eq!(one.verifier.expose_str().len(), 43);
    assert_eq!(
        oauth::challenge_for(one.verifier.expose_str()),
        one.challenge
    );
    assert!(!format!("{:?}", one.verifier).contains(one.verifier.expose_str()));
}

#[test]
fn metadata_is_looked_for_with_the_path_inserted() {
    let endpoint = reqwest::Url::parse("https://mcp.example.com/v1/mcp/").unwrap();
    assert_eq!(
        oauth::protected_resource_candidates(&endpoint),
        [
            "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
            "https://mcp.example.com/.well-known/oauth-protected-resource",
        ]
    );
    let issuer = reqwest::Url::parse("https://auth.example.com/tenant").unwrap();
    assert_eq!(
        oauth::authorization_server_candidates(&issuer),
        [
            "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
            "https://auth.example.com/.well-known/openid-configuration/tenant",
            "https://auth.example.com/tenant/.well-known/openid-configuration",
        ]
    );
    assert_eq!(
        oauth::canonical_resource(&endpoint),
        "https://mcp.example.com/v1/mcp"
    );
}

#[test]
fn a_server_without_s256_or_with_insecure_endpoints_is_refused() {
    let plain = json!({"authorization_endpoint": "https://a.example.com/auth", "token_endpoint": "https://a.example.com/token", "code_challenge_methods_supported": ["plain"]});
    assert_eq!(
        oauth::parse_auth_server(&plain, "x").unwrap_err().code,
        "connector_oauth_pkce"
    );
    let absent = json!({"authorization_endpoint": "https://a.example.com/auth", "token_endpoint": "https://a.example.com/token"});
    assert_eq!(
        oauth::parse_auth_server(&absent, "x").unwrap_err().code,
        "connector_oauth_pkce"
    );
    let insecure = json!({"authorization_endpoint": "http://a.example.com/auth", "token_endpoint": "https://a.example.com/token", "code_challenge_methods_supported": ["S256"]});
    assert_eq!(
        oauth::parse_auth_server(&insecure, "x").unwrap_err().code,
        "connector_oauth_discovery"
    );
}

#[tokio::test]
async fn a_401_leads_through_discovery_registration_pkce_and_the_exchange() {
    let (base, log) = serve(|base, request| mcp_handler(base, request, Some("good"))).await;
    let pool = pool().await;
    let row = connector("oauth-e2e", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();

    // The sign-in starts: probe, discover, register, store the flow.
    let runtime::SignIn::Browser(url) = runtime::begin_sign_in(&pool, &row).await.unwrap() else {
        panic!("a server that answers 401 needs the browser");
    };
    let parsed = reqwest::Url::parse(&url).unwrap();
    assert!(url.starts_with(&format!("{base}/authorize?")));
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], "client-123");
    assert_eq!(params["redirect_uri"], oauth::REDIRECT_URI);
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["resource"], format!("{base}/mcp"));
    assert_eq!(params["scope"], "read write");
    // The registered client is kept, so the next sign-in does not register again.
    assert_eq!(
        state(&pool, &row.id).await.oauth_client.unwrap()["clientId"],
        "client-123"
    );

    // The browser comes back: only the flow its state names is finished.
    let callback = format!(
        "{}?code=the-code&state={}",
        oauth::REDIRECT_URI,
        params["state"]
    );
    let (state_param, outcome) = oauth::parse_callback(&callback).unwrap();
    let oauth::CallbackOutcome::Code(code) = outcome else {
        panic!("a code came back");
    };
    let flow = oauth::take_pending(&state_param, chrono::Utc::now().timestamp()).unwrap();
    assert!(oauth::redirect_matches(&callback, &flow.redirect_uri));
    assert!(
        oauth::take_pending(&state_param, chrono::Utc::now().timestamp()).is_err(),
        "single use"
    );
    let tokens = oauth::exchange(&flow, code.expose_str()).await.unwrap();
    assert_eq!(tokens.access_token.expose_str(), "good");

    // The verifier sent to the token endpoint is the one the challenge was made from.
    let verifier = log
        .lock()
        .unwrap()
        .iter()
        .find(|request| request.path == "/token")
        .map(|request| request.form()["code_verifier"].clone())
        .unwrap();
    assert_eq!(oauth::challenge_for(&verifier), params["code_challenge"]);

    // Stored, the connector now lists its tools with that token.
    oauth::save_tokens(&row.id, &tokens).unwrap();
    let tools = runtime::refresh_tools(&pool, &row).await.unwrap();
    assert_eq!(tools.len(), 3);
    assert_eq!(state(&pool, &row.id).await.status, "connected");
    assert!(has_credential(&row));
}

#[test]
fn a_server_must_name_the_issuer_it_was_fetched_for() {
    let metadata = |issuer: Option<&str>| {
        let mut value = json!({
            "authorization_endpoint": "https://a.example.com/auth",
            "token_endpoint": "https://a.example.com/token",
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": true,
        });
        if let Some(issuer) = issuer {
            value["issuer"] = json!(issuer);
        }
        value
    };
    let server = oauth::parse_auth_server(
        &metadata(Some("https://a.example.com")),
        "https://a.example.com/",
    )
    .unwrap();
    assert_eq!(server.issuer, "https://a.example.com");
    assert!(server.iss_parameter_supported);
    for (named, expected) in [
        (Some("https://evil.example.com"), "https://a.example.com"),
        (Some("https://a.example.com/other"), "https://a.example.com"),
        (Some("https://a.example.com//"), "https://a.example.com"),
        (None, "https://a.example.com"),
    ] {
        assert_eq!(
            oauth::parse_auth_server(&metadata(named), expected)
                .unwrap_err()
                .code,
            "connector_oauth_issuer",
            "{named:?}"
        );
    }
}

/// A server whose metadata names another issuer is refused before anything
/// is registered; one that says its callback carries `iss` must send its own.
#[tokio::test]
async fn the_sign_in_server_is_the_one_its_metadata_and_callback_name() {
    let (base, log) = serve(|base, request| {
        if request.path == "/.well-known/oauth-authorization-server" {
            return json_resp(json!({
                "issuer": "https://login.elsewhere.example",
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
                "registration_endpoint": format!("{base}/register"),
                "code_challenge_methods_supported": ["S256"],
            }));
        }
        mcp_handler(base, request, Some("good"))
    })
    .await;
    let pool = pool().await;
    let row = connector("oauth-mixup", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    let Err(refused) = runtime::begin_sign_in(&pool, &row).await else {
        panic!("a server naming another issuer is not signed in to");
    };
    assert_eq!(refused.code, "connector_oauth_issuer");
    assert!(!log
        .lock()
        .unwrap()
        .iter()
        .any(|request| request.path == "/register"));

    let (base, _) = serve(|base, request| {
        if request.path == "/.well-known/oauth-authorization-server" {
            return json_resp(json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
                "registration_endpoint": format!("{base}/register"),
                "code_challenge_methods_supported": ["S256"],
                "authorization_response_iss_parameter_supported": true,
            }));
        }
        mcp_handler(base, request, Some("good"))
    })
    .await;
    let row = connector("oauth-iss", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    let runtime::SignIn::Browser(url) = runtime::begin_sign_in(&pool, &row).await.unwrap() else {
        panic!("a server that answers 401 needs the browser");
    };
    let state_param = reqwest::Url::parse(&url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap();
    let flow = oauth::take_pending(&state_param, chrono::Utc::now().timestamp()).unwrap();
    assert_eq!(flow.issuer.as_deref(), Some(base.as_str()));
    let callback = |extra: &str| {
        format!(
            "{}?code=the-code&state={state_param}{extra}",
            oauth::REDIRECT_URI
        )
    };
    let accepted =
        |url: String| oauth::issuer_accepted(&flow, oauth::callback_issuer(&url).as_deref());
    assert!(!accepted(callback("")), "the server said it names itself");
    assert!(!accepted(callback(
        "&iss=https%3A%2F%2Flogin.elsewhere.example"
    )));
    assert!(accepted(callback(&format!(
        "&iss={}",
        urlencoding::encode(&base)
    ))));

    // A server that never said so is not asked for it, but a wrong one is
    // still refused; a built-in sign-in has no metadata to agree with.
    let mut quiet = flow;
    quiet.issuer_in_response = false;
    assert!(oauth::issuer_accepted(&quiet, None));
    assert!(!oauth::issuer_accepted(
        &quiet,
        Some("https://login.elsewhere.example")
    ));
    let verifier = crate::redacted::Redacted::new("v".to_string());
    let builtin = oauth::PendingFlow::new(
        "google",
        &verifier,
        "https://t",
        "id",
        oauth::REDIRECT_URI,
        None,
    );
    assert!(oauth::issuer_accepted(&builtin, None));
}

#[tokio::test]
async fn a_stale_token_is_refreshed_once_and_the_call_goes_through() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, Some("good2"))).await;
    let pool = pool().await;
    let row = connector("oauth-refresh", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    oauth::save_tokens(
        &row.id,
        &oauth::Tokens {
            access_token: crate::redacted::Redacted::new("stale".into()),
            refresh_token: Some(crate::redacted::Redacted::new("r1".into())),
            expires_at: None,
            token_endpoint: format!("{base}/token"),
            client_id: "client-123".into(),
            resource: Some(format!("{base}/mcp")),
            scope: None,
        },
    )
    .unwrap();
    let result = runtime::call_tool(&pool, &row, "search", &json!({"query": "x"}))
        .await
        .unwrap();
    assert!(mcp::result_text(&result, 100).starts_with("search found x"));
    let kept = oauth::load_tokens(&row.id).unwrap().unwrap();
    assert_eq!(kept.access_token.expose_str(), "good2");
    // The server returned no new refresh token: the old one stays.
    assert_eq!(kept.refresh_token.unwrap().expose_str(), "r1");
}

#[tokio::test]
async fn a_refused_refresh_asks_for_a_sign_in_instead_of_looping() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, Some("never"))).await;
    let pool = pool().await;
    let row = connector("oauth-refused", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    oauth::save_tokens(
        &row.id,
        &oauth::Tokens {
            access_token: crate::redacted::Redacted::new("stale".into()),
            refresh_token: Some(crate::redacted::Redacted::new("revoked".into())),
            expires_at: None,
            token_endpoint: format!("{base}/token"),
            client_id: "client-123".into(),
            resource: None,
            scope: None,
        },
    )
    .unwrap();
    let error = runtime::call_tool(&pool, &row, "search", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "connector_sign_in");
    assert_eq!(state(&pool, &row.id).await.status, "needs_sign_in");
}

#[test]
fn token_responses_are_bounded_to_bearer_and_expiry_is_early() {
    let context = oauth::TokenContext {
        token_endpoint: "https://a.example.com/token",
        client_id: "c",
        resource: None,
    };
    let tokens = oauth::parse_token_response(
        &json!({"access_token": "a", "expires_in": 100, "token_type": "Bearer"}),
        &context,
        None,
        1_000,
    )
    .unwrap();
    assert_eq!(tokens.expires_at, Some(1_100));
    assert!(!tokens.expiring(1_000));
    assert!(tokens.expiring(1_050), "a minute early");
    assert!(oauth::parse_token_response(
        &json!({"access_token": "a", "token_type": "mac"}),
        &context,
        None,
        0
    )
    .is_err());
    assert!(oauth::parse_token_response(&json!({}), &context, None, 0).is_err());
}

#[test]
fn a_callback_needs_a_state_and_a_code_or_an_error() {
    assert!(oauth::parse_callback("subrosa://connector/callback?code=x").is_none());
    assert!(matches!(
        oauth::parse_callback("subrosa://connector/callback?state=s&error=access_denied"),
        Some((_, oauth::CallbackOutcome::Denied(_)))
    ));
    assert!(!oauth::redirect_matches(
        "subrosa://auth/callback?state=s",
        oauth::REDIRECT_URI
    ));
    assert!(oauth::is_callback(
        "subrosa://connector/callback?state=s&code=c"
    ));
    assert!(!oauth::is_callback(
        "subrosa://auth/callback?request=x&code=c"
    ));
}

#[test]
fn a_sign_in_left_too_long_is_refused() {
    let verifier = crate::redacted::Redacted::new("v".to_string());
    let mut flow = oauth::PendingFlow::new(
        "c",
        &verifier,
        "https://a.example.com/t",
        "id",
        oauth::REDIRECT_URI,
        None,
    );
    flow.created_at -= 16 * 60;
    oauth::store_pending("old-state", &flow).unwrap();
    assert_eq!(
        oauth::take_pending("old-state", chrono::Utc::now().timestamp())
            .unwrap_err()
            .code,
        "connector_oauth_expired"
    );
}

// --- Definitions, calls, the agent ------------------------------------------------

#[test]
fn an_add_request_becomes_a_definition() {
    let from_catalog = connector_for(&ConnectorAddRequest {
        catalog_id: Some("linear".into()),
        name: None,
        url: None,
        auth: None,
    })
    .unwrap();
    assert_eq!(from_catalog.url, "https://mcp.linear.app/mcp");
    assert_eq!(from_catalog.auth, "oauth");
    let custom = connector_for(&ConnectorAddRequest {
        catalog_id: None,
        name: Some("My Server!".into()),
        url: Some("https://mcp.example.com/mcp".into()),
        auth: Some("token".into()),
    })
    .unwrap();
    assert!(custom.id.starts_with("my_server-"));
    assert_eq!(custom.auth, "token");
    assert!(connector_for(&ConnectorAddRequest {
        catalog_id: None,
        name: None,
        url: Some("http://mcp.example.com".into()),
        auth: None,
    })
    .is_err());
    // A build without the app's Google client id does not offer Google.
    if !builtin::provider("google").unwrap().available() {
        assert_eq!(
            connector_for(&ConnectorAddRequest {
                catalog_id: Some("google".into()),
                name: None,
                url: None,
                auth: None,
            })
            .unwrap_err()
            .code,
            "connector_unavailable"
        );
    }
}

#[test]
fn tool_names_are_namespaced_and_safe() {
    let row = connector("Linear Tracker", "https://x.example.com", "oauth");
    assert_eq!(slug("Linear Tracker--x"), "linear_tracker_x");
    assert_eq!(
        agent::function_name(&row, "create.issue"),
        "linear_tracker__create_issue"
    );
    assert!(agent::function_name(&row, &"x".repeat(200)).len() <= 64);
    assert!(agent::is_connector_tool("linear__search"));
    assert!(!agent::is_connector_tool("web_search"));
    let google = connector("google", "", "google");
    assert_eq!(
        agent::function_name(&google, "calendar_list"),
        "google__calendar_list"
    );
}

#[tokio::test]
async fn a_pending_call_runs_once_and_a_decline_runs_nothing() {
    let pool = pool().await;
    let id = calls::insert(
        &pool,
        "task",
        "c",
        "create_issue",
        &json!({"title": "x"}),
        "pending",
    )
    .await
    .unwrap();
    assert!(calls::claim(&pool, &id).await.unwrap());
    assert!(
        !calls::claim(&pool, &id).await.unwrap(),
        "a second tap runs nothing"
    );
    calls::finish(
        &pool,
        &id,
        &Ok(json!({"content": [{"type": "text", "text": "done"}]})),
    )
    .await
    .unwrap();
    let row = calls::get(&pool, &id).await.unwrap();
    assert_eq!(row.status, "done");
    assert_eq!(row.result.unwrap()["text"], "done");

    let declined = calls::insert(&pool, "task", "c", "delete", &json!({}), "pending")
        .await
        .unwrap();
    assert!(calls::deny(&pool, &declined).await.unwrap());
    assert!(!calls::claim(&pool, &declined).await.unwrap());
    assert_eq!(calls::get(&pool, &declined).await.unwrap().status, "denied");
}

#[test]
fn cards_go_under_the_reply_once() {
    calls::push_card("t-cards", calls::call_fence("a"));
    calls::push_card("t-cards", calls::call_fence("a"));
    calls::push_card("t-cards", calls::app_fence("call-a"));
    let answer = calls::with_cards("t-cards", "Here it is.");
    assert_eq!(answer.matches("subrosa:connector").count(), 1);
    assert!(answer.contains("subrosa:app"));
    // Drained: the next reply carries none of them.
    assert_eq!(calls::with_cards("t-cards", "Next."), "Next.");
    // A card the model already copied is not repeated.
    calls::push_card("t-copied", calls::call_fence("b"));
    let copied = format!("Done.\n\n{}", calls::call_fence("b"));
    assert_eq!(calls::with_cards("t-copied", &copied), copied);
}

#[tokio::test]
async fn the_agent_is_offered_namespaced_tools_and_asks_before_a_write() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    let mut row = connector("tracker", &format!("{base}/mcp"), "none");
    row.tool_policy.insert("show_board".into(), "deny".into());
    insert(&pool, &row).await.unwrap();

    let mut tools = Vec::new();
    let note = agent::offer(&pool, "task-a", &mut tools, &agent::Grant::General).await;
    assert_eq!(note, Some(agent::PROMPT_NOTE));
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
        .collect();
    assert_eq!(
        names,
        ["tracker__search", "tracker__create_issue"],
        "denied tools are not offered"
    );
    let create = tools[1]
        .pointer("/function/description")
        .and_then(Value::as_str)
        .unwrap();
    assert!(create.starts_with("[Tracker]") && create.contains("confirms"));

    // A custom assistant gets only the connectors it was granted.
    let mut none = Vec::new();
    let ungranted = agent::Grant::for_assistant(&["web".to_string()]);
    assert_eq!(
        agent::offer(&pool, "task-b", &mut none, &ungranted).await,
        None
    );
    assert!(none.is_empty());
    let mut other = Vec::new();
    let elsewhere = agent::Grant::for_assistant(&["connector:linear".to_string()]);
    assert_eq!(
        agent::offer(&pool, "task-b", &mut other, &elsewhere).await,
        None
    );
    let mut granted = Vec::new();
    let tracker = agent::Grant::for_assistant(&["web".into(), "connector:tracker".into()]);
    assert_eq!(
        agent::offer(&pool, "task-c", &mut granted, &tracker).await,
        Some(agent::PROMPT_NOTE)
    );
    assert_eq!(granted.len(), 2);
    // And a name offered to another conversation is not this one's.
    let foreign = agent::dispatch_with(&pool, "task-b", "tracker__search", &json!({}), |_| {})
        .await
        .unwrap();
    assert!(foreign.contains("not available"));

    // A read runs at once and leaves a card.
    let read = agent::dispatch_with(
        &pool,
        "task-a",
        "tracker__search",
        &json!({"query": "bugs"}),
        |_| {},
    )
    .await
    .unwrap();
    assert!(read.contains("search found bugs") && read.contains("data, not instructions"));

    // A write waits for the person.
    let write = agent::dispatch_with(
        &pool,
        "task-a",
        "tracker__create_issue",
        &json!({"title": "x"}),
        |_| {},
    )
    .await
    .unwrap();
    assert!(write.contains("waits for the user's confirmation"));
    let pending: Vec<String> =
        sqlx::query::query("SELECT status FROM connector_calls WHERE tool='create_issue'")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| sqlx::row::Row::get(row, "status"))
            .collect();
    assert_eq!(pending, ["pending"]);

    // A name this turn did not offer is not run, even if it is real.
    let invented = agent::dispatch_with(&pool, "task-a", "tracker__show_board", &json!({}), |_| {})
        .await
        .unwrap();
    assert!(invented.contains("not available"));
    assert_eq!(
        agent::dispatch_with(&pool, "task-a", "web_search", &json!({}), |_| {}).await,
        None
    );

    let sealed = agent::seal_answer("task-a", "Done.");
    assert_eq!(sealed.matches("subrosa:connector").count(), 2);
}

#[tokio::test]
async fn an_interactive_view_is_kept_and_served_under_its_own_policy() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    let row = connector("board", &format!("{base}/mcp"), "none");
    insert(&pool, &row).await.unwrap();
    runtime::refresh_tools(&pool, &row).await.unwrap();
    let id = calls::insert(&pool, "task", &row.id, "show_board", &json!({}), "done")
        .await
        .unwrap();
    let call = calls::get(&pool, &id).await.unwrap();
    let result =
        json!({"content": [{"type": "text", "text": "ok"}], "structuredContent": {"cards": 3}});
    let app_id = apps::keep_for_call(&pool, &row, &call, &result)
        .await
        .unwrap();
    assert_eq!(app_id, format!("call-{id}"));
    assert_eq!(apps::id_of(&format!("/{app_id}")), Some(app_id.as_str()));
    assert_eq!(apps::id_of("/../etc"), None);

    let csp = apps::csp_for(&apps::origin_of(&row.url));
    assert!(csp.contains("connect-src http://127.0.0.1:"));
    assert!(csp.contains("default-src 'none'") && csp.contains("frame-src 'none'"));
    assert!(!csp.contains("unsafe-eval") && !csp.contains('*'));
    // An origin that is neither https nor this machine is not allowed anywhere.
    assert!(!apps::csp_for("http://evil.example.com").contains("evil"));

    let page = apps::document(
        "<html><head></head><body>x</body></html>",
        &json!({"q": "</script><script>alert(1)"}),
        &json!({"cards": 3}),
        "dark",
    );
    assert!(page.contains("window.openai"));
    assert!(
        !page.contains("</script><script>alert"),
        "data cannot close the script element"
    );
}

// --- Triggers ----------------------------------------------------------------------

fn trigger(armed: bool, seen: &[&str]) -> triggers::TriggerRow {
    triggers::TriggerRow {
        id: "t".into(),
        assignment_id: "a".into(),
        connector_id: "c".into(),
        kind: "tool_poll".into(),
        config: json!({"tool": "list_issues"}),
        seen: seen.iter().map(|id| id.to_string()).collect(),
        armed,
        last_checked_at: None,
        last_error: None,
    }
}

#[test]
fn items_are_found_wherever_the_result_lists_them() {
    let structured = json!({"structuredContent": {"issues": [{"number": 7, "title": "A"}, {"id": "x", "name": "B"}]}});
    let items = triggers::items_from_result(&structured);
    assert_eq!(
        items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["7", "x"]
    );
    let links = json!({"content": [{"type": "resource_link", "name": "Doc", "uri": "https://d.example.com/1"}]});
    assert_eq!(
        triggers::items_from_result(&links)[0].id,
        "https://d.example.com/1"
    );
    let text = json!({"content": [{"type": "text", "text": "[{\"id\": 1, \"subject\": \"Hi\"}]"}]});
    assert_eq!(triggers::items_from_result(&text)[0].title, "Hi");
    assert!(triggers::items_from_result(
        &json!({"content": [{"type": "text", "text": "nothing"}]})
    )
    .is_empty());
}

#[test]
fn the_first_look_learns_and_later_looks_fire_a_few_at_a_time() {
    let item = |id: &str| triggers::Item {
        id: id.into(),
        title: id.into(),
    };
    let backlog = [item("1"), item("2")];
    let first = triggers::decide(&trigger(false, &[]), &backlog);
    assert!(first.fire.is_empty(), "the backlog never fires");
    assert!(first.armed);
    assert_eq!(first.seen, ["1", "2"]);

    let now = [
        item("1"),
        item("2"),
        item("3"),
        item("4"),
        item("5"),
        item("6"),
    ];
    let second = triggers::decide(&trigger(true, &["1", "2"]), &now);
    assert_eq!(
        second
            .fire
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["3", "4", "5"]
    );
    // What did not fire yet is not remembered, so the next look fires it.
    assert_eq!(second.seen, ["1", "2", "3", "4", "5"]);
    let third = triggers::decide(&trigger(true, &["1", "2", "3", "4", "5"]), &now);
    assert_eq!(
        third
            .fire
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["6"]
    );
}

#[test]
fn a_trigger_looks_every_few_minutes_and_hears_resource_updates() {
    let now = chrono::Utc::now();
    assert!(triggers::due(None, now));
    assert!(!triggers::due(Some(&now.to_rfc3339()), now));
    let earlier = now - chrono::Duration::minutes(6);
    assert!(triggers::due(Some(&earlier.to_rfc3339()), now));
    let update = json!({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": "file:///a"}});
    assert_eq!(triggers::updated_uri(&update), Some("file:///a"));
    assert_eq!(
        triggers::updated_uri(&json!({"method": "notifications/progress"})),
        None
    );
    let a = triggers::resource_digest(&json!({"contents": [{"text": "a"}]}));
    assert_ne!(
        a,
        triggers::resource_digest(&json!({"contents": [{"text": "b"}]}))
    );
}

#[test]
fn a_trigger_is_checked_before_it_is_kept() {
    assert!(triggers::validate("email_match", &json!({})).is_err());
    assert_eq!(
        triggers::validate("email_match", &json!({"query": " invoice "})).unwrap()["query"],
        "invoice"
    );
    assert_eq!(
        triggers::validate("calendar_event", &json!({"days": 90})).unwrap()["days"],
        30
    );
    assert!(triggers::validate("anything", &json!({})).is_err());
    let calendar = connector("google", "", "google");
    let mut row = trigger(false, &[]);
    row.kind = "calendar_event".into();
    assert_eq!(
        triggers::look_call(&row, &calendar).unwrap().0,
        "calendar_list"
    );
    row.kind = "email_match".into();
    // Gmail waits on its review: no look is possible yet.
    assert_eq!(
        triggers::look_call(&row, &calendar).is_some(),
        builtin::GMAIL_VERIFIED
    );
}

// --- Research ----------------------------------------------------------------------

#[test]
fn research_searches_only_with_a_tool_that_runs_without_asking() {
    let tools: Vec<mcp::ToolInfo> = [
        tool_json("create_issue", false),
        tool_json("search_issues", true),
        json!({"name": "search_docs", "annotations": {"readOnlyHint": true}, "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}),
    ]
    .iter()
    .filter_map(mcp::tool_info)
    .collect();
    let rules = std::collections::BTreeMap::new();
    let (tool, field) = research::search_tool(&tools, &rules).unwrap();
    assert_eq!((tool.name.as_str(), field), ("search_issues", "query"));
    let mut rules = std::collections::BTreeMap::new();
    rules.insert("search_issues".to_string(), "ask".to_string());
    let (tool, field) = research::search_tool(&tools, &rules).unwrap();
    assert_eq!((tool.name.as_str(), field), ("search_docs", "q"));
}

#[test]
fn onedrive_downloads_stay_on_microsoft_storage() {
    assert!(
        builtin::onedrive_download("https://contoso-my.sharepoint.com/personal/x?tempauth=1")
            .is_ok()
    );
    assert!(builtin::onedrive_download("https://public.ch.files.1drv.com/y").is_ok());
    assert!(builtin::onedrive_download("http://contoso.sharepoint.com/x").is_err());
    assert!(builtin::onedrive_download("https://sharepoint.com.evil.example.com/x").is_err());
}

#[test]
fn gmail_is_present_but_gated() {
    let catalog = builtin::catalog();
    let google = catalog.iter().find(|entry| entry.id == "google").unwrap();
    if !builtin::GMAIL_VERIFIED {
        assert_eq!(google.gated[0].state, "requires_verification");
        assert!(!builtin::tools_for("google")
            .iter()
            .any(|tool| tool.name.starts_with("gmail")));
    }
}

// GitHub's device flow and the computer's runtime, each in its own file.
mod github_tests;
#[cfg(desktop)]
mod hermes_tests;
mod sign_in_tests;
// Real servers, run by hand: `cargo test real_server -- --ignored`.
mod real_server_tests;
