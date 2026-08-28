//! Where a report actually goes.
//!
//! Upstream files user reports as Issues on its own tracker, through a bot key
//! held by the hosted backend. This fork has no hosted backend and no bot key,
//! so `june-api/config.toml` leaves that destination blank, the sidecar builds
//! its `LogIssueReportSink`, and every report ever sent turned into one line in
//! `june-api.log` while the app said "Your report was sent to the Sub Rosa
//! team". The report was real; the sentence was not.
//!
//! The tracker is this repo's own Issues. Two things it cannot be:
//!
//! - **A token in the binary.** The source repo is public and the builds are
//!   public, so any credential shipped inside is a credential published, and
//!   anyone holding it could file as the project.
//! - **A relay.** A small service holding the token would work and is exactly
//!   the remote infrastructure this fork exists without (ADR-0017). One
//!   operator, no Sub Rosa server.
//!
//! So the credential is the user's own, and there are two ways to use it:
//!
//! 1. **A GitHub token in the OS keychain** (Settings › Reports). The app
//!    files the Issue itself, in the background, and hands back its URL.
//! 2. **No token: the browser.** The app opens GitHub's own new-issue form
//!    with the title and body already filled in, and the user presses Submit
//!    under their own account. Nothing to configure, and they see exactly what
//!    is filed before it is filed.
//!
//! Anything else - offline, a refused token, a platform with no browser to
//! open - falls back to the local log, and the UI says so rather than
//! claiming a delivery that did not happen. See
//! [ADR-0036](../../../docs/adr/0036-reports-are-github-issues-filed-with-the-users-own-credential.md).

use crate::domain::types::{AppError, SubmitIssueReportRequest};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::branding;

/// The tracker. A constant rather than a setting: an app reports bugs against
/// itself, and a second text field asking the user which repo to file against
/// would be a question nobody has an answer to.
pub const ISSUE_TRACKER_REPO: &str = "Irdanwen/sub-rosa";

const GITHUB_API: &str = "https://api.github.com";
const KEYCHAIN_ACCOUNT: &str = "github-token";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa.carpe-diem";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa-dev.carpe-diem";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TOKEN_CHARS: usize = 1_024;
/// An Issue title is one line in a list.
const MAX_TITLE_CHARS: usize = 120;
/// GitHub accepts a 65,536-character Issue body; a report that long is a file,
/// not a report.
const MAX_BODY_CHARS: usize = 60_000;
/// What survives the trip through a URL. Browsers and GitHub both tolerate
/// more, but a query string is not a document, and the whole point of the
/// browser path is that the user reads what they are about to file.
const MAX_BROWSER_BODY_CHARS: usize = 5_000;
/// GitHub rejects a request with no User-Agent.
const USER_AGENT: &str = "SubRosa-Issue-Reporter";

/// How a report reached (or failed to reach) the tracker. The frontend turns
/// this into what it tells the user, so every arm has to be true.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    /// Filed directly with the stored token. Carries every Issue opened.
    Filed { urls: Vec<String> },
    /// GitHub's new-issue form is open in the browser, filled in, waiting for
    /// the user to press Submit. Nothing is filed yet, and the copy must not
    /// pretend otherwise.
    Browser,
    /// Nowhere but this machine's log, with the reason.
    Logged { reason: String },
}

/// Whether a token is stored. The token itself is never returned, matching
/// the Carpe Diem key ([`super::settings`]).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportSettingsDto {
    pub repo: String,
    pub repo_url: String,
    pub has_token: bool,
    /// Whether a logged-in GitHub CLI is sitting there to import from, so the
    /// button appears only when it would work.
    pub has_cli_token: bool,
    /// Whether this platform can open the pre-filled form when there is no
    /// token, so the settings copy can describe what will actually happen.
    pub can_open_browser: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGithubTokenRequest {
    pub token: String,
}

/// One Issue to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueDraft {
    pub title: String,
    pub body: String,
    /// Best-effort: GitHub ignores labels from anyone without push access, and
    /// a report from a stranger is worth more than the label it lacks.
    pub label: Option<&'static str>,
}

