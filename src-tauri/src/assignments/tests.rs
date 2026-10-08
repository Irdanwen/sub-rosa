//! Assignments: the rows, the single-use slots, the inbox and its feedback,
//! against a real database built by the migrations.

use sqlx_sqlite::SqlitePool;

use super::prompt::{self, Autonomy, RunPrompt};
use super::schedule::{self, Role};
use super::store::{self, NewRun};
use super::*;

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn input(goal: &str) -> AssignmentInput {
    AssignmentInput {
        id: None,
        kind: None,
        title: String::new(),
        goal: goal.into(),
        cadence: "daily".into(),
        at_minute: Some(9 * 60),
        weekday: None,
        every_hours: None,
        autonomy: "ask".into(),
        tools: vec!["web".into(), "notes".into(), "made-up".into(), "web".into()],
        device_id: None,
        device_name: None,
    }
}

const NOW: &str = "2026-10-08T07:00:00Z";

#[test]
fn a_save_fills_the_title_drops_unknown_tools_and_addresses_this_device() {
    let row = normalize(
        &input("Watch the public tenders\nin Geneva"),
        None,
        "phone-1",
        NOW,
    )
    .unwrap();
    assert_eq!(row.title, "Watch the public tenders");
    assert_eq!(row.tools, ["web", "notes"]);
    assert_eq!(row.device_id, "phone-1");
    assert_eq!(row.origin_device_id, "phone-1");
    assert_eq!(row.active_since, NOW);
    assert_eq!(row.kind, "assignment");
    // No goal, no assignment; no known cadence, no assignment.
    assert_eq!(
        normalize(&input("   "), None, "phone-1", NOW)
            .unwrap_err()
            .code,
        "assignment_goal_missing"
    );
    let mut monthly = input("x");
    monthly.cadence = "monthly".into();
    assert!(normalize(&monthly, None, "phone-1", NOW).is_err());
}

#[test]
fn another_device_needs_an_account_and_an_edit_keeps_the_origin() {
    let mut remote = input("Draft the weekly report");
    remote.device_id = Some("desk-1".into());
    remote.device_name = Some("Mac".into());
    assert_eq!(
        normalize(&remote, None, "", NOW).unwrap_err().code,
        "assignment_no_account"
    );
    let row = normalize(&remote, None, "phone-1", NOW).unwrap();
    assert_eq!(
        (row.device_id.as_str(), row.device_name.as_str()),
        ("desk-1", "Mac")
    );
    // Edited on the computer later: still the phone's, still its clock.
    let mut edit = remote.clone();
    edit.id = Some(row.id.clone());
    edit.goal = "Draft the weekly report, in French".into();
    let edited = normalize(&edit, Some(&row), "desk-1", "2026-10-09T07:00:00Z").unwrap();
    assert_eq!(edited.id, row.id);
    assert_eq!(edited.origin_device_id, "phone-1");
    assert_eq!(edited.created_at, row.created_at);
    assert_eq!(edited.active_since, row.active_since);
    assert_eq!(edited.device_id, "desk-1", "the computer runs it");
    assert_eq!(edited.device_name, "Mac", "and the phone still names it");
}

#[tokio::test]
async fn an_assignment_is_a_durable_row_and_resuming_restarts_its_clock() {
    let pool = pool().await;
    let row = normalize(&input("Watch tenders"), None, "", "2020-01-01T00:00:00Z").unwrap();
    store::upsert(&pool, &row).await.unwrap();
    assert_eq!(store::get(&pool, &row.id).await.unwrap().unwrap(), row);
    store::set_paused(&pool, &row.id, true).await.unwrap();
    let paused = store::get(&pool, &row.id).await.unwrap().unwrap();
    assert!(paused.paused);
    store::set_paused(&pool, &row.id, false).await.unwrap();
    let resumed = store::get(&pool, &row.id).await.unwrap().unwrap();
    assert!(!resumed.paused);
    assert!(
        resumed.active_since > row.active_since,
        "the slots it was paused through are not owed"
    );
    // A library that gets an account: its own rows become this device's.
    store::adopt_unaddressed(&pool, "desk-1").await.unwrap();
    let adopted = store::get(&pool, &row.id).await.unwrap().unwrap();
    assert_eq!(adopted.device_id, "desk-1");
    assert_eq!(adopted.origin_device_id, "desk-1");
}

#[tokio::test]
async fn a_slot_runs_once_here_and_not_at_all_when_another_device_ran_it() {
    let pool = pool().await;
    let row = normalize(&input("Watch tenders"), None, "phone-1", NOW).unwrap();
    store::upsert(&pool, &row).await.unwrap();
    let key = "2026-10-08T07:00:00Z";
    let id = store::run_id(&row.id, key);
    assert_eq!(id, store::run_id(&row.id, key), "one slot, one object");
    assert!(store::claim_slot(&pool, &row.id, key, &id).await.unwrap());
    assert!(!store::claim_slot(&pool, &row.id, key, &id).await.unwrap());
    // A run that arrived through synchronisation, for tomorrow's slot.
    let tomorrow = "2026-10-09T07:00:00Z";
    store::insert_run(
        &pool,
        &NewRun {
            id: &store::run_id(&row.id, tomorrow),
            assignment_id: &row.id,
            slot: tomorrow,
            late: false,
            device_id: "desk-1",
            device_name: "computer",
        },
    )
    .await
    .unwrap();
    let ran = store::ran_slots(&pool, &row.id).await.unwrap();
    assert!(ran.contains(key) && ran.contains(tomorrow));
    let schedule = row.schedule().unwrap();
    let morning = chrono::DateTime::parse_from_rfc3339("2026-10-09T09:30:00+02:00").unwrap();
    assert_eq!(
        schedule::due(
            &schedule,
            chrono::DateTime::parse_from_rfc3339(NOW)
                .unwrap()
                .with_timezone(&chrono::Utc),
            &morning,
            |slot| ran.contains(slot),
            Role::Fallback,
        ),
        None,
        "the computer already ran it: the phone does not catch it up"
    );
}

