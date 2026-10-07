//! One test per path a temporary chat could leak through (ADR-0083), and the
//! deletion that ends it.

use super::*;
use crate::db::repositories::Repositories;

async fn database() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

/// A database bound to an account, so every outbox trigger is armed.
async fn bound_database() -> SqlitePool {
    let pool = database().await;
    query("UPDATE account_sync_control SET account_id='account-one' WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn add_message(pool: &SqlitePool, task_id: &str, role: &str, content: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,?)")
        .bind(&id)
        .bind(task_id)
        .bind(role)
        .bind(content)
        .bind(crate::db::repositories::timestamp())
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    query(sql).fetch_one(pool).await.unwrap().get(0)
}

#[tokio::test]
async fn a_temporary_chat_is_left_out_of_every_history_list() {
    let pool = database().await;
    let repos = Repositories::new(pool.clone());
    let kept = repos
        .create_agent_task("an ordinary chat", None, Default::default(), None)
        .await
        .unwrap();
    let temporary = create(&pool, "a temporary chat", None).await.unwrap();
    add_message(&pool, &temporary, "assistant", "a reply").await;

    let general = crate::assistants::general::visible_tasks(&repos)
        .await
        .unwrap();
    let ids: Vec<_> = general
        .items
        .iter()
        .map(|item| item.task.id.clone())
        .collect();
    assert_eq!(ids, vec![kept.id.clone()]);

    let all = repos.list_agent_tasks().await.unwrap();
    assert!(all.items.iter().all(|task| task.id != temporary));

    let portable = crate::account::conversations::list_conversations(&pool)
        .await
        .unwrap();
    assert!(portable.iter().all(|c| c.id != temporary));
    assert!(portable.iter().any(|c| c.id == kept.id));
}

#[tokio::test]
async fn a_temporary_chat_never_enters_the_search_index() {
    let pool = database().await;
    let repos = Repositories::new(pool.clone());
    let temporary = create(&pool, "zanzibar itinerary", None).await.unwrap();
    let reply = add_message(&pool, &temporary, "assistant", "zanzibar has spice farms").await;
    query("UPDATE agent_messages SET content='zanzibar ferries' WHERE id=?")
        .bind(&reply)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM agent_messages_fts WHERE agent_messages_fts MATCH 'zanzibar'"
        )
        .await,
        0
    );
    let hits = repos.search_everything("zanzibar", 20).await.unwrap();
    assert!(
        hits.iter().all(|hit| hit.target_id != temporary),
        "{hits:?}"
    );

    // The same words in an ordinary chat are indexed, so the gate is the flag.
    let kept = repos
        .create_agent_task("zanzibar again", None, Default::default(), None)
        .await
        .unwrap();
    let hits = repos.search_everything("zanzibar", 20).await.unwrap();
    assert!(hits.iter().any(|hit| hit.target_id == kept.id));
}

#[tokio::test]
async fn past_chat_recall_never_quotes_a_temporary_chat() {
    let pool = database().await;
    let temporary = create(&pool, "my secret plan for the harbour", None)
        .await
        .unwrap();
    // Even a row that reached the index some other way stays out.
    query("INSERT INTO agent_messages_fts(message_id, task_id, content) SELECT id, task_id, content FROM agent_messages WHERE task_id = ?")
        .bind(&temporary)
        .execute(&pool)
        .await
        .unwrap();
    let snippets = crate::memory::past_chats::search(&pool, "harbour", None, 10, None)
        .await
        .unwrap();
    assert!(snippets.is_empty(), "{snippets:?}");
}

#[tokio::test]
async fn a_temporary_chat_never_feeds_memory_extraction() {
    let pool = database().await;
    let repos = Repositories::new(pool.clone());
    let temporary = create(&pool, "Remember that I live in Lyon", None)
        .await
        .unwrap();
    for turn in 0..3 {
        add_message(&pool, &temporary, "assistant", "Noted.").await;
        add_message(&pool, &temporary, "user", &format!("And fact {turn}")).await;
    }
    // Returns before any model is asked: an ordinary chat would try to reach
    // one here and fail, since tests have none.
    let added = crate::memory::extract::extract_after_turn(&repos, &temporary)
        .await
        .unwrap();
    assert_eq!(added, 0);
    assert_eq!(count(&pool, "SELECT count(*) FROM memories").await, 0);

    // The desktop names its session instead of a task.
    register_session(&pool, "hermes-temporary").await.unwrap();
    assert!(is_temporary_session(&pool, "hermes-temporary")
        .await
        .unwrap());
    assert!(!is_temporary_session(&pool, "hermes-other").await.unwrap());
    forget_session(&pool, "hermes-temporary").await.unwrap();
}

