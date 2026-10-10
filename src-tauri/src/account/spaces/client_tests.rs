//! The client against a service that lies about history: a forged first
//! head, a key sealed to the reader under it, and an object signed in a real
//! member's name. Nothing of it is accepted and nothing is written. The same
//! service telling the truth is read normally, so the refusal is the chain's.
use super::client::{self, Ctx, Fetched};
use super::protocol::tests::{
    alice, bob, body, carol, chain, forged_first_head, key, mallory, wire, ALICE, BOB, CAROL,
    CREATED, SPACE,
};
use super::protocol::{self, EpochHead, IdentitySecret};
use super::store::{self, NewSpace};
use crate::account::{Account, Session};
use serde_json::{json, Value};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqlitePool, SqlitePoolOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A service that answers the space's detail and its objects, as given,
/// until the test ends.
async fn service(detail: Value, objects: Value) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut received = Vec::new();
            let mut chunk = [0u8; 2048];
            while !received.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => received.extend_from_slice(&chunk[..read]),
                }
            }
            let request = String::from_utf8_lossy(&received).into_owned();
            let path = request.split(' ').nth(1).unwrap_or_default();
            let (status, data) = if path == format!("/api/v1/spaces/{SPACE}") {
                ("200 OK", detail.clone())
            } else if path.starts_with(&format!("/api/v1/spaces/{SPACE}/objects?")) {
                ("200 OK", objects.clone())
            } else {
                ("404 Not Found", json!(null))
            };
            let body = if data.is_null() {
                json!({"error": {"code": "not_found"}}).to_string()
            } else {
                json!({ "data": data }).to_string()
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    base
}

/// Bob's device: it joined at epoch 2 and keeps the heads given.
async fn bobs_device(kept: &[&EpochHead]) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    store::insert_space(
        &pool,
        NewSpace {
            id: SPACE,
            name: "Launch",
            owner: ALICE,
            role: "member",
            state: "active",
            source_folder_id: None,
            anchor: &alice().bundle(ALICE, CREATED),
        },
    )
    .await
    .unwrap();
    store::save_heads(&pool, SPACE, kept).await.unwrap();
    pool
}

fn ctx(base: String) -> Ctx {
    Ctx {
        s: Session {
            base,
            account: Account {
                id: BOB.into(),
                email: "bob@example.test".into(),
                created_at: CREATED.into(),
            },
            token: crate::redacted::Redacted::new("device-token".to_string()),
        },
        identity: bob(),
        bundle: bob().bundle(BOB, CREATED),
    }
}

fn wrapped(epoch: u64, key: &[u8; 32]) -> Value {
    let sealed =
        protocol::wrap_key(key, &bob().bundle(BOB, CREATED).x25519, SPACE, epoch, BOB).unwrap();
    json!({"epoch": epoch, "sealed": sealed})
}

/// The detail of a space at epoch 3 (Alice, Bob, Carol), with the heads and
/// the epoch-1 key as given.
fn detail(heads: &[&EpochHead], first_key: &[u8; 32]) -> Value {
    let identity = |secret: &IdentitySecret, account: &str| json!({"account_id": account, "identity": secret.bundle(account, CREATED)});
    json!({
        "current_epoch": 3,
        "members": [identity(&alice(), ALICE), identity(&bob(), BOB), identity(&carol(), CAROL)],
        "heads": heads.iter().map(|head| json!({"epoch": head.epoch, "head": head})).collect::<Vec<_>>(),
        "keys": [wrapped(1, first_key), wrapped(2, &key(2)), wrapped(3, &key(3))],
        "invitations": [],
        "departures": [],
    })
}

/// One note at `epoch`, in Alice's name, signed by `signer` under `key`.
fn objects(epoch: u64, key: &[u8; 32], signer: &IdentitySecret) -> Value {
    let note = body(
        "note",
        "0191d1a4-3000-7000-8000-00000000d001",
        ALICE,
        json!({"title":"Venue","body":"Wire the deposit to this account."}),
    );
    let parts = protocol::seal_object(key, SPACE, epoch, &note, signer).unwrap();
    let mut object = serde_json::to_value(wire(&note, epoch, &parts)).unwrap();
    object["sequence"] = json!(1);
    json!({"objects": [object], "cursor": 1, "has_more": false})
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    query(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
        .get::<i64, _>("n")
}

#[tokio::test]
async fn the_genuine_history_is_read() {
    let heads = chain();
    let pool = bobs_device(&[&heads[0], &heads[1]]).await;
    let base = service(
        detail(&[&heads[0], &heads[1], &heads[2]], &key(1)),
        objects(3, &key(3), &alice()),
    )
    .await;
    let ctx = ctx(base);
    let row = store::space(&pool, SPACE).await.unwrap();
    let Fetched::Verified(v) = client::fetch(&pool, &ctx, &row).await.unwrap() else {
        panic!("Bob is a member at epoch 3");
    };
    client::pull(&pool, &ctx, &row, &v).await.unwrap();
    assert_eq!(count(&pool, "space_heads").await, 3);
    assert_eq!(count(&pool, "space_objects").await, 1);
}

#[tokio::test]
async fn a_forged_first_head_writes_nothing_in_a_members_name() {
    let heads = chain();
    // A device that kept the whole history, and one that kept only the head
    // it trusts: the chain alone must refuse the forgery, the kept history
    // must agree with it.
    for kept in [vec![&heads[0], &heads[1]], vec![&heads[1]]] {
        let pool = bobs_device(&kept).await;
        let forged = forged_first_head();
        let base = service(
            detail(&[&forged, &heads[1], &heads[2]], &key(13)),
            objects(1, &key(13), &mallory()),
        )
        .await;
        let ctx = ctx(base);
        let row = store::space(&pool, SPACE).await.unwrap();
        let error = match client::fetch(&pool, &ctx, &row).await {
            Err(error) => error,
            Ok(_) => panic!("a forged head was accepted"),
        };
        assert_eq!(error.code, "space_rollback");
        assert_eq!(count(&pool, "space_heads").await, kept.len() as i64);
        assert_eq!(count(&pool, "space_objects").await, 0);
        assert_eq!(count(&pool, "space_members").await, 0);
    }
}
