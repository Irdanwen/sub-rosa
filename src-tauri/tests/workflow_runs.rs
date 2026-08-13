//! Workflow run rows (ADR-0021): the durable state a production resume reads.

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::{WorkflowRunDto, WorkflowRunStatus};
use sqlx_sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

fn run(id: &str) -> WorkflowRunDto {
    WorkflowRunDto {
        id: id.to_string(),
        workflow_id: "wf-1".to_string(),
        name: "Short film".to_string(),
        definition: r#"{"nodes":[],"edges":[]}"#.to_string(),
        status: WorkflowRunStatus::Running,
        error: None,
        node_costs: Some(r#"{"clip":35}"#.to_string()),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[tokio::test]
async fn creates_a_run_with_one_pending_row_per_node() {
    let repos = repos().await;
    repos
        .insert_workflow_run(&run("r1"), &["a".to_string(), "b".to_string()])
        .await
        .expect("insert");

    let (stored, nodes) = repos
        .get_workflow_run("r1")
        .await
        .expect("get")
        .expect("exists");
    assert_eq!(stored.status, WorkflowRunStatus::Running);
    assert_eq!(stored.node_costs.as_deref(), Some(r#"{"clip":35}"#));
    assert_eq!(nodes.len(), 2);
    assert!(nodes.iter().all(|node| node.status == "pending"));
    assert!(nodes.iter().all(|node| node.output.is_none()));
}

#[tokio::test]
async fn node_transitions_replace_output_and_error_whole() {
    let repos = repos().await;
    repos
        .insert_workflow_run(&run("r1"), &["clip".to_string()])
        .await
        .expect("insert");

    // Running with a pending job pointer, the state a resume re-attaches to.
    repos
        .set_workflow_run_node(
            "r1",
            "clip",
            "running",
            Some(r#"{"pendingJobId":"q-9"}"#),
            None,
        )
        .await
        .expect("set running");
    let (_, nodes) = repos.get_workflow_run("r1").await.unwrap().unwrap();
    assert_eq!(nodes[0].status, "running");
    assert_eq!(
        nodes[0].output.as_deref(),
        Some(r#"{"pendingJobId":"q-9"}"#)
    );

    // Done replaces the pointer with the dehydrated result, not a merge.
    repos
        .set_workflow_run_node(
            "r1",
            "clip",
            "done",
            Some(r#"{"kind":"video","artifactId":"a.mp4"}"#),
            None,
        )
        .await
        .expect("set done");
    let (_, nodes) = repos.get_workflow_run("r1").await.unwrap().unwrap();
    assert_eq!(nodes[0].status, "done");
    assert_eq!(
        nodes[0].output.as_deref(),
        Some(r#"{"kind":"video","artifactId":"a.mp4"}"#)
    );
    assert!(nodes[0].error.is_none());

    // An error clears the output: there is no result to resume from.
    repos
        .set_workflow_run_node("r1", "clip", "error", None, Some("boom"))
        .await
        .expect("set error");
    let (_, nodes) = repos.get_workflow_run("r1").await.unwrap().unwrap();
    assert_eq!(nodes[0].status, "error");
    assert!(nodes[0].output.is_none());
    assert_eq!(nodes[0].error.as_deref(), Some("boom"));
}

#[tokio::test]
async fn settles_lists_and_dismisses_runs() {
    let repos = repos().await;
    repos
        .insert_workflow_run(&run("r1"), &["a".to_string()])
        .await
        .expect("insert r1");
    repos
        .insert_workflow_run(&run("r2"), &["a".to_string()])
        .await
        .expect("insert r2");

    // A gate hold round-trips through the snake case column value.
    let held = repos
        .set_workflow_run_status("r1", WorkflowRunStatus::AwaitingGate, None)
        .await
        .expect("hold")
        .expect("exists");
    assert_eq!(held.status, WorkflowRunStatus::AwaitingGate);

    let settled = repos
        .set_workflow_run_status("r1", WorkflowRunStatus::Failed, Some("credits ran out"))
        .await
        .expect("settle")
        .expect("exists");
    assert_eq!(settled.status, WorkflowRunStatus::Failed);
    assert_eq!(settled.error.as_deref(), Some("credits ran out"));

    let runs = repos.list_workflow_runs().await.expect("list");
    assert_eq!(runs.len(), 2);

    // Dismissing removes the run and its node rows.
    repos.delete_workflow_run("r1").await.expect("delete");
    let runs = repos.list_workflow_runs().await.expect("list");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, "r2");
    assert!(repos.get_workflow_run("r1").await.expect("get").is_none());
}

#[tokio::test]
async fn media_jobs_carry_their_source() {
    use os_june_lib::domain::types::{MediaJobDto, MediaJobStatus};
    let repos = repos().await;
    let job = MediaJobDto {
        id: "q-1".to_string(),
        kind: "video".to_string(),
        model: "m".to_string(),
        prompt: "p".to_string(),
        extension: "mp4".to_string(),
        status: MediaJobStatus::Queued,
        error: None,
        error_status: None,
        artifact_path: None,
        artifact_file_name: None,
        artifact_bytes: None,
        parent_artifact_id: None,
        parent_handoff_seconds: None,
        cost_credits: None,
        source: Some("workflow".to_string()),
        created_at: String::new(),
        updated_at: String::new(),
    };
    repos
        .insert_media_job(&job, "/video/retrieve", "{}", "[\"video_url\"]")
        .await
        .expect("insert");
    let stored = repos
        .get_media_job("q-1")
        .await
        .expect("get")
        .expect("exists");
    assert_eq!(stored.source.as_deref(), Some("workflow"));
    // Rows from before the column existed read back as None.
    let listed = repos.list_media_jobs().await.expect("list");
    assert_eq!(listed.len(), 1);
}
