use axum::{extract::State, response::Html};

use crate::state::{ApiState, AttestationInfo};

/// Human-facing explanation of what this backend does with the user's data.
/// Served by the backend itself, so it describes the process answering the
/// request. Public and unauthenticated like the health probes, and
/// deliberately HTML rather than the `ApiResponse` envelope: the audience is a
/// person, not a client.
pub(crate) async fn verify(State(state): State<ApiState>) -> Html<String> {
    Html(render_page(state.attestation()))
}

/// First seven characters of the commit, only when it looks like a real git
/// sha. Anything else (empty, placeholder text) renders as "not stamped".
fn short_commit(commit: &str) -> Option<&str> {
    let trimmed = commit.trim();
    let looks_like_sha = trimmed.len() >= 7 && trimmed.chars().all(|c| c.is_ascii_hexdigit());
    looks_like_sha.then(|| &trimmed[..7])
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn render_page(info: &AttestationInfo) -> String {
    let repo_url = escape_html(&info.source_repo_url);
    let trust_center_url = escape_html(&info.trust_center_url);

    let (commit_value, short_sha) = match short_commit(&info.source_commit) {
        Some(short) => {
            let full = escape_html(info.source_commit.trim());
            let short = escape_html(short);
            (
                format!(
                    "<a href=\"{repo_url}/commit/{full}\"><code>{short}</code></a> \
                     <span class=\"muted\"><code>{full}</code></span>"
                ),
                short,
            )
        }
        None => (
            "<em>not stamped (local or development build)</em>".to_string(),
            "&lt;short-sha&gt;".to_string(),
        ),
    };

    // This fork ships the backend inside the app instead of publishing a
    // container, so `image_repo` is normally blank and its row is dropped
    // rather than rendered empty. A deployment that does publish an image
    // still gets the row.
    let image_row = if info.image_repo.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n  <div><dt>Image</dt><dd><code>{}:{short_sha}</code></dd></div>",
            escape_html(&info.image_repo)
        )
    };

    PAGE_TEMPLATE
        .replace("@VERSION@", env!("CARGO_PKG_VERSION"))
        .replace("@COMMIT_VALUE@", &commit_value)
        .replace("@IMAGE_ROW@", &image_row)
        .replace("@REPO_URL@", &repo_url)
        .replace("@TRUST_CENTER_URL@", &trust_center_url)
}

