//! Google and Microsoft as built-in connectors: tools written here in Rust,
//! signed in with the app's own OAuth client (ADR-0092).
//!
//! Only scopes the providers do not class as restricted: Google Calendar
//! events, Drive `drive.file` (the files Sub Rosa created or the person opened
//! with it, never the whole Drive, and the screens say so), Contacts read;
//! Microsoft Graph calendars, files read and mail read. The client ids come
//! from the build (`SUBROSA_GOOGLE_CLIENT_ID`, `SUBROSA_MS_CLIENT_ID`); a build
//! without one does not offer that provider at all.
//!
//! Full Gmail access is a restricted scope: Google lets an app use it only
//! after an independent security assessment (CASA). The code path is here,
//! behind [`GMAIL_VERIFIED`], and the screens show it as "requires
//! verification" until that gate is passed. Turning it on is a build change
//! made after the assessment, never a setting.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::mcp::ToolInfo;
use super::{oauth, BuiltinDto, Connector, GatedDto};
use crate::domain::types::AppError;
use crate::redacted::Redacted;

/// The CASA gate for Gmail. False until the assessment is passed.
pub const GMAIL_VERIFIED: bool = false;

const GOOGLE_AUTHORIZE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_API: &str = "https://www.googleapis.com";
const GOOGLE_PEOPLE: &str = "https://people.googleapis.com";
const GMAIL_API: &str = "https://gmail.googleapis.com";
const MS_AUTHORIZE: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";

const GOOGLE_SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/contacts.readonly",
];
const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const MS_SCOPES: &[&str] = &[
    "offline_access",
    "User.Read",
    "Calendars.ReadWrite",
    "Files.Read",
    "Mail.Read",
];

const MAX_READ_CHARS: usize = 40_000;
const MAX_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;

pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    client_id: Option<&'static str>,
    authorize: &'static str,
    token: &'static str,
}

fn present(value: Option<&'static str>) -> Option<&'static str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

const GOOGLE: Provider = Provider {
    id: "google",
    name: "Google",
    client_id: option_env!("SUBROSA_GOOGLE_CLIENT_ID"),
    authorize: GOOGLE_AUTHORIZE,
    token: GOOGLE_TOKEN,
};

const MICROSOFT: Provider = Provider {
    id: "microsoft",
    name: "Microsoft",
    client_id: option_env!("SUBROSA_MS_CLIENT_ID"),
    authorize: MS_AUTHORIZE,
    token: MS_TOKEN,
};

pub fn provider(id: &str) -> Option<&'static Provider> {
    match id {
        "google" => Some(&GOOGLE),
        "microsoft" => Some(&MICROSOFT),
        _ => None,
    }
}

/// Where Google sends the browser back. Google accepts a custom scheme only
/// for its iOS client type, as the reversed client id, so a build that ships
/// Google sets `SUBROSA_GOOGLE_REDIRECT_URI` to the one its client was
/// registered with and registers that scheme in the bundle.
fn google_redirect() -> String {
    present(option_env!("SUBROSA_GOOGLE_REDIRECT_URI"))
        .unwrap_or(oauth::REDIRECT_URI)
        .to_string()
}

/// Callback addresses other than `subrosa://connector/callback`.
pub fn extra_redirects() -> Vec<String> {
    let google = google_redirect();
    if google == oauth::REDIRECT_URI {
        Vec::new()
    } else {
        vec![google]
    }
}

impl Provider {
    pub fn available(&self) -> bool {
        present(self.client_id).is_some()
    }

    fn scopes(&self) -> Vec<String> {
        match self.id {
            "google" => {
                let mut scopes: Vec<String> = GOOGLE_SCOPES
                    .iter()
                    .map(|scope| scope.to_string())
                    .collect();
                if GMAIL_VERIFIED {
                    scopes.push(GMAIL_SCOPE.to_string());
                }
                scopes
            }
            _ => MS_SCOPES.iter().map(|scope| scope.to_string()).collect(),
        }
    }

    fn redirect(&self) -> String {
        if self.id == "google" {
            google_redirect()
        } else {
            oauth::REDIRECT_URI.to_string()
        }
    }

