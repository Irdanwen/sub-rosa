//! A connector, in use: a token that is fresh, a session that opens, a call
//! that comes back. A `401` triggers one refresh and one retry; a second one
//! marks the connector as needing a sign-in rather than failing in a loop.

use serde_json::Value;
use sqlx_sqlite::SqlitePool;

use super::mcp::{McpError, Session, ToolInfo};
use super::{builtin, oauth, set_status, set_tools, tokens, Connector};
use crate::domain::types::AppError;
use crate::redacted::Redacted;

/// The credential to send, refreshed first when it is about to expire.
pub async fn bearer(connector: &Connector) -> Result<Option<Redacted<String>>, AppError> {
    match connector.auth.as_str() {
        "none" => Ok(None),
        "token" => tokens::get(&tokens::tokens_slot(&connector.id))?
            .map(Some)
            .ok_or_else(|| super::error("connector_token_missing")),
        _ => {
            let Some(current) = oauth::load_tokens(&connector.id)? else {
                return Err(McpError::Unauthorized {
                    resource_metadata: None,
                    scope: None,
                }
                .into_app());
            };
            if current.expiring(chrono::Utc::now().timestamp()) && current.refresh_token.is_some() {
                let fresh = oauth::refresh(&current).await?;
                oauth::save_tokens(&connector.id, &fresh)?;
                return Ok(Some(fresh.access_token));
            }
            Ok(Some(current.access_token))
        }
    }
}

/// Trades the refresh token for a new access token after a `401`. False when
/// there is nothing to refresh or the server refused.
async fn refresh_after_401(connector: &Connector) -> bool {
    if !matches!(connector.auth.as_str(), "oauth" | "google" | "microsoft") {
        return false;
    }
    let Ok(Some(current)) = oauth::load_tokens(&connector.id) else {
        return false;
    };
    match oauth::refresh(&current).await {
        Ok(fresh) => oauth::save_tokens(&connector.id, &fresh).is_ok(),
        Err(_) => false,
    }
}

async fn open(connector: &Connector) -> Result<Session, McpError> {
    let endpoint = super::mcp::validate_endpoint(&connector.url)
        .map_err(|_| McpError::Invalid("address".into()))?;
    let bearer = bearer(connector)
        .await
        .map_err(|failure| match failure.code.as_str() {
            "connector_sign_in" | "connector_token_missing" => McpError::Unauthorized {
                resource_metadata: None,
                scope: None,
            },
            _ => McpError::Network(failure.code),
        })?;
    Session::open(&endpoint, bearer).await
}

/// Runs `work` on a fresh session, once more after a refresh when the server
/// says the token is no longer good. The session is closed either way.
macro_rules! with_session {
    ($pool:expr, $connector:expr, |$session:ident| $work:expr) => {{
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = match open($connector).await {
                Ok(mut $session) => {
                    let result = $work;
                    $session.close().await;
                    result
                }
                Err(error) => Err(error),
            };
            match outcome {
                Err(McpError::Unauthorized { .. }) if attempt == 1 => {
                    if refresh_after_401($connector).await {
                        continue;
                    }
                    set_status(
                        $pool,
                        &$connector.id,
                        "needs_sign_in",
                        Some(&crate::tr!("Sign in again to keep using this connector.")),
                    )
                    .await;
                    break Err(McpError::Unauthorized {
                        resource_metadata: None,
                        scope: None,
                    }
                    .into_app());
                }
                Err(McpError::Unauthorized { .. }) => {
                    set_status(
                        $pool,
                        &$connector.id,
                        "needs_sign_in",
                        Some(&crate::tr!("Sign in again to keep using this connector.")),
                    )
                    .await;
                    break Err(McpError::Unauthorized {
                        resource_metadata: None,
                        scope: None,
                    }
                    .into_app());
                }
                Err(McpError::SessionExpired) if attempt == 1 => continue,
                Err(error) => break Err(error.into_app()),
                Ok(value) => break Ok(value),
            }
        }
    }};
}

