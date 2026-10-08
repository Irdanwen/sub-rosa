//! A Model Context Protocol client over Streamable HTTP, for the shells that
//! cannot run Hermes's own (ADR-0092).
//!
//! The transport is the one the protocol now defines for remote servers: every
//! client message is a JSON-RPC `POST` to one endpoint, and the server answers
//! with plain JSON or with a short event stream that carries the response
//! among notifications. The server may hand out a session id at `initialize`;
//! every later request echoes it, and a `404` on it means the session is gone.
//!
//! Bounded on purpose: one request may take a minute and read at most four
//! megabytes, a tool list stops at two hundred tools, and nothing here logs a
//! header or a body. A `401` is not an error to show; it is the start of the
//! sign-in, and it carries where to begin (`resource_metadata`, RFC 9728).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::domain::types::AppError;
use crate::redacted::Redacted;
use crate::sse_lines::SseLines;

/// The protocol revision this client speaks. A server that answers with an
/// older one is followed: the subset used here did not change.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The most one response may weigh. A tool that returns more is refused
/// rather than buffered: the model could not read it anyway.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TOOLS: usize = 200;
const MAX_PAGES: usize = 10;
/// Notifications kept from a stream while waiting for a response.
const MAX_NOTIFICATIONS: usize = 64;

#[derive(Debug, PartialEq)]
pub enum McpError {
    /// The server wants a token, or a better one. Carries the protected
    /// resource metadata address and the scope it named, when it did.
    Unauthorized {
        resource_metadata: Option<String>,
        scope: Option<String>,
    },
    /// A session id the server no longer knows.
    SessionExpired,
    Status(u16),
    Rpc {
        code: i64,
        message: String,
    },
    TooLarge,
    Invalid(String),
    Network(String),
}

impl McpError {
    /// What a person reads. Never the server's body: it is not ours to show.
    pub fn into_app(self) -> AppError {
        match self {
            McpError::Unauthorized { .. } => AppError::new(
                "connector_sign_in",
                "This connector needs you to sign in again.",
            ),
            McpError::SessionExpired => AppError::new(
                "connector_session",
                "The connector closed the session. Try again.",
            ),
            McpError::Status(status) => AppError::new(
                "connector_status",
                crate::tr!(
                    "The connector answered with status {status}.",
                    status = status
                ),
            ),
            McpError::Rpc { message, .. } => AppError::new(
                "connector_refused",
                crate::tr!(
                    "The connector refused: {reason}",
                    reason = message.chars().take(300).collect::<String>()
                ),
            ),
            McpError::TooLarge => AppError::new(
                "connector_too_large",
                "The connector sent back more than Sub Rosa can read at once.",
            ),
            McpError::Invalid(_) => AppError::new(
                "connector_invalid",
                "The connector answered in a way Sub Rosa does not understand.",
            ),
            McpError::Network(_) => AppError::new(
                "connector_unreachable",
                "The connector could not be reached. Check your connection.",
            ),
        }
    }
}

/// An address a connector may live at: https anywhere, plain http only on
/// this machine (a developer's local server), no credentials in the URL.
pub fn validate_endpoint(raw: &str) -> Result<reqwest::Url, AppError> {
    let invalid = || {
        AppError::new(
            "connector_url_invalid",
            "Use the connector's full https address.",
        )
    };
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| invalid())?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let scheme_ok = url.scheme() == "https" || (loopback && url.scheme() == "http");
    if !scheme_ok
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || raw.len() > 2048
    {
        return Err(invalid());
    }
    Ok(url)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::http_client::build(
            crate::http_client::credentialed(REQUEST_TIMEOUT),
            "connectors",
        )
    })
}

/// One line for the egress ledger (ADR-0043): the shape, never the content.
pub(crate) fn ledger(
    url: &reqwest::Url,
    method: &str,
    sent: usize,
    received: usize,
    status: Option<u16>,
    started: Instant,
) {
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: url.host_str().unwrap_or_default().to_string(),
        purpose: crate::egress_ledger::current_context()
            .map(|context| context.purpose.to_string())
            .unwrap_or_else(|| "connector".to_string()),
        method: method.to_string(),
        request_bytes: sent as u64,
        response_bytes: received as u64,
        status,
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
}

/// `resource_metadata` and `scope` from a `WWW-Authenticate: Bearer …` header.
pub fn parse_www_authenticate(header: &str) -> (Option<String>, Option<String>) {
    let mut metadata = None;
    let mut scope = None;
    let rest = header.trim();
    let rest = rest
        .strip_prefix("Bearer")
        .or_else(|| rest.strip_prefix("bearer"))
        .unwrap_or(rest);
    for part in split_params(rest) {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_string();
        match key.trim().to_ascii_lowercase().as_str() {
            "resource_metadata" if !value.is_empty() => metadata = Some(value),
            "scope" if !value.is_empty() => scope = Some(value),
            _ => {}
        }
    }
    (metadata, scope)
}

