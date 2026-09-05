#[test]
fn a_turn_has_one_owner_until_that_owner_finishes() {
    let task_id = "claim-exclusivity-test";
    let first = super::TurnClaim::try_hold(task_id).expect("first runner owns the turn");
    assert!(super::TurnClaim::try_hold(task_id).is_none());
    // Rejecting the duplicate must not release the original owner's claim.
    assert!(super::TurnClaim::try_hold(task_id).is_none());
    let other = super::TurnClaim::try_hold("claim-independent-test")
        .expect("independent chats can run together");
    drop(other);
    drop(first);
    assert!(super::TurnClaim::try_hold(task_id).is_some());
}

use super::*;

#[test]
fn simultaneous_foreground_and_resume_calls_acquire_only_one_claim() {
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let runners: Vec<_> = (0..8)
        .map(|_| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let claim = TurnClaim::try_hold("claim-concurrent-test");
                // Hold the winner until every contender has tried.
                barrier.wait();
                claim.is_some()
            })
        })
        .collect();
    let owners = runners
        .into_iter()
        .map(|runner| usize::from(runner.join().unwrap()))
        .sum::<usize>();
    assert_eq!(owners, 1);
}

#[test]
fn resume_rechecks_status_and_last_message_after_claiming() {
    let mut task: crate::domain::types::AgentTaskDto = serde_json::from_value(serde_json::json!({
        "id": "resume-snapshot", "title": "Test", "prompt": "Question",
        "status": "running", "safetyProfile": "autonomousPrivate",
        "createdAt": "2026-09-05T00:00:00Z", "updatedAt": "2026-09-05T00:00:00Z",
        "messages": [{ "id": "message-1", "taskId": "resume-snapshot", "role": "user",
            "content": "Question", "createdAt": "2026-09-05T00:00:00Z" }]
    }))
    .unwrap();
    for status in [
        AgentTaskStatus::Queued,
        AgentTaskStatus::Running,
        AgentTaskStatus::Paused,
    ] {
        task.status = status;
        assert!(turn_needs_resume(&task));
    }
    for status in [
        AgentTaskStatus::Completed,
        AgentTaskStatus::Failed,
        AgentTaskStatus::Cancelled,
    ] {
        task.status = status;
        assert!(
            !turn_needs_resume(&task),
            "terminal work must not be replayed"
        );
    }
    task.status = AgentTaskStatus::Running;
    task.messages[0].role = AgentMessageRole::Assistant;
    assert!(
        !turn_needs_resume(&task),
        "a persisted answer must not be answered again"
    );
    task.messages.clear();
    assert!(!turn_needs_resume(&task));
}

#[test]
fn lost_attachment_payloads_are_rejected_before_a_request_can_be_built() {
    for marker in [
        "Describe this\n[Image: photo.jpg]",
        "Read this\n[File: notes.txt]",
    ] {
        let error = validate_turn_attachments(marker, &[]).unwrap_err();
        assert_eq!(error.code, "agent_lite_attachments_missing");
    }
    assert!(validate_turn_attachments("A normal text question", &[]).is_ok());
    assert!(validate_turn_attachments(
        "Read this\n[File: notes.txt]",
        &[AgentLiteAttachment {
            kind: "text".into(),
            name: "notes.txt".into(),
            data: "My notes".into()
        }]
    )
    .is_ok());
}

#[test]
fn rate_limit_detail_matches_sidecar_and_direct_provider_wording() {
    // The June API sidecar's message for an upstream 429 / 503.
    assert!(is_rate_limit_detail("upstream_rate_limited"));
    // A direct provider 429 (Carpe Diem / Venice).
    assert!(is_rate_limit_detail(
        "Venice rate limit reached — please retry in a few seconds."
    ));
    assert!(is_rate_limit_detail("Too Many Requests"));
    // A direct provider 503 capacity/saturation (the dominant hot-model case).
    assert!(is_rate_limit_detail(
        "Model kimi-k3 is currently saturated upstream. Retry after 9s."
    ));
    assert!(is_rate_limit_detail("NO_PROVIDER_CAPACITY"));
    // A genuine provider failure must NOT read as busy.
    assert!(!is_rate_limit_detail("upstream_provider_failed"));
}

#[test]
fn provider_failure_detail_matches_sidecar_and_gateway_wording() {
    // The June API sidecar's message for an upstream 500/502/504.
    assert!(is_provider_failure_detail("upstream_provider_failed"));
    // A raw gateway body that reaches us un-normalized.
    assert!(is_provider_failure_detail("VENICE_ERROR"));
    // Busy vocabulary stays on its own branch.
    assert!(!is_provider_failure_detail("upstream_rate_limited"));
    assert!(!is_provider_failure_detail("MODEL_INFRA_SATURATED"));
}

#[test]
fn system_prompt_appends_memory_block_when_present() {
    let plain = build_system_prompt(None);
    assert_eq!(plain, SYSTEM_PROMPT);

    let block = "User memory: facts.\n- Répond toujours en français.\n";
    let with_memory = build_system_prompt(Some(block));
    assert!(with_memory.starts_with(SYSTEM_PROMPT));
    assert!(with_memory.ends_with(block));
}

