//! The web client's connectors and skill packs, as Rust says them (ADR-0092,
//! see `mod.rs`). The browser speaks MCP itself, so what it needs from here is
//! the catalog, the words the model reads, the bounds, and test vectors for
//! every pure rule it ports (naming, results, the trigger's look, a view's
//! document), so the two implementations cannot drift unseen.

use serde_json::{json, Value};

use crate::connectors::mcp::{self, ToolInfo};
use crate::connectors::{
    agent, apps, catalog, oauth, policy, relay, research, slug, triggers, Connector,
};
use crate::skill_packs::{agent as skills, SkillPack};

fn connector(id: &str, name: &str, auth: &str) -> Connector {
    Connector {
        id: id.into(),
        name: name.into(),
        url: "https://mcp.example.invalid/mcp".into(),
        catalog_id: String::new(),
        auth: auth.into(),
        enabled: true,
        tool_policy: Default::default(),
    }
}

fn tool(name: &str, description: &str, read_only: bool, schema: Value) -> ToolInfo {
    ToolInfo {
        name: name.into(),
        title: None,
        description: description.into(),
        input_schema: schema,
        read_only,
        destructive: !read_only,
        ui_resource: None,
    }
}

fn pack(name: &str, description: &str, body: &str, tools: &[&str]) -> SkillPack {
    SkillPack {
        id: name.into(),
        name: name.into(),
        description: description.into(),
        body: body.into(),
        tools: tools.iter().map(|tool| tool.to_string()).collect(),
        enabled: true,
        updated_at: String::new(),
    }
}

fn function_names() -> Value {
    let cases = [
        ("notion", "Notion", "oauth", "search"),
        ("notion", "Notion", "oauth", "create.page"),
        ("My Server-ab12cd", "My server", "token", "__odd name__"),
        ("linear", "Linear", "oauth", &"x".repeat(80)),
        ("Été déjà vu", "Été", "none", "list-items"),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(id, name, auth, tool)| {
                json!({
                    "id": id, "auth": auth, "tool": tool,
                    "name": agent::function_name(&connector(id, name, auth), tool),
                })
            })
            .collect(),
    )
}

fn slugs() -> Value {
    let cases = [
        "notion",
        "My Server-ab12cd",
        "  leading  and trailing  ",
        "UPPER_case__x",
        "Été déjà vu",
        "a-very-long-connector-identifier-indeed",
        "!!!",
        "",
    ];
    Value::Array(
        cases
            .iter()
            .map(|raw| json!({"raw": raw, "slug": slug(raw)}))
            .collect(),
    )
}

