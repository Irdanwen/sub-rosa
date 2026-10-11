//! Two devices, one account, a service between them (`fake_service`). Each
//! device is an ordinary library: migrations, triggers, outbox, inbox, heads.
//! The scenarios here are the ones a person lives: an edit on one machine
//! and a deletion on the other, a phone that was away, a build that is older
//! than its sibling. They drive `synchronize` exactly as the app does.
use super::fake_service::Service;
use super::*;
use sqlx_sqlite::SqlitePoolOptions;

pub(super) struct Device {
    pub pool: SqlitePool,
    pub session: Session,
}

pub(super) async fn device(service: &Service, name: &str) -> Device {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    query("UPDATE account_sync_control SET account_id='account-one',device_id=?,recovery_confirmed=1 WHERE id=1")
        .bind(name)
        .execute(&pool)
        .await
        .unwrap();
    set_enabled(&pool, true).await.unwrap();
    Device {
        pool,
        session: Session {
            base: service.base.clone(),
            account: Account {
                id: "account-one".into(),
                email: "one@example.test".into(),
                created_at: "now".into(),
            },
            token: Redacted::new(name.into()),
        },
    }
}

impl Device {
    pub async fn sync(&self, key: &[u8; 32]) -> Result<Summary, AppError> {
        synchronize(&self.pool, &self.session, key).await
    }
    pub async fn create_note(&self, id: &str, title: &str) {
        query("INSERT INTO notes(id,title,created_at,updated_at) VALUES(?,?,?,?)")
            .bind(id)
            .bind(title)
            .bind("2026-10-11T12:00:00Z")
            .bind("2026-10-11T12:00:00Z")
            .execute(&self.pool)
            .await
            .unwrap();
    }
    pub async fn edit_note(&self, id: &str, title: &str) {
        query("UPDATE notes SET title=?,updated_at=? WHERE id=?")
            .bind(title)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
    }
    pub async fn delete_note(&self, id: &str) {
        let mut tx = self.pool.begin().await.unwrap();
        crate::db::repositories::delete_note_records(&mut tx, id)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    pub async fn title(&self, id: &str) -> Option<String> {
        query("SELECT title FROM notes WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|r| r.get("title"))
    }
    pub async fn cards(&self, id: &str) -> i64 {
        self.count(
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE resolved=0 AND object_id=?",
            id,
        )
        .await
    }
    pub async fn outbox(&self, id: &str) -> i64 {
        self.count(
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            id,
        )
        .await
    }
    pub async fn head(&self, id: &str) -> Option<String> {
        query("SELECT revision FROM account_sync_heads WHERE object_id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|r| r.get("revision"))
    }
    pub async fn cursor(&self) -> i64 {
        query("SELECT cursor FROM account_sync_control WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get("cursor")
    }
    pub async fn applying(&self) -> i64 {
        query("SELECT applying FROM account_sync_control WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get("applying")
    }
    pub async fn count(&self, sql: &str, id: &str) -> i64 {
        query(sql)
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get::<i64, _>("n")
    }
}

fn note() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tokio::test]
async fn a_note_written_on_one_device_reaches_the_other() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&id).await.as_deref(), Some("Monday"));
    assert_eq!(phone.head(&id).await, mac.head(&id).await);
    assert_eq!(phone.cards(&id).await, 0);
}

#[tokio::test]
async fn a_stale_phones_deletion_after_the_macs_edit_deletes_everywhere_without_a_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The phone goes away. The Mac edits, and the service has that edit.
    mac.edit_note(&id, "Monday, revised").await;
    mac.sync(&key).await.unwrap();
    // The phone comes back and the person deletes the note before it caught
    // up. What the person did is the later decision.
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None, "the Mac still has the note");
    assert_eq!(phone.title(&id).await, None);
    assert_eq!(mac.cards(&id).await, 0, "the Mac was asked to review");
    assert_eq!(phone.cards(&id).await, 0, "the phone was asked to review");
    let heads = service.heads(&id).await;
    assert_eq!(heads.len(), 1, "the service holds one head");
    assert!(heads[0].deleted);
    // Nothing is left to say about it on either side.
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.outbox(&id).await + phone.outbox(&id).await, 0);
}

#[tokio::test]
async fn two_devices_deleting_the_same_note_leave_one_tombstone_and_no_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.delete_note(&id).await;
    phone.delete_note(&id).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await + phone.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
    assert_eq!(
        service.revisions(&id).await.iter().filter(|r| r.deleted).count(),
        1,
        "one deletion was enough"
    );
}