// --- Credential ------------------------------------------------------------

/// The stored GitHub token, if any.
pub fn token() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_token(raw: &str) -> Result<String, AppError> {
    let token = raw.trim();
    if token.is_empty() {
        return Err(AppError::new(
            "github_token_invalid",
            "Enter a GitHub token.",
        ));
    }
    if token.chars().count() > MAX_TOKEN_CHARS {
        return Err(AppError::new(
            "github_token_invalid",
            "That token is too long to be a GitHub token.",
        ));
    }
    if token.chars().any(char::is_whitespace) {
        return Err(AppError::new(
            "github_token_invalid",
            "A GitHub token has no spaces in it. Paste the token on its own.",
        ));
    }
    Ok(token.to_string())
}

/// Where a person actually installs the GitHub CLI, beyond whatever `PATH`
/// says. A GUI app on macOS inherits a `PATH` without Homebrew in it, which is
/// why this list exists at all (same reason as `ingest::extractor`).
#[cfg(desktop)]
const GH_PATHS: &[&str] = &[
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "/opt/local/bin/gh",
];

/// The GitHub CLI on this machine, if there is one.
#[cfg(desktop)]
fn find_gh() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(if cfg!(windows) { "gh.exe" } else { "gh" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    GH_PATHS
        .iter()
        .map(std::path::PathBuf::from)
        .find(|candidate| candidate.is_file())
}

/// The token an already-authenticated `gh` is holding.
///
/// Anyone who works on this app has run `gh auth login`, and sending them to
/// github.com to mint a second credential by hand is a worse first run than
/// pressing a button. Nothing is installed and nothing is authenticated here:
/// this reads a token that already exists, and does nothing at all when there
/// is no CLI or it is logged out.
#[cfg(desktop)]
fn cli_token() -> Result<String, AppError> {
    let Some(gh) = find_gh() else {
        return Err(AppError::new(
            "github_cli_missing",
            "The GitHub CLI is not installed on this machine.",
        ));
    };
    let output = std::process::Command::new(gh)
        .args(["auth", "token"])
        .output()
        .map_err(|error| AppError::new("github_cli_failed", error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::new(
            "github_cli_logged_out",
            "The GitHub CLI is installed but not logged in. Run `gh auth login` first.",
        ));
    }
    normalize_token(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(desktop))]
fn cli_token() -> Result<String, AppError> {
    Err(AppError::new(
        "github_cli_missing",
        "The GitHub CLI is not available on this device.",
    ))
}

// --- Composing the Issue ---------------------------------------------------

/// The Issues one report becomes.
///
/// The report prompt asks the agent to head each distinct problem it found
/// with `Issue 1: <short title>`, and says in as many words that the title is
/// the one "the team can use as the tracker title". So a heading is a title,
/// whether there is one of them or six:
///
/// - **No heading**: nothing named the problem, so the first line the user
///   wrote becomes the title and the diagnosis rides along whole.
/// - **One heading**: the report is about one thing and the agent already
///   named it. Using the user's raw first line instead would file "the app is
///   broken again, this is the third time" over a written title.
/// - **Several**: one Issue each, so a report covering three things becomes
///   three entries somebody can close one at a time.
///
/// A heading always becomes a title, never a line in the body: repeating it
/// under a title that already says it is noise.
pub fn compose(
    request: &SubmitIssueReportRequest,
    app_version: &str,
    platform: &str,
) -> Vec<IssueDraft> {
    let description = request.description.trim();
    let diagnosis = request
        .agent_diagnosis
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let label = label_for(request.category.as_deref());
    let sections = diagnosis.map(split_issue_sections).unwrap_or_default();

    if sections.is_empty() {
        return vec![IssueDraft {
            title: title_from_description(description),
            body: body(request, description, diagnosis, app_version, platform, None),
            label,
        }];
    }
    let total = sections.len();
    sections
        .into_iter()
        .enumerate()
        .map(|(index, section)| IssueDraft {
            title: truncate_chars(&section.title, MAX_TITLE_CHARS),
            body: body(
                request,
                description,
                Some(section.body.as_str()),
                app_version,
                platform,
                // A lone Issue is not "1 of 1"; that line only means something
                // when a reader might go looking for the others.
                (total > 1).then_some((index + 1, total)),
            ),
            label,
        })
        .collect()
}

/// A heading the agent wrote and everything under it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IssueSection {
    title: String,
    body: String,
}

