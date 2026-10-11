//! The agent browser against a scripted DevTools socket: what the agent may
//! do, what it is refused, and that a refusal happens before the browser is
//! asked to do anything.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use super::browser::{center_of, Consent, ConsentAnswer, ConsentAsker, Tab};
use super::cdp::{Attached, CdpClient};
use super::gate::{after_action, Gate, GateSink};
use super::launch::parse_devtools_active_port;
use super::pipe;
use super::site::{self, Decision};
use super::snapshot::{self, Sensitive};
use super::ws;

type Handler = dyn Fn(&str, &Value) -> Value + Send + Sync;

/// A one-connection DevTools stand-in. Every command's method is recorded,
/// and `handler` answers it.
async fn mock_browser(handler: Arc<Handler>) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        assert!(String::from_utf8_lossy(&head).contains("Upgrade: websocket"));
        stream
            .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
            .await
            .unwrap();
        loop {
            let message = match ws::read_message(&mut stream).await {
                Ok(ws::Incoming::Text(text)) => text,
                _ => return,
            };
            let request: Value = serde_json::from_str(&message).unwrap();
            let method = request["method"].as_str().unwrap_or_default().to_string();
            log.lock().unwrap().push(method.clone());
            let result = handler(&method, &request["params"]);
            let reply = json!({ "id": request["id"], "result": result }).to_string();
            stream
                .write_all(&server_frame(reply.as_bytes()))
                .await
                .unwrap();
        }
    });
    (port, seen)
}

/// A server frame: unmasked, as RFC 6455 has servers send.
fn server_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x81];
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

/// The page every test browses: a search box, a password field, a button,
/// and a CAPTCHA checkbox.
fn page_handler(password_type: &'static str) -> Arc<Handler> {
    Arc::new(move |method: &str, params: &Value| match method {
        "Runtime.evaluate" => {
            let expression = params["expression"].as_str().unwrap_or_default();
            if expression == "document.readyState" {
                json!({ "result": { "value": "complete" } })
            } else if expression.contains("location.href") {
                json!({ "result": { "value": { "url": "https://www.example.com/start", "title": "Example" } } })
            } else if expression.contains("captcha") {
                json!({ "result": { "value": false } })
            } else {
                json!({ "result": { "value": null } })
            }
        }
        "Page.navigate" => json!({ "frameId": "F", "loaderId": "L" }),
        "Accessibility.getFullAXTree" => ax_fixture(),
        "DOM.getBoxModel" => json!({ "model": { "content": [10, 20, 110, 20, 110, 60, 10, 60] } }),
        "DOM.describeNode" => {
            let backend = params["backendNodeId"].as_i64().unwrap_or_default();
            if backend == 12 {
                json!({ "node": { "nodeName": "INPUT", "attributes": ["type", password_type, "name", "pwd"] } })
            } else {
                json!({ "node": { "nodeName": "INPUT", "attributes": ["type", "search", "name", "q"] } })
            }
        }
        "DOM.resolveNode" => json!({ "object": { "objectId": "obj-1" } }),
        _ => json!({}),
    })
}

fn ax_fixture() -> Value {
    json!({ "nodes": [
        { "nodeId": "1", "role": { "value": "RootWebArea" }, "name": { "value": "Example" }, "childIds": ["2", "3", "4", "5", "6", "7"] },
        { "nodeId": "2", "parentId": "1", "role": { "value": "heading" }, "name": { "value": "Find a flight" }, "properties": [{ "name": "level", "value": { "value": 1 } }], "childIds": [] },
        { "nodeId": "3", "parentId": "1", "role": { "value": "searchbox" }, "name": { "value": "Search" }, "backendDOMNodeId": 11, "value": { "value": "lisbon" }, "childIds": [] },
        { "nodeId": "4", "parentId": "1", "role": { "value": "textbox" }, "name": { "value": "Your secret" }, "backendDOMNodeId": 12, "value": { "value": "••••••" }, "childIds": [] },
        { "nodeId": "5", "parentId": "1", "role": { "value": "button" }, "name": { "value": "Go" }, "backendDOMNodeId": 13, "childIds": [] },
        { "nodeId": "6", "parentId": "1", "role": { "value": "checkbox" }, "name": { "value": "I'm not a robot" }, "backendDOMNodeId": 14, "childIds": [] },
        { "nodeId": "7", "parentId": "1", "role": { "value": "generic" }, "ignored": true, "childIds": ["8"] },
        { "nodeId": "8", "parentId": "7", "role": { "value": "StaticText" }, "name": { "value": "Prices include taxes" }, "childIds": [] }
    ] })
}

struct Answer(ConsentAnswer, Arc<Mutex<Vec<String>>>);