/// Splits `a="x, y", b=z` on the commas outside quotes.
fn split_params(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in input.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ',' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

/// Server-sent events assembled from chunks: the `data:` lines of each event,
/// joined, handed back once the blank line that ends the event arrives.
#[derive(Default)]
pub struct SseEvents {
    lines: SseLines,
    data: Vec<String>,
}

impl SseEvents {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let lines = self.lines.push(chunk);
        self.take(lines)
    }

    pub fn finish(&mut self) -> Vec<String> {
        let mut lines: Vec<String> = self.lines.finish().into_iter().collect();
        lines.push(String::new());
        self.take(lines)
    }

    fn take(&mut self, lines: Vec<String>) -> Vec<String> {
        let mut events = Vec::new();
        for line in lines {
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
            // `event:`, `id:`, `retry:` and comments carry nothing this
            // client acts on.
        }
        events
    }
}

/// The response to request `id` in one JSON-RPC message (or batch), if it is
/// there.
pub fn rpc_outcome(message: &Value, id: u64) -> Option<Result<Value, McpError>> {
    if let Some(batch) = message.as_array() {
        return batch.iter().find_map(|entry| rpc_outcome(entry, id));
    }
    if message.get("id").and_then(Value::as_u64) != Some(id) || message.get("method").is_some() {
        return None;
    }
    if let Some(error) = message.get("error") {
        return Some(Err(McpError::Rpc {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string(),
        }));
    }
    Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
}

#[derive(Debug, Clone, Default)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub capabilities: Value,
}

/// One conversation with a server.
pub struct Session {
    endpoint: reqwest::Url,
    bearer: Option<Redacted<String>>,
    session_id: Option<String>,
    protocol: String,
    next_id: u64,
    pub server: ServerInfo,
    /// Notifications that arrived on a response stream, newest last.
    pub notifications: Vec<Value>,
}