/// Splits a diagnosis on its `Issue N:` headings. Tolerates the markup a model
/// reaches for around a heading (`## `, `**…**`, `- `) because the prompt asks
/// for the words, not for the syntax.
fn split_issue_sections(diagnosis: &str) -> Vec<IssueSection> {
    let mut sections: Vec<IssueSection> = Vec::new();
    for line in diagnosis.lines() {
        match parse_issue_heading(line) {
            Some(title) => sections.push(IssueSection {
                title,
                body: String::new(),
            }),
            None => {
                if let Some(current) = sections.last_mut() {
                    current.body.push_str(line);
                    current.body.push('\n');
                }
            }
        }
    }
    // A heading with nothing under it is a heading the model started and did
    // not finish; it is not an Issue anyone can act on.
    sections.retain(|section| !section.body.trim().is_empty());
    for section in &mut sections {
        section.body = section.body.trim().to_string();
    }
    sections
}

/// `Issue 3: the recorder freezes` → `the recorder freezes`.
fn parse_issue_heading(line: &str) -> Option<String> {
    let heading = strip_heading_markup(line);
    let rest = heading.strip_prefix("Issue ")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let title = rest[digits.len()..]
        .trim_start()
        .trim_start_matches([':', '-', '.', ')', ']'])
        .trim()
        .trim_end_matches(':')
        .trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn strip_heading_markup(line: &str) -> String {
    let mut text = line.trim();
    text = text.trim_start_matches('#').trim();
    for prefix in ["- ", "* "] {
        if let Some(stripped) = text.strip_prefix(prefix) {
            text = stripped.trim();
            break;
        }
    }
    while let Some(stripped) = text
        .strip_prefix("**")
        .and_then(|value| value.strip_suffix("**"))
        .or_else(|| {
            text.strip_prefix("__")
                .and_then(|value| value.strip_suffix("__"))
        })
    {
        text = stripped.trim();
    }
    text.to_string()
}

/// The first line the user wrote, which is what they would have called it.
fn title_from_description(description: &str) -> String {
    let first = description
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if first.is_empty() {
        return "Report from Sub Rosa".to_string();
    }
    truncate_chars(first, MAX_TITLE_CHARS)
}

fn label_for(category: Option<&str>) -> Option<&'static str> {
    match category.map(str::trim) {
        Some("bug") => Some("bug"),
        Some("feature") => Some("enhancement"),
        Some("feedback") => Some("question"),
        _ => None,
    }
}

fn body(
    request: &SubmitIssueReportRequest,
    description: &str,
    diagnosis: Option<&str>,
    app_version: &str,
    platform: &str,
    split: Option<(usize, usize)>,
) -> String {
    use std::fmt::Write as _;

    let mut body = String::from("## Report\n\n");
    body.push_str(description);
    body.push('\n');
    if let Some(diagnosis) = diagnosis {
        body.push_str("\n## What the assistant found\n\n");
        body.push_str(diagnosis);
        body.push('\n');
    }
    body.push_str("\n## Context\n\n");
    if let Some((index, total)) = split {
        let _ = writeln!(body, "- Issue {index} of {total} from one report");
    }
    if let Some(category) = request.category.as_deref().filter(|v| !v.trim().is_empty()) {
        let _ = writeln!(body, "- Category: {category}");
    }
    let _ = writeln!(body, "- App version: {app_version}");
    let _ = writeln!(body, "- Platform: {platform}");
    if let Some(session) = request
        .session_id
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        let _ = writeln!(body, "- Session: `{session}`");
    }
    // Named, never uploaded: GitHub's REST API has no way to attach a file to
    // an Issue, so claiming to carry them would be the same kind of lie this
    // whole module exists to remove. The names still tell the reader what the
    // reporter was looking at, and they can be asked for.
    if !request.attachment_names.is_empty() {
        let _ = writeln!(
            body,
            "- Attached by the reporter, not uploaded: {}",
            request.attachment_names.join(", ")
        );
    }
    let _ = write!(
        body,
        "\n<sub>Filed from {}.</sub>\n",
        branding::PRODUCT_NAME
    );
    truncate_chars(&body, MAX_BODY_CHARS)
}

