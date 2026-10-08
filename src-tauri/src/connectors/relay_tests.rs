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
