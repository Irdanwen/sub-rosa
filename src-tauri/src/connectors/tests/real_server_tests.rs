//! The client against real servers, ignored by default because they need
//! the network: `cargo test real_server -- --ignored --nocapture`.
//!
//! - Cloudflare's documentation server (in the catalog, no sign-in, its
//!   address read on developers.cloudflare.com) is driven through
//!   `initialize`, `tools/list` and one `tools/call` over Streamable HTTP,
//!   then through the same runtime a turn uses.
//! - Linear's and Notion's servers (in the catalog, OAuth) are taken only as
//!   far as discovery: the `401`, the protected resource metadata and the
//!   authorization server's metadata. Nothing is registered, nobody signs in.
//! - GitHub's remote server's metadata is read to confirm that its
//!   authorization server is GitHub's own OAuth, whose device-flow tokens the
//!   GitHub connector sends.

use super::*;

const CLOUDFLARE_DOCS: &str = "https://docs.mcp.cloudflare.com/mcp";

fn arguments(property: &str, query: &str) -> Value {
    let mut arguments = serde_json::Map::new();
    arguments.insert(property.to_string(), json!(query));
    Value::Object(arguments)
}

#[tokio::test]
#[ignore = "needs the network: a real MCP server"]
async fn real_server_cloudflare_docs_initializes_lists_and_answers_a_call() {
    let endpoint = mcp::validate_endpoint(CLOUDFLARE_DOCS).unwrap();
    let mut session = Session::open(&endpoint, None).await.expect("initialize");
    eprintln!(
        "initialize: server {} {} (session id: {:?})",
        session.server.name,
        session.server.version,
        session.session_id()
    );
    assert!(!session.server.name.is_empty());

    let listed = session.list_tools().await.expect("tools/list");
    let tools: Vec<mcp::ToolInfo> = listed.iter().filter_map(mcp::tool_info).collect();
    eprintln!(
        "tools/list: {:?}",
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>()
    );
    let search = tools
        .iter()
        .find(|tool| tool.name.contains("search"))
        .expect("a search tool");
    let property = search
        .input_schema
        .pointer("/properties")
        .and_then(Value::as_object)
        .and_then(|properties| properties.keys().next().cloned())
        .unwrap_or_else(|| "query".into());
    let result = session
        .call_tool(&search.name, &arguments(&property, "Workers KV"))
        .await
        .expect("tools/call");
    let text = mcp::result_text(&result, 400);
    eprintln!("tools/call {} -> {}", search.name, text.replace('\n', " "));
    assert!(!text.trim().is_empty());
    assert_ne!(result.get("isError"), Some(&json!(true)));
    session.close().await;

    // The same server through the runtime a turn uses.
    let pool = pool().await;
    let row = connector("cloudflare-real", CLOUDFLARE_DOCS, "none");
    insert(&pool, &row).await.unwrap();
    let listed = runtime::refresh_tools(&pool, &row)
        .await
        .expect("runtime list");
    assert_eq!(listed.len(), tools.len());
    let through = runtime::call_tool(
        &pool,
        &row,
        &search.name,
        &arguments(&property, "Durable Objects"),
    )
    .await
    .expect("runtime call");
    eprintln!(
        "runtime call -> {}",
        mcp::result_text(&through, 200).replace('\n', " ")
    );
}

async fn discovered(url: &str) -> oauth::AuthServer {
    let endpoint = mcp::validate_endpoint(url).unwrap();
    let Err(McpError::Unauthorized {
        resource_metadata,
        scope,
    }) = Session::open(&endpoint, None).await.map(|_| ())
    else {
        panic!("{url} should ask for a token");
    };
    eprintln!("{url}: 401 resource_metadata={resource_metadata:?} scope={scope:?}");
    let server = oauth::discover(&endpoint, resource_metadata.as_deref(), scope.as_deref())
        .await
        .expect("discovery");
    eprintln!(
        "{url}: issuer={} authorize={} token={} registration={:?} scopes={:?} resource={:?}",
        server.issuer,
        server.authorization_endpoint,
        server.token_endpoint,
        server.registration_endpoint,
        server.scopes,
        server.resource
    );
    server
}

#[tokio::test]
#[ignore = "needs the network: real OAuth metadata"]
async fn real_server_catalog_oauth_metadata_is_discovered() {
    for url in ["https://mcp.linear.app/mcp", "https://mcp.notion.com/mcp"] {
        let server = discovered(url).await;
        assert!(server.authorization_endpoint.starts_with("https://"));
        assert!(server.token_endpoint.starts_with("https://"));
        assert!(
            server.registration_endpoint.is_some(),
            "{url} is in the catalog because it registers clients by itself"
        );
        assert!(server.resource.is_some());
    }
}

/// Hugging Face answers without a token, so discovery starts from its
/// metadata rather than from a `401`.
#[tokio::test]
#[ignore = "needs the network: real OAuth metadata"]
async fn real_server_hugging_face_metadata_is_discovered_without_a_401() {
    let endpoint = mcp::validate_endpoint("https://huggingface.co/mcp").unwrap();
    let session = Session::open(&endpoint, None)
        .await
        .expect("anonymous initialize");
    session.close().await;
    let server = oauth::discover(&endpoint, None, None)
        .await
        .expect("discovery");
    eprintln!(
        "huggingface: issuer={} registration={:?} scopes={:?}",
        server.issuer, server.registration_endpoint, server.scopes
    );
    assert!(server.registration_endpoint.is_some());
}

#[tokio::test]
#[ignore = "needs the network: real OAuth metadata"]
async fn real_server_github_names_githubs_own_oauth() {
    let endpoint = mcp::validate_endpoint(github::MCP_URL).unwrap();
    let Err(McpError::Unauthorized {
        resource_metadata, ..
    }) = Session::open(&endpoint, None).await.map(|_| ())
    else {
        panic!("GitHub's server should ask for a token");
    };
    let metadata_url = resource_metadata.expect("resource_metadata");
    let metadata: Value = reqwest::get(&metadata_url)
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (issuers, scopes, resource) = oauth::parse_protected_resource(&metadata);
    eprintln!("github: issuers={issuers:?} scopes={scopes:?} resource={resource:?}");
    assert_eq!(issuers, ["https://github.com/login/oauth"]);
    assert!(scopes.iter().any(|scope| scope == "repo"));
}