fn results() -> Value {
    let cases = [
        (
            json!({"content": [{"type": "text", "text": "Hello"}, {"type": "image", "data": "x"}]}),
            100,
        ),
        (
            json!({"content": [{"type": "resource_link", "name": "Doc", "uri": "https://a.example/doc"},
                {"type": "resource", "resource": {"uri": "ui://view", "text": "<p>v</p>"}},
                {"type": "resource", "resource": {"uri": "file://x", "text": "inside"}},
                {"type": "audio", "data": "x"}]}),
            100,
        ),
        (json!({"structuredContent": {"items": [1, 2]}}), 100),
        (
            json!({"isError": true, "content": [{"type": "text", "text": "boom"}]}),
            100,
        ),
        (json!({}), 100),
        (
            json!({"content": [{"type": "text", "text": "abcdefghijklmnopqrstuvwxyz"}]}),
            10,
        ),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(result, limit)| {
                json!({
                    "result": result, "limit": limit,
                    "text": mcp::result_text(result, *limit),
                    "links": mcp::result_links(result)
                        .into_iter()
                        .map(|(title, url)| json!({"title": title, "url": url}))
                        .collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn tool_infos() -> Value {
    let cases = [
        json!({"name": "search", "description": "Find", "annotations": {"readOnlyHint": true, "title": "Search"},
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}}),
        json!({"name": "delete", "annotations": {"destructiveHint": false}}),
        json!({"name": "show", "_meta": {"ui": {"resourceUri": "ui://widget/show"}}}),
        json!({"name": "legacy", "_meta": {"openai/outputTemplate": "ui://widget/legacy.html"}}),
        json!({"name": "  ", "description": "no name"}),
        json!({"name": "bad", "inputSchema": "not an object"}),
    ];
    Value::Array(
        cases
            .iter()
            .map(|value| json!({"value": value, "info": mcp::tool_info(value)}))
            .collect(),
    )
}

fn trigger_row(seen: &[&str], armed: bool) -> triggers::TriggerRow {
    triggers::TriggerRow {
        id: "t".into(),
        assignment_id: "a".into(),
        connector_id: "c".into(),
        kind: "tool_poll".into(),
        config: json!({}),
        seen: seen.iter().map(|id| id.to_string()).collect(),
        armed,
        last_checked_at: None,
        last_error: None,
    }
}

fn item(id: &str) -> triggers::Item {
    triggers::Item {
        id: id.into(),
        title: format!("Item {id}"),
    }
}

fn decisions() -> Value {
    let current: Vec<triggers::Item> = ["1", "2", "3", "4", "5"]
        .iter()
        .map(|id| item(id))
        .collect();
    let cases = [
        (trigger_row(&[], false), current.clone()),
        (trigger_row(&["1", "2"], true), current.clone()),
        (trigger_row(&["1"], true), current.clone()),
        (
            trigger_row(&["1", "2", "3", "4", "5"], true),
            current.clone(),
        ),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(row, current)| {
                let decision = triggers::decide(row, current);
                json!({
                    "seen": row.seen, "armed": row.armed,
                    "current": current.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
                    "fire": decision.fire.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
                    "nextSeen": decision.seen,
                })
            })
            .collect(),
    )
}

fn trigger_items() -> Value {
    let cases = [
        json!({"structuredContent": {"issues": [{"id": 7, "title": "Bug"}, {"key": "K-1", "name": "Task"}]}}),
        json!({"content": [{"type": "resource_link", "name": "Doc", "uri": "https://a.example/1"}]}),
        json!({"content": [{"type": "text", "text": "[{\"identifier\": \"L-2\", \"summary\": \"Ticket\"}]"}]}),
        json!({"content": [{"type": "text", "text": "plain"}]}),
    ];
    Value::Array(
        cases
            .iter()
            .map(|result| {
                json!({
                    "result": result,
                    "items": triggers::items_from_result(result)
                        .into_iter()
                        .map(|item| json!({"id": item.id, "title": item.title}))
                        .collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn describes() -> Value {
    let mut out = serde_json::Map::new();
    for kind in triggers::KINDS {
        let mut row = trigger_row(&[], true);
        row.kind = kind.to_string();
        let item = triggers::Item {
            id: "{id}".into(),
            title: "{title}".into(),
        };
        out.insert(
            kind.to_string(),
            json!(triggers::describe(&row, "{connector}", &item)),
        );
    }
    Value::Object(out)
}

fn search_tools() -> Value {
    let query = json!({"type": "object", "properties": {"query": {"type": "string"}}});
    let q = json!({"type": "object", "properties": {"q": {"type": "string"}}});
    let none = json!({"type": "object", "properties": {"limit": {"type": "number"}}});
    let tools = vec![
        tool("create_issue", "", false, query.clone()),
        tool("list_projects", "", true, query.clone()),
        tool("find_pages", "", true, none.clone()),
        tool("search_docs", "", true, q.clone()),
        tool("search", "", true, query.clone()),
    ];
    let mut denied = std::collections::BTreeMap::new();
    denied.insert("search_docs".to_string(), "deny".to_string());
    let rules = [std::collections::BTreeMap::new(), denied];
    Value::Array(
        rules
            .iter()
            .map(|rules| {
                let found = research::search_tool(&tools, rules)
                    .map(|(tool, field)| json!({"tool": tool.name, "field": field}));
                json!({"rules": rules, "found": found})
            })
            .collect(),
    )
}

fn documents() -> Value {
    let input = json!({"q": "</script><b>"});
    let output = json!({"text": "a\u{2028}b & c"});
    Value::Array(
        [
            "<html><head><title>V</title></head><body>v</body></html>",
            "<p>no head</p>",
        ]
        .iter()
        .map(|html| {
            json!({
                "html": html, "toolInput": input, "toolOutput": output, "theme": "dark",
                "document": apps::document(html, &input, &output, "dark"),
            })
        })
        .collect(),
    )
}

fn export() -> Value {
    let ask = agent::declaration(
        &connector("c", "{connector}", "oauth"),
        &tool("t", "{description}", false, json!({"type": "object"})),
        "c__t",
        policy::Rule::Ask,
    );
    let allow = agent::declaration(
        &connector("c", "{connector}", "oauth"),
        &tool("t", "{description}", true, json!({"type": "object"})),
        "c__t",
        policy::Rule::Allow,
    );
    let offered = skills::plan(&[pack("{name}", "{description}", "", &[])], "");
    let picked = skills::plan(
        &[pack("{name}", "{description}", "{body}", &["search_notes"])],
        "/{name} go",
    );
    let mut loader = Vec::new();
    skills::SkillTurn {
        offer_loader: true,
        ..Default::default()
    }
    .apply(&mut loader);
    json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/connectors.rs",
        "catalog": catalog::CATALOG,
        "protocolVersion": mcp::PROTOCOL_VERSION,
        "limits": {
            "requestSeconds": mcp::REQUEST_TIMEOUT.as_secs(),
            "maxBodyBytes": mcp::MAX_BODY_BYTES,
            "maxTools": mcp::MAX_TOOLS,
            "maxOffered": agent::MAX_OFFERED,
            "maxSchemaBytes": agent::MAX_SCHEMA_BYTES,
            "resultChars": agent::RESULT_CHARS,
            "pendingSignInSeconds": oauth::PENDING_TTL_SECS,
            "triggerCheckSeconds": triggers::CHECK_EVERY_SECS,
            "triggerMaxSeen": triggers::MAX_SEEN,
            "triggerMaxFires": triggers::MAX_FIRES_PER_CHECK,
            "researchExcerptChars": research::EXCERPT_CHARS,
            "researchMaxConnectors": research::MAX_CONNECTORS,
            "appMaxHtmlBytes": apps::MAX_HTML_BYTES,
            "appMaxOutputBytes": apps::MAX_OUTPUT_BYTES,
        },
        "promptNote": agent::PROMPT_NOTE,
        "declaration": {
            "description": allow.pointer("/function/description"),
            "askDescription": ask.pointer("/function/description"),
        },
        "sentences": {
            "notOffered": agent::NOT_OFFERED,
            "removed": agent::REMOVED,
            "turnedOff": agent::TURNED_OFF,
            "awaitsConfirmation": agent::AWAITS_CONFIRMATION,
            "resultFrom": agent::result_from("{connector}", "{result}"),
            "couldNot": agent::could_not("{connector}", "{reason}"),
        },
        "triggerDescriptions": describes(),
        "app": {
            "csp": apps::csp_for("https://origin.invalid"),
            "cspMarker": "https://origin.invalid",
            "bridge": apps::BRIDGE,
        },
        "skills": {
            "offeredPrompt": offered.prompt,
            "pickedPrompt": picked.prompt,
            "loadSkill": loader.first(),
            "missing": skills::missing("{name}"),
            "unreadable": skills::UNREADABLE,
            "maxOffered": skills::MAX_OFFERED,
            "maxBodyChars": crate::skill_packs::MAX_BODY_CHARS,
        },
        "vectors": {
            "functionNames": function_names(),
            "slugs": slugs(),
            "results": results(),
            "toolInfos": tool_infos(),
            "decisions": decisions(),
            "triggerItems": trigger_items(),
            "searchTools": search_tools(),
            "documents": documents(),
        },
        "relay": {
            "waitSeconds": relay::WAIT_SECS,
            "expirySeconds": relay::EXPIRY_SECS,
            "maxArgumentBytes": relay::MAX_ARGUMENT_BYTES,
            "sentences": {
                "notAccepting": relay::NOT_ACCEPTING,
                "tooLate": relay::TOO_LATE,
                "notSignedIn": relay::NOT_SIGNED_IN,
                "needsApproval": relay::NEEDS_APPROVAL,
                "tooLarge": relay::TOO_LARGE,
                "clockAhead": relay::CLOCK_AHEAD,
                "badArguments": relay::BAD_ARGUMENTS,
                "noAnswer": relay::NO_ANSWER,
            },
            "approval": {
                "type": crate::connectors::relay_approval::APPROVAL_TYPE,
                "vector": {
                    "tool": "resolve",
                    "arguments": r#"{"id":"PROJ-1","status":"done"}"#,
                    "digest": crate::connectors::relay_approval::digest("resolve", r#"{"id":"PROJ-1","status":"done"}"#),
                },
            },
            "offerIds": [
                {"device": "mac", "connector": "sentry", "id": relay::offer_id("mac", "sentry")},
                {"device": "0191d1a4-0000-7000-8000-00000000d001", "connector": "google-ab12", "id": relay::offer_id("0191d1a4-0000-7000-8000-00000000d001", "google-ab12")},
            ],
        },
        "tables": super::tables(&[
            "connectors",
            "skill_packs",
            "connector_relays",
            "connector_errands",
        ]),
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("connectors", export());
}