    /// The pending flow is stored, then the page to open is returned.
    pub fn begin(&self, connector_id: &str) -> Result<String, AppError> {
        let client_id =
            present(self.client_id).ok_or_else(|| super::error("connector_unavailable"))?;
        let pkce = oauth::pkce();
        let state = oauth::random_state();
        let redirect = self.redirect();
        oauth::store_pending(
            &state,
            &oauth::PendingFlow::new(
                connector_id,
                &pkce.verifier,
                self.token,
                client_id,
                &redirect,
                None,
            ),
        )?;
        // Google hands out a refresh token only when asked for offline
        // access, and only on a consent screen.
        let extra: &[(&str, &str)] = if self.id == "google" {
            &[("access_type", "offline"), ("prompt", "consent")]
        } else {
            &[]
        };
        oauth::authorize_url(&oauth::AuthorizeRequest {
            authorization_endpoint: self.authorize,
            client_id,
            redirect_uri: &redirect,
            challenge: &pkce.challenge,
            state: &state,
            scopes: &self.scopes(),
            resource: None,
            extra,
        })
    }
}

pub fn catalog() -> Vec<BuiltinDto> {
    vec![
        BuiltinDto {
            id: "google",
            name: "Google",
            available: GOOGLE.available(),
            description: "Calendar, Drive files you open with Sub Rosa, and contacts",
            gated: if GMAIL_VERIFIED {
                Vec::new()
            } else {
                vec![GatedDto {
                    id: "gmail",
                    name: "Gmail",
                    state: "requires_verification",
                }]
            },
        },
        BuiltinDto {
            id: "microsoft",
            name: "Microsoft",
            available: MICROSOFT.available(),
            description: "Outlook calendar and mail, and OneDrive",
            gated: Vec::new(),
        },
    ]
}

fn tool(name: &str, description: &str, read_only: bool, schema: Value) -> ToolInfo {
    ToolInfo {
        name: name.to_string(),
        title: None,
        description: description.to_string(),
        input_schema: schema,
        read_only,
        destructive: false,
        ui_resource: None,
    }
}

fn calendar_list_schema() -> Value {
    json!({"type":"object","properties":{
        "days":{"type":"integer","description":"Days ahead to look, 1 to 30. Defaults to 7."},
        "query":{"type":"string","description":"Optional words to match."}
    }})
}

fn calendar_create_schema() -> Value {
    json!({"type":"object","properties":{
        "title":{"type":"string"},
        "start":{"type":"string","description":"RFC 3339 start time."},
        "end":{"type":"string","description":"RFC 3339 end time."},
        "description":{"type":"string"},
        "attendees":{"type":"array","items":{"type":"string"},"description":"Email addresses."}
    },"required":["title","start","end"]})
}

fn query_schema(what: &str) -> Value {
    json!({"type":"object","properties":{"query":{"type":"string","description":what}},"required":["query"]})
}

fn id_schema(key: &str) -> Value {
    json!({"type":"object","properties":{key:{"type":"string"}},"required":[key]})
}

/// The tools a provider offers, by their short names (the conversation sees
/// them as `google__calendar_list` and so on).
pub fn tools_for(provider: &str) -> Vec<ToolInfo> {
    match provider {
        "google" => {
            let mut tools = vec![
                tool("calendar_list", "List the events in the user's Google Calendar for the coming days.", true, calendar_list_schema()),
                tool("calendar_create", "Create an event in the user's Google Calendar.", false, calendar_create_schema()),
                tool("drive_search", "Search the Google Drive files Sub Rosa created or the user opened with Sub Rosa. Other Drive files are not visible to this tool.", true, query_schema("Words in the file name or text.")),
                tool("drive_read", "Read one of those Google Drive files as text.", true, id_schema("file_id")),
                tool("contacts_search", "Search the user's Google contacts by name or email.", true, query_schema("A name or an email address.")),
            ];
            if GMAIL_VERIFIED {
                tools.push(tool(
                    "gmail_search",
                    "Search the user's Gmail.",
                    true,
                    query_schema("A Gmail search query."),
                ));
                tools.push(tool(
                    "gmail_read",
                    "Read one Gmail message.",
                    true,
                    id_schema("message_id"),
                ));
            }
            tools
        }
        "microsoft" => vec![
            tool(
                "calendar_list",
                "List the events in the user's Outlook calendar for the coming days.",
                true,
                calendar_list_schema(),
            ),
            tool(
                "calendar_create",
                "Create an event in the user's Outlook calendar.",
                false,
                calendar_create_schema(),
            ),
            tool(
                "mail_search",
                "Search the user's Outlook mail.",
                true,
                query_schema("Words to search for."),
            ),
            tool(
                "mail_read",
                "Read one Outlook message.",
                true,
                id_schema("message_id"),
            ),
            tool(
                "onedrive_search",
                "Search the user's OneDrive files.",
                true,
                query_schema("Words in the file name or text."),
            ),
            tool(
                "onedrive_read",
                "Read one OneDrive file as text.",
                true,
                id_schema("item_id"),
            ),
        ],
        _ => Vec::new(),
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::http_client::build(
            crate::http_client::credentialed(Duration::from_secs(30)),
            "connectors",
        )
    })
}