/// Lists the server's tools and keeps them for the next turn.
pub async fn refresh_tools(
    pool: &SqlitePool,
    connector: &Connector,
) -> Result<Vec<ToolInfo>, AppError> {
    if connector.builtin() {
        let tools = builtin::tools_for(&connector.auth);
        set_tools(pool, &connector.id, &tools).await;
        return Ok(tools);
    }
    let listed: Result<Vec<Value>, AppError> =
        with_session!(pool, connector, |session| session.list_tools().await);
    match listed {
        Ok(listed) => {
            let tools: Vec<ToolInfo> = listed.iter().filter_map(super::mcp::tool_info).collect();
            set_tools(pool, &connector.id, &tools).await;
            Ok(tools)
        }
        Err(failure) => {
            if failure.code != "connector_sign_in" {
                set_status(pool, &connector.id, "error", Some(&failure.message)).await;
            }
            Err(failure)
        }
    }
}

pub async fn call_tool(
    pool: &SqlitePool,
    connector: &Connector,
    tool: &str,
    arguments: &Value,
) -> Result<Value, AppError> {
    if connector.builtin() {
        return builtin::call(connector, tool, arguments).await;
    }
    with_session!(pool, connector, |session| session
        .call_tool(tool, arguments)
        .await)
}

pub async fn read_resource(
    pool: &SqlitePool,
    connector: &Connector,
    uri: &str,
) -> Result<Value, AppError> {
    with_session!(pool, connector, |session| session.read_resource(uri).await)
}

pub enum SignIn {
    /// The server needs no sign-in, or the token in the keychain still works.
    Connected,
    /// The browser has to open this page.
    Browser(String),
}

/// Starts a sign-in: probes the server, discovers how it signs in, registers
/// the app if it has to, and stores the pending flow before the browser opens.
pub async fn begin_sign_in(pool: &SqlitePool, connector: &Connector) -> Result<SignIn, AppError> {
    if let Some(provider) = builtin::provider(&connector.auth) {
        return provider.begin(&connector.id).map(SignIn::Browser);
    }
    match connector.auth.as_str() {
        "none" => return Ok(SignIn::Connected),
        "token" => {
            return if super::has_credential(connector) {
                Ok(SignIn::Connected)
            } else {
                Err(super::error("connector_token_missing"))
            }
        }
        _ => {}
    }
    let endpoint = super::mcp::validate_endpoint(&connector.url)?;
    let (metadata, scope) = match Session::open(&endpoint, None).await {
        // It answers without a token, but it was added to be signed in to:
        // Hugging Face, for one, serves a public subset anonymously and the
        // person's own account after a sign-in. Its metadata says how; a
        // server that publishes none is refused below, and the person adds
        // it with "No sign-in" instead.
        Ok(session) => {
            session.close().await;
            (None, None)
        }
        Err(McpError::Unauthorized {
            resource_metadata,
            scope,
        }) => (resource_metadata, scope),
        Err(error) => return Err(error.into_app()),
    };
    let server = oauth::discover(&endpoint, metadata.as_deref(), scope.as_deref()).await?;
    // A client registered earlier with the same issuer and callback is
    // reused: registering on every sign-in fills the server with copies.
    let local = super::state(pool, &connector.id).await;
    let known = local.oauth_client.as_ref().and_then(|client| {
        let same = client.get("issuer").and_then(Value::as_str) == Some(server.issuer.as_str())
            && client.get("redirectUri").and_then(Value::as_str) == Some(oauth::REDIRECT_URI);
        same.then(|| {
            client
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .flatten()
    });
    let client_id = match known {
        Some(id) => id,
        None => {
            let id = oauth::register(&server, oauth::REDIRECT_URI).await?;
            super::set_oauth_client(
                pool,
                &connector.id,
                &serde_json::json!({
                    "issuer": server.issuer,
                    "clientId": id,
                    "redirectUri": oauth::REDIRECT_URI,
                }),
            )
            .await;
            id
        }
    };
    let pkce = oauth::pkce();
    let state = oauth::random_state();
    oauth::store_pending(
        &state,
        &oauth::PendingFlow::new(
            &connector.id,
            &pkce.verifier,
            &server.token_endpoint,
            &client_id,
            oauth::REDIRECT_URI,
            server.resource.as_deref(),
        )
        .with_issuer(&server),
    )?;
    oauth::authorize_url(&oauth::AuthorizeRequest {
        authorization_endpoint: &server.authorization_endpoint,
        client_id: &client_id,
        redirect_uri: oauth::REDIRECT_URI,
        challenge: &pkce.challenge,
        state: &state,
        scopes: &server.scopes,
        resource: server.resource.as_deref(),
        extra: &[],
    })
    .map(SignIn::Browser)
}
