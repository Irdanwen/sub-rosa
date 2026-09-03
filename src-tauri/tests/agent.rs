// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::{
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{AgentMessageRole, AgentSafetyProfile, AgentTaskStatus, AgentToolEventStatus},
};
use sqlx_sqlite::SqlitePoolOptions;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

#[tokio::test]
async fn creates_agent_task_with_message_and_tool_events() {
    let repos = test_repositories().await;

    let task = repos
        .create_agent_task(
            "Summarize my open desktop windows",
            None,
            AgentSafetyProfile::AutonomousPrivate,
            None,
        )
        .await
        .expect("task should be created");
    repos
        .add_agent_tool_event(
            &task.id,
            "local_tool_policy",
            AgentToolEventStatus::Completed,
            "Autonomous private mode is active.",
            None,
            None,
            true,
        )
        .await
        .expect("tool event should be created");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");

    assert_eq!(loaded.status, AgentTaskStatus::Queued);
    assert_eq!(loaded.messages.len(), 1);
    assert_eq!(
        loaded.messages[0].content,
        "Summarize my open desktop windows"
    );
    assert_eq!(loaded.tool_events.len(), 1);
    assert_eq!(loaded.tool_events[0].tool_name, "local_tool_policy");
    assert!(loaded.tool_events[0].redacted);
}

#[tokio::test]
async fn pauses_active_agent_tasks_on_launch() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Book time to review the design",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");
    repos
        .update_agent_task_status(&task.id, AgentTaskStatus::Running, Some("Working"), None)
        .await
        .expect("task should run");

    repos
        .pause_running_agent_tasks_on_launch()
        .await
        .expect("launch recovery should succeed");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Paused);
    assert_eq!(
        loaded.progress_summary.as_deref(),
        Some("Paused when June restarted.")
    );
}

#[tokio::test]
async fn repair_completes_stale_running_task_with_assistant_reply() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Collect release notes",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");
    repos
        .update_agent_task_status(&task.id, AgentTaskStatus::Running, Some("Working"), None)
        .await
        .expect("task should run");
    repos
        .add_agent_message(&task.id, AgentMessageRole::Assistant, "Here are the notes.")
        .await
        .expect("assistant message should be added");

    repos
        .complete_agent_tasks_with_assistant_messages()
        .await
        .expect("repair should succeed");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Completed);
}

#[tokio::test]
async fn repair_skips_requeued_task_whose_latest_message_is_from_the_user() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Plan the offsite",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");
    // First turn answered, then the user sent a follow-up that re-queued
    // the task. The stale assistant reply must not complete the new turn.
    repos
        .add_agent_message(&task.id, AgentMessageRole::Assistant, "Draft agenda done.")
        .await
        .expect("assistant message should be added");
    repos
        .add_agent_message(&task.id, AgentMessageRole::User, "Add a dinner slot too.")
        .await
        .expect("user message should be added");

    repos
        .complete_agent_tasks_with_assistant_messages()
        .await
        .expect("repair should succeed");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Queued);
}

#[tokio::test]
async fn repair_leaves_paused_and_waiting_tasks_alone() {
    let repos = test_repositories().await;
    for status in [AgentTaskStatus::Paused, AgentTaskStatus::WaitingForUser] {
        let task = repos
            .create_agent_task(
                "Review the design",
                None,
                AgentSafetyProfile::default(),
                None,
            )
            .await
            .expect("task should be created");
        repos
            .add_agent_message(
                &task.id,
                AgentMessageRole::Assistant,
                "Paused before taking desktop actions.",
            )
            .await
            .expect("assistant message should be added");
        repos
            .update_agent_task_status(&task.id, status, Some("Resting state"), None)
            .await
            .expect("status should update");

        repos
            .complete_agent_tasks_with_assistant_messages()
            .await
            .expect("repair should succeed");

        let loaded = repos
            .get_agent_task(&task.id)
            .await
            .expect("task should load");
        assert_eq!(loaded.status, status);
    }
}

