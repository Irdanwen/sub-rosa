//! What travels between the extension and the app (ADR-0100).
//!
//! The browser's native messaging framing on both legs: a 32-bit length in
//! the machine's byte order, then that many bytes of UTF-8 JSON. The relay
//! copies frames between the browser and the app without reading them, so
//! the app is the only place a message is parsed, and this file is the only
//! place it is described. `browser-extension/src/protocol.js` is the other
//! half; the vitest suite there pins the same shapes.
//!
//! Every request carries an `id` the extension chose; every reply to it
//! carries the same `id`, so one connection can stream an answer while a
//! cancel or a save goes through. Version 1, sent as `v`; a request from a
//! newer extension is refused by name rather than half understood.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;

/// Largest frame the app reads. A page's text is capped well under it by
/// the extension ([`MAX_PAGE_CHARS`] UTF-8 characters is at most 240 KB).
pub const MAX_INCOMING_FRAME: usize = 1024 * 1024;
/// Chrome refuses a message from a host above 1 MB; the app stays far below.
pub const MAX_OUTGOING_TEXT_BYTES: usize = 256 * 1024;

pub const MAX_PAGE_CHARS: usize = 60_000;
pub const MAX_SELECTION_CHARS: usize = 20_000;
pub const MAX_QUESTION_CHARS: usize = 4_000;
pub const MAX_TITLE_CHARS: usize = 300;
pub const MAX_URL_CHARS: usize = 2_048;
/// The longest thing "Add to a note" keeps from one click.
pub const MAX_NOTE_TEXT_CHARS: usize = 100_000;

/// Reads one frame. `Ok(None)` is a clean end of stream between frames.
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame of {length} bytes is over the {max} byte limit"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Writes one frame and flushes it: the browser reads a message only once
/// all of it has arrived.
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    body: &[u8],
) -> std::io::Result<()> {
    let length = u32::try_from(body.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&length.to_ne_bytes()).await?;
    writer.write_all(body).await?;
    writer.flush().await
}

/// The page as the extension read it, on the click that asked for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub selection: String,
}

/// Every request the extension can make, and the relay's opening frame.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    /// Written by the relay before any browser frame: who launched it, as the
    /// browser told it on the command line. The extension cannot forge it.
    Origin {
        origin: String,
    },
    Hello {
        id: String,
        #[serde(default)]
        token: Option<String>,
    },
    Pair {
        id: String,
        code: String,
        #[serde(default)]
        browser: Option<String>,
    },
    Ask {
        id: String,
        token: String,
        question: String,
        #[serde(default)]
        page: Option<Page>,
        #[serde(default)]
        conversation_id: Option<String>,
    },
    AddToNote {
        id: String,
        token: String,
        page: Page,
        #[serde(default)]
        text: String,
    },
    SaveLink {
        id: String,
        token: String,
        page: Page,
    },
    Cancel {
        id: String,
        token: String,
        conversation_id: String,
    },
    Unpair {
        id: String,
        token: String,
    },
}

/// Everything the app sends back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Response {
    Hello {
        id: String,
        paired: bool,
        protocol: u32,
        app_version: String,
    },
    Paired {
        id: String,
        token: String,
    },
    /// The chat the question was filed as, before the first word arrives.
    Started {
        id: String,
        conversation_id: String,
    },
    Status {
        id: String,
        stage: String,
    },
    Delta {
        id: String,
        text: String,
    },
    /// Take back the last `count` UTF-16 units shown (a stream the app had to
    /// replay). JavaScript string lengths count the same units.
    Retract {
        id: String,
        count: usize,
    },
    Done {
        id: String,
        conversation_id: String,
        text: String,
    },
    Saved {
        id: String,
        kind: String,
        item_id: String,
        title: String,
    },
    Unpaired {
        id: String,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        code: String,
        message: String,
    },
}

impl Response {
    pub fn error(id: Option<&str>, code: &str, message: &str) -> Self {
        Self::Error {
            id: id.map(str::to_string),
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        // A Response is plain strings and numbers; serialising cannot fail.
        serde_json::to_vec(self).unwrap_or_default()
    }
}

/// Why a frame was not a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed {
    pub id: Option<String>,
    pub code: &'static str,
}

/// Parses one frame. The version is checked before the shape, so a newer
/// extension hears "update the app" and not "malformed".
pub fn parse_request(frame: &[u8]) -> Result<Request, Malformed> {
    let value: serde_json::Value = serde_json::from_slice(frame).map_err(|_| Malformed {
        id: None,
        code: "malformed",
    })?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let version = value
        .get("v")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::from(PROTOCOL_VERSION));
    if version != u64::from(PROTOCOL_VERSION) {
        return Err(Malformed {
            id,
            code: "unsupported_version",
        });
    }
    serde_json::from_value(value).map_err(|_| Malformed {
        id,
        code: "malformed",
    })
}

