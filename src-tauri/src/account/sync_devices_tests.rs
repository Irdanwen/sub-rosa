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
    pub async fn sync(&self, key: &[u8; 32]) -> Result<(), AppError> {
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