#[tokio::test]
async fn an_edit_not_yet_sent_keeps_a_card_on_the_device_that_holds_it_only() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The phone deletes and sends it. The Mac edits meanwhile, unsent.
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.edit_note(&id, "Monday, kept").await;
    mac.sync(&key).await.unwrap();
    // The Mac holds work the phone never saw: that is a question for a
    // person, on the device that has the content.
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday, kept"));
    assert_eq!(mac.cards(&id).await, 1);
    // Answering it on the Mac converges both.
    let card: String = query("SELECT id FROM account_sync_conflicts WHERE resolved=0 AND object_id=?")
        .bind(&id)
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("id");
    resolve_in_store(&mac.pool, &mac.session, &key, &card, "use_remote")
        .await
        .unwrap();
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(phone.title(&id).await, None);
    assert_eq!(mac.cards(&id).await + phone.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
}

/// A revision as a newer build would write it: a column this build does not
/// know, under the same table.
fn unreadable_note(s: &Session, key: &[u8; 32], id: &str, parent: Option<String>) -> Value {
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":false,"table":"notes","row":{"id":id,"title":"From the future","mood_colour":"teal","created_at":"now","updated_at":"now"}});
    json!({"operation_id":op,"object_id":id,"parent_revision":parent,"kind":"note","ciphertext":crypto::seal(key,&aad(s,"note",id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":false})
}

#[tokio::test]
async fn an_unreadable_revision_is_parked_the_cursor_advances_and_applying_is_back_to_zero() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let (future, ordinary) = (note(), note());
    // The phone, on a newer build, writes a note this Mac cannot read, then
    // an ordinary one, then deletes the ordinary one.
    let op = unreadable_note(&phone.session, &key, &future, None);
    let data = call(&phone.session, reqwest::Method::POST, "/api/v1/sync", Some(json!({"operations":[op]}))).await.unwrap();
    assert_eq!(data["results"].as_array().unwrap().len(), 1);
    phone.create_note(&ordinary, "Ordinary").await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&ordinary).await.as_deref(), Some("Ordinary"), "the stream froze on the unreadable revision");
    assert_eq!(mac.title(&future).await, None);
    assert_eq!(mac.applying().await, 0, "applying was left set");
    assert_eq!(mac.cursor().await, 2);
    let parked = mac.count("SELECT count(*) AS n FROM account_sync_issues WHERE lane='inbox' AND item_id<>?", "").await;
    assert_eq!(parked, 1);
    // A deletion decided on the phone still reaches the Mac.
    phone.delete_note(&ordinary).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&ordinary).await, None);
    assert_eq!(mac.cards(&ordinary).await, 0);
    // The Mac still writes: its triggers were not silenced.
    let own = note();
    mac.create_note(&own, "Still mine").await;
    assert_eq!(mac.outbox(&own).await, 1);
}

