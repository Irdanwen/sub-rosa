//! The agent browser against a scripted DevTools socket: what the agent may
//! do, what it is refused, and that a refusal happens before the browser is
//! asked to do anything.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::browser::{center_of, Consent, ConsentAnswer, ConsentAsker, Tab};
use super::cdp::CdpClient;
use super::launch::parse_devtools_active_port;
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

#[tokio::test]
async fn opening_a_page_navigates_after_consent_and_reads_where_it_landed() {
    let (mut tab, seen) = tab_on(page_handler("password")).await;
    let asked = Arc::new(Mutex::new(Vec::new()));
    let mut consent = Consent::default();
    let (location, remembered, loaded) = tab
        .open(
            "https://www.example.com/start",
            &mut consent,
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
        &mut consent,
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
            &mut Consent::default(),
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
            &mut Consent::default(),
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
                &mut Consent::default(),
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

/// The whole path against the browser on this machine, headless: launch with
/// a throwaway profile, read `DevToolsActivePort`, attach, open a page served
/// on loopback, snapshot it, click, type, and be refused a password field.
/// Opt-in (`cargo test -- --ignored real_browser`), because it starts a
/// browser.
#[tokio::test]
#[ignore = "launches the Chromium-family browser installed on this machine"]
async fn real_browser_end_to_end() {
    use super::launch::{launch_with, pick};

    let Some(browser) = pick(None) else {
        eprintln!("no Chromium-family browser installed; nothing to drive");
        return;
    };
    let page = r#"<!doctype html><html><head><title>Start</title></head><body>
<h1>Find a flight</h1>
<input type="search" name="q" aria-label="Search">
<input type="password" name="pwd" aria-label="Password">
<button onclick="document.title = 'Clicked'">Go</button>
</body></html>"#;
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = server.accept().await else {
                return;
            };
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer).await;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });

    let profile = tempfile::tempdir().unwrap();
    let launched = launch_with(&browser.executable, profile.path(), &["--headless=new"])
        .await
        .unwrap();
    let mut child = launched.child;
    let client = CdpClient::connect(launched.port, &launched.path)
        .await
        .unwrap();
    let session = super::cdp::attach_to_page(&client).await.unwrap();
    let mut tab = Tab::new(client, session);

    let asked = Arc::new(Mutex::new(Vec::new()));
    let url = format!("http://127.0.0.1:{port}/");
    let (location, _, loaded) = tab
        .open(
            &url,
            &mut Consent::default(),
            &Answer(ConsentAnswer::Once, asked.clone()),
        )
        .await
        .unwrap();
    assert!(loaded);
    assert_eq!(location.title, "Start");
    assert_eq!(*asked.lock().unwrap(), vec!["127.0.0.1".to_string()]);

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
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
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
