//! Interactive views a connector returns, drawn in the chat (ADR-0092).
//!
//! A tool can name a `ui://` resource (MCP Apps, or the older Apps SDK
//! `openai/outputTemplate`) whose HTML shows its result. The HTML is the
//! server's, so it never runs in the app's page. It is kept here, served from
//! its own scheme (`subrosa-app:`) with its own content security policy, and
//! shown in an iframe sandboxed without `allow-same-origin`: an opaque origin
//! with no access to the app, its storage or its IPC. The policy lets it load
//! and connect to its own server's origin and nothing else, and the only way
//! out is the `postMessage` bridge the card validates.

use serde::Serialize;
use serde_json::Value;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, UriSchemeResponder};

use super::calls::CallRow;
use super::mcp::embedded_ui;
use super::Connector;
use crate::domain::types::AppError;

pub const SCHEME: &str = "subrosa-app";
const MAX_HTML_BYTES: usize = 512 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// The mime types an interactive view is served as.
pub fn is_app_html(mime: &str) -> bool {
    let mime = mime.to_ascii_lowercase();
    mime.starts_with("text/html")
}

/// The policy a view runs under: its server's origin for everything it
/// loads or calls, inline script and style for what it carries itself, and
/// nothing else. No `unsafe-eval`, no frames, no forms, no `<base>`.
pub fn csp_for(origin: &str) -> String {
    let origin = if origin.starts_with("https://") || origin.starts_with("http://127.0.0.1") {
        origin
    } else {
        ""
    };
    format!(
        "default-src 'none'; script-src 'unsafe-inline' {origin}; style-src 'unsafe-inline' {origin}; img-src data: blob: {origin}; font-src data: {origin}; media-src data: blob: {origin}; connect-src {origin}; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
    )
    .replace("  ", " ")
}

/// The scheme, host and port of a connector's address.
pub fn origin_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .filter(|url| matches!(url.scheme(), "https" | "http"))
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}

/// The HTML text of a `resources/read` result: the first content that is
/// HTML, as text or as base64.
pub fn html_of(result: &Value) -> Option<String> {
    let contents = result.get("contents")?.as_array()?;
    contents.iter().find_map(|content| {
        let mime = content
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("text/html");
        if !is_app_html(mime) {
            return None;
        }
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            return Some(text.to_string());
        }
        use base64::Engine as _;
        let blob = content.get("blob").and_then(Value::as_str)?;
        base64::engine::general_purpose::STANDARD
            .decode(blob)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    })
}

