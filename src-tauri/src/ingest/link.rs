//! What a pasted link is, and whether it is safe to fetch (ADR-0028).
//!
//! Three kinds of link, and the difference decides everything downstream:
//!
//! - a **direct media URL** — an MP3, an M4A, an MP4 served over HTTP(S);
//! - a **feed URL** — RSS or Atom, whose enclosure is a direct media URL;
//! - a **platform page** — where the media URL is deliberately not in the
//!   markup and is reconstructed by tools that track the platform week by
//!   week. The app ships no such tool and reimplements none.
//!
//! Everything here is a pure function of the URL string, so it is cheap,
//! deterministic and testable without a network.

use crate::domain::types::AppError;

/// What a link resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    /// Fetch it and decode it.
    DirectMedia,
    /// Parse it, take the enclosure, fetch that.
    Feed,
    /// Reachable only through an extractor the user installed themselves.
    PlatformPage,
}

impl LinkKind {
    pub fn as_db(self) -> &'static str {
        match self {
            LinkKind::DirectMedia => "direct",
            LinkKind::Feed => "feed",
            LinkKind::PlatformPage => "platform",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "feed" => LinkKind::Feed,
            "platform" => LinkKind::PlatformPage,
            _ => LinkKind::DirectMedia,
        }
    }
}

/// File extensions that make a URL a direct media URL on sight.
const MEDIA_EXTENSIONS: &[&str] = &[
    "aac", "aif", "aiff", "caf", "flac", "m4a", "m4b", "m4v", "mka", "mov", "mp3", "mp4", "mpga",
    "oga", "ogg", "ogv", "opus", "wav", "webm",
];

/// Path shapes that mean "this is a feed" even without an extension.
const FEED_HINTS: &[&str] = &[
    "/rss", "/feed", "/feeds/", "rss.xml", "feed.xml", "atom.xml",
];

/// Hosts whose media URLs are not in the page. Not an exhaustive list and not
/// meant to be: it exists so the app can say something useful instead of
/// downloading an HTML page and failing to decode it.
const PLATFORM_HOSTS: &[&str] = &[
    "youtube.com",
    "youtu.be",
    "vimeo.com",
    "dailymotion.com",
    "twitch.tv",
    "soundcloud.com",
    "spotify.com",
    "open.spotify.com",
    "music.apple.com",
    "podcasts.apple.com",
    "tiktok.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "bilibili.com",
    "rumble.com",
    "odysee.com",
];

/// A link that passed validation, with what it turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLink {
    pub url: String,
    pub kind: LinkKind,
    pub host: String,
}

/// Classify and validate a pasted link.
///
/// Refuses anything that is not http(s), anything aimed at the machine itself
/// or the local network, and anything without a host. A pasted link is
/// untrusted input, and this is the only place that is enforced.
pub fn resolve_link(raw: &str) -> Result<ResolvedLink, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("ingest_invalid_link", "Paste a link first."));
    }
    // A scheme without "//" is still a scheme: `data:`, `javascript:` and
    // `mailto:` must be refused rather than quietly turned into a host by the
    // https assumption below.
    if let Some((scheme, _)) = trimmed.split_once(':') {
        let looks_like_a_scheme = !scheme.is_empty()
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
        if looks_like_a_scheme && !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        {
            return Err(AppError::new(
                "ingest_invalid_link",
                "Only web links can be fetched.",
            ));
        }
    }
    // A bare "example.com/talk.mp3" is what people paste; assume https rather
    // than refusing something obviously well-meant.
    let normalized = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let (scheme, rest) = normalized
        .split_once("://")
        .ok_or_else(|| AppError::new("ingest_invalid_link", "That does not look like a link."))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::new(
            "ingest_invalid_link",
            "Only web links can be fetched.",
        ));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host_of(authority);
    if host.is_empty() {
        return Err(AppError::new(
            "ingest_invalid_link",
            "That link has no address to fetch from.",
        ));
    }
    if is_local_address(&host) {
        return Err(AppError::new(
            "ingest_invalid_link",
            "That link points at this machine or your local network.",
        ));
    }

    let path_and_query = rest[authority.len()..].to_ascii_lowercase();
    let kind = classify(&host, &path_and_query);
    Ok(ResolvedLink {
        url: normalized,
        kind,
        host,
    })
}