fn api_error(status: u16) -> AppError {
    match status {
        401 => AppError::new(
            "connector_sign_in",
            "This connector needs you to sign in again.",
        ),
        403 => AppError::new(
            "connector_forbidden",
            "The service did not allow this with the access you granted.",
        ),
        404 => AppError::new("connector_missing", "The service could not find that item."),
        _ => AppError::new(
            "connector_status",
            format!("The connector answered with status {status}."),
        ),
    }
}

async fn send(
    request: reqwest::RequestBuilder,
    url: &str,
    method: &str,
) -> Result<Vec<u8>, AppError> {
    let started = Instant::now();
    let parsed = reqwest::Url::parse(url).map_err(|_| api_error(400))?;
    let mut response = request.send().await.map_err(|_| {
        AppError::new(
            "connector_unreachable",
            "The connector could not be reached. Check your connection.",
        )
    })?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_DOWNLOAD_BYTES {
            break;
        }
    }
    super::mcp::ledger(&parsed, method, 0, body.len(), Some(status), started);
    if !(200..300).contains(&status) {
        return Err(api_error(status));
    }
    if body.len() > MAX_DOWNLOAD_BYTES {
        return Err(AppError::new(
            "connector_too_large",
            "The connector sent back more than Sub Rosa can read at once.",
        ));
    }
    Ok(body)
}

async fn get_json(token: &Redacted<String>, url: &str) -> Result<Value, AppError> {
    let body = send(
        client().get(url).bearer_auth(token.expose_str()),
        url,
        "GET",
    )
    .await?;
    serde_json::from_slice(&body).map_err(|_| api_error(502))
}