impl ConsentAsker for Answer {
    fn ask<'a>(
        &'a self,
        site: &'a str,
    ) -> Pin<Box<dyn Future<Output = ConsentAnswer> + Send + 'a>> {
        self.1.lock().unwrap().push(site.to_string());
        let answer = self.0;
        Box::pin(async move { answer })
    }
}

async fn tab_on(handler: Arc<Handler>) -> (Tab, Arc<Mutex<Vec<String>>>) {
    let (port, seen) = mock_browser(handler).await;
    let client = CdpClient::connect(port, "/devtools/browser/test")
        .await
        .unwrap();
    (Tab::new(client, "S1".to_string()), seen)
}

fn consent() -> tokio::sync::Mutex<Consent> {
    tokio::sync::Mutex::new(Consent::default())
}

#[tokio::test]
async fn opening_a_page_navigates_after_consent_and_reads_where_it_landed() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    let asked = Arc::new(Mutex::new(Vec::new()));
    let consent = consent();
    let (location, remembered, loaded) = tab
        .open(
            "https://www.example.com/start",
            &consent,
            &Answer(ConsentAnswer::Always, asked.clone()),
        )
        .await
        .unwrap();
    assert_eq!(location.url, "https://www.example.com/start");
    assert_eq!(location.title, "Example");
    assert!(loaded);
    // The person was asked about the site, not the host.
    assert_eq!(*asked.lock().unwrap(), vec!["example.com".to_string()]);
    assert_eq!(remembered.as_deref(), Some("example.com"));
    assert!(seen.lock().unwrap().contains(&"Page.navigate".to_string()));

    // Allowed once is allowed for the rest of the session without asking.
    tab.open(
        "https://shop.example.com/",
        &consent,
        &Answer(ConsentAnswer::Deny, asked.clone()),
    )
    .await
    .unwrap();
    assert_eq!(asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_refused_site_is_never_requested() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    let asked = Arc::new(Mutex::new(Vec::new()));
    let error = tab
        .open(
            "https://bank.example.org/login",
            &consent(),
            &Answer(ConsentAnswer::Deny, asked),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_site_refused");
    assert!(!seen.lock().unwrap().contains(&"Page.navigate".to_string()));

    // Unanswered is not consent either.
    let error = tab
        .open(
            "https://other.example.net/",
            &consent(),
            &Answer(ConsentAnswer::Unanswered, Arc::new(Mutex::new(Vec::new()))),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_site_unanswered");
    assert!(!seen.lock().unwrap().contains(&"Page.navigate".to_string()));
}

#[tokio::test]
async fn only_web_addresses_open() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    for url in [
        "file:///etc/passwd",
        "chrome://settings",
        "javascript:alert(1)",
    ] {
        let error = tab
            .open(
                url,
                &consent(),
                &Answer(ConsentAnswer::Always, Arc::new(Mutex::new(Vec::new()))),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "browser_url_refused", "{url}");
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_click_lands_in_the_middle_of_the_element_named_by_its_ref() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    let (snapshot, captcha) = tab.snapshot().await.unwrap();
    assert!(!captcha);
    let go = snapshot
        .refs
        .iter()
        .find(|(_, target)| target.name == "Go")
        .map(|(reference, _)| reference.clone())
        .unwrap();
    let target = tab.click(&go).await.unwrap();
    assert_eq!(target.backend_node_id, 13);
    let methods = seen.lock().unwrap().clone();
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "Input.dispatchMouseEvent")
            .count(),
        3
    );
    assert!(methods.contains(&"DOM.getBoxModel".to_string()));

    let error = tab.click("e999").await.unwrap_err();
    assert_eq!(error.code, "browser_unknown_ref");
}

#[tokio::test]
async fn a_password_field_is_refused_before_it_is_focused() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    let (snapshot, _) = tab.snapshot().await.unwrap();
    let secret = snapshot
        .refs
        .iter()
        .find(|(_, target)| target.backend_node_id == 12)
        .map(|(reference, _)| reference.clone())
        .unwrap();
    let error = tab.type_text(&secret, "hunter2", false).await.unwrap_err();
    assert_eq!(error.code, "browser_field_refused");
    assert!(error.message.contains("password"));
    let methods = seen.lock().unwrap().clone();
    assert!(!methods.contains(&"DOM.focus".to_string()));
    assert!(!methods.contains(&"Input.insertText".to_string()));

    // The search box takes text, and submits.
    let search = snapshot
        .refs
        .iter()
        .find(|(_, target)| target.backend_node_id == 11)
        .map(|(reference, _)| reference.clone())
        .unwrap();
    tab.type_text(&search, "lisbon flights", true)
        .await
        .unwrap();
    let methods = seen.lock().unwrap().clone();
    assert!(methods.contains(&"Input.insertText".to_string()));
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "Input.dispatchKeyEvent")
            .count(),
        2
    );
}

