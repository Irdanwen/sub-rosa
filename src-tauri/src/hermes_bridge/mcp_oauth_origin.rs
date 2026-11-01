//! Whether an MCP server's sign-in address may be opened without asking
//! (ADR-0140, review 3).
//!
//! `hermes mcp login` prints the authorization address it wants opened. A
//! sandboxed sign-in runs under the jail, so the address is the jail's to
//! choose: the app opens it in the browser only when its origin is the MCP
//! server's own or one of the authorization servers that server declares
//! (RFC 9728 protected-resource metadata, then each authorization server's
//! metadata). The server comes from the app's own record of the person's
//! settings, never from a file the jail writes. Anything else is shown to
//! the person, who decides.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::admin_settings;

/// Whether `auth_url` may be opened without asking.
pub(super) async fn authorization_url_trusted(
    any_home: &Path,
    server: &str,
    auth_url: &str,
) -> bool {
    let settings = admin_settings::load(any_home);
    let Some(server_url) = settings
        .config
        .mcp_servers
        .get(server)
        .and_then(|entry| entry.get("url"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Some(wanted) = origin(auth_url) else {
        return false;
    };
    allowed_origins(server_url).await.contains(&wanted)
}

/// `scheme://host[:port]` of an `https` address, or of an `http` one on the
/// loopback.
pub(super) fn origin(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1");
    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return None,
    }
    Some(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

/// The MCP server's own origin, the authorization servers it declares, and
/// the origin of each one's authorization endpoint.
async fn allowed_origins(server_url: &str) -> HashSet<String> {
    let mut allowed = HashSet::new();
    let Some(server_origin) = origin(server_url) else {
        return allowed;
    };
    allowed.insert(server_origin.clone());
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return allowed;
    };
    let path = reqwest::Url::parse(server_url)
        .map(|url| url.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let mut issuers = vec![server_origin.clone()];
    for candidate in [
        format!("{server_origin}/.well-known/oauth-protected-resource{path}"),
        format!("{server_origin}/.well-known/oauth-protected-resource"),
    ] {
        if let Some(metadata) = fetch_json(&client, &candidate).await {
            for issuer in metadata
                .get("authorization_servers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if let Some(found) = origin(issuer) {
                    allowed.insert(found);
                    issuers.push(issuer.trim_end_matches('/').to_string());
                }
            }
            break;
        }
    }
    for issuer in issuers {
        for well_known in ["oauth-authorization-server", "openid-configuration"] {
            let Some(metadata) =
                fetch_json(&client, &format!("{issuer}/.well-known/{well_known}")).await
            else {
                continue;
            };
            if let Some(endpoint) = metadata
                .get("authorization_endpoint")
                .and_then(Value::as_str)
                .and_then(origin)
            {
                allowed.insert(endpoint);
            }
            break;
        }
    }
    allowed
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<Value> {
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

    /// A server answering its metadata: it declares an authorization server
    /// on another origin, whose endpoint is on a third.
    fn metadata_server() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = if request.starts_with("GET /.well-known/oauth-protected-resource") {
                    format!(r#"{{"authorization_servers":["http://localhost:{port}"]}}"#)
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

    #[test]
    fn only_https_or_the_loopback_has_an_origin() {
        assert_eq!(
            origin("https://a.test/x?y=1"),
            Some("https://a.test".to_string())
        );
        assert_eq!(
            origin("https://a.test:8443/"),
            Some("https://a.test:8443".to_string())
        );
        assert_eq!(
            origin("http://127.0.0.1:9/cb"),
            Some("http://127.0.0.1:9".to_string())
        );
        assert_eq!(origin("http://a.test/"), None);
        assert_eq!(origin("file:///etc/passwd"), None);
    }

    /// ADR-0140 (review 3): the sign-in address opens by itself only on the
    /// server's own origin or one its metadata declares; anything else, or
    /// a server the person never configured, is shown instead.
    #[tokio::test]
    async fn the_sign_in_opens_only_on_a_declared_origin() {
        let port = metadata_server();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        let mut settings = admin_settings::load(&home);
        settings.config.mcp_servers.insert(
            "linear".to_string(),
            serde_json::json!({"url": format!("http://127.0.0.1:{port}/mcp")}),
        );
        admin_settings::save(&home, &settings).unwrap();
        for (url, trusted) in [
            (format!("http://127.0.0.1:{port}/authorize?x=1"), true),
            (format!("http://localhost:{port}/authorize"), true),
            (
                "https://login.example.test/authorize?client_id=x".to_string(),
                true,
            ),
            ("https://evil.example.test/authorize".to_string(), false),
            ("http://login.example.test/authorize".to_string(), false),
        ] {
            assert_eq!(
                authorization_url_trusted(&home, "linear", &url).await,
                trusted,
                "{url}"
            );
        }
        assert!(!authorization_url_trusted(&home, "unknown", "https://login.example.test/a").await);
    }
}