/// GitHub's own new-issue form, pre-filled. The body is cut harder than the
/// API's, and says so where it was cut, so nobody files a report that stops
/// mid-sentence without knowing.
pub fn browser_url(draft: &IssueDraft) -> String {
    let body = if draft.body.chars().count() > MAX_BROWSER_BODY_CHARS {
        format!(
            "{}\n\n_(Trimmed to fit the browser. Add a GitHub token in Settings > Reports to file the whole report from the app.)_\n",
            truncate_chars(&draft.body, MAX_BROWSER_BODY_CHARS)
        )
    } else {
        draft.body.clone()
    };
    let mut url = format!(
        "https://github.com/{repo}/issues/new?title={title}&body={body}",
        repo = ISSUE_TRACKER_REPO,
        title = urlencoding::encode(&draft.title),
        body = urlencoding::encode(&body),
    );
    if let Some(label) = draft.label {
        url.push_str("&labels=");
        url.push_str(&urlencoding::encode(label));
    }
    url
}

/// Truncates on a character boundary. Every string here is user or model text,
/// so a byte-indexed cut would panic on the first accent.
fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((byte, _)) => value[..byte].to_string(),
        None => value.to_string(),
    }
}

// --- Filing ----------------------------------------------------------------

#[derive(Deserialize)]
struct CreatedIssue {
    html_url: String,
}

fn client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("github_http_client", error.to_string()))
}

/// Opens one Issue and returns its URL.
async fn file_one(
    http: &reqwest::Client,
    token: &str,
    draft: &IssueDraft,
) -> Result<String, AppError> {
    let mut payload = serde_json::json!({ "title": draft.title, "body": draft.body });
    if let Some(label) = draft.label {
        payload["labels"] = serde_json::json!([label]);
    }
    let response = http
        .post(format!("{GITHUB_API}/repos/{ISSUE_TRACKER_REPO}/issues"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .json(&payload)
        .send()
        .await
        .map_err(|error| AppError::new("github_unreachable", error.to_string()))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::new(
            "github_refused",
            github_error_message(status.as_u16(), &text),
        ));
    }
    serde_json::from_str::<CreatedIssue>(&text)
        .map(|issue| issue.html_url)
        .map_err(|error| AppError::new("github_response_invalid", error.to_string()))
}

/// What a reader can act on. GitHub's own `message` is included when it says
/// something, but the status is what tells the user which of their problems
/// this is.
fn github_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let reason = match status {
        401 => "GitHub refused the token. Check it in Settings > Reports.",
        403 => "GitHub refused the request. The token may lack the Issues permission, or you may be rate limited.",
        404 => "GitHub could not find the tracker, which usually means the token cannot see it.",
        410 => "Issues are turned off on the tracker.",
        422 => "GitHub rejected the issue's contents.",
        _ => "GitHub could not open the issue.",
    };
    if detail.is_empty() {
        reason.to_string()
    } else {
        format!("{reason} ({detail})")
    }
}

/// Files every Issue the report became. Stops at the first failure and reports
/// what did get filed: a half-filed report the user can see beats a silent
/// retry that duplicates the first half.
pub async fn file_all(token: &str, drafts: &[IssueDraft]) -> Result<Vec<String>, AppError> {
    let http = client()?;
    let mut urls = Vec::with_capacity(drafts.len());
    for draft in drafts {
        match file_one(&http, token, draft).await {
            Ok(url) => urls.push(url),
            Err(error) if urls.is_empty() => return Err(error),
            Err(error) => {
                return Err(AppError::new(
                    error.code,
                    format!(
                        "Opened {} of {} issues, then stopped: {}",
                        urls.len(),
                        drafts.len(),
                        error.message
                    ),
                ))
            }
        }
    }
    Ok(urls)
}

