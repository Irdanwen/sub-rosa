//! What a "site" is, for consent: the registrable domain of a URL.
//!
//! The person allows `example.co.uk`, not `www.example.co.uk/path`, so a
//! visit to `shop.example.co.uk` is covered and a visit to
//! `example-login.com` is not. There is no public-suffix list in the binary;
//! the multi-label suffixes below are the ones a person in Europe or North
//! America meets, and a suffix missing here errs on the strict side (the
//! person is asked about `city.example`, never let through to a neighbour).

use url::{Host, Url};

/// Second-level labels that are public suffixes under some country codes
/// (`co.uk`, `com.au`, `gouv.fr`...). Checked only under a two-letter TLD.
const SECOND_LEVEL_SUFFIXES: &[&str] = &[
    "ac", "co", "com", "edu", "gov", "gouv", "net", "org", "ne", "or", "go", "gv", "ltd", "plc",
    "nhs", "police", "sch", "mil", "nom", "asso", "admin",
];

/// Whole suffixes that are public although their shape is unusual.
const KNOWN_SUFFIXES: &[&str] = &[
    "github.io",
    "gitlab.io",
    "pages.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "blogspot.com",
    "appspot.com",
    "azurewebsites.net",
    "cloudfront.net",
    "web.app",
    "firebaseapp.com",
];

/// Whether `url` may be opened at all: http and https only. `file:`,
/// `chrome:`, `javascript:` and `data:` would reach the person's disk or the
/// browser's own settings rather than a site.
pub fn openable(url: &str) -> bool {
    parse_web(url).is_some()
}

/// `url` parsed the way the browser parses it (the WHATWG URL standard, which
/// the `url` crate implements), when it is an http(s) address with a host.
/// Reading the host by hand is how `https://evil.example\@allowed.example/`
/// came to look like `allowed.example`: for a browser `\` ends the host, so
/// that address opens `evil.example`.
fn parse_web(url: &str) -> Option<Url> {
    let parsed = Url::parse(url.trim()).ok()?;
    (matches!(parsed.scheme(), "http" | "https") && parsed.host().is_some()).then_some(parsed)
}

/// The host of an http(s) URL as the browser will contact it: lowercased,
/// IDN in its ASCII form, without port, credentials or trailing dot.
pub fn host_of(url: &str) -> Option<String> {
    let parsed = parse_web(url)?;
    let host = match parsed.host()? {
        Host::Domain(domain) => domain.to_string(),
        Host::Ipv4(address) => address.to_string(),
        // An IPv6 literal keeps its brackets off.
        Host::Ipv6(address) => address.to_string(),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// The registrable domain consent is given for.
pub fn site_of(url: &str) -> Option<String> {
    let host = host_of(url)?;
    Some(registrable_domain(&host))
}

pub fn registrable_domain(host: &str) -> String {
    // An address is its own site: there is nothing above it to share.
    if host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') {
        return host.to_string();
    }
    for suffix in KNOWN_SUFFIXES {
        if let Some(prefix) = host.strip_suffix(suffix) {
            if let Some(prefix) = prefix.strip_suffix('.') {
                let label = prefix.rsplit('.').next().unwrap_or(prefix);
                return format!("{label}.{suffix}");
            }
        }
    }
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    if n >= 3 && labels[n - 1].len() == 2 && SECOND_LEVEL_SUFFIXES.contains(&labels[n - 2]) {
        return labels[n - 3..].join(".");
    }
    labels[n.saturating_sub(2)..].join(".")
}

/// What the gate decides before a page of `site` is touched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Ask,
}

/// `allowed` is the durable list from Settings; `this_session` holds the
/// "only this time" answers, forgotten when the browser closes.
pub fn decide(site: &str, allowed: &[String], this_session: &[String]) -> Decision {
    let matches = |entry: &String| entry.eq_ignore_ascii_case(site);
    if allowed.iter().any(matches) || this_session.iter().any(matches) {
        Decision::Allowed
    } else {
        Decision::Ask
    }
}

/// Normalises what the person typed into the allow list (`https://www.x.com/`
/// becomes `x.com`), or `None` when it is not a site.
pub fn normalise_entry(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = if openable(trimmed) {
        trimmed.to_string()
    } else {
        // Parsed, never fetched: the scheme only lets `site_of` read the host.
        ["https://", trimmed.trim_start_matches("//")].concat()
    };
    let site = site_of(&url)?;
    let valid = site
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    (valid && site.contains('.')).then_some(site)
}
