//! Where this binary is allowed to send bytes.
//!
//! "Your prompts do not go anywhere else" is the product. It was an argument
//! about architecture — true, and unmeasured. The audit proposed proving it by
//! diverting DNS to a collector and exercising every flow; that test is green
//! whenever a flow simply fails to run, which is the worst property a security
//! test can have.
//!
//! This is the static version, and it holds for a reason the runtime one does
//! not: an HTTP client that is never built cannot send anything, so if every
//! client comes from `http_client` and every destination is a declared
//! constant, the set of reachable hosts is the set below. Adding a destination
//! then means editing this file, in the same commit, where a reviewer sees it.

use std::path::Path;

// The list itself lives in `src/egress.rs`, not here: the Privacy screen in
// Settings renders the same rows, so a destination that fails this test is also
// one the user would never have been shown. Two copies would let those drift.
use os_june_lib::egress::{Reach, DECLARED_EGRESS};

/// Files allowed to build a `reqwest::Client` outside `http_client`, and why.
fn client_factory_exempt(path: &str) -> bool {
    // The import fetcher's policy is STRICTER than the shared one: it
    // re-validates every redirect target against the SSRF preflight
    // (`ingest/link.rs`), which the shared factory cannot express because it
    // does not know about import links. Weakening it to use the factory would
    // be a downgrade.
    path.ends_with("ingest/fetch.rs") || path.ends_with("http_client.rs")
}

fn rust_sources(dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            if let Ok(source) = std::fs::read_to_string(&path) {
                out.push((path.display().to_string().replace('\\', "/"), source));
            }
        }
    }
}

/// The source with `#[cfg(test)]` modules and comment lines removed.
///
/// Fixtures are the bulk of the host names in this crate — `cdn.example.com`,
/// `auth.linear.app`, `192.168.1.10` — and they are exactly the strings a test
/// SHOULD contain. Scanning them would make this file a list of test data.
fn shipping_code(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut depth: i32 = 0;
    let mut in_test_module = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if !in_test_module && trimmed.starts_with("#[cfg(test)]") {
            in_test_module = true;
            depth = 0;
            continue;
        }
        if in_test_module {
            depth += line.matches('{').count() as i32;
            depth -= line.matches('}').count() as i32;
            if depth <= 0 && line.contains('}') {
                in_test_module = false;
            }
            continue;
        }
        if trimmed.starts_with("//") || trimmed.starts_with("*") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Host names appearing in `https://…` / `http://…` literals.
fn hosts_in(source: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for (index, _) in source.match_indices("://") {
        let before = &source[..index];
        if !(before.ends_with("https") || before.ends_with("http")) {
            continue;
        }
        let rest = &source[index + 3..];
        let host: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        // A host with no dot is not a host: it is `{base}`, a truncated
        // fixture, or a scheme-relative fragment.
        if !host.contains('.') {
            continue;
        }
        hosts.push(host.trim_matches('.').to_ascii_lowercase());
    }
    hosts.retain(|host| !host.is_empty());
    hosts.sort();
    hosts.dedup();
    hosts
}

fn is_declared(host: &str) -> bool {
    DECLARED_EGRESS.iter().any(|entry| host == entry.host)
}

/// Hosts that appear in source but are not destinations: documentation links,
/// XML namespaces, licence URLs, schema identifiers.
fn not_a_destination(host: &str) -> bool {
    const NON_DESTINATIONS: &[&str] = &[
        "localhost",
        "example.com",
        "example.org",
        "www.w3.org",
        "schema.tauri.app",
        "docs.rs",
        "rustsec.org",
        "developer.apple.com",
        "developer.mozilla.org",
        "www.rfc-editor.org",
        "datatracker.ietf.org",
        "creativecommons.org",
        "www.gnu.org",
        "opensource.org",
        "spdx.org",
        "purl.org",
        "ns.adobe.com",
        "www.apple.com",
        "itunes.apple.com",
        "rss.applemarketingtools.com",
        // The Windows webview's own origin, patched into a Hermes config file.
        // It is what the app is called, not somewhere it goes.
        "tauri.localhost",
    ];
    NON_DESTINATIONS.contains(&host)
        || host.ends_with(".local")
        || host.starts_with("127.")
        || host.starts_with("0.0.0.0")
        || host == "[::1]"
        || host == "::1"
}

#[test]
fn every_http_client_comes_from_the_shared_factory() {
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);
    assert!(sources.len() > 40, "the scan is looking in the wrong place");

    let mut offenders = Vec::new();
    for (path, source) in &sources {
        if client_factory_exempt(path) {
            continue;
        }
        for (index, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("///") {
                continue;
            }
            if line.contains("reqwest::Client::builder()")
                || line.contains("reqwest::Client::new()")
            {
                offenders.push(format!("{path}:{}: {}", index + 1, line.trim()));
            }
        }
    }

    assert_eq!(
        offenders,
        Vec::<String>::new(),
        "build clients through `crate::http_client` so the redirect policy, the \
         timeout, and the inventory in this file all still mean something."
    );
}