async fn post_json(
    token: &Redacted<String>,
    url: &str,
    payload: &Value,
) -> Result<Value, AppError> {
    let body = send(
        client()
            .post(url)
            .bearer_auth(token.expose_str())
            .json(payload),
        url,
        "POST",
    )
    .await?;
    serde_json::from_slice(&body).map_err(|_| api_error(502))
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn window(args: &Value) -> (String, String) {
    let days = args
        .get("days")
        .and_then(Value::as_i64)
        .unwrap_or(7)
        .clamp(1, 30);
    let now = chrono::Utc::now();
    (
        now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        (now + chrono::Duration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

fn enc(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// An id the provider minted: letters, digits and a few separators. Anything
/// else is not put in a URL path.
fn safe_id(raw: &str) -> Result<&str, AppError> {
    if !raw.is_empty()
        && raw.len() <= 512
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '!' | '.' | '='))
    {
        Ok(raw)
    } else {
        Err(AppError::new(
            "connector_missing",
            "The service could not find that item.",
        ))
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() > MAX_READ_CHARS {
        let mut cut: String = text.chars().take(MAX_READ_CHARS).collect();
        cut.push_str("\n[truncated]");
        cut
    } else {
        text.to_string()
    }
}

fn text_result(text: String) -> Value {
    json!({"content": [{"type": "text", "text": text}]})
}

/// Text from downloaded bytes: plain text as is, documents through the
/// same extractor chat attachments use.
fn readable(name: &str, mime: &str, bytes: Vec<u8>) -> Result<String, AppError> {
    let textual = mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "application/csv"
        );
    if textual {
        return Ok(clip(&String::from_utf8_lossy(&bytes)));
    }
    crate::documents::extract_for_chat(name, bytes).map(|document| clip(&document.text))
}

/// Runs one built-in tool. The result has the MCP shape so the rest of the
/// app reads it the same way.
pub async fn call(connector: &Connector, tool: &str, args: &Value) -> Result<Value, AppError> {
    let token = super::runtime::bearer(connector)
        .await?
        .ok_or_else(|| api_error(401))?;
    match (connector.auth.as_str(), tool) {
        ("google", "calendar_list") => {
            let (from, to) = window(args);
            let mut url = format!("{GOOGLE_API}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin={}&timeMax={}", enc(&from), enc(&to));
            if !arg(args, "query").is_empty() {
                url.push_str(&format!("&q={}", enc(arg(args, "query"))));
            }
            let value = get_json(&token, &url).await?;
            let items = value.get("items").cloned().unwrap_or(json!([]));
            Ok(
                json!({"content":[{"type":"text","text": google_events_text(&items)}], "structuredContent": {"events": events_from_google(&items)}}),
            )
        }
        ("google", "calendar_create") => {
            let mut event = json!({
                "summary": arg(args, "title"),
                "start": {"dateTime": arg(args, "start")},
                "end": {"dateTime": arg(args, "end")},
            });
            if !arg(args, "description").is_empty() {
                event["description"] = json!(arg(args, "description"));
            }
            if let Some(attendees) = args.get("attendees").and_then(Value::as_array) {
                event["attendees"] = Value::Array(
                    attendees
                        .iter()
                        .filter_map(Value::as_str)
                        .take(50)
                        .map(|email| json!({"email": email}))
                        .collect(),
                );
            }
            let created = post_json(
                &token,
                &format!("{GOOGLE_API}/calendar/v3/calendars/primary/events"),
                &event,
            )
            .await?;
            let link = created
                .get("htmlLink")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(json!({"content":[
                {"type":"text","text": format!("Created \"{}\".", arg(args, "title"))},
                {"type":"resource_link","name": arg(args, "title"),"uri": link}
            ]}))
        }
        ("google", "drive_search") => {
            let q = arg(args, "query").replace('\\', "").replace('\'', "\\'");
            let url = format!("{GOOGLE_API}/drive/v3/files?pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q={}", enc(&format!("fullText contains '{q}' and trashed=false")));
            let value = get_json(&token, &url).await?;
            let files = value
                .get("files")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut content = vec![json!({"type":"text","text": if files.is_empty() {
                "No file Sub Rosa can see matches. Drive access covers only the files Sub Rosa created or that you opened with it.".to_string()
            } else {
                files.iter().map(|file| format!("- {} (id {}, {})",
                    file.get("name").and_then(Value::as_str).unwrap_or_default(),
                    file.get("id").and_then(Value::as_str).unwrap_or_default(),
                    file.get("modifiedTime").and_then(Value::as_str).unwrap_or_default())).collect::<Vec<_>>().join("\n")
            }})];
            for file in files.iter().take(6) {
                if let (Some(name), Some(link)) = (
                    file.get("name").and_then(Value::as_str),
                    file.get("webViewLink").and_then(Value::as_str),
                ) {
                    content.push(json!({"type":"resource_link","name": name,"uri": link}));
                }
            }
            Ok(json!({"content": content}))
        }
        ("google", "drive_read") => {
            let id = safe_id(arg(args, "file_id"))?;
            let meta = get_json(
                &token,
                &format!("{GOOGLE_API}/drive/v3/files/{id}?fields=name,mimeType"),
            )
            .await?;
            let name = meta
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_string();
            let mime = meta
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let text = if let Some(export) = google_export_type(&mime) {
                let url = format!(
                    "{GOOGLE_API}/drive/v3/files/{id}/export?mimeType={}",
                    enc(export)
                );
                clip(&String::from_utf8_lossy(
                    &send(
                        client().get(&url).bearer_auth(token.expose_str()),
                        &url,
                        "GET",
                    )
                    .await?,
                ))
            } else {
                let url = format!("{GOOGLE_API}/drive/v3/files/{id}?alt=media");
                let bytes = send(
                    client().get(&url).bearer_auth(token.expose_str()),
                    &url,
                    "GET",
                )
                .await?;
                readable(&name, &mime, bytes)?
            };
            Ok(text_result(format!("{name}\n\n{text}")))
        }
        ("google", "contacts_search") => {
            let url = format!("{GOOGLE_PEOPLE}/v1/people:searchContacts?pageSize=10&readMask=names,emailAddresses,phoneNumbers&query={}", enc(arg(args, "query")));
            let value = get_json(&token, &url).await?;
            let rows: Vec<String> = value
                .get("results")
                .and_then(Value::as_array)
                .map(|results| {
                    results
                        .iter()
                        .map(|result| {
                            let person = result.get("person").cloned().unwrap_or(Value::Null);
                            format!(
                                "- {} {} {}",
                                person
                                    .pointer("/names/0/displayName")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default(),
                                person
                                    .pointer("/emailAddresses/0/value")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default(),
                                person
                                    .pointer("/phoneNumbers/0/value")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(text_result(if rows.is_empty() {
                "No contact matches.".into()
            } else {
                rows.join("\n")
            }))
        }
        ("google", "gmail_search" | "gmail_read") if !GMAIL_VERIFIED => {
            Err(super::error("connector_requires_verification"))
        }
        ("google", "gmail_search") => {
            let url = format!(
                "{GMAIL_API}/gmail/v1/users/me/messages?maxResults=10&q={}",
                enc(arg(args, "query"))
            );
            let value = get_json(&token, &url).await?;
            let ids: Vec<String> = value
                .get("messages")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|m| m.get("id").and_then(Value::as_str))
                        .map(|id| format!("- message id {id}"))
                        .collect()
                })
                .unwrap_or_default();
            Ok(text_result(if ids.is_empty() {
                "No message matches.".into()
            } else {
                ids.join("\n")
            }))
        }
        ("google", "gmail_read") => {
            let id = safe_id(arg(args, "message_id"))?;
            let value = get_json(
                &token,
                &format!("{GMAIL_API}/gmail/v1/users/me/messages/{id}?format=metadata"),
            )
            .await?;
            Ok(text_result(clip(
                value
                    .get("snippet")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )))
        }
        ("microsoft", "calendar_list") => {
            let (from, to) = window(args);
            let url = format!("{GRAPH}/me/calendarView?startDateTime={}&endDateTime={}&$top=25&$orderby=start/dateTime&$select=id,subject,start,end,location,webLink,attendees", enc(&from), enc(&to));
            let value = get_json(&token, &url).await?;
            let items = value.get("value").cloned().unwrap_or(json!([]));
            let query = arg(args, "query").to_lowercase();
            let events: Vec<Value> = events_from_graph(&items)
                .into_iter()
                .filter(|event| {
                    query.is_empty()
                        || event
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&query)
                })
                .collect();
            Ok(
                json!({"content":[{"type":"text","text": events_text(&events)}], "structuredContent": {"events": events}}),
            )
        }
        ("microsoft", "calendar_create") => {
            let mut event = json!({
                "subject": arg(args, "title"),
                "start": {"dateTime": arg(args, "start"), "timeZone": "UTC"},
                "end": {"dateTime": arg(args, "end"), "timeZone": "UTC"},
            });
            if !arg(args, "description").is_empty() {
                event["body"] = json!({"contentType": "text", "content": arg(args, "description")});
            }
            if let Some(attendees) = args.get("attendees").and_then(Value::as_array) {
                event["attendees"] = Value::Array(
                    attendees
                        .iter()
                        .filter_map(Value::as_str)
                        .take(50)
                        .map(
                            |email| json!({"emailAddress": {"address": email}, "type": "required"}),
                        )
                        .collect(),
                );
            }
            let created = post_json(&token, &format!("{GRAPH}/me/events"), &event).await?;
            let link = created
                .get("webLink")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(json!({"content":[
                {"type":"text","text": format!("Created \"{}\".", arg(args, "title"))},
                {"type":"resource_link","name": arg(args, "title"),"uri": link}
            ]}))
        }
        ("microsoft", "mail_search") => {
            let url = format!("{GRAPH}/me/messages?$top=10&$select=id,subject,from,receivedDateTime,bodyPreview,webLink&$search={}", enc(&format!("\"{}\"", arg(args, "query").replace('"', ""))));
            let value = get_json(&token, &url).await?;
            let messages = value
                .get("value")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Ok(text_result(if messages.is_empty() {
                "No message matches.".into()
            } else {
                messages
                    .iter()
                    .map(|message| {
                        format!(
                            "- {} | {} | {} (id {})\n  {}",
                            message
                                .get("receivedDateTime")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            message
                                .pointer("/from/emailAddress/address")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            message
                                .get("subject")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            message
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            message
                                .get("bodyPreview")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .chars()
                                .take(200)
                                .collect::<String>()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        ("microsoft", "mail_read") => {
            let id = safe_id(arg(args, "message_id"))?;
            let url = format!(
                "{GRAPH}/me/messages/{id}?$select=subject,from,toRecipients,receivedDateTime,body"
            );
            let body = send(
                client()
                    .get(&url)
                    .bearer_auth(token.expose_str())
                    .header("Prefer", "outlook.body-content-type=\"text\""),
                &url,
                "GET",
            )
            .await?;
            let value: Value = serde_json::from_slice(&body).map_err(|_| api_error(502))?;
            Ok(text_result(clip(&format!(
                "{}\nFrom: {}\nReceived: {}\n\n{}",
                value
                    .get("subject")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                value
                    .pointer("/from/emailAddress/address")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                value
                    .get("receivedDateTime")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                value
                    .pointer("/body/content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ))))
        }
        ("microsoft", "onedrive_search") => {
            let q = arg(args, "query").replace('\'', "''");
            let url = format!("{GRAPH}/me/drive/root/search(q='{}')?$top=10&$select=id,name,webUrl,lastModifiedDateTime", enc(&q));
            let value = get_json(&token, &url).await?;
            let items = value
                .get("value")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut content = vec![
                json!({"type":"text","text": if items.is_empty() { "No file matches.".to_string() } else {
                    items.iter().map(|item| format!("- {} (id {}, {})",
                        item.get("name").and_then(Value::as_str).unwrap_or_default(),
                        item.get("id").and_then(Value::as_str).unwrap_or_default(),
                        item.get("lastModifiedDateTime").and_then(Value::as_str).unwrap_or_default())).collect::<Vec<_>>().join("\n")
                }}),
            ];
            for item in items.iter().take(6) {
                if let (Some(name), Some(link)) = (
                    item.get("name").and_then(Value::as_str),
                    item.get("webUrl").and_then(Value::as_str),
                ) {
                    content.push(json!({"type":"resource_link","name": name,"uri": link}));
                }
            }
            Ok(json!({"content": content}))
        }
        ("microsoft", "onedrive_read") => {
            let id = safe_id(arg(args, "item_id"))?;
            let meta = get_json(&token, &format!("{GRAPH}/me/drive/items/{id}?$select=id,name,size,file,@microsoft.graph.downloadUrl")).await?;
            let name = meta
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_string();
            let mime = meta
                .pointer("/file/mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let download = meta
                .get("@microsoft.graph.downloadUrl")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let url = onedrive_download(download)?;
            // A pre-signed address: it carries its own authorization, so the
            // bearer is not sent to it.
            let bytes = send(client().get(url.clone()), url.as_str(), "GET").await?;
            Ok(text_result(format!(
                "{name}\n\n{}",
                readable(&name, &mime, bytes)?
            )))
        }
        _ => Err(AppError::new(
            "connector_tool_unknown",
            "This connector has no such tool.",
        )),
    }
}

/// The download address Graph gives for a file: https on Microsoft's own
/// storage hosts only.
pub fn onedrive_download(raw: &str) -> Result<reqwest::Url, AppError> {
    let refused = || AppError::new("connector_missing", "The service could not find that item.");
    let url = reqwest::Url::parse(raw).map_err(|_| refused())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let microsoft = [
        ".sharepoint.com",
        ".1drv.com",
        ".onedrive.com",
        ".livefilestore.com",
    ]
    .iter()
    .any(|suffix| host.ends_with(suffix));
    if url.scheme() != "https" || !microsoft {
        return Err(refused());
    }
    Ok(url)
}

fn google_export_type(mime: &str) -> Option<&'static str> {
    match mime {
        "application/vnd.google-apps.document" => Some("text/plain"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        _ => None,
    }
}

/// Calendar events in one shape for both providers, which the triggers read:
/// `{id, title, start, end, link}`.
pub fn events_from_google(items: &Value) -> Vec<Value> {
    items
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "id": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "title": item.get("summary").and_then(Value::as_str).unwrap_or_default(),
                        "start": item.pointer("/start/dateTime").or_else(|| item.pointer("/start/date")).and_then(Value::as_str).unwrap_or_default(),
                        "end": item.pointer("/end/dateTime").or_else(|| item.pointer("/end/date")).and_then(Value::as_str).unwrap_or_default(),
                        "link": item.get("htmlLink").and_then(Value::as_str).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn events_from_graph(items: &Value) -> Vec<Value> {
    items
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "id": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "title": item.get("subject").and_then(Value::as_str).unwrap_or_default(),
                        "start": item.pointer("/start/dateTime").and_then(Value::as_str).unwrap_or_default(),
                        "end": item.pointer("/end/dateTime").and_then(Value::as_str).unwrap_or_default(),
                        "link": item.get("webLink").and_then(Value::as_str).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn google_events_text(items: &Value) -> String {
    events_text(&events_from_google(items))
}

fn events_text(events: &[Value]) -> String {
    if events.is_empty() {
        return "No event in that window.".into();
    }
    events
        .iter()
        .map(|event| {
            format!(
                "- {} to {}: {}",
                event
                    .get("start")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                event.get("end").and_then(Value::as_str).unwrap_or_default(),
                event
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
