//! Whether an MCP server's sign-in address may be opened without asking
//! (ADR-0140, review 3, F4, review 4).
//!
//! `hermes mcp login` prints the authorization address it wants opened. A
//! sandboxed sign-in runs under the jail, so the address is the jail's to
//! choose: the app opens it in the browser only when it is a plain address
//! (no user information, no backslash, no control or non-ASCII character
//! before parsing) whose origin is the MCP server's own or one the server
//! declares (RFC 9728 protected-resource metadata, then each authorization
//! server's metadata), and it opens the address as it re-serialized it,
//! never the raw text. The server comes from the app's own record of the
//! person's settings, never from a file the jail writes. A local or private
//! address (`http`, a loopback or private IP) is accepted only when it is
//! the configured server's own host and port. Anything else is shown to the
//! person, who decides.

use std::collections::HashSet;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use reqwest::Url;
use serde_json::Value;

use super::admin_settings;

/// At most this many authorization servers are asked about.
const MAX_ISSUERS: usize = 4;

/// Resolves a host name to its addresses (the system's resolver; tests
/// pass their own).
pub(super) type Lookup = fn(String, u16) -> Pin<Box<dyn Future<Output = Vec<SocketAddr>> + Send>>;

fn system_lookup(host: String, port: u16) -> Pin<Box<dyn Future<Output = Vec<SocketAddr>> + Send>> {
    Box::pin(async move {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map(|addresses| addresses.collect())
            .unwrap_or_default()
    })
}

/// The address to open, as re-serialized, when it may be opened without
/// asking; `None` when the person must decide.
pub(super) async fn openable_authorization_url(
    any_home: &Path,
    server: &str,
    auth_url: &str,
) -> Option<String> {
    openable_authorization_url_with(any_home, server, auth_url, system_lookup).await
}

async fn openable_authorization_url_with(
    any_home: &Path,
    server: &str,
    auth_url: &str,
    lookup: Lookup,
) -> Option<String> {
    let settings = admin_settings::load(any_home);
    let server_url = settings
        .config
        .mcp_servers
        .get(server)
        .and_then(|entry| entry.get("url"))
        .and_then(Value::as_str)
        .and_then(parse_strict)?;
    let wanted = parse_strict(auth_url)?;
    vetted(&wanted, &server_url, lookup).await?;
    allowed_origins(&server_url, lookup)
        .await
        .contains(&origin_of(&wanted))
        .then(|| wanted.as_str().to_string())
}

/// The addresses `url` may be reached at (B1): the configured server's own
/// origin as it resolves; any other only `https`, on a host that is not
/// local by its text, and whose every resolved address is public (an
/// IPv4-mapped or NAT64 address judged by the IPv4 inside). The request is
/// then made to these addresses, never resolved again.
async fn vetted(url: &Url, server: &Url, lookup: Lookup) -> Option<Vec<SocketAddr>> {
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default()?;
    let addresses = lookup(host, port).await;
    if addresses.is_empty() {
        return None;
    }
    if origin_of(url) == origin_of(server) {
        return Some(addresses);
    }
    if url.scheme() != "https" || is_local(url) {
        return None;
    }
    addresses
        .iter()
        .all(|address| !ip_is_local(address.ip()))
        .then_some(addresses)
}

/// Anything but a public, global unicast address (7th pass): an allowlist
/// rather than a list of local ranges. IPv4 outside 0/8, 10/8, 100.64/10,
/// 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24,
/// 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and 240/4;
/// IPv6 only within 2000::/3, outside Teredo (2001::/32), documentation
/// (2001:db8::/32) and 6to4 (2002::/16); an IPv4-mapped address is judged
/// by the IPv4 inside, and every other form (IPv4-compatible, NAT64,
/// site-local, unique local, link-local) is local.
fn ip_is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..128).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..32).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(inner) = ip.to_ipv4_mapped() {
                return ip_is_local(IpAddr::V4(inner));
            }
            let segments = ip.segments();
            let global_unicast = (segments[0] & 0xe000) == 0x2000;
            let teredo = segments[0] == 0x2001 && segments[1] == 0;
            let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
            let six_to_four = segments[0] == 0x2002;
            !global_unicast || teredo || documentation || six_to_four
        }
    }
}

/// Parses an address only when its raw text is plain: ASCII, no control
/// character, no backslash, no space, and no user information once parsed.
fn parse_strict(raw: &str) -> Option<Url> {
    if raw
        .chars()
        .any(|c| !c.is_ascii() || c.is_ascii_control() || c == '\\' || c == ' ')
    {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return None;
    }
    Some(url)
}

/// `scheme://host[:port]`.
fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// A host that is local by its text: `localhost` (with or without a final
/// dot), a `.localhost` or `.local` name, or a local address literal.
fn is_local(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if bare == "localhost" || bare.ends_with(".localhost") || bare.ends_with(".local") {
        return true;
    }
    bare.parse::<IpAddr>().is_ok_and(ip_is_local)
}

