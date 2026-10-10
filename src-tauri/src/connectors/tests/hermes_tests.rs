//! The computer's agent runtime reaches the connectors through the app: the
//! same tools the phones get, the person's rules read here, and an "ask"
//! that runs only when the guard ledger made the runtime ask.

use super::*;

async fn tracker(pool: &SqlitePool, base: &str, id: &str) -> Connector {
    let mut row = connector(id, &format!("{base}/mcp"), "none");
    row.tool_policy.insert("show_board".into(), "deny".into());
    insert(pool, &row).await.unwrap();
    runtime::refresh_tools(pool, &row).await.unwrap();
    row
}

#[test]
fn runtime_names_follow_the_runtimes_own_sanitising() {
    assert_eq!(
        hermes::hermes_name("tracker__create_issue"),
        "mcp__subrosa_connectors__tracker__create_issue"
    );
    assert_eq!(
        hermes::hermes_name("cloudflare_docs__search-docs"),
        "mcp__subrosa_connectors__cloudflare_docs__search_docs"
    );
}

#[tokio::test]
async fn the_runtime_lists_what_the_phones_offer_and_the_ledger_holds_each_rule() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    let row = tracker(&pool, &base, "hermes-list").await;

    let listing = hermes::listing(&pool).await;
    let names: Vec<&str> = listing["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names, ["hermes_list__search", "hermes_list__create_issue"]);
    assert!(listing["fingerprint"]
        .as_str()
        .unwrap()
        .contains("hermes_list__create_issue=ask"));

    let rules = hermes::ledger_rules(&pool).await;
    let rule = |tool: &str| rules[&hermes::hermes_name(&format!("hermes_list__{tool}"))].clone();
    assert_eq!(rule("search")["rule"], "allow");
    assert_eq!(rule("show_board")["rule"], "deny");
    assert_eq!(rule("create_issue")["rule"], "ask");
    assert!(rule("create_issue")["message"]
        .as_str()
        .unwrap()
        .contains("Tracker"));

    // Turned off, a connector leaves the runtime's list and its ledger.
    sqlx::query::query("UPDATE connectors SET enabled=0 WHERE id=?")
        .bind(&row.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(hermes::listing(&pool).await["tools"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(hermes::ledger_rules(&pool).await.is_empty());
}

#[tokio::test]
async fn a_runtime_call_follows_the_rule_in_force_and_is_filed() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    tracker(&pool, &base, "hermes-call").await;

    let run = |name: &'static str, published: Option<&'static str>| {
        let pool = pool.clone();
        async move {
            hermes::route(
                &pool,
                json!({"op": "call", "name": name, "arguments": {"query": "bugs"}})
                    .to_string()
                    .as_bytes(),
                move |_| published.map(str::to_string),
            )
            .await
        }
    };

    // Allowed: it runs.
    let (status, result) = run("hermes_call__search", Some("allow")).await;
    assert_eq!(status, 200);
    assert_eq!(result["isError"], false);
    assert!(mcp::result_text(&result, 400).contains("search found bugs"));
    assert!(mcp::result_text(&result, 400).contains("https://tracker.example.com/7"));

    // Off: refused whatever the ledger said.
    let (_, refused) = run("hermes_call__show_board", Some("allow")).await;
    assert_eq!(refused["isError"], true);
    assert!(mcp::result_text(&refused, 400).contains("turned off"));

    // Asks first, and the ledger the runtime read said so: the runtime asked.
    let (_, asked) = run("hermes_call__create_issue", Some("ask")).await;
    assert_eq!(asked["isError"], false);
    // A tool missing from the ledger was asked about too (the plugin's default).
    let (_, unknown) = run("hermes_call__create_issue", None).await;
    assert_eq!(unknown["isError"], false);
    // But a ledger that still said "allow" means nobody was asked.
    let (_, stale) = run("hermes_call__create_issue", Some("allow")).await;
    assert_eq!(stale["isError"], true);
    assert!(mcp::result_text(&stale, 400).contains("confirmation"));

    // A name that is no connector's.
    let (_, gone) = run("nobody__search", Some("allow")).await;
    assert_eq!(gone["isError"], true);

    let filed: Vec<String> = sqlx::query::query(
        "SELECT status FROM connector_calls WHERE task_id='hermes' ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| sqlx::row::Row::get(row, "status"))
    .collect();
    assert_eq!(
        filed,
        ["done", "done", "done"],
        "every call that ran is filed"
    );

    let (status, _) = hermes::route(&pool, b"{\"op\":\"other\"}", |_| None).await;
    assert_eq!(status, 404);
    let (status, _) = hermes::route(&pool, b"not json", |_| None).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn a_removed_connector_leaves_nothing_in_the_runtime() {
    let (base, _) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    tracker(&pool, &base, "hermes-gone").await;
    assert!(!hermes::listing(&pool).await["tools"]
        .as_array()
        .unwrap()
        .is_empty());
    remove_rows(&pool, "hermes-gone").await.unwrap();
    assert!(hermes::listing(&pool).await["tools"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(hermes::ledger_rules(&pool).await.is_empty());
    let (_, gone) = hermes::route(
        &pool,
        br#"{"op":"call","name":"hermes_gone__search","arguments":{}}"#,
        |_| Some("allow".into()),
    )
    .await;
    assert_eq!(gone["isError"], true);
}

/// The runtime's side of it: the MCP script the app installs, run by a real
/// Python over stdio, listing and calling through a mock of the proxy route.
#[tokio::test(flavor = "multi_thread")]
async fn the_installed_script_lists_and_calls_through_the_proxy_route() {
    use std::io::{BufRead as _, Write as _};
    if !crate::test_python::python3_available("the script's own test") {
        return;
    }
    let (base, log) = serve(|_, request| {
        assert_eq!(request.path, "/v1/connectors");
        assert_eq!(request.header("authorization"), Some("Bearer proxy-tok"));
        match request.json()["op"].as_str() {
            Some("list") => json_resp(json!({
                "tools": [{"name": "linear__search", "description": "[Linear] Search.", "inputSchema": {"type": "object"}}],
                "fingerprint": "linear__search=allow",
            })),
            _ => json_resp(json!({
                "content": [{"type": "text", "text": format!("ran {}", request.json()["name"])}],
                "isError": false,
            })),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("subrosa_connectors_mcp.py");
    std::fs::write(
        &script,
        include_str!("../../hermes/subrosa_connectors_mcp.py"),
    )
    .unwrap();
    let coordinates = dir.path().join("june_web_proxy.json");
    std::fs::write(
        &coordinates,
        json!({"base_url": format!("{base}/v1"), "token": "proxy-tok"}).to_string(),
    )
    .unwrap();
    let lines = tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new("python3")
            .arg(&script)
            .arg(&coordinates)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut answers = Vec::new();
        for message in [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "linear__search", "arguments": {"query": "x"}}}),
        ] {
            writeln!(stdin, "{message}").unwrap();
            stdin.flush().unwrap();
            if message.get("id").is_some() {
                let mut line = String::new();
                stdout.read_line(&mut line).unwrap();
                answers.push(serde_json::from_str::<Value>(&line).unwrap());
            }
        }
        drop(stdin);
        let _ = child.wait();
        answers
    })
    .await
    .unwrap();
    assert_eq!(
        lines[0]["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    assert_eq!(lines[1]["result"]["tools"][0]["name"], "linear__search");
    assert_eq!(
        lines[2]["result"]["content"][0]["text"],
        "ran \"linear__search\""
    );
    let calls: Vec<Value> = log.lock().unwrap().iter().map(Req::json).collect();
    assert_eq!(calls[0]["op"], "list");
    assert_eq!(calls[1]["op"], "call");
    assert_eq!(calls[1]["arguments"]["query"], "x");
}
