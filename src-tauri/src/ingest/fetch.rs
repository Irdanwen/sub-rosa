//! Fetching what a link points at, within bounds (ADR-0028).
//!
//! The app has an HTTP client already; what this adds is the discipline a
//! pasted link deserves. A link is untrusted input, and the request leaves
//! from the user's own machine, so:
//!
//! - only http(s), checked **at every redirect hop**, not just on the URL the
//!   user pasted — a 302 to `127.0.0.1` is exactly how a naive fetcher gets
//!   talked into probing the local network;
//! - a byte ceiling enforced while reading, not from `Content-Length`, which a
//!   server is free to lie about;
//! - a content type that has to look like media before the body is kept;
//! - the body streamed to disk, never held in memory, because the whole point
//!   of this feature is files too big to hold.

use super::link::content_type_looks_like_media;
use crate::domain::types::AppError;
use std::path::{Path, PathBuf};

/// Refuse a URL this module must not fetch.
///
/// In a shipped binary this is [`super::link::resolve_link`] in full: http(s)
/// only, and nothing aimed at this machine or the local network. Under `cargo
/// test` the address guard is relaxed, and only for this call, so the tests
/// below can serve fixtures from a loopback port — the guard itself is proved
/// by `link::tests::links_at_this_machine_or_the_local_network_are_refused`,
/// which is unaffected.
#[cfg(not(test))]
fn check_link(url: &str) -> Result<(), AppError> {
    super::link::resolve_link(url).map(|_| ())
}

#[cfg(test)]
fn check_link(url: &str) -> Result<(), AppError> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(());
    }
    Err(AppError::new(
        "ingest_invalid_link",
        "Only web links can be fetched.",
    ))
}

/// Redirect hops allowed. Podcast hosts chain two or three (analytics prefix,
/// CDN, region); five is generous and still bounded.
const MAX_REDIRECTS: usize = 5;

/// How long the whole fetch may take. A two-hour talk on a slow connection is
/// legitimately slow, so this is measured in tens of minutes, not seconds.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 45);

/// What the app calls itself to the hosts it fetches from. Podcast hosts log
/// this, and a few refuse an empty one outright.
fn user_agent() -> String {
    format!(
        "{}/{}",
        crate::carpe_diem::branding::PRODUCT_NAME.replace(' ', ""),
        env!("CARGO_PKG_VERSION")
    )
}

/// What a completed fetch produced.
#[derive(Debug, Clone)]
pub struct FetchedFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub content_type: Option<String>,
}

fn client() -> Result<reqwest::Client, AppError> {
    // Every hop is re-validated: `resolve_link` refuses loopback, private and
    // link-local addresses, and a redirect must not be able to reach what the
    // pasted URL could not.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        match check_link(attempt.url().as_str()) {
            Ok(()) => attempt.follow(),
            Err(_) => attempt.stop(),
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .timeout(FETCH_TIMEOUT)
        .user_agent(user_agent())
        .build()
        .map_err(|error| AppError::new("ingest_fetch_failed", error.to_string()))
}