// --- Delivery --------------------------------------------------------------

/// Sends one report, and says where it went.
///
/// The order is the decision in [ADR-0036]: the stored token first because it
/// is the one path that needs nothing from the user, the browser next because
/// it needs no credential, the local log last because it is not a delivery and
/// must never be described as one. A failure with a token in hand does **not**
/// fall through to the browser: a network blip is not a reason to throw a
/// window at somebody, and the report is safe in the log either way.
pub async fn deliver(
    app: &tauri::AppHandle,
    request: &SubmitIssueReportRequest,
    app_version: &str,
) -> Delivery {
    let drafts = compose(request, app_version, std::env::consts::OS);

    if let Some(token) = token() {
        return match file_all(&token, &drafts).await {
            Ok(urls) => Delivery::Filed { urls },
            Err(error) => {
                log_locally(request, app_version, &error.message).await;
                Delivery::Logged {
                    reason: error.message,
                }
            }
        };
    }

    match open_prefilled(app, &drafts) {
        Ok(()) => Delivery::Browser,
        Err(reason) => {
            log_locally(request, app_version, &reason).await;
            Delivery::Logged { reason }
        }
    }
}

/// Opens GitHub's new-issue form for each draft.
///
/// Deliberately not routed through `open_external_url`: that command exists to
/// gate URLs a *model* wrote and caps them at 2 KB, which a filled-in issue
/// form exceeds by design. This URL is composed here, from this app's own
/// text, against a constant host.
#[cfg(desktop)]
fn open_prefilled(_app: &tauri::AppHandle, drafts: &[IssueDraft]) -> Result<(), String> {
    for draft in drafts {
        crate::os_accounts::open_in_browser(&browser_url(draft))
            .map_err(|error| format!("The browser could not be opened. {}", error.message))?;
    }
    Ok(())
}

/// No browser to hand a form to, and no report surface on this shell either.
#[cfg(not(desktop))]
fn open_prefilled(_app: &tauri::AppHandle, _drafts: &[IssueDraft]) -> Result<(), String> {
    Err("This device cannot open the issue form.".to_string())
}

/// The pre-existing route: the sidecar writes the whole report to
/// `june-api.log`. It is the floor, not a destination, so the caller still
/// tells the user the report stayed on this machine.
async fn log_locally(request: &SubmitIssueReportRequest, app_version: &str, reason: &str) {
    eprintln!("issue report not filed on the tracker ({reason}); logging it locally");
    if let Err(error) = crate::june_api::submit_issue_report(request, app_version).await {
        eprintln!("issue report could not be logged either: {}", error.message);
    }
}

// --- IPC -------------------------------------------------------------------

/// The settings surface, as they are right now.
///
/// `has_cli_token` costs a subprocess, so this is async and probes off the IPC
/// thread. Every command answers with it rather than a cheaper half-truth:
/// after removing a token the user is exactly the person who wants to see the
/// import button reappear.
async fn settings_dto() -> IssueReportSettingsDto {
    let has_cli_token = tokio::task::spawn_blocking(|| cli_token().is_ok())
        .await
        .unwrap_or(false);
    IssueReportSettingsDto {
        repo: ISSUE_TRACKER_REPO.to_string(),
        repo_url: format!("https://github.com/{ISSUE_TRACKER_REPO}/issues"),
        has_token: token().is_some(),
        has_cli_token,
        can_open_browser: cfg!(desktop),
    }
}

#[tauri::command]
pub async fn issue_reports_get_settings() -> IssueReportSettingsDto {
    settings_dto().await
}

#[tauri::command]
pub async fn issue_reports_set_github_token(
    request: SetGithubTokenRequest,
) -> Result<IssueReportSettingsDto, AppError> {
    let token = normalize_token(&request.token)?;
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .and_then(|entry| entry.set_password(&token))
    })
    .await
    .map_err(|error| AppError::new("github_keychain", error.to_string()))?
    .map_err(|error| AppError::new("github_keychain", error.to_string()))?;
    Ok(settings_dto().await)
}