#[tokio::test]
async fn guarded_status_update_does_not_resurrect_cancelled_tasks() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Clean up downloads",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");
    repos
        .update_agent_task_status(
            &task.id,
            AgentTaskStatus::Cancelled,
            Some("Cancelled by the user."),
            None,
        )
        .await
        .expect("task should cancel");

    let started = repos
        .update_agent_task_status_if_in(
            &task.id,
            AgentTaskStatus::Running,
            Some("Preparing"),
            None,
            &[AgentTaskStatus::Queued],
        )
        .await
        .expect("guarded update should succeed");
    assert!(!started);
    let paused = repos
        .update_agent_task_status_if_in(
            &task.id,
            AgentTaskStatus::Paused,
            Some("Paused"),
            None,
            &[AgentTaskStatus::Running],
        )
        .await
        .expect("guarded update should succeed");
    assert!(!paused);

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Cancelled);
}

#[tokio::test]
async fn guarded_status_update_applies_allowed_transitions() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task("Summarize inbox", None, AgentSafetyProfile::default(), None)
        .await
        .expect("task should be created");

    let started = repos
        .update_agent_task_status_if_in(
            &task.id,
            AgentTaskStatus::Running,
            Some("Preparing"),
            None,
            &[AgentTaskStatus::Queued],
        )
        .await
        .expect("guarded update should succeed");
    assert!(started);

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Running);
}

#[tokio::test]
async fn hydrated_messages_dedupe_by_external_id_and_legacy_content() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Find the meeting notes",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");

    let inserted = repos
        .add_agent_message_if_absent(
            &task.id,
            AgentMessageRole::Assistant,
            "Found three matching notes.",
            "2026-06-09T10:00:00.000Z",
            "hermes:session-1:42",
        )
        .await
        .expect("first insert should succeed");
    assert!(inserted);

    // Same Hermes message hydrated again (e.g. by a concurrent poll).
    let duplicate = repos
        .add_agent_message_if_absent(
            &task.id,
            AgentMessageRole::Assistant,
            "Found three matching notes.",
            "2026-06-09T10:00:00.000Z",
            "hermes:session-1:42",
        )
        .await
        .expect("second insert should succeed");
    assert!(!duplicate);

    // A different Hermes message with identical content is a new message.
    let distinct = repos
        .add_agent_message_if_absent(
            &task.id,
            AgentMessageRole::Assistant,
            "Found three matching notes.",
            "2026-06-09T10:05:00.000Z",
            "hermes:session-1:43",
        )
        .await
        .expect("third insert should succeed");
    assert!(distinct);

    // Rows hydrated before external ids existed are matched by content.
    repos
        .add_agent_message(&task.id, AgentMessageRole::Assistant, "Legacy reply.")
        .await
        .expect("legacy message should be added");
    let legacy_duplicate = repos
        .add_agent_message_if_absent(
            &task.id,
            AgentMessageRole::Assistant,
            "Legacy reply.",
            "2026-06-09T10:10:00.000Z",
            "hermes:session-1:44",
        )
        .await
        .expect("legacy-matching insert should succeed");
    assert!(!legacy_duplicate);

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    let assistant_messages = loaded
        .messages
        .iter()
        .filter(|message| message.role == AgentMessageRole::Assistant)
        .count();
    assert_eq!(assistant_messages, 3);
}

#[tokio::test]
async fn detects_hermes_sessions_bound_to_other_tasks() {
    let repos = test_repositories().await;
    let first = repos
        .create_agent_task("Same prompt", None, AgentSafetyProfile::default(), None)
        .await
        .expect("task should be created");
    let second = repos
        .create_agent_task("Same prompt", None, AgentSafetyProfile::default(), None)
        .await
        .expect("task should be created");
    repos
        .set_agent_task_hermes_session(&first.id, "session-1")
        .await
        .expect("session should bind");

    assert!(repos
        .hermes_session_bound_to_other_task(&second.id, "session-1")
        .await
        .expect("check should succeed"));
    assert!(!repos
        .hermes_session_bound_to_other_task(&first.id, "session-1")
        .await
        .expect("check should succeed"));
}

