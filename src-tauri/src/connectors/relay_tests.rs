use super::*;

fn tool(name: &str, read_only: bool) -> ToolInfo {
    ToolInfo {
        name: name.into(),
        title: None,
        description: format!("{name} things"),
        input_schema: json!({"type": "object", "properties": {"query": {"type": "string"}}}),
        read_only,
        destructive: !read_only,
        ui_resource: None,
    }
}

fn connector(id: &str) -> Connector {
    Connector {
        id: id.into(),
        name: "Sentry".into(),
        url: "https://mcp.sentry.dev/mcp".into(),
        catalog_id: id.into(),
        auth: "oauth".into(),
        enabled: true,
        tool_policy: Default::default(),
    }
}

fn errand(tool: &str, approved: bool, at: chrono::DateTime<chrono::Utc>) -> Errand {
    Errand {
        id: "e1".into(),
        connector_id: "sentry".into(),
        tool: tool.into(),
        arguments: r#"{"query":"crash"}"#.into(),
        approved,
        requested_at: at.to_rfc3339(),
        requested_by: "browser-1".into(),
        approval: None,
    }
}

/// The device applies its own rules, never the asker's: the switch, the
/// clock, the size, the connector and the person's rule for the tool.
#[test]
fn a_call_runs_only_under_this_devices_own_rules() {
    let now = chrono::Utc::now();
    let tools = [tool("search", true), tool("resolve", false)];
    let sentry = connector("sentry");
    let run = |errand: &Errand, accepting, connector: Option<&Connector>, signed_in| {
        decide(errand, accepting, connector, signed_in, &tools, now)
    };
    assert_eq!(
        run(&errand("search", false, now), true, Some(&sentry), true),
        Decision::Run(json!({"query": "crash"}))
    );
    assert_eq!(
        run(&errand("search", false, now), false, Some(&sentry), true),
        Decision::Decline(NOT_ACCEPTING.into()),
        "a device with the switch off says so rather than leaving the tab waiting"
    );
    let stale = now - chrono::Duration::seconds(EXPIRY_SECS + 5);
    assert_eq!(
        run(&errand("search", false, stale), true, Some(&sentry), true),
        Decision::Decline(TOO_LATE.into())
    );
    assert_eq!(
        run(&errand("search", false, now), true, None, true),
        Decision::Decline(super::super::agent::REMOVED.into())
    );
    assert_eq!(
        run(&errand("search", false, now), true, Some(&sentry), false),
        Decision::Decline(NOT_SIGNED_IN.into())
    );
    // A tool that changes something asks first, unless the person approved
    // it where they asked.
    assert_eq!(
        run(&errand("resolve", false, now), true, Some(&sentry), true),
        Decision::Ask
    );
    assert!(matches!(
        run(&errand("resolve", true, now), true, Some(&sentry), true),
        Decision::Run(_)
    ));
    // The person's deny wins over an approval sent from elsewhere.
    let mut denied = sentry.clone();
    denied.tool_policy.insert("resolve".into(), "deny".into());
    assert_eq!(
        run(&errand("resolve", true, now), true, Some(&denied), true),
        Decision::Decline(super::super::agent::TURNED_OFF.into())
    );
    // A tool this device never listed asks.
    assert_eq!(
        run(&errand("unknown", false, now), true, Some(&sentry), true),
        Decision::Ask
    );
    let mut large = errand("search", false, now);
    large.arguments = format!(r#"{{"query":"{}"}}"#, "x".repeat(MAX_ARGUMENT_BYTES));
    assert_eq!(
        run(&large, true, Some(&sentry), true),
        Decision::Decline(TOO_LARGE.into())
    );
}

/// A call dated ahead of this clock is refused (it would otherwise stay
/// fresh past its lifetime), past a minute of drift; arguments that are not
/// an object are declined, never run as an empty one.
#[test]
fn a_call_from_the_future_or_without_an_object_is_not_made() {
    let now = chrono::Utc::now();
    let tools = [tool("search", true)];
    let sentry = connector("sentry");
    let run = |errand: &Errand| decide(errand, true, Some(&sentry), true, &tools, now);
    let ahead = now + chrono::Duration::seconds(super::super::relay_approval::CLOCK_SKEW_SECS + 5);
    assert_eq!(
        run(&errand("search", false, ahead)),
        Decision::Decline(CLOCK_AHEAD.into())
    );
    let drift = now + chrono::Duration::seconds(30);
    assert!(matches!(
        run(&errand("search", false, drift)),
        Decision::Run(_)
    ));
    let mut undated = errand("search", false, now);
    undated.requested_at = "soon".into();
    assert_eq!(run(&undated), Decision::Decline(TOO_LATE.into()));
    for arguments in ["[1,2]", "\"crash\"", "null", "42", "{not json"] {
        let mut odd = errand("search", false, now);
        odd.arguments = arguments.into();
        assert_eq!(
            run(&odd),
            Decision::Decline(BAD_ARGUMENTS.into()),
            "{arguments}"
        );
    }
}

/// A browser device key, as WebCrypto makes one, and its approval of a call.
struct Browser {
    key: p256::ecdsa::SigningKey,
    public: super::super::relay_approval::BrowserKey,
}

impl Browser {
    fn new(id: &str) -> Self {
        use base64::Engine as _;
        let key = loop {
            let bytes = p256::FieldBytes::from(rand::random::<[u8; 32]>());
            if let Ok(key) = p256::ecdsa::SigningKey::from_bytes(&bytes) {
                break key;
            }
        };
        let point = key.verifying_key().to_encoded_point(false);
        let encode = |c: Option<&p256::FieldBytes>| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(c.unwrap())
        };
        Self {
            public: super::super::relay_approval::BrowserKey {
                device_id: id.into(),
                x: encode(point.x()),
                y: encode(point.y()),
            },
            key,
        }
    }

    fn sign(&self, header: Value, claims: Value) -> String {
        use base64::Engine as _;
        use p256::ecdsa::signature::Signer as _;
        let b64 = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        let input = format!("{}.{}", b64(&header), b64(&claims));
        let signature: p256::ecdsa::Signature = self.key.sign(input.as_bytes());
        format!(
            "{input}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    fn approve(&self, errand: &Errand, iat: i64) -> String {
        self.sign(
            json!({"alg": "ES256", "typ": super::super::relay_approval::APPROVAL_TYPE, "kid": self.public.device_id}),
            json!({
                "eid": errand.id,
                "dig": super::super::relay_approval::digest(&errand.tool, &errand.arguments),
                "iat": iat,
            }),
        )
    }
}

/// An "ask" call runs only with an approval its asking browser signed over
/// this very call, and only while that browser is a live device of the
/// account. The row's own flag is not enough.
#[test]
fn an_approval_counts_only_when_its_browser_signed_this_call() {
    use super::super::relay_approval::{browser_keys, digest, holds};
    let now = chrono::Utc::now();
    let browser = Browser::new("browser-1");
    let stranger = Browser::new("browser-9");
    let keys = vec![browser.public.clone()];
    let mut call = errand("resolve", true, now);
    assert!(!holds(&call, &keys, now), "a flag without a signature");

    call.approval = Some(browser.approve(&call, now.timestamp()));
    assert!(holds(&call, &keys, now));

    // Another call, other arguments, another tool: the same approval is void.
    let mut other = call.clone();
    other.arguments = r#"{"query":"everything"}"#.into();
    assert!(!holds(&other, &keys, now));
    let mut renamed = call.clone();
    renamed.tool = "delete".into();
    assert!(!holds(&renamed, &keys, now));
    let mut replayed = call.clone();
    replayed.id = "e2".into();
    assert!(!holds(&replayed, &keys, now));
    // Signed by a browser the account does not list, or for another asker.
    let mut forged = call.clone();
    forged.approval = Some(stranger.approve(&call, now.timestamp()));
    forged.requested_by = "browser-9".into();
    assert!(!holds(&forged, &keys, now));
    let mut misattributed = call.clone();
    misattributed.requested_by = "browser-2".into();
    assert!(!holds(&misattributed, &keys, now));
    // Too old, or from a clock too far ahead.
    let mut stale = call.clone();
    stale.approval = Some(browser.approve(&call, now.timestamp() - EXPIRY_SECS - 5));
    assert!(!holds(&stale, &keys, now));
    let mut early = call.clone();
    early.approval = Some(browser.approve(&call, now.timestamp() + 600));
    assert!(!holds(&early, &keys, now));
    // A tampered signature, a wrong type, an unsigned token.
    let mut tampered = call.clone();
    let token = call.approval.clone().unwrap();
    let at = token.rfind('.').unwrap() + 10;
    let flipped = if &token[at..=at] == "A" { "B" } else { "A" };
    tampered.approval = Some(format!("{}{flipped}{}", &token[..at], &token[at + 1..]));
    assert!(!holds(&tampered, &keys, now));
    let mut typed = call.clone();
    typed.approval = Some(browser.sign(
        json!({"alg": "ES256", "typ": "dpop+jwt", "kid": "browser-1"}),
        json!({"eid": call.id, "dig": digest(&call.tool, &call.arguments), "iat": now.timestamp()}),
    ));
    assert!(!holds(&typed, &keys, now));
    let mut none = call.clone();
    none.approval = Some(format!("{}.{}.", "eyJhbGciOiJub25lIn0", "e30"));
    assert!(!holds(&none, &keys, now));

    // The account service's list: live browser devices with a key only.
    let listed = json!([
        {"id": "browser-1", "kind": "browser", "revoked_at": null, "public_key": {"x": browser.public.x, "y": browser.public.y}},
        {"id": "browser-9", "kind": "browser", "revoked_at": "2026-10-01T00:00:00Z", "public_key": {"x": stranger.public.x, "y": stranger.public.y}},
        {"id": "mac", "kind": "native", "revoked_at": null},
        {"id": "browser-3", "kind": "browser", "revoked_at": null},
    ]);
    assert_eq!(browser_keys(&listed), keys);
    // A browser revoked since is no longer listed, so its approval is void.
    assert!(!holds(
        &call,
        &browser_keys(&json!([listed[1].clone()])),
        now
    ));
}

/// The digest the web client computes (`relay.ts`) is this one, byte for
/// byte: a vector both sides check.
#[test]
fn the_approval_digest_is_the_shared_vector() {
    assert_eq!(
        super::super::relay_approval::digest("resolve", r#"{"id":"PROJ-1","status":"done"}"#),
        "D-UvKPYRo3fvOfJUuyJFlvoCFIThcMC27D7XYTNKm28"
    );
}

#[test]
fn an_offer_carries_tools_as_the_web_reads_them_and_stays_bounded() {
    let mut huge = tool("huge", true);
    huge.input_schema = json!({"type": "object", "description": "x".repeat(20_000)});
    let mut rules = BTreeMap::new();
    rules.insert("drop".to_string(), "deny".to_string());
    let offered = offered_tools(&[tool("search", true), tool("drop", false), huge], &rules);
    assert_eq!(
        offered.as_array().unwrap().len(),
        2,
        "a denied tool is not offered"
    );
    assert_eq!(offered[0]["readOnly"], json!(true));
    assert_eq!(offered[0]["rule"], "allow");
    assert_eq!(
        offered[0]["inputSchema"]["properties"]["query"]["type"],
        "string"
    );
    assert_eq!(
        offered[1]["inputSchema"],
        json!({"type": "object", "properties": {}})
    );
    let many: Vec<ToolInfo> = (0..500).map(|n| tool(&format!("t{n}"), true)).collect();
    let offered = offered_tools(&many, &BTreeMap::new());
    assert!(offered.as_array().unwrap().len() <= super::super::agent::MAX_OFFERED);
    assert!(offered.to_string().len() <= MAX_TOOLS_BYTES);
}

#[test]
fn a_result_keeps_small_structured_content_for_the_brief() {
    let events = json!({"events": [{"title": "Stand-up", "start": "2026-10-08T09:00:00Z"}]});
    let kept = kept_result(&json!({
        "content": [{"type": "text", "text": "1 event"}],
        "structuredContent": events,
    }));
    assert_eq!(kept["text"], "1 event");
    assert_eq!(kept["structured"], events);
    let big =
        kept_result(&json!({"structuredContent": {"blob": "x".repeat(MAX_STRUCTURED_BYTES)}}));
    assert!(big.get("structured").is_none());
}

async fn store(device: &str) -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    query("UPDATE account_sync_control SET device_id=? WHERE id=1")
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn offers(pool: &SqlitePool) -> Vec<(String, String, String)> {
    query("SELECT id, connector_id, updated_at FROM connector_relays ORDER BY connector_id")
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|row| {
            (
                row.get("id"),
                row.get("connector_id"),
                row.get("updated_at"),
            )
        })
        .collect()
}

/// The offer follows the switch and the sign-in, and an unchanged offer is
/// not written again: one revision per change, not one per minute.
#[tokio::test]
async fn the_offer_follows_the_switch_and_the_sign_in() {
    let pool = store("mac").await;
    super::super::insert(&pool, &connector("sentry"))
        .await
        .unwrap();
    let mut other = connector("stripe");
    other.name = "Stripe".into();
    super::super::insert(&pool, &other).await.unwrap();
    super::super::set_tools(&pool, "sentry", &[tool("search", true)]).await;
    super::super::set_tools(&pool, "stripe", &[tool("charge", false)]).await;
    let only_sentry = |c: &Connector| c.id == "sentry";

    publish_with(&pool, false, only_sentry).await;
    assert!(offers(&pool).await.is_empty(), "off until switched on");

    publish_with(&pool, true, only_sentry).await;
    let first = offers(&pool).await;
    assert_eq!(first.len(), 1, "only what this device is signed in to");
    assert_eq!(first[0].0, offer_id("mac", "sentry"));

    publish_with(&pool, true, only_sentry).await;
    assert_eq!(
        offers(&pool).await,
        first,
        "nothing changed, nothing written"
    );

    publish_with(&pool, true, |_| true).await;
    assert_eq!(offers(&pool).await.len(), 2);

    publish_with(&pool, false, |_| true).await;
    assert!(offers(&pool).await.is_empty(), "switching off withdraws");
}

/// A call is handled once, even if its row comes back as requested.
#[tokio::test]
async fn a_call_is_claimed_once_and_never_again() {
    let pool = store("mac").await;
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO connector_errands(id,device_id,connector_id,tool,arguments,requested_at,updated_at) VALUES('e1','mac','sentry','search','{}',?,?)")
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO connector_errands(id,device_id,connector_id,tool,arguments,requested_at,updated_at) VALUES('e2','phone','sentry','search','{}',?,?)")
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    let mine = pending(&pool, "mac").await;
    assert_eq!(mine.len(), 1, "only what is addressed here");
    assert!(claim_once(&pool, "e1").await);
    assert!(!claim_once(&pool, "e1").await);
    assert!(pending(&pool, "mac").await.is_empty());
    settle(&pool, "e1", "done", Some(&json!({"text": "ok"})), None).await;
    let state: String =
        sqlx::query_scalar::query_scalar("SELECT state FROM connector_errands WHERE id='e1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state, "done");
}