/// An `https` address on a public host, or the configured server's own
/// origin (which may be local: the person chose it).
fn acceptable(url: &Url, server: &Url) -> bool {
    (url.scheme() == "https" && !is_local(url)) || origin_of(url) == origin_of(server)
}

/// An authorization server the metadata names: a plain, acceptable
/// address with no query or fragment, whose path is plain too.
fn issuer_of(raw: &str, server: &Url) -> Option<Url> {
    // Dot segments are checked on the raw text: parsing removes them.
    let lowered = raw.to_ascii_lowercase();
    if lowered.contains("%2e")
        || raw.contains("/../")
        || raw.contains("/./")
        || raw.ends_with("/..")
        || raw.ends_with("/.")
    {
        return None;
    }
    let url = parse_strict(raw)?;
    if url.query().is_some() || url.fragment().is_some() || !acceptable(&url, server) {
        return None;
    }
    if url
        .path()
        .split('/')
        .any(|part| part == ".." || part == ".")
    {
        return None;
    }
    Some(url)
}

/// The MCP server's own origin, the authorization servers it declares, and
/// the origin of each one's authorization endpoint. Every request goes to
/// addresses vetted first.
async fn allowed_origins(server: &Url, lookup: Lookup) -> HashSet<String> {
    let mut allowed = HashSet::new();
    let server_origin = origin_of(server);
    allowed.insert(server_origin.clone());
    let path = server.path().trim_end_matches('/').to_string();
    let mut issuers = vec![server.clone()];
    for candidate in [
        format!("{server_origin}/.well-known/oauth-protected-resource{path}"),
        format!("{server_origin}/.well-known/oauth-protected-resource"),
    ] {
        if let Some(metadata) = fetch_json(&candidate, server, lookup).await {
            for issuer in metadata
                .get("authorization_servers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|raw| issuer_of(raw, server))
                .take(MAX_ISSUERS)
            {
                allowed.insert(origin_of(&issuer));
                issuers.push(issuer);
            }
            break;
        }
    }
    for issuer in issuers {
        let origin = origin_of(&issuer);
        let issuer_path = issuer.path().trim_end_matches('/').to_string();
        for well_known in [
            format!("{origin}/.well-known/oauth-authorization-server{issuer_path}"),
            format!("{origin}{issuer_path}/.well-known/openid-configuration"),
        ] {
            let Some(metadata) = fetch_json(&well_known, server, lookup).await else {
                continue;
            };
            if let Some(endpoint) = metadata
                .get("authorization_endpoint")
                .and_then(Value::as_str)
                .and_then(parse_strict)
                .filter(|endpoint| acceptable(endpoint, server))
            {
                allowed.insert(origin_of(&endpoint));
            }
            break;
        }
    }
    allowed
}

/// One metadata document, fetched at the vetted addresses only.
async fn fetch_json(raw: &str, server: &Url, lookup: Lookup) -> Option<Value> {
    let url = parse_strict(raw)?;
    let addresses = vetted(&url, server, lookup).await?;
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    // Through the app's factory (`tests/egress.rs`): no redirect at all, no
    // proxy, and the addresses checked above, never resolved again.
    let client = crate::http_client::build(
        crate::http_client::anonymous(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(&host, &addresses),
        "MCP sign-in metadata",
    );
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    /// A local MCP server answering its metadata: it declares itself as its
    /// authorization server, whose endpoint is on a public origin; and it
    /// lists issuers that must never be asked.
    fn metadata_server(asked: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                asked
                    .lock()
                    .unwrap()
                    .push(request.lines().next().unwrap_or("").to_string());
                let body = if request.starts_with("GET /.well-known/oauth-protected-resource") {
                    format!(
                        r#"{{"authorization_servers":["http://127.0.0.1:{port}","http://10.0.0.1","https://169.254.169.254","https://x.test/a?b=c","https://user@x.test","http://localhost:{port}"]}}"#
                    )
                } else if request.starts_with("GET /.well-known/oauth-authorization-server") {
                    r#"{"authorization_endpoint":"https://login.example.test/authorize"}"#
                        .to_string()
                } else {
                    String::new()
                };
                let status = if body.is_empty() {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    /// The names the tests resolve: `*.example.test` to a public address,
    /// `private.example.test` to a private one, IP literals to themselves.
    fn test_lookup(
        host: String,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = Vec<SocketAddr>> + Send>> {
        Box::pin(async move {
            if let Ok(ip) = host.parse::<IpAddr>() {
                return vec![SocketAddr::new(ip, port)];
            }
            match host.as_str() {
                "localhost" => vec![SocketAddr::new("127.0.0.1".parse().unwrap(), port)],
                "private.example.test" => {
                    vec![
                        SocketAddr::new("93.184.215.14".parse().unwrap(), port),
                        SocketAddr::new("10.0.0.7".parse().unwrap(), port),
                    ]
                }
                "mapped.example.test" => {
                    vec![SocketAddr::new("::ffff:127.0.0.1".parse().unwrap(), port)]
                }
                name if name.ends_with(".example.test") => {
                    vec![SocketAddr::new("93.184.215.14".parse().unwrap(), port)]
                }
                _ => Vec::new(),
            }
        })
    }

    /// B1: a name is judged by every address it resolves to, an
    /// IPv4-mapped or shared (100.64/10) one included, and a host that is
    /// local by its text never passes.
    #[tokio::test]
    async fn a_name_is_judged_by_every_address_it_resolves_to() {
        let server = parse_strict("https://mcp.example.test/mcp").unwrap();
        for (raw, passes) in [
            ("https://login.example.test/a", true),
            ("https://private.example.test/a", false),
            ("https://mapped.example.test/a", false),
            ("https://[::ffff:127.0.0.1]/a", false),
            ("https://localhost./a", false),
            ("https://100.64.0.1/a", false),
            ("https://[64:ff9b::a00:1]/a", false),
            ("https://[fd00::1]/a", false),
            ("https://[::7f00:1]/a", false),
            ("https://[2002:7f00:1::]/a", false),
            ("https://[2001:0:4136:e378::1]/a", false),
            ("https://[fec0::1]/a", false),
            ("https://198.18.0.1/a", false),
            ("https://192.0.0.8/a", false),
            ("https://240.0.0.1/a", false),
            ("https://[2606:4700::1111]/a", true),
            ("https://1.1.1.1/a", true),
        ] {
            let url = parse_strict(raw).unwrap();
            assert_eq!(
                vetted(&url, &server, test_lookup).await.is_some(),
                passes,
                "{raw}"
            );
        }
    }

    #[test]
    fn only_a_plain_address_parses() {
        assert!(parse_strict("https://a.test/x?y=1").is_some());
        assert!(parse_strict("https://user@a.test/").is_none());
        assert!(parse_strict("https://a.test\\@evil.test/").is_none());
        assert!(parse_strict("https://a.test/\n").is_none());
        assert!(parse_strict("https://\u{e1}.test/").is_none());
        assert!(parse_strict("file:///etc/passwd").is_none());
        assert!(parse_strict("javascript:alert(1)").is_none());
    }

    /// Review 4 (2): no issuer on a local or private address unless it is
    /// the configured server's own, none with a query, a fragment or user
    /// information.
    #[test]
    fn an_issuer_is_public_and_plain_or_the_server_itself() {
        let server = parse_strict("http://127.0.0.1:9000/mcp").unwrap();
        assert!(issuer_of("http://127.0.0.1:9000", &server).is_some());
        assert!(issuer_of("http://localhost:9000", &server).is_none());
        assert!(issuer_of("http://10.0.0.1", &server).is_none());
        assert!(issuer_of("https://10.0.0.1", &server).is_none());
        assert!(issuer_of("https://169.254.169.254", &server).is_none());
        assert!(issuer_of("https://[::1]", &server).is_none());
        assert!(issuer_of("https://auth.test/x?y", &server).is_none());
        assert!(issuer_of("https://auth.test/x#y", &server).is_none());
        assert!(issuer_of("https://auth.test/../x", &server).is_none());
        assert!(issuer_of("https://auth.test/tenant", &server).is_some());
    }

    /// ADR-0140 (review 3, F4, review 4): the sign-in address opens by
    /// itself only on the server's own origin or one its metadata declares,
    /// a local one only as the server's own host and port, and what opens is
    /// the re-serialized address; anything else, or a server the person
    /// never configured, is shown instead.
    #[tokio::test]
    async fn the_sign_in_opens_only_on_a_declared_origin() {
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let port = metadata_server(asked.clone());
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        let mut settings = admin_settings::load(&home);
        settings.config.mcp_servers.insert(
            "linear".to_string(),
            serde_json::json!({"url": format!("http://127.0.0.1:{port}/mcp")}),
        );
        admin_settings::save(&home, &settings).unwrap();
        let local = format!("http://127.0.0.1:{port}/authorize?x=1");
        for (url, opened) in [
            (local.clone(), Some(local.clone())),
            (format!("http://localhost:{port}/authorize"), None),
            (
                "https://LOGIN.example.test/authorize?client_id=x".to_string(),
                Some("https://login.example.test/authorize?client_id=x".to_string()),
            ),
            ("https://evil.example.test/authorize".to_string(), None),
            ("http://login.example.test/authorize".to_string(), None),
            (
                "https://user@login.example.test/authorize".to_string(),
                None,
            ),
            ("https://login.example.test\\@evil.test/".to_string(), None),
        ] {
            assert_eq!(
                openable_authorization_url_with(&home, "linear", &url, test_lookup).await,
                opened,
                "{url}"
            );
        }
        assert_eq!(
            openable_authorization_url_with(
                &home,
                "unknown",
                "https://login.example.test/a",
                test_lookup
            )
            .await,
            None
        );
        // Only the server itself was asked, never a private issuer.
        assert!(asked
            .lock()
            .unwrap()
            .iter()
            .all(|line| line.starts_with("GET /.well-known/")));
    }
}