impl Session {
    /// `initialize`, then `notifications/initialized`.
    pub async fn open(
        endpoint: &reqwest::Url,
        bearer: Option<Redacted<String>>,
    ) -> Result<Self, McpError> {
        let mut session = Self {
            endpoint: endpoint.clone(),
            bearer,
            session_id: None,
            protocol: PROTOCOL_VERSION.to_string(),
            next_id: 1,
            server: ServerInfo::default(),
            notifications: Vec::new(),
        };
        let result = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": crate::carpe_diem::branding::PRODUCT_NAME,
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            )
            .await?;
        if let Some(version) = result.get("protocolVersion").and_then(Value::as_str) {
            session.protocol = version.chars().take(32).collect();
        }
        session.server = ServerInfo {
            name: result
                .pointer("/serverInfo/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(120)
                .collect(),
            version: result
                .pointer("/serverInfo/version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(40)
                .collect(),
            capabilities: result.get("capabilities").cloned().unwrap_or(Value::Null),
        };
        session
            .notify("notifications/initialized", json!({}))
            .await?;
        Ok(session)
    }

    pub fn supports_subscribe(&self) -> bool {
        self.server
            .capabilities
            .pointer("/resources/subscribe")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    fn post(&self, body: &Value) -> reqwest::RequestBuilder {
        let mut request = client()
            .post(self.endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header("MCP-Protocol-Version", &self.protocol)
            .json(body);
        if let Some(id) = &self.session_id {
            request = request.header("Mcp-Session-Id", id);
        }
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer.expose_str());
        }
        request
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        let body = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let started = Instant::now();
        let response = self
            .post(&body)
            .send()
            .await
            .map_err(|error| McpError::Network(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        ledger(
            &self.endpoint,
            "POST",
            body.to_string().len(),
            0,
            Some(status),
            started,
        );
        check_status(&response, self.session_id.is_some())?;
        Ok(())
    }

    /// One request, its response, and whatever notifications rode with it.
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let sent = body.to_string().len();
        let started = Instant::now();
        let mut response = self
            .post(&body)
            .send()
            .await
            .map_err(|error| McpError::Network(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        if let Err(error) = check_status(&response, self.session_id.is_some()) {
            ledger(&self.endpoint, "POST", sent, 0, Some(status), started);
            return Err(error);
        }
        if method == "initialize" {
            if let Some(value) = response
                .headers()
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.len() <= 256 && value.chars().all(|c| c.is_ascii_graphic()))
            {
                self.session_id = Some(value.to_string());
            }
        }
        let streamed = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));
        let mut received = 0usize;
        let outcome = if streamed {
            let mut events = SseEvents::default();
            let mut found = None;
            loop {
                let chunk = response
                    .chunk()
                    .await
                    .map_err(|error| McpError::Network(error.without_url().to_string()))?;
                let (batch, done) = match chunk {
                    Some(chunk) => {
                        received += chunk.len();
                        if received > MAX_BODY_BYTES {
                            found = Some(Err(McpError::TooLarge));
                            break;
                        }
                        (events.push(&chunk), false)
                    }
                    None => (events.finish(), true),
                };
                for data in batch {
                    let Ok(message) = serde_json::from_str::<Value>(&data) else {
                        continue;
                    };
                    if let Some(outcome) = rpc_outcome(&message, id) {
                        found = Some(outcome);
                        break;
                    }
                    self.keep_notification(message);
                }
                if found.is_some() || done {
                    break;
                }
            }
            found.unwrap_or_else(|| {
                Err(McpError::Invalid(
                    "the stream ended without a response".into(),
                ))
            })
        } else {
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        body.extend_from_slice(&chunk);
                        if body.len() > MAX_BODY_BYTES {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        return Err(McpError::Network(error.without_url().to_string()));
                    }
                }
            }
            received = body.len();
            if body.len() > MAX_BODY_BYTES {
                Err(McpError::TooLarge)
            } else {
                serde_json::from_slice::<Value>(&body)
                    .map_err(|error| McpError::Invalid(error.to_string()))
                    .and_then(|message| {
                        rpc_outcome(&message, id).unwrap_or_else(|| {
                            Err(McpError::Invalid("no response for this request".into()))
                        })
                    })
            }
        };
        ledger(
            &self.endpoint,
            "POST",
            sent,
            received,
            Some(status),
            started,
        );
        outcome
    }

    /// A server notification that rode on a response, kept (bounded) for the
    /// caller that asked for resource updates.
    fn keep_notification(&mut self, message: Value) {
        if message.get("method").is_none() || message.get("id").is_some() {
            return;
        }
        if self.notifications.len() >= MAX_NOTIFICATIONS {
            self.notifications.remove(0);
        }
        self.notifications.push(message);
    }

    /// Every tool the server lists, across pages, up to [`MAX_TOOLS`].
    pub async fn list_tools(&mut self) -> Result<Vec<Value>, McpError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let page = self.request("tools/list", params).await?;
            if let Some(list) = page.get("tools").and_then(Value::as_array) {
                tools.extend(list.iter().take(MAX_TOOLS - tools.len()).cloned());
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() || tools.len() >= MAX_TOOLS {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<Value, McpError> {
        let arguments = if arguments.is_object() {
            arguments.clone()
        } else {
            json!({})
        };
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    pub async fn read_resource(&mut self, uri: &str) -> Result<Value, McpError> {
        self.request("resources/read", json!({ "uri": uri })).await
    }

    pub async fn subscribe(&mut self, uri: &str) -> Result<(), McpError> {
        self.request("resources/subscribe", json!({ "uri": uri }))
            .await
            .map(|_| ())
    }

    /// The stream a server uses for what it says unprompted (resource
    /// updates). A `405` means it offers none, and the caller polls instead.
    pub async fn notification_stream(&self) -> Result<reqwest::Response, McpError> {
        let mut request = client()
            .get(self.endpoint.clone())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header("MCP-Protocol-Version", &self.protocol)
            // The stream is meant to stay open: the per-request deadline
            // would cut it, so the listener bounds it instead.
            .timeout(Duration::from_secs(60 * 60));
        if let Some(id) = &self.session_id {
            request = request.header("Mcp-Session-Id", id);
        }
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer.expose_str());
        }
        let started = Instant::now();
        let response = request
            .send()
            .await
            .map_err(|error| McpError::Network(error.without_url().to_string()))?;
        ledger(
            &self.endpoint,
            "GET",
            0,
            0,
            Some(response.status().as_u16()),
            started,
        );
        check_status(&response, self.session_id.is_some())?;
        Ok(response)
    }

    /// Ends the session on the server, when it gave one. Best effort.
    pub async fn close(self) {
        let Some(id) = self.session_id.clone() else {
            return;
        };
        let mut request = client()
            .delete(self.endpoint.clone())
            .header("Mcp-Session-Id", id)
            .header("MCP-Protocol-Version", &self.protocol);
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer.expose_str());
        }
        let started = Instant::now();
        let status = request
            .send()
            .await
            .ok()
            .map(|response| response.status().as_u16());
        ledger(&self.endpoint, "DELETE", 0, 0, status, started);
    }
}