#[tokio::test]
async fn a_captcha_is_left_to_the_person() {
    let (mut tab, seen) = tab_on(page_handler("text")).await;
    let (snapshot, _) = tab.snapshot().await.unwrap();
    let robot = snapshot
        .refs
        .iter()
        .find(|(_, target)| target.name.contains("robot"))
        .map(|(reference, _)| reference.clone())
        .unwrap();
    let error = tab.click(&robot).await.unwrap_err();
    assert_eq!(error.code, "browser_captcha_refused");
    assert!(!seen
        .lock()
        .unwrap()
        .contains(&"Input.dispatchMouseEvent".to_string()));
}

#[test]
fn the_snapshot_numbers_controls_and_never_copies_a_field_value() {
    let snapshot = snapshot::from_ax_tree(&ax_fixture());
    assert_eq!(snapshot.refs.len(), 4);
    assert!(snapshot.text.contains("heading \"Find a flight\" level 1"));
    assert!(snapshot.text.contains("searchbox \"Search\" (filled)"));
    assert!(snapshot.text.contains("button \"Go\""));
    // An ignored wrapper is skipped, its text kept.
    assert!(snapshot.text.contains("text \"Prices include taxes\""));
    assert!(!snapshot.text.contains("lisbon"));
    assert!(!snapshot.text.contains("••"));
    assert!(!snapshot.truncated);
}

#[test]
fn payment_and_password_fields_are_recognised_however_they_are_named() {
    let attrs = |pairs: &[(&str, &str)]| -> Vec<String> {
        pairs
            .iter()
            .flat_map(|(key, value)| [key.to_string(), value.to_string()])
            .collect()
    };
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("type", "password")]), ""),
        Some(Sensitive::Password)
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("autocomplete", "cc-number")]), ""),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("name", "cvc")]), ""),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        snapshot::sensitive_field("SELECT", &attrs(&[("id", "exp-date-month")]), ""),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("type", "text")]), "Numéro de carte"),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("autocomplete", "one-time-code")]), ""),
        Some(Sensitive::OneTimeCode)
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("type", "text")]), "Mot de passe"),
        Some(Sensitive::Password)
    );
    // Short hints only match as words.
    assert_eq!(
        snapshot::sensitive_field(
            "INPUT",
            &attrs(&[("name", "footprint")]),
            "Carbon footprint"
        ),
        None
    );
    assert_eq!(
        snapshot::sensitive_field("INPUT", &attrs(&[("type", "email")]), "Email"),
        None
    );
}

#[test]
fn a_site_is_the_registrable_domain() {
    assert_eq!(
        site::site_of("https://www.example.com/a?b").as_deref(),
        Some("example.com")
    );
    assert_eq!(
        site::site_of("https://shop.example.co.uk/").as_deref(),
        Some("example.co.uk")
    );
    assert_eq!(
        site::site_of("https://user:pw@a.b.gouv.fr:8443/x").as_deref(),
        Some("b.gouv.fr")
    );
    assert_eq!(
        site::site_of("https://me.github.io/page").as_deref(),
        Some("me.github.io")
    );
    assert_eq!(
        site::site_of("http://127.0.0.1:3000/").as_deref(),
        Some("127.0.0.1")
    );
    assert_eq!(site::site_of("about:blank"), None);
    assert!(site::openable("HTTPS://example.com"));
    assert!(!site::openable("data:text/html,hi"));
    assert_eq!(
        site::normalise_entry(" https://www.Example.com/path ").as_deref(),
        Some("example.com")
    );
    assert_eq!(
        site::normalise_entry("news.example.org").as_deref(),
        Some("example.org")
    );
    assert_eq!(site::normalise_entry("not a site"), None);
    let allowed = vec!["example.com".to_string()];
    assert_eq!(
        site::decide("example.com", &allowed, &[]),
        Decision::Allowed
    );
    assert_eq!(site::decide("example.org", &allowed, &[]), Decision::Ask);
    assert_eq!(
        site::decide("example.org", &allowed, &["example.org".to_string()]),
        Decision::Allowed
    );
}