#[tokio::test]
async fn a_review_and_its_feedback_reach_the_next_run() {
    let pool = pool().await;
    let row = normalize(&input("Watch tenders"), None, "", NOW).unwrap();
    store::upsert(&pool, &row).await.unwrap();
    let run_id = store::run_id(&row.id, "now:1");
    store::insert_run(
        &pool,
        &NewRun {
            id: &run_id,
            assignment_id: &row.id,
            slot: "now:1",
            late: false,
            device_id: "",
            device_name: "computer",
        },
    )
    .await
    .unwrap();
    assert!(store::finish_run(
        &pool,
        &run_id,
        "needs_review",
        Some("Found two.\n\nResult\nTwo tenders."),
        None
    )
    .await
    .unwrap());
    let inbox = store::needs_review(&pool).await.unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].1, row.title);
    let reviewed = store::review(&pool, &run_id, false, Some("  Only Geneva, please  "))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reviewed.state, "rejected");
    assert_eq!(reviewed.feedback.as_deref(), Some("Only Geneva, please"));
    assert!(store::needs_review(&pool).await.unwrap().is_empty());
    // A late answer cannot overwrite the verdict.
    assert!(
        !store::finish_run(&pool, &run_id, "needs_review", Some("again"), None)
            .await
            .unwrap()
    );
    let back = store::reviewed_for_prompt(&pool, &row.id, 5).await.unwrap();
    let text = prompt::run_prompt(&RunPrompt {
        kind: &row.kind,
        title: &row.title,
        goal: &row.goal,
        autonomy: Autonomy::Ask,
        late_for: None,
        reviewed: &back,
        approved_proposal: None,
    });
    assert!(text.contains("I rejected your result (\"Two tenders.\")"));
    assert!(text.contains("My feedback: Only Geneva, please"));
}

#[tokio::test]
async fn an_approved_proposal_is_carried_out_once_and_only_when_asked_first() {
    let pool = pool().await;
    let asked = normalize(&input("Draft replies"), None, "", NOW).unwrap();
    let mut acting_input = input("Tidy the notes");
    acting_input.autonomy = "act".into();
    let acting = normalize(&acting_input, None, "", NOW).unwrap();
    for row in [&asked, &acting] {
        store::upsert(&pool, row).await.unwrap();
        let id = store::run_id(&row.id, "now:1");
        store::insert_run(
            &pool,
            &NewRun {
                id: &id,
                assignment_id: &row.id,
                slot: "now:1",
                late: false,
                device_id: "",
                device_name: "computer",
            },
        )
        .await
        .unwrap();
        store::finish_run(&pool, &id, "needs_review", Some("Send three drafts"), None)
            .await
            .unwrap();
        store::review(&pool, &id, true, None).await.unwrap();
    }
    let pending = store::pending_carry_outs(&pool).await.unwrap();
    assert_eq!(
        pending.len(),
        1,
        "an approval under \"act\" is only a verdict"
    );
    assert_eq!(pending[0].assignment_id, asked.id);
    let key = format!("approved:{}", pending[0].id);
    assert!(
        store::claim_slot(&pool, &asked.id, &key, &store::run_id(&asked.id, &key))
            .await
            .unwrap()
    );
    assert!(
        store::pending_carry_outs(&pool).await.unwrap().is_empty(),
        "carried out once"
    );
}

#[tokio::test]
async fn deleting_an_assignment_takes_its_history_with_it() {
    let pool = pool().await;
    let row = normalize(&input("Watch tenders"), None, "", NOW).unwrap();
    store::upsert(&pool, &row).await.unwrap();
    store::insert_run(
        &pool,
        &NewRun {
            id: "r1",
            assignment_id: &row.id,
            slot: "now:1",
            late: false,
            device_id: "",
            device_name: "computer",
        },
    )
    .await
    .unwrap();
    store::delete(&pool, &row.id).await.unwrap();
    assert!(store::get(&pool, &row.id).await.unwrap().is_none());
    assert!(store::runs(&pool, Some(&row.id), 10)
        .await
        .unwrap()
        .is_empty());
}

#[test]
fn a_row_runs_on_the_device_it_names_or_here_without_an_account() {
    let mut row = normalize(&input("x"), None, "", NOW).unwrap();
    assert!(runs_here(&row, ""));
    assert!(runs_here(&row, "desk-1"));
    row.device_id = "desk-1".into();
    assert!(runs_here(&row, "desk-1"));
    assert!(!runs_here(&row, "phone-1"));
}

#[test]
fn only_our_address_is_an_assignment_errand() {
    assert_eq!(
        errand_assignment("subrosa://assignment/abc-123"),
        Some("abc-123")
    );
    assert_eq!(errand_assignment("subrosa://assignment/"), None);
    assert_eq!(errand_assignment("subrosa://assignment/../x"), None);
    assert_eq!(errand_assignment("https://example.com/watch?v=1"), None);
}