/// Saves the token the GitHub CLI already holds, so the common case needs no
/// trip to github.com.
#[tauri::command]
pub async fn issue_reports_import_cli_token() -> Result<IssueReportSettingsDto, AppError> {
    let token = tokio::task::spawn_blocking(cli_token)
        .await
        .map_err(|error| AppError::new("github_cli_failed", error.to_string()))??;
    issue_reports_set_github_token(SetGithubTokenRequest { token }).await
}

#[tauri::command]
pub async fn issue_reports_clear_github_token() -> Result<IssueReportSettingsDto, AppError> {
    tokio::task::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            // Clearing an unset token is a no-op, not a failure.
            let _ = entry.delete_credential();
        }
    })
    .await
    .map_err(|error| AppError::new("github_keychain", error.to_string()))?;
    Ok(settings_dto().await)
}

/// Whether the stored token can actually see the tracker, checked before a
/// report depends on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTrackerResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn issue_reports_test_token() -> Result<TestTrackerResult, AppError> {
    let Some(token) = token() else {
        return Ok(TestTrackerResult {
            ok: false,
            message:
                "No token saved. Reports will open a pre-filled issue in your browser instead."
                    .to_string(),
        });
    };
    let http = client()?;
    let response = http
        .get(format!("{GITHUB_API}/repos/{ISSUE_TRACKER_REPO}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|error| AppError::new("github_unreachable", error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(TestTrackerResult {
            ok: true,
            message: format!("Connected. Reports will open issues on {ISSUE_TRACKER_REPO}."),
        });
    }
    let text = response.text().await.unwrap_or_default();
    Ok(TestTrackerResult {
        ok: false,
        message: github_error_message(status.as_u16(), &text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(description: &str, diagnosis: Option<&str>) -> SubmitIssueReportRequest {
        SubmitIssueReportRequest {
            category: Some("bug".to_string()),
            description: description.to_string(),
            agent_diagnosis: diagnosis.map(str::to_string),
            attachment_names: vec![],
            attachment_paths: vec![],
            session_id: Some("20260828_205717_ba8d0d".to_string()),
        }
    }

    #[test]
    fn a_single_heading_still_titles_the_issue() {
        // The prompt asks for `Issue 1: <short title>` and says in as many
        // words that it is the title the team will use. Treating one heading
        // as "not a split" and falling back to the user's raw first line filed
        // a written title under a sentence like the one below.
        let drafts = compose(
            &request(
                "it broke again, third time this week",
                Some("Issue 1: Recorder freezes on pause\n\nIt hangs at the pause."),
            ),
            "1.50.0",
            "macos",
        );
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "Recorder freezes on pause");
        // The heading became the title, so it is not repeated in the body.
        assert!(!drafts[0].body.contains("Issue 1:"));
        assert!(drafts[0].body.contains("It hangs at the pause."));
        // A lone issue is not "1 of 1".
        assert!(!drafts[0].body.contains("from one report"));
        assert_eq!(drafts[0].label, Some("bug"));
        assert!(drafts[0].body.contains("## Report"));
        assert!(drafts[0].body.contains("- App version: 1.50.0"));
        assert!(drafts[0].body.contains("20260828_205717_ba8d0d"));
    }

    #[test]
    fn with_nothing_named_the_users_own_first_line_is_the_title() {
        let drafts = compose(
            &request(
                "The recorder freezes on pause\nEvery time, since 1.49.",
                Some("I could not reproduce it, but the pause path writes twice."),
            ),
            "1.50.0",
            "macos",
        );
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "The recorder freezes on pause");
        // The whole diagnosis rides along when none of it was headed.
        assert!(drafts[0].body.contains("the pause path writes twice"));
    }

    #[test]
    fn a_report_covering_three_things_becomes_three_issues() {
        let diagnosis = "Here is what I found.\n\n\
             ## Issue 1: Usage counters reset\n\nThey restart at zero.\n\n\
             **Issue 2: Reports go nowhere**\n\nNo sink is configured.\n\n\
             Issue 3: The agent cannot write a note\n\nNo write tool exists.\n";
        let drafts = compose(
            &request("Three things are wrong", Some(diagnosis)),
            "1.50.0",
            "macos",
        );
        assert_eq!(drafts.len(), 3);
        assert_eq!(drafts[0].title, "Usage counters reset");
        assert_eq!(drafts[1].title, "Reports go nowhere");
        assert_eq!(drafts[2].title, "The agent cannot write a note");
        // Each carries only its own section, and says which of how many it is.
        assert!(drafts[0].body.contains("They restart at zero."));
        assert!(!drafts[0].body.contains("No sink is configured."));
        assert!(drafts[1].body.contains("- Issue 2 of 3 from one report"));
        // The user's report rides on every one of them: a tracker entry with
        // only the assistant's half is not the report they filed.
        assert!(drafts[2].body.contains("Three things are wrong"));
    }

    #[test]
    fn a_heading_with_nothing_under_it_is_not_an_issue() {
        let diagnosis = "Issue 1: Started this one\n\nIssue 2: Real problem\n\nHere are details.";
        let sections = split_issue_sections(diagnosis);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].title, "Real problem");
    }

    #[test]
    fn headings_survive_the_markup_a_model_puts_around_them() {
        assert_eq!(parse_issue_heading("Issue 1: Plain"), Some("Plain".into()));
        assert_eq!(
            parse_issue_heading("### Issue 12: Deep"),
            Some("Deep".into())
        );
        assert_eq!(
            parse_issue_heading("**Issue 2 - Dashed**"),
            Some("Dashed".into())
        );
        assert_eq!(
            parse_issue_heading("- Issue 3. Dotted"),
            Some("Dotted".into())
        );
        // Not headings.
        assert_eq!(parse_issue_heading("Issue with the recorder"), None);
        assert_eq!(parse_issue_heading("Issue 4:"), None);
        assert_eq!(parse_issue_heading("The issue 1: lowercase"), None);
    }

    #[test]
    fn attachments_are_named_and_never_claimed_to_be_uploaded() {
        let mut input = request("Broken", None);
        input.attachment_names = vec!["screenshot.png".to_string()];
        let drafts = compose(&input, "1.50.0", "macos");
        assert!(drafts[0].body.contains("not uploaded: screenshot.png"));
    }

    #[test]
    fn the_browser_url_carries_the_whole_form_and_says_where_it_cut() {
        let drafts = compose(&request("Broken", None), "1.50.0", "macos");
        let url = browser_url(&drafts[0]);
        assert!(url.starts_with("https://github.com/Irdanwen/sub-rosa/issues/new?title="));
        assert!(url.contains("&body="));
        assert!(url.contains("&labels=bug"));
        // Nothing raw survives into the query string.
        assert!(!url.contains(' ') && !url.contains('\n') && !url.contains('#'));

        let long = IssueDraft {
            title: "Long".to_string(),
            body: "x".repeat(MAX_BROWSER_BODY_CHARS + 500),
            label: None,
        };
        let trimmed = browser_url(&long);
        assert!(trimmed.contains("Trimmed+to+fit+the+browser") || trimmed.contains("Trimmed%20to"));
    }

    #[test]
    fn bounds_cut_on_characters_so_accents_cannot_panic() {
        let accented = "é".repeat(MAX_TITLE_CHARS + 40);
        assert_eq!(
            title_from_description(&accented).chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn a_pasted_token_is_checked_before_it_is_stored() {
        assert!(normalize_token("  ghp_abc123  ").is_ok());
        assert!(normalize_token("   ").is_err());
        // The classic paste mistake: the whole `gh auth token` line.
        assert!(normalize_token("token ghp_abc123").is_err());
        assert!(normalize_token(&"a".repeat(MAX_TOKEN_CHARS + 1)).is_err());
    }

    #[test]
    fn a_refusal_names_the_thing_the_user_can_fix() {
        assert!(github_error_message(401, r#"{"message":"Bad credentials"}"#).contains("token"));
        assert!(
            github_error_message(401, r#"{"message":"Bad credentials"}"#)
                .contains("Bad credentials")
        );
        assert!(github_error_message(403, "").contains("Issues permission"));
        assert!(github_error_message(500, "not json").contains("could not open"));
    }
}