#[tokio::test]
async fn a_temporary_chat_is_never_titled() {
    let pool = database().await;
    let temporary = create(&pool, "What should I cook tonight", None)
        .await
        .unwrap();
    add_message(&pool, &temporary, "assistant", "A risotto.").await;
    let mut tx = pool.begin().await.unwrap();
    crate::chat_titles::mark_first_reply(&mut tx, &temporary, "t1")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM agent_task_titles").await,
        0
    );
    let title: String = query("SELECT title FROM agent_tasks WHERE id=?")
        .bind(&temporary)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("title");
    assert_eq!(title, TEMPORARY_TITLE);
}

#[tokio::test]
async fn no_row_of_a_temporary_chat_ever_reaches_the_outbox() {
    let pool = bound_database().await;
    let repos = Repositories::new(pool.clone());
    let temporary = create(&pool, "nothing leaves", None).await.unwrap();
    let reply = add_message(&pool, &temporary, "assistant", "indeed").await;
    query("UPDATE agent_messages SET content='still nothing' WHERE id=?")
        .bind(&reply)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE agent_tasks SET status='completed', title='Renamed' WHERE id=?")
        .bind(&temporary)
        .execute(&pool)
        .await
        .unwrap();
    discard_task(&pool, &temporary).await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_sync_outbox").await,
        0
    );

    // A desktop session row neither.
    register_session(&pool, "hermes-session").await.unwrap();
    forget_session(&pool, "hermes-session").await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_sync_outbox").await,
        0
    );

    // The first inventory, taken when synchronisation is switched on, skips
    // one too.
    let open = create(&pool, "still open", None).await.unwrap();
    add_message(&pool, &open, "assistant", "yes").await;
    crate::account::sync::set_enabled(&pool, true)
        .await
        .unwrap();
    assert_eq!(
        count(
            &pool,
            &format!("SELECT count(*) FROM account_sync_outbox WHERE body LIKE '%{open}%'")
        )
        .await,
        0
    );

    // And an ordinary chat is journaled, so the gate is the flag.
    repos
        .create_agent_task("an ordinary chat", None, Default::default(), None)
        .await
        .unwrap();
    assert!(count(&pool, "SELECT count(*) FROM account_sync_outbox").await > 0);
}

#[tokio::test]
async fn a_branch_of_a_temporary_chat_is_temporary() {
    let pool = bound_database().await;
    let repos = Repositories::new(pool.clone());
    let temporary = create(&pool, "first question", None).await.unwrap();
    add_message(&pool, &temporary, "assistant", "first answer").await;
    let branch = repos.fork_agent_task(&temporary, None).await.unwrap();
    assert!(is_temporary(&pool, &branch.id).await.unwrap());
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_sync_outbox").await,
        0
    );
}

#[tokio::test]
async fn a_temporary_desktop_session_is_never_copied_into_portable_history() {
    let pool = bound_database().await;
    register_session(&pool, "hermes-temporary").await.unwrap();
    let mut response = serde_json::json!([
        {"id": "m1", "role": "user", "content": "a private question"},
        {"id": "m2", "role": "assistant", "content": "a private answer"}
    ]);
    crate::account::conversations::mirror_history(
        &pool,
        "account-one",
        "hermes-temporary",
        &mut response,
    )
    .await
    .unwrap();
    assert_eq!(count(&pool, "SELECT count(*) FROM agent_messages").await, 0);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_sync_outbox").await,
        0
    );
    forget_session(&pool, "hermes-temporary").await.unwrap();
}

