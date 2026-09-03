//! The one thing unit tests cannot prove: that GitHub accepts what this app
//! actually sends.
//!
//! Everything else about filing a report is pure and covered in
//! `carpe_diem::issue_reports` - the `Issue N:` split, the titles, the body,
//! the bounds, the error copy. What no assertion in this repo can settle is
//! whether the request itself is well formed: the bearer, the `User-Agent`
//! GitHub refuses to work without, the API version header, the field names,
//! and the shape of the reply this app parses back.
//!
//! So this test files a real issue on the real tracker and closes it, using
//! the same `compose` and `file_all` the product calls. It is `#[ignore]`d and
//! gated on a token in the environment, so it never runs in CI and never runs
//! by accident:
//!
//! ```sh
//! SUBROSA_GITHUB_TEST_TOKEN=$(gh auth token) \
//!   cargo test --test issue_report_filing -- --ignored --nocapture
//! ```
//!
//! It leaves a closed issue behind. That is the point: a closed issue is the
//! receipt.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::carpe_diem::issue_reports::{compose, file_all, ISSUE_TRACKER_REPO};
use os_june_lib::domain::types::SubmitIssueReportRequest;

const USER_AGENT: &str = "SubRosa-Issue-Reporter";

fn github(token: &str, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
}

#[tokio::test]
#[ignore = "files a real issue on the tracker; needs SUBROSA_GITHUB_TEST_TOKEN"]
async fn a_report_becomes_an_issue_github_accepts() {
    let token = std::env::var("SUBROSA_GITHUB_TEST_TOKEN")
        .expect("set SUBROSA_GITHUB_TEST_TOKEN, e.g. $(gh auth token)");

    let request = SubmitIssueReportRequest {
        category: Some("bug".to_string()),
        description: "Smoke test of the in-app report path. Please ignore and close.".to_string(),
        agent_diagnosis: Some(
            "Issue 1: Smoke test of the report path\n\n\
             Filed by `cargo test --test issue_report_filing`. It exercises the request this \
             app sends to GitHub: the bearer, the User-Agent, the API version header, the \
             field names, and parsing the reply. Nothing is wrong; this issue exists only to \
             prove the path works, and the test closes it immediately."
                .to_string(),
        ),
        attachment_names: vec!["screenshot.png".to_string()],
        attachment_paths: vec![],
        session_id: Some("smoke-test".to_string()),
    };

    let drafts = compose(&request, env!("CARGO_PKG_VERSION"), std::env::consts::OS);
    assert_eq!(drafts.len(), 1, "one problem is one issue");

    let urls = file_all(&token, &drafts)
        .await
        .expect("GitHub accepted the issue this app composes");
    assert_eq!(urls.len(), 1);
    let url = &urls[0];
    println!("filed: {url}");
    assert!(url.starts_with(&format!("https://github.com/{ISSUE_TRACKER_REPO}/issues/")));

    // What GitHub stored is what this app sent. Reading it back is the part
    // that catches a field name that was accepted and quietly ignored.
    let number: u64 = url
        .rsplit('/')
        .next()
        .and_then(|tail| tail.parse().ok())
        .expect("issue number in the returned url");
    let api = format!("https://api.github.com/repos/{ISSUE_TRACKER_REPO}/issues/{number}");
    let stored: serde_json::Value = github(&token, reqwest::Method::GET, &api)
        .send()
        .await
        .expect("read the issue back")
        .json()
        .await
        .expect("issue json");

    assert_eq!(stored["title"], drafts[0].title);
    let body = stored["body"].as_str().unwrap_or_default();
    assert!(body.contains("## Report"), "body: {body}");
    assert!(body.contains("Smoke test of the in-app report path"));
    assert!(body.contains("not uploaded: screenshot.png"));
    assert!(body.contains(&format!("- App version: {}", env!("CARGO_PKG_VERSION"))));
    // Labels only stick for an account with push access, which is why the
    // product treats them as best-effort. Report what happened rather than
    // failing a run from a fork.
    let labels: Vec<&str> = stored["labels"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["name"].as_str())
                .collect()
        })
        .unwrap_or_default();
    println!("labels: {labels:?}");

    // Close it. The test that leaves the tracker dirty is a test nobody runs
    // twice.
    let closed = github(&token, reqwest::Method::PATCH, &api)
        .json(&serde_json::json!({ "state": "closed", "state_reason": "not_planned" }))
        .send()
        .await
        .expect("close the issue");
    assert!(
        closed.status().is_success(),
        "the smoke-test issue is still open at {url}"
    );
    println!("closed: {url}");
}