const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Where your data goes</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fdfdfc;
    --fg: #1c1b18;
    --muted: #6f6c64;
    --border: #e6e4de;
    --surface: #f4f3ef;
    --accent: #1f6f4a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161513;
      --fg: #e9e7e1;
      --muted: #9b988f;
      --border: #2c2a26;
      --surface: #201f1c;
      --accent: #6fbf95;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 3.5rem 1.25rem 5rem;
    max-width: 42rem;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1, h2 {
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-weight: 400;
    line-height: 1.2;
  }
  h1 { font-size: 2.1rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.35rem; margin: 2.75rem 0 0.75rem; }
  p { margin: 0.75rem 0; }
  a { color: var(--accent); }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .muted { color: var(--muted); }
  code {
    font: 0.875em ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--surface);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    overflow-wrap: anywhere;
  }
  pre {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  dl.facts {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  dl.facts > div {
    display: grid;
    grid-template-columns: 9.5rem 1fr;
    gap: 1rem;
    padding: 0.7rem 1rem;
  }
  dl.facts > div + div { border-top: 1px solid var(--border); }
  dl.facts dt { margin: 0; color: var(--muted); }
  dl.facts dd { margin: 0; overflow-wrap: anywhere; }
  ol.steps { padding-left: 1.25rem; }
  ol.steps > li { margin: 1.1rem 0; }
  ol.steps > li::marker { color: var(--muted); }
  .badge {
    display: inline-block;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.1rem 0.7rem;
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 1.25rem;
  }
  footer {
    margin-top: 3.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>
</head>
<body>
<header>
  <span class="badge">Local backend</span>
  <h1>Where your data goes</h1>
  <p class="lede">You are reading this from a process running on your own
  computer. This page explains what that process does with your work, what
  leaves the device, and how to check both.</p>
</header>

<h2>This build</h2>
<dl class="facts">
  <div><dt>Version</dt><dd><code>v@VERSION@</code></dd></div>
  <div><dt>Source commit</dt><dd>@COMMIT_VALUE@</dd></div>
  <div><dt>Source code</dt><dd><a href="@REPO_URL@">@REPO_URL@</a></dd></div>@IMAGE_ROW@
  <div><dt>Address</dt><dd><code>127.0.0.1</code> (loopback only)</dd></div>
</dl>

<h2>What this process is</h2>
<p>It is the app's backend, started by the app when it launches and stopped
when you quit. It listens on a random loopback port with a bearer token
generated for this run, so nothing outside your machine can reach it.</p>
<p>It keeps no user data. Notes, transcripts, sessions, memory, and agent
state are files on your disk, written by the app, not by this process. There
is no account here and no server-side copy of anything, because there is no
server: nobody operates this but you.</p>

<h2>What leaves your device</h2>
<p>One thing: the content of a request that needs a model. Audio to be
transcribed, the text to turn into a note, the prompts and context of an agent
turn. This process attaches your own API key and forwards the request to
Carpe Diem, which runs the model. Nothing else is sent anywhere.</p>
<p>Everything else in the app, including retrieval over your own notes, runs
locally and never crosses this boundary.</p>

<h2>What this page does not prove</h2>
<p>Once a request reaches Carpe Diem, what happens to it is governed by
<strong>their</strong> guarantees, not ours: their confidential-computing
setup, their retention policy, and the policies of any upstream model provider
they route to. Those are theirs to state and theirs to prove.</p>
<p>Check them at <a href="@TRUST_CENTER_URL@">@TRUST_CENTER_URL@</a>. Treat any
claim on this page about their infrastructure as hearsay: this page can only
speak for the process serving it.</p>

<h2>Check this side yourself</h2>
<ol class="steps">
  <li>
    <p>Confirm nothing but your machine can reach this backend. It binds
    loopback, so from another device on your network this address answers
    nothing:</p>
    <pre><code>curl --max-time 5 http://&lt;this-machine-ip&gt;:&lt;port&gt;/livez</code></pre>
  </li>
  <li>
    <p>Watch what actually leaves. Point a proxy (Charles, mitmproxy) at the
    app, or list its open sockets while you work:</p>
    <pre><code>lsof -i -nP | grep -i subrosa</code></pre>
    <p>You should see connections to Carpe Diem and nothing else carrying your
    content.</p>
  </li>
  <li>
    <p>Read the source at the commit above. The whole app, this backend
    included, is public.</p>
  </li>
</ol>

<footer>
  <p><a href="@REPO_URL@">source</a> · <a href="@TRUST_CENTER_URL@">Carpe Diem</a></p>
</footer>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::{AttestationInfo, escape_html, render_page, short_commit};
    use pretty_assertions::assert_eq;

    fn info() -> AttestationInfo {
        AttestationInfo {
            source_commit: "0123abc4567890def0123abc4567890def012345".to_string(),
            source_repo_url: "https://github.com/example-org/example-app".to_string(),
            // Blank on this fork; a deployment that publishes an image is
            // covered by `render_includes_the_image_row_when_one_is_configured`.
            image_repo: String::new(),
            trust_center_url: "https://operator.example/trust".to_string(),
        }
    }

    #[test]
    fn short_commit_accepts_full_sha() {
        assert_eq!(
            short_commit("0123abc4567890def0123abc4567890def012345"),
            Some("0123abc")
        );
    }

    #[test]
    fn short_commit_rejects_non_sha_values() {
        assert_eq!(short_commit(""), None);
        assert_eq!(short_commit("unknown"), None);
        assert_eq!(short_commit("abc"), None);
    }

    #[test]
    fn escape_html_neutralizes_markup() {
        assert_eq!(
            escape_html("<script>\"&'"),
            "&lt;script&gt;&quot;&amp;&#39;"
        );
    }

    #[test]
    fn render_links_commit_and_operator() {
        let html = render_page(&info());
        assert!(html.contains(
            "https://github.com/example-org/example-app/commit/0123abc4567890def0123abc4567890def012345"
        ));
        assert!(html.contains("https://operator.example/trust"));
        assert!(!html.contains("@IMAGE_ROW@"));
        assert!(!html.contains("@TRUST_CENTER_URL@"));
    }

    #[test]
    fn render_omits_the_image_row_when_no_image_is_published() {
        // The fork's backend ships inside the app, so there is no image to
        // name. An empty row would read as a missing fact rather than an
        // absent one.
        let html = render_page(&info());
        assert!(!html.contains("<dt>Image</dt>"));
    }

    #[test]
    fn render_includes_the_image_row_when_one_is_configured() {
        let mut info = info();
        info.image_repo = "ghcr.io/example-org/example-api".to_string();
        let html = render_page(&info);
        assert!(html.contains("<dt>Image</dt>"));
        assert!(html.contains("ghcr.io/example-org/example-api:0123abc"));
    }

    #[test]
    fn render_describes_a_local_backend_not_a_hosted_one() {
        let html = render_page(&info());

        assert!(html.contains("<title>Where your data goes</title>"));
        assert!(html.contains(&format!(
            "<div><dt>Version</dt><dd><code>v{}</code></dd></div>",
            env!("CARGO_PKG_VERSION")
        )));
        // The page must not restate the operator's confidential-computing
        // claims as its own: this process runs on the user's machine.
        assert!(html.contains("loopback"));
        assert!(!html.contains("Intel TDX"));
        assert!(!html.contains("confidential VM"));
        assert!(!html.contains("Phala"));
        assert!(!html.contains("Open Software"));
        assert!(!html.contains("@SERVICE@"));
    }

    #[test]
    fn render_without_commit_says_not_stamped() {
        let mut info = info();
        info.source_commit = String::new();
        let html = render_page(&info);
        assert!(html.contains("not stamped"));
    }

    #[test]
    fn render_without_commit_still_labels_a_configured_image() {
        let mut info = info();
        info.source_commit = String::new();
        info.image_repo = "ghcr.io/example-org/example-api".to_string();
        let html = render_page(&info);
        assert!(html.contains("ghcr.io/example-org/example-api:&lt;short-sha&gt;"));
    }

    #[test]
    fn render_escapes_configured_values() {
        let mut info = info();
        info.image_repo = "ghcr.io/<evil>".to_string();
        let html = render_page(&info);
        assert!(!html.contains("ghcr.io/<evil>"));
        assert!(html.contains("ghcr.io/&lt;evil&gt;"));
    }
}
