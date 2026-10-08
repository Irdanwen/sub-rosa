use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;

const QUICK: (Duration, Duration) = (Duration::from_millis(200), Duration::from_millis(300));

fn attachment(kind: &str, name: &str, data: &str) -> AgentLiteAttachment {
    AgentLiteAttachment {
        kind: kind.to_string(),
        name: name.to_string(),
        data: data.to_string(),
    }
}

fn request(code: &str) -> PythonRunEvent {
    build_request("task-1", &serde_json::json!({ "code": code }), &[]).unwrap()
}

/// An emitter that plays the webview: each reply is delivered shortly after
/// the run is announced, in order.
fn webview(replies: Vec<PythonReply>) -> impl Fn(&PythonRunEvent) -> bool {
    move |event: &PythonRunEvent| {
        let id = event.request_id.clone();
        let replies = replies.clone();
        tokio::spawn(async move {
            for reply in replies {
                tokio::time::sleep(Duration::from_millis(10)).await;
                deliver(&id, reply);
            }
        });
        true
    }
}

fn counting() -> (Arc<AtomicUsize>, impl Fn(&str)) {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    (count, move |_: &str| {
        seen.fetch_add(1, Ordering::SeqCst);
    })
}

#[test]
fn the_request_mounts_this_turns_text_files_only() {
    let attachments = [
        attachment("text", "sales.csv", "a,b\n1,2\n"),
        attachment("image", "photo.jpg", "data:image/jpeg;base64,xx"),
        attachment("text", "budget.xlsx", "[Sheet 1]\nA1: x\n"),
    ];
    let all = build_request("t", &serde_json::json!({ "code": "1" }), &attachments).unwrap();
    assert_eq!(
        all.files
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["sales.csv", "budget.xlsx"]
    );
    assert_eq!(all.session, "t");
    let picked = build_request(
        "t",
        &serde_json::json!({ "code": "1", "files": ["budget.xlsx"] }),
        &attachments,
    )
    .unwrap();
    assert_eq!(picked.files.len(), 1);
    assert_eq!(picked.files[0].name, "budget.xlsx");
}

#[test]
fn a_request_without_code_or_with_too_much_is_refused_with_a_reason() {
    assert!(build_request("t", &serde_json::json!({}), &[])
        .unwrap_err()
        .contains("needs Python code"));
    let long = "x".repeat(MAX_CODE_CHARS + 1);
    assert!(
        build_request("t", &serde_json::json!({ "code": long }), &[])
            .unwrap_err()
            .contains("too long")
    );
    let big = attachment("text", "big.csv", &"1,2\n".repeat(MAX_FILE_BYTES / 4 + 1));
    assert!(
        build_request("t", &serde_json::json!({ "code": "1" }), &[big])
            .unwrap_err()
            .contains("too large")
    );
}

#[test]
fn the_webview_replies_deserialize_as_it_sends_them() {
    let started: PythonReply =
        serde_json::from_value(serde_json::json!({ "kind": "started" })).unwrap();
    assert_eq!(started, PythonReply::Started);
    let refused: PythonReply =
        serde_json::from_value(serde_json::json!({ "kind": "refused", "reason": "background" }))
            .unwrap();
    assert!(
        matches!(refused, PythonReply::Refused { ref reason, detail: None } if reason == "background")
    );
    let done: PythonReply = serde_json::from_value(serde_json::json!({
        "kind": "done",
        "stdout": "6\n",
        "result": "3.5",
        "blocks": [{ "kind": "chart", "json": "{\"v\":1}" }],
        "error": null,
        "files": ["/data/sales.csv"]
    }))
    .unwrap();
    let PythonReply::Done(outcome) = done else {
        panic!("expected done")
    };
    assert_eq!(outcome.result.as_deref(), Some("3.5"));
    assert_eq!(outcome.blocks[0].kind, "chart");
    assert_eq!(outcome.files, ["/data/sales.csv"]);
}