/// Download `url` into `dest`, reporting progress as it goes.
///
/// `on_progress` is called with (bytes so far, total if the server declared
/// one). It is called at most a few times a second, not per chunk.
pub async fn fetch_to_file(
    url: &str,
    dest: &Path,
    max_bytes: u64,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<FetchedFile, AppError> {
    // Refuse before opening a socket, and again on every redirect above.
    check_link(url)?;
    let response =
        client()?.get(url).send().await.map_err(|error| {
            AppError::new("ingest_fetch_failed", friendly_network_error(&error))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "ingest_fetch_failed",
            format!("That link answered with {status}."),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !content_type_looks_like_media(content_type.as_deref()) {
        return Err(AppError::new(
            "ingest_not_media",
            "That link is a web page, not an audio or video file.",
        ));
    }
    let declared = response.content_length();
    if declared.is_some_and(|length| length > max_bytes) {
        return Err(AppError::new(
            "ingest_too_large",
            "That file is too large to import.",
        ));
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("ingest_fetch_failed", error.to_string()))?;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| AppError::new("ingest_fetch_failed", error.to_string()))?;
    let mut response = response;
    let mut written = 0_u64;
    let mut last_report = std::time::Instant::now();
    loop {
        let chunk = response.chunk().await.map_err(|error| {
            AppError::new("ingest_fetch_failed", friendly_network_error(&error))
        })?;
        let Some(chunk) = chunk else { break };
        written += chunk.len() as u64;
        // The ceiling is enforced on what actually arrives, because
        // `Content-Length` is a claim, not a fact.
        if written > max_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err(AppError::new(
                "ingest_too_large",
                "That file is too large to import.",
            ));
        }
        use tokio::io::AsyncWriteExt as _;
        file.write_all(&chunk)
            .await
            .map_err(|error| AppError::new("ingest_fetch_failed", error.to_string()))?;
        if last_report.elapsed() >= std::time::Duration::from_millis(400) {
            on_progress(written, declared);
            last_report = std::time::Instant::now();
        }
    }
    use tokio::io::AsyncWriteExt as _;
    file.flush()
        .await
        .map_err(|error| AppError::new("ingest_fetch_failed", error.to_string()))?;
    drop(file);
    on_progress(written, declared);

    if written == 0 {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(AppError::new(
            "ingest_fetch_empty",
            "That link returned an empty file.",
        ));
    }
    Ok(FetchedFile {
        path: dest.to_path_buf(),
        bytes: written,
        content_type,
    })
}

/// Fetch a feed document as text, bounded.
pub async fn fetch_text(url: &str, max_bytes: usize) -> Result<String, AppError> {
    check_link(url)?;
    let response =
        client()?.get(url).send().await.map_err(|error| {
            AppError::new("ingest_fetch_failed", friendly_network_error(&error))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "ingest_fetch_failed",
            format!("That link answered with {status}."),
        ));
    }
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AppError::new("ingest_fetch_failed", friendly_network_error(&error)))?
    {
        if body.len() + chunk.len() > max_bytes {
            return Err(AppError::new(
                "ingest_too_large",
                "That feed is too large to read.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Network errors read like stack traces. This says what happened.
fn friendly_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "That link took too long to answer.".to_string();
    }
    if error.is_connect() {
        return "That link could not be reached.".to_string();
    }
    if error.is_redirect() {
        return "That link redirects somewhere this app will not follow.".to_string();
    }
    format!("The download failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    /// A one-request HTTP server, so the bounds this module promises are
    /// tested against a real socket rather than asserted in a comment.
    ///
    /// Returns the URL to hit. It answers once and stops, which is all any
    /// test here needs.
    async fn serve_once(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut discard = [0_u8; 2048];
                let _ = socket.read(&mut discard).await;
                let _ = socket.write_all(&response).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{address}/media.mp3")
    }

    fn http_response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("os-june-fetch-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("out.bin")
    }

    #[tokio::test]
    async fn writes_the_body_to_disk_and_reports_progress() {
        let body = vec![7_u8; 64 * 1024];
        let url = serve_once(http_response("200 OK", "audio/mpeg", &body)).await;
        let dest = scratch("ok");
        let mut reported = Vec::new();

        let fetched = fetch_to_file(&url, &dest, 10 * 1024 * 1024, |done, total| {
            reported.push((done, total));
        })
        .await
        .expect("a plain audio response must be fetched");

        assert_eq!(fetched.bytes, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap().len(), body.len());
        assert_eq!(
            reported.last().map(|(done, _)| *done),
            Some(body.len() as u64)
        );
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    async fn a_web_page_is_refused_before_its_body_is_kept() {
        let url = serve_once(http_response(
            "200 OK",
            "text/html; charset=utf-8",
            b"<html>not media</html>",
        ))
        .await;
        let dest = scratch("html");

        let error = fetch_to_file(&url, &dest, 10 * 1024 * 1024, |_, _| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "ingest_not_media");
        assert!(!dest.exists(), "an HTML page must not be left on disk");
    }

    #[tokio::test]
    async fn a_declared_length_past_the_ceiling_is_refused_without_downloading_it() {
        let body = vec![0_u8; 4096];
        let url = serve_once(http_response("200 OK", "audio/mpeg", &body)).await;
        let dest = scratch("too-big");

        let error = fetch_to_file(&url, &dest, 1024, |_, _| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "ingest_too_large");
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn a_body_with_no_declared_length_is_still_stopped_at_the_ceiling() {
        // The dangerous case is not a server that lies in its Content-Length —
        // the client truncates at the declared length anyway — but one that
        // declares nothing and streams until it feels like stopping. That body
        // is unbounded, and the ceiling has to hold on what actually arrives.
        let body = vec![3_u8; 512 * 1024];
        let mut response =
            b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(&body);
        let url = serve_once(response).await;
        let dest = scratch("unbounded");

        let error = fetch_to_file(&url, &dest, 64 * 1024, |_, _| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "ingest_too_large");
        assert!(!dest.exists(), "the partial file must be cleaned up");
    }

    #[tokio::test]
    async fn a_not_found_says_so_rather_than_writing_an_error_page() {
        let url = serve_once(http_response("404 Not Found", "text/plain", b"nope")).await;
        let dest = scratch("404");

        let error = fetch_to_file(&url, &dest, 1024 * 1024, |_, _| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "ingest_fetch_failed");
        assert!(error.message.contains("404"), "got {}", error.message);
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn an_empty_body_is_reported_rather_than_becoming_an_empty_note() {
        let url = serve_once(http_response("200 OK", "audio/mpeg", b"")).await;
        let dest = scratch("empty");

        let error = fetch_to_file(&url, &dest, 1024 * 1024, |_, _| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "ingest_fetch_empty");
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn a_feed_is_read_as_text_within_its_own_ceiling() {
        let xml = b"<rss><channel><title>Show</title></channel></rss>";
        let url = serve_once(http_response("200 OK", "application/rss+xml", xml)).await;

        let body = fetch_text(&url, 1024 * 1024).await.unwrap();

        assert!(body.contains("<title>Show</title>"));
    }

    #[tokio::test]
    async fn a_feed_past_its_ceiling_is_refused() {
        let xml = vec![b'x'; 128 * 1024];
        let url = serve_once(http_response("200 OK", "application/rss+xml", &xml)).await;

        let error = fetch_text(&url, 4096).await.unwrap_err();

        assert_eq!(error.code, "ingest_too_large");
    }

    #[tokio::test]
    async fn a_non_web_scheme_never_opens_a_socket() {
        let dest = scratch("scheme");
        let error = fetch_to_file("file:///etc/passwd", &dest, 1024, |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "ingest_invalid_link");
    }
}