/// The host is read the way the browser reads it, so an address crafted to
/// look like an allowed site resolves to the site the browser would open.
#[test]
fn a_host_is_what_the_browser_would_contact() {
    let cases: &[(&str, Option<&str>, Option<&str>)] = &[
        // `\` ends the host for a browser: this opens evil.example.
        (
            "https://evil.example\\@allowed.example/",
            Some("evil.example"),
            Some("evil.example"),
        ),
        (
            "https://evil.example\\.allowed.example/",
            Some("evil.example"),
            Some("evil.example"),
        ),
        // An encoded slash is not a separator: the part before `@` is the
        // user, and the browser goes to the host after it.
        (
            "https://evil.example%2F@allowed.example/",
            Some("allowed.example"),
            Some("allowed.example"),
        ),
        (
            "https://user:pw@allowed.example:8443/x",
            Some("allowed.example"),
            Some("allowed.example"),
        ),
        (
            "https://allowed.example@evil.example/",
            Some("evil.example"),
            Some("evil.example"),
        ),
        // A suffix is not a site.
        (
            "https://allowed.com.evil.com/",
            Some("allowed.com.evil.com"),
            Some("evil.com"),
        ),
        // An international name is compared in the form the browser sends.
        (
            "https://www.bücher.example/",
            Some("www.xn--bcher-kva.example"),
            Some("xn--bcher-kva.example"),
        ),
        (
            "https://EXAMPLE.com./",
            Some("example.com"),
            Some("example.com"),
        ),
        ("http://[::1]:8080/", Some("::1"), Some("::1")),
        ("https://127.0.0.1/", Some("127.0.0.1"), Some("127.0.0.1")),
        // Not web addresses at all.
        ("file:///etc/passwd", None, None),
        ("javascript:alert(1)//https://allowed.example/", None, None),
        (
            "data:text/html,<a href=https://allowed.example>",
            None,
            None,
        ),
        ("https:///", None, None),
        ("not a url", None, None),
    ];
    for (url, host, site_of) in cases {
        assert_eq!(site::host_of(url).as_deref(), *host, "host of {url}");
        assert_eq!(site::site_of(url).as_deref(), *site_of, "site of {url}");
        assert_eq!(site::openable(url), host.is_some(), "openable {url}");
    }
    assert_eq!(
        site::normalise_entry("bücher.example").as_deref(),
        Some("xn--bcher-kva.example")
    );
    // Asked about evil.example, never let through as allowed.example.
    let allowed = vec!["allowed.example".to_string()];
    let site = site::site_of("https://evil.example\\@allowed.example/").unwrap();
    assert_eq!(site::decide(&site, &allowed, &[]), Decision::Ask);
}