/// The first `max` characters of `text`, trimmed.
pub fn clip(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// The longest prefix of `text` within `max` UTF-8 bytes, cut on a character
/// boundary.
pub fn clip_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A page the app agrees to read: an http(s) address, bounded fields.
pub fn clean_page(page: &Page) -> Option<Page> {
    let url = page.url.trim();
    if url.chars().count() > MAX_URL_CHARS {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    let title = clip(&page.title, MAX_TITLE_CHARS);
    Some(Page {
        url: parsed.to_string(),
        title: if title.is_empty() {
            parsed.host_str().unwrap_or_default().to_string()
        } else {
            title
        },
        text: clip(&page.text, MAX_PAGE_CHARS),
        selection: clip(&page.selection, MAX_SELECTION_CHARS),
    })
}

/// The address's host, `www.` dropped, as the Library shows a link.
pub fn domain_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_frame_round_trips_in_the_browsers_framing() {
        let (mut a, mut b) = tokio::io::duplex(64);
        write_frame(&mut a, br#"{"type":"hello","id":"1"}"#)
            .await
            .unwrap();
        drop(a);
        let frame = read_frame(&mut b, MAX_INCOMING_FRAME).await.unwrap();
        assert_eq!(frame.as_deref(), Some(&br#"{"type":"hello","id":"1"}"#[..]));
        // A clean end between frames is not an error.
        assert_eq!(read_frame(&mut b, MAX_INCOMING_FRAME).await.unwrap(), None);
    }

    #[tokio::test]
    async fn the_length_is_native_endian_and_bounded() {
        let mut bytes = 3u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        let mut reader = &bytes[..];
        assert_eq!(
            read_frame(&mut reader, 8).await.unwrap().as_deref(),
            Some(&b"abc"[..])
        );
        let mut huge = 9u32.to_ne_bytes().to_vec();
        huge.extend_from_slice(&[b'x'; 9]);
        let mut reader = &huge[..];
        assert!(read_frame(&mut reader, 8).await.is_err());
    }

    #[test]
    fn requests_parse_with_camel_case_fields() {
        let ask = parse_request(
            br#"{"v":1,"type":"ask","id":"7","token":"t","question":"Why?","conversationId":"c1",
                "page":{"url":"https://example.com/a","title":"A","text":"body"}}"#,
        )
        .unwrap();
        let Request::Ask {
            id,
            conversation_id,
            page,
            ..
        } = ask
        else {
            panic!("not an ask");
        };
        assert_eq!(id, "7");
        assert_eq!(conversation_id.as_deref(), Some("c1"));
        assert_eq!(page.unwrap().selection, "");
    }

    #[test]
    fn a_newer_protocol_is_refused_by_name_with_its_id() {
        let error = parse_request(br#"{"v":2,"type":"ask","id":"9"}"#).unwrap_err();
        assert_eq!(error.code, "unsupported_version");
        assert_eq!(error.id.as_deref(), Some("9"));
        let error = parse_request(br#"{"type":"teleport","id":"3"}"#).unwrap_err();
        assert_eq!(error.code, "malformed");
        assert_eq!(error.id.as_deref(), Some("3"));
        assert_eq!(parse_request(b"not json").unwrap_err().id, None);
    }

    #[test]
    fn responses_serialise_with_the_type_tag() {
        let value: serde_json::Value = serde_json::from_slice(
            &Response::Done {
                id: "1".into(),
                conversation_id: "c".into(),
                text: "Hi".into(),
            }
            .to_bytes(),
        )
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"type":"done","id":"1","conversationId":"c","text":"Hi"})
        );
        let value: serde_json::Value =
            serde_json::from_slice(&Response::error(None, "app_not_running", "x").to_bytes())
                .unwrap();
        assert!(value.get("id").is_none());
    }

    #[test]
    fn only_web_pages_are_read() {
        let page = |url: &str| Page {
            url: url.into(),
            ..Page::default()
        };
        assert!(clean_page(&page("chrome://settings")).is_none());
        assert!(clean_page(&page("file:///Users/me/secret.txt")).is_none());
        assert!(clean_page(&page("javascript:alert(1)")).is_none());
        let cleaned = clean_page(&page("https://www.example.com/path")).unwrap();
        // A page without a title is named after its host.
        assert_eq!(cleaned.title, "www.example.com");
        assert_eq!(domain_of(&cleaned.url), "example.com");
    }

    #[test]
    fn long_fields_are_clipped_not_refused() {
        let page = Page {
            url: "https://example.com".into(),
            title: "t".repeat(MAX_TITLE_CHARS + 50),
            text: "é".repeat(MAX_PAGE_CHARS + 10),
            selection: String::new(),
        };
        let cleaned = clean_page(&page).unwrap();
        assert_eq!(cleaned.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(cleaned.text.chars().count(), MAX_PAGE_CHARS);
        assert_eq!(clip_bytes("aé", 2), "a");
    }
}