fn tool_names(tools: &serde_json::Value) -> Vec<String> {
    tools
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_stream_rebuilds_the_message_the_tool_loop_expects() {
    let mut reply = StreamedReply::default();
    // Content arrives token by token.
    reply.apply(&serde_json::json!({ "content": "Hel" }));
    reply.apply(&serde_json::json!({ "content": "lo" }));
    assert_eq!(reply.content, "Hello");
    let message = reply.into_message();
    assert_eq!(message["content"], "Hello");
    assert!(message.get("tool_calls").is_none());
}

#[test]
fn tool_call_fragments_reassemble_by_index() {
    let mut reply = StreamedReply::default();
    // The id and name land once, the arguments across several frames, and
    // two parallel calls interleave by index.
    reply.apply(&serde_json::json!({
        "tool_calls": [
            { "index": 0, "id": "a", "function": { "name": "read_note", "arguments": "{\"note" } },
            { "index": 1, "id": "b", "function": { "name": "web_search", "arguments": "{\"que" } }
        ]
    }));
    reply.apply(&serde_json::json!({
        "tool_calls": [
            { "index": 0, "function": { "arguments": "_id\":\"n1\"}" } },
            { "index": 1, "function": { "arguments": "ry\":\"x\"}" } }
        ]
    }));
    let message = reply.into_message();
    let calls = message["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["id"], "a");
    assert_eq!(calls[0]["function"]["name"], "read_note");
    assert_eq!(calls[0]["function"]["arguments"], "{\"note_id\":\"n1\"}");
    assert_eq!(calls[1]["function"]["arguments"], "{\"query\":\"x\"}");
}

#[test]
fn an_empty_stream_is_reported_so_the_turn_can_be_replayed_buffered() {
    assert!(StreamedReply::default().is_empty());
    let mut whitespace = StreamedReply::default();
    whitespace.apply(&serde_json::json!({ "content": "   " }));
    assert!(whitespace.is_empty());
    let mut answered = StreamedReply::default();
    answered.apply(&serde_json::json!({ "content": "hi" }));
    assert!(!answered.is_empty());
}

#[test]
fn a_tool_call_without_a_name_is_dropped_rather_than_sent_nameless() {
    let mut reply = StreamedReply::default();
    reply.apply(&serde_json::json!({
        "tool_calls": [{ "index": 0, "id": "a", "function": { "arguments": "{}" } }]
    }));
    assert!(reply.into_message().get("tool_calls").is_none());
}

#[test]
fn web_snippets_lose_their_markup_and_duplicate_paragraph() {
    // Exactly the shape the provider returns: highlight tags, then the
    // same passage repeated after a blank line.
    let raw = "Lisbon, its <strong>capital</strong>, is the largest city.\n\nLisbon, its capital, is the largest city.";
    let cleaned = clean_snippet(raw);
    assert_eq!(cleaned, "Lisbon, its capital, is the largest city.");
    assert!(!cleaned.contains('<'));
}

#[test]
fn web_snippets_are_capped_so_five_results_still_fit() {
    let cleaned = clean_snippet(&"word ".repeat(500));
    assert!(cleaned.chars().count() <= WEB_SNIPPET_CHARS);
}

#[test]
fn every_web_result_survives_the_shaping() {
    // The regression this replaces: the raw body was forwarded truncated
    // at 6000 chars, which cut the JSON mid-result and silently dropped
    // most of what was found. Long snippets must not cost a result.
    let long = "x".repeat(3000);
    let body = serde_json::json!({
        "data": {
            "results": (0..5).map(|index| serde_json::json!({
                "title": format!("Result {index}"),
                "url": format!("https://example.com/{index}"),
                "snippet": long,
            })).collect::<Vec<_>>()
        }
    })
    .to_string();
    let shaped = summarize_web_results(body.as_bytes());
    let items: Vec<serde_json::Value> = serde_json::from_str(&shaped).expect("valid json");
    assert_eq!(items.len(), 5);
    assert_eq!(items[4]["url"], "https://example.com/4");
}

#[test]
fn an_empty_or_unreadable_web_response_says_so() {
    assert!(summarize_web_results(b"not json").contains("unreadable"));
    let empty = serde_json::json!({ "data": { "results": [] } }).to_string();
    assert!(summarize_web_results(empty.as_bytes()).contains("no results"));
}

#[test]
fn blank_string_arguments_read_as_absent() {
    // Models routinely send "" for a field they mean to omit; treating that
    // as a real value makes read_note look up the empty note id.
    let args = serde_json::json!({ "note_id": "  ", "title": " Standup ", "content": "x" });
    assert_eq!(arg_str(&args, "note_id"), None);
    assert_eq!(arg_str(&args, "title").as_deref(), Some("Standup"));
    assert_eq!(arg_str(&args, "missing"), None);
}

#[test]
fn numeric_arguments_accept_both_json_shapes() {
    assert_eq!(
        arg_i64(&serde_json::json!({ "limit": 5 }), "limit"),
        Some(5)
    );
    assert_eq!(
        arg_i64(&serde_json::json!({ "limit": "5" }), "limit"),
        Some(5)
    );
    assert_eq!(arg_i64(&serde_json::json!({ "limit": "x" }), "limit"), None);
}

#[test]
fn truncation_is_announced_so_the_model_knows_it_saw_a_fragment() {
    assert_eq!(truncate("short".to_string(), 10), "short");
    let long = truncate("a".repeat(50), 10);
    assert!(long.starts_with(&"a".repeat(10)));
    assert!(long.ends_with("[truncated]"));
}

#[test]
fn places_results_keep_the_provider_and_the_rows_verbatim() {
    let body = serde_json::json!({
        "success": true,
        "data": {
            "query": "expert comptable annemasse",
            "provider": "osm",
            "places": [{
                "name": "Sogeca Experts",
                "lat": 46.19,
                "lng": 6.23,
                "address": "Rue de la Gare, Annemasse",
                "category": "Accountant"
            }]
        }
    });
    let summary = summarize_places_results(body.to_string().as_bytes());
    let parsed: serde_json::Value = serde_json::from_str(&summary).unwrap();
    assert_eq!(parsed["provider"], "osm");
    assert_eq!(parsed["places"][0]["name"], "Sogeca Experts");
    assert_eq!(parsed["places"][0]["lat"], 46.19);

    let empty = serde_json::json!({ "data": { "provider": "osm", "places": [] } });
    assert_eq!(
        summarize_places_results(empty.to_string().as_bytes()),
        "The places search returned no results."
    );
    assert_eq!(
        summarize_places_results(b"not json"),
        "The places search returned an unreadable response."
    );
}

#[test]
fn the_system_prompt_teaches_both_chat_block_kinds() {
    let prompt = build_system_prompt(None);
    assert!(prompt.contains("subrosa:links"));
    assert!(prompt.contains("subrosa:places"));
    assert!(prompt.contains("Never invent a place or a coordinate."));
}

#[test]
fn reading_and_writing_tools_are_advertised() {
    let names = tool_names(&tool_definitions(true));
    for expected in [
        "search_notes",
        "read_note",
        "list_recent_notes",
        "create_note",
        "append_to_note",
        "web_search",
        "places_search",
        "summarize_note",
        "import_link",
        // The production surface: the same two the desktop MCP has, and
        // deliberately no render tool - the phone's agent prepares a film
        // and the spending happens where the user sees the figure.
        "bible",
        "shots",
    ] {
        assert!(names.contains(&expected.to_string()), "missing {expected}");
    }
    assert!(!names.contains(&"render".to_string()));
}

/// These two are the only tools that spend money and take minutes rather
/// than answering. A model that describes their result instead of saying
/// they started is the failure mode, so the description has to say so.
#[test]
fn the_tools_that_start_work_say_they_start_work() {
    let tools = tool_definitions(false);
    let describe = |name: &str| -> String {
        tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == name)
            .unwrap_or_else(|| panic!("{name} is not advertised"))["function"]["description"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };

    let summarize = describe("summarize_note");
    assert!(
        summarize.contains("ask the user before starting"),
        "summarize_note must tell the model to ask first: {summarize}"
    );
    assert!(
        summarize.contains("read_note could answer"),
        "summarize_note must steer cheap questions to read_note: {summarize}"
    );

    let import = describe("import_link");
    assert!(
        import.contains("do not work"),
        "import_link must name the rail that cannot work: {import}"
    );
    assert!(
        import.contains("rather than promising the result"),
        "import_link must stop the model describing a note that does not exist: {import}"
    );
}

#[test]
fn the_system_prompt_tells_the_model_what_the_slow_tools_cost() {
    let prompt = build_system_prompt(None);

    assert!(prompt.contains("summarize_note"));
    assert!(prompt.contains("import_link"));
    // The two rules that keep a model from lying about work in flight.
    assert!(prompt.contains("ask before starting one"));
    assert!(prompt.contains("has started rather than describing a result you have not seen"));
}

#[test]
fn read_note_requires_the_id_search_handed_back() {
    let tools = tool_definitions(false);
    let read = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "read_note")
        .unwrap();
    assert_eq!(
        read["function"]["parameters"]["required"],
        serde_json::json!(["note_id"])
    );
}

#[test]
fn memory_tools_are_only_advertised_when_memory_is_enabled() {
    // Both directions matter: advertising `remember` while memory is off
    // would have the model promise to remember something that is dropped.
    let with_memory = tool_names(&tool_definitions(true));
    assert!(with_memory.contains(&"search_memories".to_string()));
    assert!(with_memory.contains(&"remember".to_string()));

    let without_memory = tool_names(&tool_definitions(false));
    assert!(!without_memory.contains(&"search_memories".to_string()));
    assert!(!without_memory.contains(&"remember".to_string()));
    // The rest of the surface is unaffected by the memory setting.
    assert!(without_memory.contains(&"read_note".to_string()));
}