#[tokio::test]
async fn pipe_messages_are_nul_framed_and_capped() {
    let (mut near, far) = tokio::io::duplex(1 << 16);
    let mut reader = tokio::io::BufReader::new(far);
    pipe::send_text(&mut near, r#"{"id":1}"#).await.unwrap();
    pipe::send_text(&mut near, r#"{"method":"x"}"#)
        .await
        .unwrap();
    assert_eq!(
        pipe::read_message(&mut reader).await.unwrap().as_deref(),
        Some(r#"{"id":1}"#)
    );
    assert_eq!(
        pipe::read_message(&mut reader).await.unwrap().as_deref(),
        Some(r#"{"method":"x"}"#)
    );
    assert!(pipe::send_text(&mut near, "a\0b").await.is_err());
    drop(near);
    assert_eq!(pipe::read_message(&mut reader).await.unwrap(), None);

    // A message past the cap is refused rather than buffered.
    let big = vec![b'x'; super::ws::MAX_MESSAGE_BYTES + 1];
    let mut reader = tokio::io::BufReader::new(&big[..]);
    assert!(pipe::read_message(&mut reader).await.is_err());
}

/// One command the pipe stand-in saw: method, params, session.
type Seen = Arc<Mutex<Vec<(String, Value, Option<String>)>>>;

/// A DevTools stand-in over the pipe framing. `build` receives the channel
/// on which the stand-in speaks first (events), and returns the handler that
/// answers commands.
async fn pipe_browser(
    build: impl FnOnce(UnboundedSender<Value>) -> Arc<Handler>,
) -> (CdpClient, Seen) {
    let (app_side, browser_side) = tokio::io::duplex(1 << 20);
    let (app_read, app_write) = tokio::io::split(app_side);
    let client = CdpClient::over_pipe(tokio::io::BufReader::new(app_read), app_write);
    let (browser_read, browser_write) = tokio::io::split(browser_side);
    let writer = Arc::new(tokio::sync::Mutex::new(browser_write));
    let (events, mut outgoing) = unbounded_channel::<Value>();
    let handler = build(events);
    let pump = writer.clone();
    tokio::spawn(async move {
        while let Some(event) = outgoing.recv().await {
            let mut writer = pump.lock().await;
            let _ = pipe::send_text(&mut *writer, &event.to_string()).await;
        }
    });
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(browser_read);
        while let Ok(Some(text)) = pipe::read_message(&mut reader).await {
            let request: Value = serde_json::from_str(&text).unwrap();
            let method = request["method"].as_str().unwrap_or_default().to_string();
            let session = request["sessionId"].as_str().map(str::to_string);
            log.lock()
                .unwrap()
                .push((method.clone(), request["params"].clone(), session.clone()));
            let result = handler(&method, &request["params"]);
            let mut reply = json!({ "id": request["id"], "result": result });
            if let Some(session) = session {
                reply["sessionId"] = json!(session);
            }
            let mut writer = writer.lock().await;
            let _ = pipe::send_text(&mut *writer, &reply.to_string()).await;
        }
    });
    (client, seen)
}

fn methods(seen: &Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|(method, _, _)| method.clone())
        .collect()
}

/// Waits until the stand-in has seen `method`, so a test reads the gate's
/// answer, not a race with it.
async fn saw(seen: &Seen, method: &str) {
    for _ in 0..200 {
        if methods(seen).iter().any(|seen| seen == method) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never saw {method}: {:?}", methods(seen));
}

#[derive(Default)]
struct Ledger {
    visits: Mutex<Vec<String>>,
    remembered: Mutex<Vec<String>>,
}

impl GateSink for Ledger {
    fn visited(&self, host: &str) {
        self.visits.lock().unwrap().push(host.to_string());
    }

    fn remembered(&self, site: &str) {
        self.remembered.lock().unwrap().push(site.to_string());
    }
}

/// Answers per site from a script; anything unlisted is refused.
struct Script(Vec<(&'static str, ConsentAnswer)>, Arc<Mutex<Vec<String>>>);

impl ConsentAsker for Script {
    fn ask<'a>(
        &'a self,
        site: &'a str,
    ) -> Pin<Box<dyn Future<Output = ConsentAnswer> + Send + 'a>> {
        self.1.lock().unwrap().push(site.to_string());
        let answer = self
            .0
            .iter()
            .find(|(wanted, _)| *wanted == site)
            .map(|(_, answer)| *answer)
            .unwrap_or(ConsentAnswer::Deny);
        Box::pin(async move { answer })
    }
}

struct Gated {
    client: CdpClient,
    seen: Seen,
    gate: Gate,
    consent: Arc<tokio::sync::Mutex<Consent>>,
    asked: Arc<Mutex<Vec<String>>>,
    ledger: Arc<Ledger>,
}

/// A tab on the pipe stand-in, held by an armed gate, with `example.com`
/// already allowed.
async fn gated(
    answers: Vec<(&'static str, ConsentAnswer)>,
    react: impl Fn(&str, &Value, &UnboundedSender<Value>) + Send + Sync + 'static,
) -> Gated {
    let (client, seen) = pipe_browser(move |events| {
        let base = page_handler("password");
        Arc::new(move |method: &str, params: &Value| {
            react(method, params, &events);
            base(method, params)
        })
    })
    .await;
    let consent = Arc::new(tokio::sync::Mutex::new(Consent {
        allowed: vec!["example.com".to_string()],
        this_session: Vec::new(),
    }));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let ledger = Arc::new(Ledger::default());
    let gate = Gate::spawn(
        client.clone(),
        client.take_events().unwrap(),
        consent.clone(),
        Arc::new(Script(answers, asked.clone())),
        ledger.clone(),
    );
    gate.arm(&Attached {
        target_id: "T1".into(),
        session_id: "S1".into(),
    })
    .await
    .unwrap();
    Gated {
        client,
        seen,
        gate,
        consent,
        asked,
        ledger,
    }
}

fn paused(request_id: &str, frame_id: &str, url: &str) -> Value {
    json!({
        "method": "Fetch.requestPaused",
        "sessionId": "S1",
        "params": {
            "requestId": request_id,
            "frameId": frame_id,
            "resourceType": "Document",
            "request": { "url": url, "method": "GET" },
        },
    })
}

fn call_for<'a>(
    seen: &'a [(String, Value, Option<String>)],
    method: &str,
    request_id: &str,
) -> Option<&'a (String, Value, Option<String>)> {
    seen.iter()
        .find(|(name, params, _)| name == method && params["requestId"] == request_id)
}

/// A click that leads to a site the person has not allowed: the document
/// request is failed in the browser before it leaves, the agent hears the
/// refusal, and the tab is not sent back through its history (the page never
/// loaded, so there is nothing to undo).
#[tokio::test]
async fn a_click_toward_a_site_not_allowed_is_stopped_before_it_loads() {
    let g = gated(vec![], |method, params, events| {
        if method == "Input.dispatchMouseEvent" && params["type"] == "mouseReleased" {
            events
                .send(paused(
                    "R1",
                    "T1",
                    "https://evil.example\\@example.com/landing",
                ))
                .unwrap();
        }
    })
    .await;
    let mut tab = Tab::new(g.client.clone(), "S1".to_string());
    let (snapshot, _) = tab.snapshot().await.unwrap();
    let go = snapshot
        .refs
        .iter()
        .find(|(_, target)| target.name == "Go")
        .map(|(reference, _)| reference.clone())
        .unwrap();
    tab.click(&go).await.unwrap();
    saw(&g.seen, "Fetch.failRequest").await;
    let asker = Script(vec![], Arc::new(Mutex::new(Vec::new())));
    let error = after_action(&mut tab, &g.gate, &g.consent, &asker)
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_site_refused");
    // Asked about the site the browser would really open.
    assert_eq!(*g.asked.lock().unwrap(), vec!["evil.example".to_string()]);
    let seen = g.seen.lock().unwrap().clone();
    let (_, failed, session) = call_for(&seen, "Fetch.failRequest", "R1").unwrap();
    assert_eq!(failed["errorReason"], "BlockedByClient");
    assert_eq!(session.as_deref(), Some("S1"));
    assert!(call_for(&seen, "Fetch.continueRequest", "R1").is_none());
    assert!(
        !seen
            .iter()
            .any(|(method, params, _)| method == "Runtime.evaluate"
                && params["expression"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("history.back")),
        "no history navigation"
    );
    assert!(g.ledger.visits.lock().unwrap().is_empty());
}

/// An allowed page loads and leaves one ledger row; a document inside one of
/// its frames goes on without a question; each redirect hop is a request of
/// its own, decided on its own.
#[tokio::test]
async fn allowed_pages_load_and_are_recorded_and_every_hop_is_decided() {
    let g = gated(
        vec![("partner.example", ConsentAnswer::Always)],
        |method, _, events| {
            if method == "Page.navigate" {
                events
                    .send(paused("R1", "T1", "https://www.example.com/start"))
                    .unwrap();
                // A frame on that page, from another site.
                events
                    .send(paused("R2", "F-ad", "https://ads.elsewhere.example/frame"))
                    .unwrap();
                // The server redirects to a new site, then to one refused.
                events
                    .send(paused("R3", "T1", "https://login.partner.example/sso"))
                    .unwrap();
                events
                    .send(paused("R4", "T1", "https://tracker.example/hop"))
                    .unwrap();
                // A document from a session the gate never held: decided
                // as a page's own, never waved through as a frame.
                let mut unknown = paused("R5", "F-x", "https://unheld.example/");
                unknown["sessionId"] = json!("S9");
                events.send(unknown).unwrap();
            }
        },
    )
    .await;
    let mut tab = Tab::new(g.client.clone(), "S1".to_string());
    let asker = Script(vec![], Arc::new(Mutex::new(Vec::new())));
    tab.open("https://www.example.com/start", &g.consent, &asker)
        .await
        .unwrap();
    for _ in 0..200 {
        let seen = g.seen.lock().unwrap().clone();
        if ["R1", "R2", "R3"]
            .iter()
            .all(|id| call_for(&seen, "Fetch.continueRequest", id).is_some())
            && call_for(&seen, "Fetch.failRequest", "R4").is_some()
            && call_for(&seen, "Fetch.failRequest", "R5").is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let seen = g.seen.lock().unwrap().clone();
    for id in ["R1", "R2", "R3"] {
        let (_, _, session) = call_for(&seen, "Fetch.continueRequest", id)
            .unwrap_or_else(|| panic!("{id} was not let through: {seen:?}"));
        assert_eq!(session.as_deref(), Some("S1"));
    }
    assert!(call_for(&seen, "Fetch.failRequest", "R4").is_some());
    let (_, _, session) = call_for(&seen, "Fetch.failRequest", "R5").unwrap();
    assert_eq!(session.as_deref(), Some("S9"));
    // Only the new sites were asked about; the frame never was.
    let mut asked = g.asked.lock().unwrap().clone();
    asked.sort();
    assert_eq!(
        asked,
        vec!["partner.example", "tracker.example", "unheld.example"]
    );
    let mut visits = g.ledger.visits.lock().unwrap().clone();
    visits.sort();
    assert_eq!(visits, vec!["login.partner.example", "www.example.com"]);
    assert_eq!(
        *g.ledger.remembered.lock().unwrap(),
        vec!["partner.example".to_string()]
    );
}

/// The agent's tab is held before anything else, every tab the browser opens
/// later is attached paused, held, then let run; a worker is only let run.
#[tokio::test]
async fn an_attached_tab_is_held_before_it_runs() {
    let g = gated(vec![], |_, _, _| {}).await;
    let opening = methods(&g.seen);
    assert_eq!(opening[0], "Fetch.enable");
    assert_eq!(opening[1], "Target.setAutoAttach");
    let seen = g.seen.lock().unwrap().clone();
    assert_eq!(seen[0].2.as_deref(), Some("S1"));
    assert_eq!(
        seen[0].1["patterns"][0],
        json!({ "urlPattern": "*", "resourceType": "Document", "requestStage": "Request" })
    );
    assert_eq!(seen[1].1["waitForDebuggerOnStart"], true);
    assert_eq!(seen[1].1["flatten"], true);

    // The stand-in speaks first: a popup, then a service worker.
    let (client, seen) = pipe_browser(|events| {
        events
            .send(json!({ "method": "Target.attachedToTarget", "params": {
                "sessionId": "S2", "waitingForDebugger": true,
                "targetInfo": { "targetId": "T2", "type": "page", "url": "" } } }))
            .unwrap();
        events
            .send(json!({ "method": "Target.attachedToTarget", "params": {
                "sessionId": "S3", "waitingForDebugger": true,
                "targetInfo": { "targetId": "W3", "type": "service_worker", "url": "" } } }))
            .unwrap();
        page_handler("password")
    })
    .await;
    let _gate = Gate::spawn(
        client.clone(),
        client.take_events().unwrap(),
        Arc::new(tokio::sync::Mutex::new(Consent::default())),
        Arc::new(Script(vec![], Arc::new(Mutex::new(Vec::new())))),
        Arc::new(Ledger::default()),
    );
    for _ in 0..200 {
        let count = methods(&seen)
            .iter()
            .filter(|method| *method == "Runtime.runIfWaitingForDebugger")
            .count();
        if count == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let seen = seen.lock().unwrap().clone();
    let index = |method: &str, session: &str| {
        seen.iter()
            .position(|(name, _, on)| name == method && on.as_deref() == Some(session))
    };
    let held = index("Fetch.enable", "S2").expect("the popup is held");
    let ran = index("Runtime.runIfWaitingForDebugger", "S2").expect("the popup runs");
    assert!(held < ran, "held before it runs: {seen:?}");
    assert!(index("Runtime.runIfWaitingForDebugger", "S3").is_some());
    assert!(
        index("Fetch.enable", "S3").is_none(),
        "a worker has no page"
    );
}

#[test]
fn the_devtools_port_file_is_read_strictly() {
    assert_eq!(
        parse_devtools_active_port("53122\n/devtools/browser/abc-def\n"),
        Some((53122, "/devtools/browser/abc-def".to_string()))
    );
    assert_eq!(parse_devtools_active_port("0\n/devtools/browser/x"), None);
    assert_eq!(parse_devtools_active_port("9222\n/json"), None);
    assert_eq!(parse_devtools_active_port(""), None);
}

#[test]
fn a_box_model_click_point_is_its_centre() {
    let model = json!({ "model": { "content": [0, 0, 100, 0, 100, 50, 0, 50] } });
    assert_eq!(center_of(&model), Some((50.0, 25.0)));
    assert_eq!(center_of(&json!({ "model": { "content": [1, 2] } })), None);
}

#[tokio::test]
async fn frames_survive_the_round_trip_at_every_length() {
    for size in [0_usize, 5, 125, 126, 70_000] {
        let payload: String = "x".repeat(size);
        let frame = ws::encode_client_frame(0x1, payload.as_bytes(), [1, 2, 3, 4]);
        let mut reader = &frame[..];
        assert_eq!(
            ws::read_message(&mut reader).await.unwrap(),
            ws::Incoming::Text(payload)
        );
    }
}

/// The whole path against the browser on this machine, headless: launch
/// with a throwaway profile over the debugging pipe (a port on Windows),
/// attach, arm the gate, open a page served on loopback, snapshot it, click,
/// type, be refused a password field, and follow a link to a site the person
/// refuses, which must never load. Opt-in
/// (`cargo test -- --ignored real_browser`), because it starts a browser.
#[tokio::test]
#[ignore = "launches the Chromium-family browser installed on this machine"]
async fn real_browser_end_to_end() {
    use super::launch::{connect, launch_with, pick};

    let Some(browser) = pick(None) else {
        eprintln!("no Chromium-family browser installed; nothing to drive");
        return;
    };
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    // The link goes to `localhost`, another site than `127.0.0.1`.
    let page = format!(
        r#"<!doctype html><html><head><title>Start</title></head><body>
<h1>Find a flight</h1>
<input type="search" name="q" aria-label="Search">
<input type="password" name="pwd" aria-label="Password">
<button onclick="document.title = 'Clicked'">Go</button>
<a href="http://localhost:{port}/elsewhere">Elsewhere</a>
</body></html>"#
    );
    let elsewhere_served = Arc::new(Mutex::new(false));
    let served = elsewhere_served.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = server.accept().await else {
                return;
            };
            let mut buffer = [0_u8; 2048];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = if request.starts_with("GET /elsewhere") {
                *served.lock().unwrap() = true;
                "<!doctype html><title>Elsewhere</title>".to_string()
            } else {
                page.clone()
            };
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });

    let profile = tempfile::tempdir().unwrap();
    let launched = launch_with(&browser.executable, profile.path(), &["--headless=new"])
        .await
        .unwrap();
    let (client, mut child) = connect(launched).await.unwrap();
    eprintln!("connected to {} over {:?}", browser.name, client.framing());
    #[cfg(unix)]
    assert_eq!(client.framing(), super::cdp::Framing::Pipe);
    let consent = Arc::new(tokio::sync::Mutex::new(Consent::default()));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let ledger = Arc::new(Ledger::default());
    let gate = Gate::spawn(
        client.clone(),
        client.take_events().unwrap(),
        consent.clone(),
        Arc::new(Script(
            vec![("127.0.0.1", ConsentAnswer::Once)],
            asked.clone(),
        )),
        ledger.clone(),
    );
    let attached = super::cdp::attach_to_page(&client).await.unwrap();
    gate.arm(&attached).await.unwrap();
    let mut tab = Tab::new(client, attached.session_id);

    let url = format!("http://127.0.0.1:{port}/");
    let asker = Script(vec![("127.0.0.1", ConsentAnswer::Once)], asked.clone());
    let (location, _, loaded) = tab.open(&url, &consent, &asker).await.unwrap();
    assert!(loaded);
    assert_eq!(location.title, "Start");
    assert_eq!(*asked.lock().unwrap(), vec!["127.0.0.1".to_string()]);
    assert_eq!(
        *ledger.visits.lock().unwrap(),
        vec!["127.0.0.1".to_string()],
        "the gate let the page through and recorded it"
    );

    let (snapshot, captcha) = tab.snapshot().await.unwrap();
    assert!(!captcha);
    assert!(snapshot.text.contains("Find a flight"), "{}", snapshot.text);
    let reference = |name: &str| {
        snapshot
            .refs
            .iter()
            .find(|(_, target)| target.name == name)
            .map(|(reference, _)| reference.clone())
            .unwrap_or_else(|| panic!("no {name} in {}", snapshot.text))
    };

    tab.click(&reference("Go")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(tab.location().await.unwrap().title, "Clicked");

    let error = tab
        .type_text(&reference("Password"), "hunter2", false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_field_refused");

    tab.type_text(&reference("Search"), "lisbon", false)
        .await
        .unwrap();
    let typed = tab
        .evaluate("document.querySelector('input[name=q]').value")
        .await
        .unwrap();
    assert_eq!(typed, json!("lisbon"));
    let secret = tab
        .evaluate("document.querySelector('input[name=pwd]').value")
        .await
        .unwrap();
    assert_eq!(secret, json!(""));

    // A link to a site nobody allowed: asked, refused, never requested.
    tab.click(&reference("Elsewhere")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let error = after_action(&mut tab, &gate, &consent, &asker)
        .await
        .unwrap_err();
    assert_eq!(error.code, "browser_site_refused");
    assert_eq!(
        *asked.lock().unwrap(),
        vec!["127.0.0.1".to_string(), "localhost".to_string()]
    );
    assert!(
        !*elsewhere_served.lock().unwrap(),
        "the refused page reached the server"
    );
    let landed = tab.location().await.unwrap();
    eprintln!("after the refusal the tab shows {}", landed.url);
    assert_ne!(landed.title, "Elsewhere");
    assert_eq!(ledger.visits.lock().unwrap().len(), 1);

    let _ = tab.cdp.call("Browser.close", json!({}), None).await;
    if let Some(child) = child.as_mut() {
        let _ = child.start_kill();
    }
}

#[test]
fn arc_is_not_offered_as_the_agent_browser() {
    // ADR-0094 addendum: no documented separate profile, a crash on
    // `Target.createTarget`, and an updater that drops the flags.
    for (id, name, path) in super::launch::candidates() {
        assert_ne!(id, "arc");
        assert_ne!(name, "Arc");
        assert!(!path.to_string_lossy().contains("Arc.app"), "{path:?}");
    }
}