#[tokio::test]
async fn agent_task_remembers_its_chat_model() {
    let repos = test_repositories().await;

    // Created with a model: it round-trips through get and list.
    let with_model = repos
        .create_agent_task(
            "Draft a reply",
            None,
            AgentSafetyProfile::default(),
            Some("venice-uncensored"),
        )
        .await
        .expect("task should be created");
    assert_eq!(with_model.model.as_deref(), Some("venice-uncensored"));
    let loaded = repos
        .get_agent_task(&with_model.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.model.as_deref(), Some("venice-uncensored"));
    let listed = repos.list_agent_tasks().await.expect("list should load");
    assert_eq!(
        listed
            .items
            .iter()
            .find(|task| task.id == with_model.id)
            .and_then(|task| task.model.as_deref()),
        Some("venice-uncensored"),
    );

    // Created without a model: it reads back as None (the app default applies).
    let without_model = repos
        .create_agent_task(
            "Draft another reply",
            None,
            AgentSafetyProfile::default(),
            None,
        )
        .await
        .expect("task should be created");
    assert_eq!(without_model.model, None);

    // A whitespace model at creation is normalized to None, not an empty id.
    let blank_model = repos
        .create_agent_task(
            "Third reply",
            None,
            AgentSafetyProfile::default(),
            Some("  "),
        )
        .await
        .expect("task should be created");
    assert_eq!(blank_model.model, None);

    // A mid-conversation switch is remembered.
    repos
        .set_agent_task_model(&without_model.id, Some("qwen3-4b"))
        .await
        .expect("model should update");
    assert_eq!(
        repos
            .get_agent_task(&without_model.id)
            .await
            .expect("task should load")
            .model
            .as_deref(),
        Some("qwen3-4b"),
    );

    // Clearing with an empty model falls back to the app default (NULL).
    repos
        .set_agent_task_model(&without_model.id, Some(""))
        .await
        .expect("model should clear");
    assert_eq!(
        repos
            .get_agent_task(&without_model.id)
            .await
            .expect("task should load")
            .model,
        None,
    );
}

#[tokio::test]
async fn fork_agent_task_copies_transcript_onto_another_model() {
    let repos = test_repositories().await;
    let source = repos
        .create_agent_task(
            "Compare these sites",
            None,
            AgentSafetyProfile::default(),
            Some("model-a"),
        )
        .await
        .expect("source task should be created");
    // create seeds the prompt as the first user message; add an assistant reply
    // so the fork has a real two-turn transcript to carry.
    repos
        .add_agent_message(
            &source.id,
            AgentMessageRole::Assistant,
            "Here is a comparison.",
        )
        .await
        .expect("assistant message should be added");

    let fork = repos
        .fork_agent_task(&source.id, Some("model-b"))
        .await
        .expect("fork should be created");

    // A new task on model B, carrying the whole transcript in order.
    assert_ne!(fork.id, source.id);
    assert_eq!(fork.model.as_deref(), Some("model-b"));
    assert_eq!(fork.title, source.title);
    // The fork opens idle, never as a phantom running task.
    assert_eq!(fork.status, AgentTaskStatus::Completed);
    assert_eq!(fork.messages.len(), 2);
    assert_eq!(fork.messages[0].role, AgentMessageRole::User);
    assert_eq!(fork.messages[0].content, "Compare these sites");
    assert_eq!(fork.messages[1].role, AgentMessageRole::Assistant);
    assert_eq!(fork.messages[1].content, "Here is a comparison.");

    // The original chat is untouched by the fork.
    let original = repos
        .get_agent_task(&source.id)
        .await
        .expect("source should reload");
    assert_eq!(original.model.as_deref(), Some("model-a"));
    assert_eq!(original.messages.len(), 2);

    // An empty target model falls back to the source chat's own model.
    let fork_default = repos
        .fork_agent_task(&source.id, None)
        .await
        .expect("default fork should be created");
    assert_eq!(fork_default.model.as_deref(), Some("model-a"));
    assert_eq!(fork_default.messages.len(), 2);
}