/// The host inside a URL authority, with userinfo, port and IPv6 brackets
/// removed.
///
/// Getting this wrong is how `https://example.com@127.0.0.1/` reaches the
/// loopback with a reassuring-looking address, and how `http://[::1]/` slips
/// past a check that splits naively on the last colon.
fn host_of(authority: &str) -> String {
    // Everything before the last "@" is userinfo, whatever it looks like.
    let after_userinfo = match authority.rfind('@') {
        Some(index) => &authority[index + 1..],
        None => authority,
    };
    // A bracketed IPv6 literal owns every colon inside the brackets.
    if let Some(rest) = after_userinfo.strip_prefix('[') {
        return rest
            .split(']')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
    }
    after_userinfo
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn classify(host: &str, path_and_query: &str) -> LinkKind {
    // An extension wins over everything: a platform that serves a plain MP3 is
    // just a host serving an MP3.
    if let Some(extension) = path_extension(path_and_query) {
        if MEDIA_EXTENSIONS.contains(&extension.as_str()) {
            return LinkKind::DirectMedia;
        }
        if extension == "xml" || extension == "rss" || extension == "atom" {
            return LinkKind::Feed;
        }
    }
    if PLATFORM_HOSTS
        .iter()
        .any(|platform| host == *platform || host.ends_with(&format!(".{platform}")))
    {
        return LinkKind::PlatformPage;
    }
    if FEED_HINTS.iter().any(|hint| path_and_query.contains(hint)) {
        return LinkKind::Feed;
    }
    // Unknown: try it as media and let the content type have the last word.
    LinkKind::DirectMedia
}

/// The extension of a URL path, ignoring the query string.
pub fn path_extension(path_and_query: &str) -> Option<String> {
    let path = path_and_query.split(['?', '#']).next().unwrap_or_default();
    let last = path.rsplit('/').next()?;
    let (_, extension) = last.rsplit_once('.')?;
    if extension.is_empty()
        || extension.len() > 8
        || !extension.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(extension.to_ascii_lowercase())
}

/// Whether a host names the machine itself or something on the local network.
///
/// The request leaves from the user's own machine, so this is not the classic
/// server-side request forgery, but a link that quietly probes the router or a
/// service on localhost is still not something a paste should be able to do.
fn is_local_address(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return match address {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    // 100.64.0.0/10, carrier-grade NAT, also where Tailscale lives.
                    || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    // fc00::/7 unique-local and fe80::/10 link-local.
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

/// Whether a `Content-Type` header names something worth decoding.
///
/// Servers are careless with this, so `application/octet-stream` and a missing
/// header both pass — the decoder is the real gate. What this stops is
/// downloading an HTML error page and spending a decode on it.
pub fn content_type_looks_like_media(content_type: Option<&str>) -> bool {
    let Some(value) = content_type else {
        return true;
    };
    let value = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if value.is_empty() {
        return true;
    }
    value.starts_with("audio/")
        || value.starts_with("video/")
        || value == "application/octet-stream"
        || value == "binary/octet-stream"
        || value == "application/ogg"
        || value == "application/mp4"
}

/// Whether a `Content-Type` names a feed rather than media.
pub fn content_type_looks_like_feed(content_type: Option<&str>) -> bool {
    let Some(value) = content_type else {
        return false;
    };
    let value = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    value.contains("xml") || value.contains("rss") || value.contains("atom")
}

/// A file name for a fetched URL, for the note title and the extension.
///
/// The result becomes a path on disk, so it is sanitized like one. Splitting
/// on `/` alone is not enough: a backslash is an ordinary character in a URL
/// and a path separator on Windows, so `https://x.com/a\..\..\evil.mp3`
/// would otherwise walk out of the temp directory on exactly one platform.
pub fn file_name_for(url: &str, fallback_extension: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = without_query
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .unwrap_or("download");
    // Drive letters and stream separators are Windows path syntax too.
    let last = last.rsplit(':').next().unwrap_or(last);
    let last = last.trim_start_matches('.');
    let last = if last.is_empty() { "download" } else { last };
    // ".com" in "x.com" is an extension by shape and not one by meaning, so
    // only a known media extension counts as the file already having one.
    let already_named = path_extension(last)
        .is_some_and(|extension| MEDIA_EXTENSIONS.contains(&extension.as_str()));
    if already_named {
        return last.to_string();
    }
    format!("{last}.{fallback_extension}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(url: &str) -> LinkKind {
        resolve_link(url).expect("link should resolve").kind
    }

    #[test]
    fn a_media_extension_makes_it_a_direct_link() {
        assert_eq!(
            kind_of("https://cdn.example.com/ep/42.mp3"),
            LinkKind::DirectMedia
        );
        assert_eq!(
            kind_of("https://example.com/talk.MP4"),
            LinkKind::DirectMedia
        );
        // A query string must not hide the extension.
        assert_eq!(
            kind_of("https://cdn.example.com/ep/42.m4a?token=abc&x=1"),
            LinkKind::DirectMedia
        );
    }

    #[test]
    fn feeds_are_recognised_by_extension_or_by_shape() {
        assert_eq!(
            kind_of("https://example.com/podcast/feed.xml"),
            LinkKind::Feed
        );
        assert_eq!(kind_of("https://example.com/rss"), LinkKind::Feed);
        assert_eq!(
            kind_of("https://feeds.example.com/feeds/show"),
            LinkKind::Feed
        );
    }

    #[test]
    fn platform_pages_are_named_rather_than_attempted() {
        assert_eq!(
            kind_of("https://www.youtube.com/watch?v=abc"),
            LinkKind::PlatformPage
        );
        assert_eq!(kind_of("https://youtu.be/abc"), LinkKind::PlatformPage);
        assert_eq!(
            kind_of("https://open.spotify.com/episode/xyz"),
            LinkKind::PlatformPage
        );
    }

    #[test]
    fn a_platform_host_serving_a_plain_file_is_just_a_file() {
        // The extension is the stronger signal: nothing needs extracting here.
        assert_eq!(
            kind_of("https://cdn.vimeo.com/exports/talk.mp4"),
            LinkKind::DirectMedia
        );
    }

    #[test]
    fn a_bare_host_is_assumed_to_be_https() {
        let resolved = resolve_link("example.com/ep/1.mp3").unwrap();
        assert_eq!(resolved.url, "https://example.com/ep/1.mp3");
    }

    #[test]
    fn links_at_this_machine_or_the_local_network_are_refused() {
        for url in [
            "http://localhost:8080/x.mp3",
            "http://127.0.0.1/x.mp3",
            "https://192.168.1.10/x.mp3",
            "http://10.0.0.5/x.mp3",
            "http://172.16.4.4/x.mp3",
            "http://[::1]/x.mp3",
            "http://router.local/x.mp3",
            "http://169.254.169.254/latest/meta-data",
            "http://100.107.124.23/x.mp3",
        ] {
            let error = resolve_link(url).unwrap_err();
            assert_eq!(
                error.code, "ingest_invalid_link",
                "{url} was allowed through"
            );
        }
    }

    #[test]
    fn userinfo_cannot_smuggle_a_different_host_past_the_check() {
        // "https://example.com@127.0.0.1/x.mp3" resolves to 127.0.0.1.
        let error = resolve_link("https://example.com@127.0.0.1/x.mp3").unwrap_err();
        assert_eq!(error.code, "ingest_invalid_link");
    }

    #[test]
    fn non_web_schemes_are_refused() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x.mp3",
            "data:audio/mp3;base64,AA",
        ] {
            assert_eq!(resolve_link(url).unwrap_err().code, "ingest_invalid_link");
        }
    }

    #[test]
    fn a_careless_content_type_still_passes_because_the_decoder_is_the_real_gate() {
        assert!(content_type_looks_like_media(Some("audio/mpeg")));
        assert!(content_type_looks_like_media(Some(
            "video/mp4; codecs=avc1"
        )));
        assert!(content_type_looks_like_media(Some(
            "application/octet-stream"
        )));
        assert!(content_type_looks_like_media(None));
        // An HTML error page is exactly what this stops.
        assert!(!content_type_looks_like_media(Some(
            "text/html; charset=utf-8"
        )));
        assert!(!content_type_looks_like_media(Some("application/json")));
    }

    #[test]
    fn a_feed_content_type_is_told_apart_from_media() {
        assert!(content_type_looks_like_feed(Some("application/rss+xml")));
        assert!(content_type_looks_like_feed(Some("text/xml")));
        assert!(!content_type_looks_like_feed(Some("audio/mpeg")));
    }

    #[test]
    fn a_file_name_can_never_walk_out_of_the_directory_it_lands_in() {
        // The result is joined onto a temp path, and a backslash is an
        // ordinary URL character that Windows reads as a separator.
        for url in [
            "https://x.com/a\\..\\..\\Windows\\System32\\evil.mp3",
            "https://x.com/../../../etc/passwd.mp3",
            "https://x.com/..",
            "https://x.com/.hidden.mp3",
            "https://x.com/C:\\evil.mp3",
        ] {
            let name = file_name_for(url, "mp3");
            assert!(!name.contains('/'), "{url} -> {name}");
            assert!(!name.contains('\\'), "{url} -> {name}");
            assert!(!name.contains(':'), "{url} -> {name}");
            assert!(!name.starts_with('.'), "{url} -> {name}");
            assert_ne!(name, "..");
        }
    }

    #[test]
    fn a_file_name_survives_a_query_string_and_gains_an_extension_when_it_has_none() {
        assert_eq!(
            file_name_for("https://x.com/ep/42.mp3?t=1", "mp3"),
            "42.mp3"
        );
        assert_eq!(
            file_name_for("https://x.com/download/episode", "m4a"),
            "episode.m4a"
        );
        assert_eq!(file_name_for("https://x.com/", "mp3"), "x.com.mp3");
    }
}