#[test]
fn no_undeclared_host_appears_in_the_source() {
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);

    let mut undeclared: Vec<String> = Vec::new();
    for (path, source) in &sources {
        for host in hosts_in(&shipping_code(source)) {
            if is_declared(&host) || not_a_destination(&host) {
                continue;
            }
            undeclared.push(format!("{host}  ({path})"));
        }
    }
    undeclared.sort();
    undeclared.dedup();

    assert_eq!(
        undeclared,
        Vec::<String>::new(),
        "a new outbound destination must be declared in DECLARED_EGRESS with a \
         reason, or listed as not-a-destination if it is a documentation link. \
         The settings screen reads the same list, so an undeclared host would \
         also be one the user is never shown."
    );
}

/// Sites that build a URL whose host is not a literal, and why each is
/// nevertheless bounded. Every entry names what decides the host.
fn computed_host_is_accounted_for(path: &str, line: &str) -> bool {
    // A pasted import link with no scheme. The host is the user's, and every
    // one of them goes through `validate_public_http_url` in june-api: HTTPS,
    // then a DNS preflight requiring every resolved address to be public.
    if path.ends_with("ingest/link.rs") && line.contains("format!(\"https://{trimmed}\")") {
        return true;
    }
    // The configured Carpe Diem base, bounded by `validate_base_url` (https
    // outside loopback) and shown to the user on the Privacy screen.
    if line.contains("base_url()") || line.contains("catalog_base_url()") || line.contains("{base}")
    {
        return true;
    }
    // A media file the backend told us to fetch, often a signed CDN URL on
    // another host. The key is attached only when the host matches the
    // backend's (`same_host`), so a redirect elsewhere carries no credential.
    if path.ends_with("carpe_diem/media.rs") && line.contains("resolve_media_url") {
        return true;
    }
    false
}

/// The hole the literal scan leaves: `format!("https://{host}/x")` names no
/// host, so the scan above cannot see it. This does not try to prove such a
/// site is safe — it makes it impossible to add one without saying where the
/// host comes from.
#[test]
fn every_computed_host_says_what_decides_it() {
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);

    let mut unaccounted = Vec::new();
    for (path, source) in &sources {
        for (index, line) in shipping_code(source).lines().enumerate() {
            // An http(s) scheme immediately followed by an interpolation is a
            // host this file cannot read. Other schemes are not egress:
            // `sqlite://` names a file, `ipc:` names the webview bridge.
            let computed = line.contains("http://{")
                || line.contains("https://{")
                || line.contains("ws://{")
                || line.contains("wss://{");
            if !computed {
                continue;
            }
            if computed_host_is_accounted_for(path, line) {
                continue;
            }
            unaccounted.push(format!("{path}:{}: {}", index + 1, line.trim()));
        }
    }

    assert_eq!(
        unaccounted,
        Vec::<String>::new(),
        "this URL's host is computed, so DECLARED_EGRESS cannot see it. Add a \
         row to `computed_host_is_accounted_for` naming what bounds the host, \
         or build the URL from a declared constant."
    );
}

#[test]
fn the_computed_host_scan_can_see_one() {
    // The guard above is worthless if the pattern never matches.
    let sample = "let url = format!(\"https://{host}/collect\");";
    assert!(sample.contains("https://{"));
    // And that a database path is not mistaken for a destination.
    assert!(!"format!(\"sqlite://{}\", path.display())".contains("https://{"));
    assert!(!computed_host_is_accounted_for("src/telemetry.rs", sample));
}

#[test]
fn the_declared_list_is_the_one_the_user_reads() {
    // Shape assertions live next to the constant, in `src/egress.rs`. What
    // belongs here is the link between the two: every host in the source is in
    // the list, and the list is what the settings screen renders.
    assert!(DECLARED_EGRESS.len() >= 8, "the list looks truncated");
    assert!(DECLARED_EGRESS
        .iter()
        .any(|entry| entry.reach == Reach::Always));
    assert!(DECLARED_EGRESS
        .iter()
        .any(|entry| entry.reach == Reach::WhenAsked));
}

#[test]
fn the_scanner_can_see_a_host_when_there_is_one() {
    // A scan that silently matched nothing would pass forever.
    let sample = r#"let url = "https://telemetry.example.net/collect";"#;
    assert_eq!(hosts_in(sample), vec!["telemetry.example.net".to_string()]);
    assert!(!is_declared("telemetry.example.net"));
    assert!(!not_a_destination("telemetry.example.net"));
}