fn check_status(response: &reqwest::Response, had_session: bool) -> Result<(), McpError> {
    let status = response.status().as_u16();
    if status == 401 {
        let (resource_metadata, scope) = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(parse_www_authenticate)
            .unwrap_or((None, None));
        return Err(McpError::Unauthorized {
            resource_metadata,
            scope,
        });
    }
    if status == 404 && had_session {
        return Err(McpError::SessionExpired);
    }
    if !(200..300).contains(&status) {
        return Err(McpError::Status(status));
    }
    Ok(())
}

/// What one listed tool is, as the rest of the app reads it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
    /// The server's own hint that the tool changes nothing. A hint, not a
    /// promise: it only chooses the default rule, which the person can change.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub destructive: bool,
    /// The `ui://` resource the tool's result is drawn with, when it has one
    /// (MCP Apps, or the older `openai/outputTemplate`).
    #[serde(default)]
    pub ui_resource: Option<String>,
}

pub fn tool_info(value: &Value) -> Option<ToolInfo> {
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    let annotations = value.get("annotations");
    let hint = |key: &str| {
        annotations
            .and_then(|annotations| annotations.get(key))
            .and_then(Value::as_bool)
    };
    let ui_resource = [
        value.pointer("/_meta/ui/resourceUri"),
        value.pointer("/_meta/ui~1resourceUri"),
        value.pointer("/_meta/openai~1outputTemplate"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|uri| uri.starts_with("ui://") && uri.len() <= 512)
    .map(str::to_string);
    let schema = value
        .get("inputSchema")
        .filter(|schema| schema.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    Some(ToolInfo {
        name: name.to_string(),
        title: value
            .get("title")
            .or_else(|| annotations.and_then(|annotations| annotations.get("title")))
            .and_then(Value::as_str)
            .map(|title| title.chars().take(120).collect()),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(1_000)
            .collect(),
        input_schema: schema,
        read_only: hint("readOnlyHint").unwrap_or(false),
        // The protocol's default for a tool that is not read-only is
        // "destructive", so only an explicit false lowers it.
        destructive: !hint("readOnlyHint").unwrap_or(false)
            && hint("destructiveHint").unwrap_or(true),
        ui_resource,
    })
}

/// A tool result as text the model reads, bounded. Images are named, never
/// carried: the turn is a text conversation.
pub fn result_text(result: &Value, limit: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                Some("resource_link") => parts.push(format!(
                    "[link] {} {}",
                    item.get("name").and_then(Value::as_str).unwrap_or_default(),
                    item.get("uri").and_then(Value::as_str).unwrap_or_default()
                )),
                Some("resource") => {
                    let uri = item
                        .pointer("/resource/uri")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if uri.starts_with("ui://") {
                        parts.push("[An interactive view is shown to the user.]".into());
                    } else if let Some(text) =
                        item.pointer("/resource/text").and_then(Value::as_str)
                    {
                        parts.push(text.to_string());
                    }
                }
                Some("image") => parts.push("[image omitted]".into()),
                Some("audio") => parts.push("[audio omitted]".into()),
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(structured.to_string());
        }
    }
    let mut text = parts.join("\n");
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        text = format!("The tool reported an error: {text}");
    }
    if text.trim().is_empty() {
        text = "The tool returned nothing.".into();
    }
    if text.chars().count() > limit {
        let mut cut: String = text.chars().take(limit).collect();
        cut.push_str("\n[truncated]");
        cut
    } else {
        text
    }
}

/// The https links a result offers, for the card's open buttons.
pub fn result_links(result: &Value) -> Vec<(String, String)> {
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("resource_link"))
        .filter_map(|item| {
            let uri = item.get("uri")?.as_str()?;
            if !uri.starts_with("https://") || uri.len() > 2048 {
                return None;
            }
            let name = item
                .get("title")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(uri);
            Some((name.chars().take(120).collect(), uri.to_string()))
        })
        .take(6)
        .collect()
}

/// An interactive view embedded in a result itself, rather than named by the
/// tool definition.
pub fn embedded_ui(result: &Value) -> Option<(String, String)> {
    result
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("resource"))
        .find_map(|item| {
            let uri = item.pointer("/resource/uri")?.as_str()?;
            let html = item.pointer("/resource/text")?.as_str()?;
            uri.starts_with("ui://")
                .then(|| (uri.to_string(), html.to_string()))
        })
}