#[tokio::test]
async fn a_finished_run_reaches_the_tool_result_and_leaves_the_registry() {
    let outcome = PythonOutcome {
        stdout: "total 12\n".into(),
        result: Some("12".into()),
        blocks: vec![PythonBlock {
            kind: "table".into(),
            json: "{\"v\":1}".into(),
        }],
        error: None,
        files: vec!["/data/a.csv".into()],
    };
    let event = request("print(12)");
    let id = event.request_id.clone();
    let (cancels, cancel) = counting();
    let result = run(
        event,
        QUICK,
        webview(vec![
            PythonReply::Started,
            PythonReply::Done(outcome.clone()),
        ]),
        cancel,
    )
    .await;
    assert_eq!(result, Outcome::Done(outcome));
    assert_eq!(cancels.load(Ordering::SeqCst), 0);
    // Gone once the wait ended: a late answer finds nobody.
    assert!(!deliver(&id, PythonReply::Started));
}

#[tokio::test]
async fn a_silent_webview_means_the_app_is_not_open() {
    let (cancels, cancel) = counting();
    let result = run(request("1"), QUICK, webview(vec![]), cancel).await;
    assert_eq!(result, Outcome::NeedsApp);
    assert_eq!(cancels.load(Ordering::SeqCst), 1);
    assert_eq!(describe(result), NEEDS_APP_OPEN);
}

#[tokio::test]
async fn a_backgrounded_app_refuses_and_the_turn_moves_on() {
    let (_, cancel) = counting();
    let refused = PythonReply::Refused {
        reason: "background".into(),
        detail: None,
    };
    assert_eq!(
        run(request("1"), QUICK, webview(vec![refused.clone()]), &cancel).await,
        Outcome::NeedsApp
    );
    // Going to the background mid-run ends it the same way.
    assert_eq!(
        run(
            request("1"),
            QUICK,
            webview(vec![PythonReply::Started, refused]),
            &cancel
        )
        .await,
        Outcome::NeedsApp
    );
    let failed = PythonReply::Refused {
        reason: "unavailable".into(),
        detail: Some("no worker".into()),
    };
    let result = run(request("1"), QUICK, webview(vec![failed]), &cancel).await;
    assert_eq!(result, Outcome::Unavailable(Some("no worker".into())));
    assert!(describe(result).contains("(no worker)"));
}

#[tokio::test]
async fn a_run_past_its_limit_is_cancelled_in_the_webview() {
    let (cancels, cancel) = counting();
    let result = run(
        request("while True: pass"),
        QUICK,
        webview(vec![PythonReply::Started]),
        cancel,
    )
    .await;
    assert_eq!(result, Outcome::TimedOut);
    assert_eq!(cancels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_emit_that_fails_needs_the_app() {
    let (_, cancel) = counting();
    assert_eq!(
        run(request("1"), QUICK, |_: &PythonRunEvent| false, cancel).await,
        Outcome::NeedsApp
    );
}

#[test]
fn the_tool_result_fences_known_cards_only_and_caps_them() {
    let mut blocks = vec![PythonBlock {
        kind: "script".into(),
        json: "{}".into(),
    }];
    for index in 0..6 {
        blocks.push(PythonBlock {
            kind: "chart".into(),
            json: format!("{{\"v\":1,\"n\":{index}}}"),
        });
    }
    let text = describe(Outcome::Done(PythonOutcome {
        stdout: "hello\n".into(),
        result: Some("42".into()),
        blocks,
        error: Some("Traceback".into()),
        files: vec!["/data/x.csv".into()],
    }));
    assert!(text.contains("Files: /data/x.csv"));
    assert!(text.contains("Output:\nhello"));
    assert!(text.contains("Result:\n42"));
    assert!(text.contains("Error:\nTraceback"));
    assert_eq!(text.matches("```subrosa:chart").count(), MAX_BLOCKS);
    assert!(!text.contains("subrosa:script"));
    assert!(describe(Outcome::Done(PythonOutcome::default())).contains("printed nothing"));
}

#[test]
fn the_tool_is_offered_on_the_phones_only() {
    let mut tools = Vec::new();
    offer_tool(&mut tools);
    assert_eq!(tools.len(), usize::from(cfg!(mobile)));
    assert_eq!(definition()["function"]["name"], TOOL);
}
