//! The local rules of shared projects: what replaces what, what waits to be
//! sent, and what a removed member keeps.
use super::protocol::{IdentitySecret, ObjectBody};
use super::store::*;
use serde_json::json;
use sqlx_sqlite::{SqlitePool, SqlitePoolOptions};

const SPACE: &str = "0191d1a4-5a00-7000-8000-00000000a001";
const ALICE: &str = "0191d1a4-0000-7000-8000-0000000000a1";
const NOTE: &str = "0191d1a4-3000-7000-8000-00000000d001";

async fn database() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    let anchor = IdentitySecret::from_seeds([1; 32], [2; 32]).bundle(ALICE, "now");
    insert_space(
        &pool,
        NewSpace {
            id: SPACE,
            name: "Launch",
            owner: ALICE,
            role: "owner",
            state: "active",
            source_folder_id: None,
            anchor: &anchor,
        },
    )
    .await
    .unwrap();
    pool
}
fn note(revision: &str, body: &str) -> ObjectBody {
    ObjectBody {
        v: 1,
        kind: "note".into(),
        object_id: NOTE.into(),
        revision: revision.into(),
        parent_revision: None,
        author: ALICE.into(),
        created_at: "2026-10-08T12:00:00Z".into(),
        deleted: false,
        data: json!({"title":"Venue","body":body}),
    }
}

#[tokio::test]
async fn a_later_sequence_replaces_and_an_older_epoch_never_does() {
    let pool = database().await;
    assert!(accept_object(&pool, SPACE, &note("r1", "first"), 2, 5)
        .await
        .unwrap());
    // The same object again at an earlier sequence changes nothing.
    assert!(!accept_object(&pool, SPACE, &note("r0", "older"), 2, 4)
        .await
        .unwrap());
    accept_object(&pool, SPACE, &note("r2", "second"), 3, 9)
        .await
        .unwrap();
    // A revision sealed under an epoch before the kept one (what a removed
    // member could still produce with the old key) does not overwrite it,
    // whatever sequence the service gives it.
    accept_object(&pool, SPACE, &note("r3", "from the old key"), 2, 12)
        .await
        .unwrap();
    let kept = objects(&pool, SPACE, "note").await.unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].data["body"], "second");
}

#[tokio::test]
async fn an_unsent_edit_shows_at_once_and_replaces_the_previous_unsent_one() {
    let pool = database().await;
    accept_object(&pool, SPACE, &note("r1", "accepted"), 1, 1)
        .await
        .unwrap();
    for body in ["draft one", "draft two"] {
        enqueue(
            &pool,
            Enqueue {
                space_id: SPACE,
                object_id: NOTE,
                kind: "note",
                data: &json!({"title":"Venue","body":body}),
                deleted: false,
            },
        )
        .await
        .unwrap();
    }
    assert_eq!(pending_writes(&pool, SPACE).await.unwrap(), 1);
    let shown = objects(&pool, SPACE, "note").await.unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].data["body"], "draft two");
    assert!(shown[0].pending);
    let queued = outbox(&pool, SPACE).await.unwrap();
    assert_eq!(queued[0].parent_revision.as_deref(), Some("r1"));
    // Once sealed it is frozen: a later edit queues beside it instead of
    // replacing bytes that may already be on their way.
    freeze(&pool, &queued[0].id, &queued[0].revision, 1, "c", "s")
        .await
        .unwrap();
    enqueue(
        &pool,
        Enqueue {
            space_id: SPACE,
            object_id: NOTE,
            kind: "note",
            data: &json!({"title":"Venue","body":"three"}),
            deleted: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(pending_writes(&pool, SPACE).await.unwrap(), 2);
}

#[tokio::test]
async fn a_deletion_hides_the_object() {
    let pool = database().await;
    accept_object(&pool, SPACE, &note("r1", "x"), 1, 1)
        .await
        .unwrap();
    let mut gone = note("r2", "");
    gone.deleted = true;
    gone.data = json!({});
    accept_object(&pool, SPACE, &gone, 1, 2).await.unwrap();
    assert!(objects(&pool, SPACE, "note").await.unwrap().is_empty());
}

#[tokio::test]
async fn a_removed_member_keeps_what_was_received_until_they_forget_it() {
    let pool = database().await;
    accept_object(&pool, SPACE, &note("r1", "kept"), 1, 1)
        .await
        .unwrap();
    set_state(&pool, SPACE, "removed").await.unwrap();
    assert_eq!(objects(&pool, SPACE, "note").await.unwrap().len(), 1);
    forget(&pool, SPACE).await.unwrap();
    assert!(space(&pool, SPACE).await.is_err());
    assert!(objects(&pool, SPACE, "note").await.unwrap().is_empty());
}

#[tokio::test]
async fn a_verified_mark_survives_a_refresh_of_the_member_list() {
    let pool = database().await;
    let bundle = IdentitySecret::from_seeds([1; 32], [2; 32]).bundle(ALICE, "now");
    let list = vec![(ALICE.to_string(), "owner".to_string(), bundle)];
    replace_members(&pool, SPACE, &list).await.unwrap();
    set_verified(&pool, SPACE, ALICE, true).await.unwrap();
    replace_members(&pool, SPACE, &list).await.unwrap();
    assert!(members(&pool, SPACE).await.unwrap()[0].verified);
}

#[test]
fn a_profile_object_is_one_per_member_per_space() {
    use super::commands::profile_id;
    let a = profile_id(SPACE, ALICE);
    assert_eq!(a, profile_id(SPACE, ALICE));
    assert_ne!(a, profile_id(SPACE, "0191d1a4-0000-7000-8000-0000000000b2"));
    assert_ne!(a, profile_id("0191d1a4-5a00-7000-8000-00000000a002", ALICE));
}