/// JSON safe to put inside a `<script>` element: no `</script>`, no `<!--`.
fn script_json(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// The bridge every view gets, injected first in the document. It speaks the
/// MCP Apps messages over `postMessage`, and gives views written for the
/// older `window.openai` interface the same calls under that name.
const BRIDGE: &str = r#"(function(){var d=JSON.parse(document.getElementById('subrosa-app-data').textContent||'{}');var n=0,w={};function rq(m,p){return new Promise(function(ok,ko){var i='sr'+(++n);w[i]=[ok,ko];parent.postMessage({jsonrpc:'2.0',id:i,method:m,params:p||{}},'*');});}window.addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;if(!m||m.jsonrpc!=='2.0')return;if(m.id&&w[m.id]){var c=w[m.id];delete w[m.id];if(m.error)c[1](new Error(m.error.message||'error'));else c[0](m.result);}});window.openai={toolInput:d.toolInput||{},toolOutput:d.toolOutput||null,theme:d.theme||'light',displayMode:'inline',widgetState:null,callTool:function(t,a){return rq('tools/call',{name:t,arguments:a||{}});},openExternal:function(o){return rq('ui/open-link',{url:o&&o.href});},sendFollowUpMessage:function(){return Promise.reject(new Error('not supported'));},setWidgetState:function(s){window.openai.widgetState=s;return Promise.resolve();}};})();"#;

pub fn document(html: &str, tool_input: &Value, tool_output: &Value, theme: &str) -> String {
    let data = serde_json::json!({
        "toolInput": tool_input,
        "toolOutput": tool_output,
        "theme": theme,
    });
    let head = format!(
        "<script type=\"application/json\" id=\"subrosa-app-data\">{}</script><script>{BRIDGE}</script>",
        script_json(&data)
    );
    let lower = html.to_ascii_lowercase();
    if let Some(at) = lower.find("<head>") {
        let at = at + "<head>".len();
        format!("{}{head}{}", &html[..at], &html[at..])
    } else {
        format!("<!doctype html><html><head><meta charset=\"utf-8\">{head}</head><body>{html}</body></html>")
    }
}

fn bounded_output(result: &Value) -> Value {
    let output = result
        .get("structuredContent")
        .cloned()
        .unwrap_or_else(|| super::calls::bounded(result));
    if output.to_string().len() > MAX_OUTPUT_BYTES {
        super::calls::bounded(result)
    } else {
        output
    }
}

/// Keeps the interactive view a call produced, when it produced one. The id
/// is derived from the call, so the card finds it again.
pub async fn keep_for_call(
    pool: &SqlitePool,
    connector: &Connector,
    call: &CallRow,
    result: &Value,
) -> Option<String> {
    if connector.builtin() {
        return None;
    }
    let (uri, html) = if let Some(embedded) = embedded_ui(result) {
        embedded
    } else {
        let uri = super::state(pool, &connector.id)
            .await
            .tools
            .into_iter()
            .find(|tool| tool.name == call.tool)
            .and_then(|tool| tool.ui_resource)?;
        let read = super::runtime::read_resource(pool, connector, &uri)
            .await
            .ok()?;
        (uri, html_of(&read)?)
    };
    if html.len() > MAX_HTML_BYTES {
        return None;
    }
    let id = format!("call-{}", call.id);
    let output = bounded_output(result);
    query("INSERT OR REPLACE INTO connector_app_resources(id,connector_id,task_id,uri,html,tool,tool_output,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(&connector.id)
        .bind(&call.task_id)
        .bind(&uri)
        .bind(&html)
        .bind(&call.tool)
        .bind(output.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .ok()?;
    Some(id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDto {
    pub id: String,
    pub connector_id: String,
    pub connector_name: String,
    pub tool: String,
    pub uri: String,
    /// The one origin the view may reach, shown on the card.
    pub origin: String,
    /// What the tool was called with and what it returned (bounded), handed
    /// to the view by the bridge.
    pub tool_input: Value,
    pub tool_output: Value,
}

#[tauri::command]
pub async fn connector_app_get(app: AppHandle, id: String) -> Result<AppDto, AppError> {
    let pool = super::pool(&app).await?;
    let row = query(
        "SELECT id,connector_id,uri,tool,tool_output FROM connector_app_resources WHERE id=?",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(missing)?;
    let connector_id: String = row.get("connector_id");
    let connector = super::get(&pool, &connector_id).await.ok();
    let tool_input = super::calls::get(&pool, id.strip_prefix("call-").unwrap_or_default())
        .await
        .map(|call| call.arguments)
        .unwrap_or(Value::Null);
    let tool_output = row
        .get::<Option<String>, _>("tool_output")
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    Ok(AppDto {
        tool_input,
        tool_output,
        id: row.get("id"),
        connector_name: connector
            .as_ref()
            .map(|connector| connector.name.clone())
            .unwrap_or_else(|| connector_id.clone()),
        origin: connector
            .map(|connector| origin_of(&connector.url))
            .unwrap_or_default(),
        connector_id,
        tool: row.get("tool"),
        uri: row.get("uri"),
    })
}

fn missing() -> AppError {
    AppError::new("connector_app_missing", "This view is no longer available.")
}

/// A tool call a view asks for through the bridge: on its own connector
/// only, and under the same rules as the assistant's calls. An "ask" tool
/// runs only with `confirmed`, which the card sets after the person agreed.
#[tauri::command]
pub async fn connector_app_call_tool(
    app: AppHandle,
    id: String,
    tool: String,
    arguments: Option<Value>,
    confirmed: Option<bool>,
) -> Result<Value, AppError> {
    let pool = super::pool(&app).await?;
    let row = query("SELECT connector_id,task_id FROM connector_app_resources WHERE id=?")
        .bind(&id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(missing)?;
    let connector = super::get(&pool, &row.get::<String, _>("connector_id")).await?;
    let task_id: String = row.get("task_id");
    let info = super::state(&pool, &connector.id)
        .await
        .tools
        .into_iter()
        .find(|candidate| candidate.name == tool)
        .ok_or_else(|| {
            AppError::new("connector_tool_unknown", "This connector has no such tool.")
        })?;
    match super::policy::effective(&connector.tool_policy, &info) {
        super::policy::Rule::Deny => {
            return Err(AppError::new(
                "connector_denied",
                "This action is turned off for this connector.",
            ))
        }
        super::policy::Rule::Ask if confirmed != Some(true) => {
            let mut error = AppError::new(
                "connector_confirm",
                "This action needs your confirmation before it runs.",
            );
            error.details = Some(serde_json::json!({ "tool": tool }));
            return Err(error);
        }
        _ => {}
    }
    let arguments = arguments
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let call_id =
        super::calls::insert(&pool, &task_id, &connector.id, &tool, &arguments, "running").await?;
    let outcome = super::runtime::call_tool(&pool, &connector, &tool, &arguments).await;
    super::calls::finish(&pool, &call_id, &outcome).await?;
    let value = outcome?;
    // What goes back into the frame is bounded like what goes to the model.
    Ok(serde_json::json!({
        "content": value.get("content").cloned().unwrap_or(Value::Null),
        "structuredContent": bounded_output(&value),
        "isError": value.get("isError").cloned().unwrap_or(Value::Bool(false)),
    }))
}

/// Registers the scheme. Requests are answered off the webview's thread.
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        SCHEME,
        |ctx: UriSchemeContext<'_, tauri::Wry>,
         request: Request<Vec<u8>>,
         responder: UriSchemeResponder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(respond(&app, &request).await);
            });
        },
    )
}

/// `/<id>` and an optional `?theme=dark`, and nothing else.
pub fn id_of(path: &str) -> Option<&str> {
    let id = path.strip_prefix('/')?;
    (!id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then_some(id)
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

async fn respond(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(id) = id_of(request.uri().path()) else {
        return status(StatusCode::FORBIDDEN);
    };
    let theme = if request.uri().query() == Some("theme=dark") {
        "dark"
    } else {
        "light"
    };
    let Ok(pool) = super::pool(app).await else {
        return status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(Some(row)) = query("SELECT r.html,r.tool_output,c.url,c.id AS cid FROM connector_app_resources r LEFT JOIN connectors c ON c.id=r.connector_id WHERE r.id=?")
        .bind(id)
        .fetch_optional(&pool)
        .await
    else {
        return status(StatusCode::NOT_FOUND);
    };
    let html: String = row.get("html");
    let output: Value = row
        .get::<Option<String>, _>("tool_output")
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let input = query("SELECT arguments FROM connector_calls WHERE id=?")
        .bind(id.strip_prefix("call-").unwrap_or_default())
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| serde_json::from_str::<Value>(&row.get::<String, _>("arguments")).ok())
        .unwrap_or(Value::Null);
    let origin = origin_of(&row.get::<Option<String>, _>("url").unwrap_or_default());
    let body = document(&html, &input, &output, theme).into_bytes();
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    let set = |headers: &mut tauri::http::HeaderMap, name: header::HeaderName, value: &str| {
        if let Ok(value) = tauri::http::HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    };
    set(headers, header::CONTENT_TYPE, "text/html; charset=utf-8");
    set(headers, header::CONTENT_SECURITY_POLICY, &csp_for(&origin));
    set(headers, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(headers, header::REFERRER_POLICY, "no-referrer");
    set(headers, header::CACHE_CONTROL, "no-store");
    response
}