#[tokio::test]
async fn a_child_of_a_parked_revision_waits_instead_of_becoming_a_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    // A library with history: a fresh one would be handed the heads only,
    // and the parked parent would not be among them.
    mac.create_note(&note(), "Earlier").await;
    mac.sync(&key).await.unwrap();
    let id = note();
    let op = unreadable_note(&phone.session, &key, &id, None);
    let data = call(&phone.session, reqwest::Method::POST, "/api/v1/sync", Some(json!({"operations":[op]}))).await.unwrap();
    let first = data["results"][0]["revision"].as_str().unwrap().to_string();
    // An ordinary edit of the same note, child of the unreadable one.
    let op2 = {
        let op = uuid::Uuid::new_v4().to_string();
        let body = json!({"v":1,"operation_id":op,"parent_revision":first,"deleted":false,"table":"notes","row":{"id":id,"title":"Readable again","created_at":"now","updated_at":"now"}});
        json!({"operation_id":op,"object_id":id,"parent_revision":first,"kind":"note","ciphertext":crypto::seal(&key,&aad(&phone.session,"note",&id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":false})
    };
    call(&phone.session, reqwest::Method::POST, "/api/v1/sync", Some(json!({"operations":[op2]}))).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await, 0, "a child of a parked parent became a card");
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(mac.count("SELECT count(*) AS n FROM account_sync_inbox WHERE applied=0 AND object_id=?", &id).await, 2);
    // Once the parked parent is retried (after an update that reads it, here
    // the issue is simply lifted and the parent is still unreadable), the
    // child keeps waiting rather than jumping ahead.
    retry_issues(&mac.pool).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await, 0);
}

#[tokio::test]
async fn old_deletion_cards_are_settled_by_revision_order_and_the_head_moves_to_the_tombstone() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.edit_note(&id, "Monday, revised").await;
    mac.sync(&key).await.unwrap();
    // The phone, behind a build that sent before receiving, pushed a
    // tombstone with a stale parent: the service holds two heads.
    let stale = mac.head(&id).await.unwrap();
    let parent: String = query("SELECT parent_revision FROM account_sync_inbox WHERE revision=?")
        .bind(&stale)
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("parent_revision");
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":true,"table":"notes","row":{"id":id}});
    let tomb = json!({"operation_id":op,"object_id":id,"parent_revision":parent,"kind":"note","ciphertext":crypto::seal(&key,&aad(&phone.session,"note",&id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":true});
    call(&phone.session, reqwest::Method::POST, "/api/v1/sync", Some(json!({"operations":[tomb]}))).await.unwrap();
    assert_eq!(service.heads(&id).await.len(), 2);
    // And the Mac, on the old rule, wrote a card for it. Reproduce that card.
    let tombstone_revision = service.revisions(&id).await.into_iter().find(|r| r.deleted).unwrap().revision;
    query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at,resolved_revisions) SELECT revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,'2026-10-01T00:00:00Z','[]' FROM account_sync_inbox WHERE revision=?")
        .bind(&tombstone_revision)
        .execute(&mac.pool)
        .await
        .ok();
    // The inbox row may not exist yet on the Mac: pull it as a card the old way.
    if mac.cards(&id).await == 0 {
        let data = call(&mac.session, reqwest::Method::GET, &format!("/api/v1/sync?after={}&limit=100", mac.cursor().await), None).await.unwrap();
        let change = data["changes"].as_array().unwrap().iter().find(|c| c["deleted"] == true).unwrap();
        query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,applied,resolved_revisions) VALUES(?,?,?,?,?,?,1,?,1,'[]')")
            .bind(change["revision"].as_str()).bind(&id).bind("note").bind(change["ciphertext"].as_str()).bind(change["parent_revision"].as_str()).bind(change["operation_id"].as_str()).bind(change["sequence"].as_i64())
            .execute(&mac.pool).await.unwrap();
        query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at,resolved_revisions) VALUES(?,?,'note',?,?,?,1,'2026-10-01T00:00:00Z','[]')")
            .bind(change["revision"].as_str()).bind(&id).bind(change["ciphertext"].as_str()).bind(change["parent_revision"].as_str()).bind(change["operation_id"].as_str())
            .execute(&mac.pool).await.unwrap();
        query("UPDATE account_sync_control SET cursor=? WHERE id=1").bind(data["cursor"].as_i64()).execute(&mac.pool).await.unwrap();
    }
    assert_eq!(mac.cards(&id).await, 1);
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday, revised"));
    // The new rule settles it on the next pass: the deletion is later than
    // the head, nothing is unsent.
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await, 0);
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(mac.head(&id).await.as_deref(), Some(tombstone_revision.as_str()));
    assert_eq!(mac.outbox(&id).await, 0, "settling sent something");
}

#[tokio::test]
async fn a_recently_deleted_note_is_listed_and_restored_on_every_device() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None);
    let listed = recently_deleted(&mac.pool, &mac.session, &key).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].object_id, id);
    assert_eq!(listed[0].title, "Monday");
    assert_eq!(listed[0].kind, "note");
    // The device that deleted it lists it too: the journal is the same.
    assert_eq!(recently_deleted(&phone.pool, &phone.session, &key).await.unwrap().len(), 1);
    restore_deleted(&mac.pool, &mac.session, &key, &id).await.unwrap();
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday"));
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&id).await.as_deref(), Some("Monday"), "the restore did not reach the phone");
    assert_eq!(phone.cards(&id).await + mac.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
    assert!(recently_deleted(&mac.pool, &mac.session, &key).await.unwrap().is_empty());
    assert!(recently_deleted(&phone.pool, &phone.session, &key).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_deleted_conversation_is_not_recreated_by_the_hermes_mirror() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (device(&service, "mac").await, device(&service, "phone").await);
    // The Mac mirrors a Hermes session into a portable conversation.
    let mut response = json!([{"role":"user","content":"Hello","id":"m1"},{"role":"assistant","content":"Hi","id":"m2"}]);
    super::super::conversations::mirror_history(&mac.pool, "account-one", "session-42", &mut response)
        .await
        .unwrap();
    let task: String = query("SELECT id FROM agent_tasks WHERE hermes_session_id='session-42'")
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("id");
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task).await, 1);
    // The phone deletes the conversation.
    for sql in [
        "DELETE FROM agent_messages WHERE task_id=?",
        "DELETE FROM agent_tasks WHERE id=?",
    ] {
        query(sql).bind(&task).execute(&phone.pool).await.unwrap();
    }
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task).await, 0);
    // The desktop runtime still has the session; reading it again must not
    // bring the conversation back.
    let mut again = json!([{"role":"user","content":"Hello","id":"m1"},{"role":"assistant","content":"Hi","id":"m2"}]);
    super::super::conversations::mirror_history(&mac.pool, "account-one", "session-42", &mut again)
        .await
        .unwrap();
    assert_eq!(mac.count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task).await, 0);
    assert_eq!(mac.outbox(&task).await, 0);
    // And the runtime is asked to forget it.
    assert_eq!(mac.count("SELECT count(*) AS n FROM account_sync_removed_files WHERE lane='hermes-session' AND path=?", "session-42").await, 1);
}