#[tokio::test]
async fn the_archive_leaves_a_temporary_chat_out() {
    let pool = database().await;
    let repos = Repositories::new(pool.clone());
    let kept = repos
        .create_agent_task("kept", None, Default::default(), None)
        .await
        .unwrap();
    let temporary = create(&pool, "not carried away", None).await.unwrap();
    let tasks = crate::archive::dump_table(&pool, "agent_tasks")
        .await
        .unwrap();
    assert!(tasks.iter().any(|row| row["id"] == kept.id.as_str()));
    assert!(tasks.iter().all(|row| row["id"] != temporary.as_str()));
    let messages = crate::archive::dump_table(&pool, "agent_messages")
        .await
        .unwrap();
    assert!(messages
        .iter()
        .all(|row| row["task_id"] != temporary.as_str()));
    assert!(messages
        .iter()
        .any(|row| row["task_id"] == kept.id.as_str()));
}

#[tokio::test]
async fn leaving_or_relaunching_deletes_a_temporary_chat() {
    let pool = bound_database().await;
    let repos = Repositories::new(pool.clone());
    let kept = repos
        .create_agent_task("kept", None, Default::default(), None)
        .await
        .unwrap();
    let before = count(&pool, "SELECT count(*) FROM account_sync_outbox").await;

    // Leaving it.
    let left = create(&pool, "left", None).await.unwrap();
    add_message(&pool, &left, "assistant", "bye").await;
    query("INSERT INTO agent_tool_events(id,task_id,tool_name,status,summary,created_at) VALUES('tool-1',?,'web_search','completed','s','t')")
        .bind(&left)
        .execute(&pool)
        .await
        .unwrap();
    discard_task(&pool, &left).await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM agent_messages WHERE task_id IN (SELECT id FROM agent_tasks WHERE ephemeral=1)").await,
        0
    );
    assert!(!is_temporary(&pool, &left).await.unwrap());
    assert_eq!(
        count(&pool, "SELECT count(*) FROM agent_tool_events").await,
        0
    );

    // A crash left one behind: the next open of the database deletes it.
    let orphan = create(&pool, "orphan", None).await.unwrap();
    // A desktop session waits for its runtime, then goes.
    register_session(&pool, "hermes-left-over").await.unwrap();
    live().remove("hermes-left-over");
    register_session(&pool, "hermes-open-now").await.unwrap();
    sweep_on_open(&pool).await;
    assert!(!is_temporary(&pool, &orphan).await.unwrap());
    assert_eq!(
        stale_sessions(&pool).await.unwrap(),
        vec!["hermes-left-over".to_string()]
    );
    let mut hidden = session_ids(&pool).await.unwrap();
    hidden.sort();
    assert_eq!(hidden, vec!["hermes-left-over", "hermes-open-now"]);
    forget_session(&pool, "hermes-left-over").await.unwrap();
    forget_session(&pool, "hermes-open-now").await.unwrap();
    assert!(session_ids(&pool).await.unwrap().is_empty());

    // Nothing of it was journaled, and the ordinary chat is untouched.
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_sync_outbox").await,
        before
    );
    assert!(repos.get_agent_task(&kept.id).await.is_ok());

    // Deleting asks the flag: an ordinary chat is never taken by mistake.
    discard_task(&pool, &kept.id).await.unwrap();
    assert!(repos.get_agent_task(&kept.id).await.is_ok());
}

async fn rate(pool: &SqlitePool, conversation_id: &str) {
    let request = crate::reply_ratings::SetReplyRatingRequest {
        conversation_id: conversation_id.into(),
        message_id: "m1".into(),
        rating: Some("down".into()),
        reason: Some("too_long".into()),
        note: None,
    };
    crate::reply_ratings::set_rating(pool, &request)
        .await
        .unwrap();
}

#[tokio::test]
async fn leaving_a_temporary_chat_deletes_its_reply_ratings() {
    let pool = database().await;
    // On the phone a rating names the task, on the desktop the Hermes session.
    let phone = create(&pool, "a temporary chat", None).await.unwrap();
    rate(&pool, &phone).await;
    register_session(&pool, "hermes-rated").await.unwrap();
    rate(&pool, "hermes-rated").await;

    discard_task(&pool, &phone).await.unwrap();
    forget_session(&pool, "hermes-rated").await.unwrap();

    assert_eq!(count(&pool, "SELECT count(*) FROM reply_ratings").await, 0);
}
