//! Shared projects (ADR 0098) against a real `PostgreSQL`: the service as a
//! blind courier that authorizes by membership. Keys and signatures here are
//! well-formed placeholders: the service checks shapes and its own rows, never
//! a signature, and the cryptography has its own suites in the app and the
//! browser (`account/spaces/protocol_tests.rs`, `website-spaces-protocol`).
use super::*;

fn key(seed: char) -> String {
    std::iter::repeat_n(seed, 43).collect()
}
fn sig() -> String {
    std::iter::repeat_n('S', 86).collect()
}
struct Person {
    browser: Browser,
    id: Uuid,
    x: String,
    e: String,
}
fn bundle(p: &Person) -> Value {
    json!({"v":1,"account_id":p.id,"x25519":p.x,"ed25519":p.e,"created_at":"2026-10-08T12:00:00Z","signature":sig()})
}
fn member(p: &Person, role: &str) -> Value {
    json!({"account_id":p.id,"role":role,"x25519":p.x,"ed25519":p.e})
}
fn head(
    space: Uuid,
    epoch: i64,
    owner: &Person,
    author: &Person,
    members: &[(&Person, &str)],
    departures: &[&Person],
) -> Value {
    let mut members: Vec<Value> = members.iter().map(|(p, role)| member(p, role)).collect();
    members.sort_by_key(|m| m["account_id"].as_str().unwrap_or_default().to_owned());
    json!({
        "v":1,"space_id":space,"epoch":epoch,"prev":if epoch == 1 { String::new() } else { key('P') },
        "owner":owner.id,"members":members,"key_commitment":key('K'),"author":author.id,
        "departures":departures.iter().map(|p| json!({"account_id":p.id,"signature":sig()})).collect::<Vec<_>>(),
        "created_at":"2026-10-08T12:00:00Z","signature":sig(),
    })
}
fn wrap(p: &Person, epoch: i64) -> Value {
    json!({"account_id":p.id,"epoch":epoch,"sealed":format!("{{\"v\":1,\"enc\":\"{}\",\"ct\":\"{}\"}}", key('E'), key('C'))})
}
fn object(epoch: i64, revision: Uuid, text: &str) -> Value {
    json!({"object_id":Uuid::new_v4(),"revision":revision,"parent_revision":null,"kind":"message","epoch":epoch,"ciphertext":format!("{{\"v\":1,\"nonce\":\"AAAAAAAAAAAAAAAA\",\"ciphertext\":\"{text}\"}}"),"signature":sig(),"deleted":false})
}

impl Fixture {
    async fn person(&self, subject: &str, seed: char) -> Result<Person> {
        let browser = self.login(subject).await?;
        let id = account_id(self, &browser).await?;
        let p = Person {
            browser,
            id,
            x: key(seed),
            e: key(seed.to_ascii_lowercase()),
        };
        let (status, _) = self
            .json(
                "PUT",
                "/api/v1/identity",
                &p.browser,
                json!({"expected_version":0,"public":bundle(&p),"sealed_private":"{\"v\":1}"}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK);
        Ok(p)
    }
    /// A space owned by `owner`, at epoch 1.
    async fn space(&self, owner: &Person) -> Result<Uuid> {
        let id = Uuid::new_v4();
        let (status, body) = self
            .json(
                "POST",
                "/api/v1/spaces",
                &owner.browser,
                json!({"head":head(id,1,owner,owner,&[(owner,"owner")],&[]),"wrapped_key":wrap(owner,1)["sealed"]}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(id)
    }
    /// Invites `guest` and has them accept; returns the invitation id.
    async fn claimed_invitation(
        &self,
        space: Uuid,
        owner: &Person,
        guest: &Person,
    ) -> Result<Uuid> {
        let invitation = Uuid::new_v4();
        let expires = Utc::now() + chrono::Duration::days(2);
        let (status, _) = self
            .json(
                "POST",
                &format!("/api/v1/spaces/{space}/invitations"),
                &owner.browser,
                json!({"id":invitation,"token_hash":key('T'),"payload":"{\"v\":1}","expires_at":expires}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = self
            .json(
                "POST",
                &format!("/api/v1/space-invitations/{invitation}/accept"),
                &guest.browser,
                json!({"token_hash":key('T'),"acceptance":{"member":bundle(guest),"proof":key('H')}}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK);
        Ok(invitation)
    }
}

#[tokio::test]
async fn a_space_carries_ciphertext_between_its_members_only() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.person("alice", 'A').await?;
    let bob = f.person("bob", 'B').await?;
    let carol = f.person("carol", 'C').await?;
    let space = f.space(&alice).await?;

    // Bob opens the invitation with the token the link derives, and only
    // with it.
    let invitation = Uuid::new_v4();
    f.json("POST", &format!("/api/v1/spaces/{space}/invitations"), &alice.browser,
        json!({"id":invitation,"token_hash":key('T'),"payload":"sealed payload","expires_at":Utc::now()+chrono::Duration::days(1)})).await?;
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/space-invitations/{invitation}/open"),
            &bob.browser,
            json!({"token_hash":key('W')}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = f
        .json(
            "POST",
            &format!("/api/v1/space-invitations/{invitation}/open"),
            &bob.browser,
            json!({"token_hash":key('T')}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["payload"], "sealed payload");
    assert_eq!(body["data"]["space_id"], json!(space));
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/space-invitations/{invitation}/accept"),
            &bob.browser,
            json!({"token_hash":key('T'),"acceptance":{"member":bundle(&bob),"proof":key('H')}}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);

    // Accepting is not membership: only the owner's admission is.
    let (status, _) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}"),
            &bob.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, detail) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(
        detail["data"]["invitations"][0]["claimed_by"],
        json!(bob.id)
    );
    assert_eq!(
        detail["data"]["invitations"][0]["acceptance"]["member"],
        bundle(&bob)
    );

    let (status, body) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/epochs"),
            &alice.browser,
            json!({
                "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
                "wrapped_keys": [wrap(&alice,2), wrap(&bob,2), wrap(&bob,1)],
                "admit": [invitation],
            }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Bob sees the space, both heads, and his own sealed keys only.
    let (status, detail) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}"),
            &bob.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let d = &detail["data"];
    assert_eq!(d["current_epoch"], 2);
    assert_eq!(d["heads"].as_array().map(Vec::len), Some(2));
    assert_eq!(d["members"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        d["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["identity"].is_object())
            .count(),
        2
    );
    let keys = d["keys"].as_array().context("keys")?;
    assert_eq!(keys.len(), 2);
    assert!(keys.iter().all(|k| k["account_id"] == json!(bob.id)));
    assert_eq!(
        d["invitations"],
        json!([]),
        "only the owner sees invitations"
    );

    // Both write; both read the same ordered journal; Carol reads nothing.
    let (status, body) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/objects"),
            &bob.browser,
            json!({"objects":[object(2, Uuid::new_v4(), "b2"), object(2, Uuid::new_v4(), "b3")]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["results"][1]["sequence"], 2);
    let (status, page) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}/objects?after=0&limit=1"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        page["data"]["objects"][0]["author_account_id"],
        json!(bob.id)
    );
    assert_eq!(page["data"]["has_more"], true);
    let (_, page) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}/objects?after=1&limit=10"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(page["data"]["cursor"], 2);
    assert_eq!(page["data"]["has_more"], false);
    for path in [
        format!("/api/v1/spaces/{space}"),
        format!("/api/v1/spaces/{space}/objects"),
    ] {
        let (status, _) = f.json("GET", &path, &carol.browser, json!({})).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/objects"),
            &carol.browser,
            json!({"objects":[object(2, Uuid::new_v4(), "c")]}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, list) = f
        .json("GET", "/api/v1/spaces", &bob.browser, json!({}))
        .await?;
    assert_eq!(list["data"][0]["role"], "member");
    assert_eq!(list["data"][0]["latest_sequence"], 2);
    Ok(())
}

#[tokio::test]
async fn epochs_follow_one_another_and_writes_follow_the_current_epoch() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.person("alice", 'A').await?;
    let bob = f.person("bob", 'B').await?;
    let space = f.space(&alice).await?;
    let invitation = f.claimed_invitation(space, &alice, &bob).await?;
    let path = format!("/api/v1/spaces/{space}/epochs");
    // Skipping an epoch is a conflict.
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 3, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,3), wrap(&bob,3)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    // A head naming keys the account did not publish is refused.
    let mut forged = Person {
        browser: Browser {
            cookie: String::new(),
            csrf: String::new(),
        },
        id: bob.id,
        x: key('Z'),
        e: bob.e.clone(),
    };
    forged.browser.cookie.clear();
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&forged,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Every member of the new epoch needs its key.
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A newcomer without an invitation is refused.
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2)], "admit":[]}),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A head whose author is not the caller is refused.
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &bob, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let objects = format!("/api/v1/spaces/{space}/objects");
    let revision = Uuid::new_v4();
    let first = object(1, revision, "one");
    let (status, body) = f
        .json(
            "POST",
            &objects,
            &alice.browser,
            json!({"objects":[first.clone()]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // The same revision with the same bytes answers its first result...
    let (status, again) = f
        .json(
            "POST",
            &objects,
            &alice.browser,
            json!({"objects":[first.clone()]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["data"]["results"], body["data"]["results"]);
    // ...and with other bytes is a conflict.
    let mut changed = first.clone();
    changed["ciphertext"] = json!("{\"v\":1,\"nonce\":\"x\",\"ciphertext\":\"other\"}");
    let (status, _) = f
        .json(
            "POST",
            &objects,
            &alice.browser,
            json!({"objects":[changed]}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // After a rotation, a write under the old epoch is refused: whoever kept
    // the old key cannot add to the space with it.
    let (status, _) = f
        .json(
            "POST",
            &objects,
            &alice.browser,
            json!({"objects":[object(1, Uuid::new_v4(), "late")]}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f
        .json(
            "POST",
            &objects,
            &bob.browser,
            json!({"objects":[object(2, Uuid::new_v4(), "ok")]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // An unknown kind never reaches the table.
    let mut odd = object(2, Uuid::new_v4(), "x");
    odd["kind"] = json!("tombstone");
    let (status, _) = f
        .json("POST", &objects, &bob.browser, json!({"objects":[odd]}))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

#[tokio::test]
async fn an_invitation_is_claimed_once_and_admitted_once() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.person("alice", 'A').await?;
    let bob = f.person("bob", 'B').await?;
    let carol = f.person("carol", 'C').await?;
    let space = f.space(&alice).await?;
    let invitation = f.claimed_invitation(space, &alice, &bob).await?;
    let accept = format!("/api/v1/space-invitations/{invitation}/accept");
    // The link replayed by someone else, or by Bob again.
    for who in [&carol, &bob] {
        let (status, _) = f
            .json(
                "POST",
                &accept,
                &who.browser,
                json!({"token_hash":key('T'),"acceptance":{"member":bundle(who),"proof":key('H')}}),
            )
            .await?;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    // A claimed invitation no longer opens.
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/space-invitations/{invitation}/open"),
            &carol.browser,
            json!({"token_hash":key('T')}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let path = format!("/api/v1/spaces/{space}/epochs");
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // Removing Bob and admitting him again with the same invitation fails.
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 3, &alice, &alice, &[(&alice,"owner")], &[]),
        "wrapped_keys": [wrap(&alice,3)]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f
        .json(
            "POST",
            &path,
            &alice.browser,
            json!({
        "head": head(space, 4, &alice, &alice, &[(&alice,"owner"),(&bob,"member")], &[]),
        "wrapped_keys": [wrap(&alice,4), wrap(&bob,4)], "admit":[invitation]}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    // A member presenting keys other than the ones they published.
    let other = f.json("POST", &format!("/api/v1/spaces/{space}/invitations"), &alice.browser,
        json!({"id":Uuid::new_v4(),"token_hash":key('U'),"payload":"p","expires_at":Utc::now()+chrono::Duration::days(1)})).await?;
    assert_eq!(other.0, StatusCode::OK);
    // Only the owner invites, and not beyond seven days.
    let (status, _) = f.json("POST", &format!("/api/v1/spaces/{space}/invitations"), &alice.browser,
        json!({"id":Uuid::new_v4(),"token_hash":key('V'),"payload":"p","expires_at":Utc::now()+chrono::Duration::days(8)})).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Revoked, it stops opening at once.
    let revoked = Uuid::new_v4();
    f.json("POST", &format!("/api/v1/spaces/{space}/invitations"), &alice.browser,
        json!({"id":revoked,"token_hash":key('R'),"payload":"p","expires_at":Utc::now()+chrono::Duration::days(1)})).await?;
    let (status, _) = f
        .json(
            "DELETE",
            &format!("/api/v1/spaces/{space}/invitations/{revoked}"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/space-invitations/{revoked}/open"),
            &carol.browser,
            json!({"token_hash":key('R')}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // An acceptance with keys Carol never published.
    let pending = Uuid::new_v4();
    f.json("POST", &format!("/api/v1/spaces/{space}/invitations"), &alice.browser,
        json!({"id":pending,"token_hash":key('Q'),"payload":"p","expires_at":Utc::now()+chrono::Duration::days(1)})).await?;
    let impostor = Person {
        browser: Browser {
            cookie: String::new(),
            csrf: String::new(),
        },
        id: carol.id,
        x: key('Z'),
        e: carol.e.clone(),
    };
    let (status, _) = f.json("POST", &format!("/api/v1/space-invitations/{pending}/accept"), &carol.browser,
        json!({"token_hash":key('Q'),"acceptance":{"member":bundle(&impostor),"proof":key('H')}})).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

#[tokio::test]
async fn a_member_who_leaves_loses_access_and_any_member_may_rotate() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.person("alice", 'A').await?;
    let bob = f.person("bob", 'B').await?;
    let carol = f.person("carol", 'C').await?;
    let dave = f.person("dave", 'D').await?;
    let space = f.space(&alice).await?;
    let ib = f.claimed_invitation(space, &alice, &bob).await?;
    let ic = f.claimed_invitation(space, &alice, &carol).await?;
    let epochs = format!("/api/v1/spaces/{space}/epochs");
    let (status, _) = f.json("POST", &epochs, &alice.browser, json!({
        "head": head(space, 2, &alice, &alice, &[(&alice,"owner"),(&bob,"member"),(&carol,"member")], &[]),
        "wrapped_keys": [wrap(&alice,2), wrap(&bob,2), wrap(&carol,2)], "admit":[ib, ic]})).await?;
    assert_eq!(status, StatusCode::OK);
    // Without a departure, a member may not rotate anyone out.
    let (status, _) = f
        .json(
            "POST",
            &epochs,
            &carol.browser,
            json!({
        "head": head(space, 3, &alice, &carol, &[(&alice,"owner"),(&carol,"member")], &[]),
        "wrapped_keys": [wrap(&alice,3), wrap(&carol,3)]}),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The owner cannot leave; the owner deletes.
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/leave"),
            &alice.browser,
            json!({"epoch":2,"statement":sig()}),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A statement for an epoch that is not current is refused.
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/leave"),
            &bob.browser,
            json!({"epoch":1,"statement":sig()}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f
        .json(
            "POST",
            &format!("/api/v1/spaces/{space}/leave"),
            &bob.browser,
            json!({"epoch":2,"statement":sig()}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}/objects"),
            &bob.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, detail) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}"),
            &carol.browser,
            json!({}),
        )
        .await?;
    assert_eq!(detail["data"]["departures"][0]["account_id"], json!(bob.id));
    // Carol may rotate Bob out, and only Bob, and add nobody.
    let ghost = f.claimed_invitation(space, &alice, &dave).await?;
    let (status, _) = f.json("POST", &epochs, &carol.browser, json!({
        "head": head(space, 3, &alice, &carol, &[(&alice,"owner"),(&carol,"member"),(&dave,"member")], &[&bob]),
        "wrapped_keys": [wrap(&alice,3), wrap(&carol,3), wrap(&dave,3)], "admit":[ghost]})).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = f
        .json(
            "POST",
            &epochs,
            &carol.browser,
            json!({
        "head": head(space, 3, &alice, &carol, &[(&alice,"owner"),(&carol,"member")], &[&bob]),
        "wrapped_keys": [wrap(&alice,3), wrap(&carol,3)]}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, detail) = f
        .json(
            "GET",
            &format!("/api/v1/spaces/{space}"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(detail["data"]["departures"], json!([]));
    assert_eq!(detail["data"]["current_epoch"], 3);
    // Identity keys cannot change while the account is in a space.
    let (status, _) = f
        .json(
            "PUT",
            "/api/v1/identity",
            &carol.browser,
            json!({"expected_version":1,"public":bundle(&carol),"sealed_private":"x"}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    // Bob, out of every space, may replace his.
    let (status, _) = f
        .json(
            "PUT",
            "/api/v1/identity",
            &bob.browser,
            json!({"expected_version":1,"public":bundle(&bob),"sealed_private":"x"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // Only the owner deletes, and deleting removes everything.
    let (status, _) = f
        .json(
            "DELETE",
            &format!("/api/v1/spaces/{space}"),
            &carol.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = f
        .json(
            "DELETE",
            &format!("/api/v1/spaces/{space}"),
            &alice.browser,
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM space_epoch_heads WHERE space_id=$1")
        .bind(space)
        .fetch_one(&f.pool)
        .await?;
    assert_eq!(left, 0);
    Ok(())
}

#[tokio::test]
async fn an_identity_is_written_once_by_its_own_account() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let id = account_id(&f, &alice).await?;
    let (status, _) = f.json("GET", "/api/v1/identity", &alice, json!({})).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let me = Person {
        browser: Browser {
            cookie: String::new(),
            csrf: String::new(),
        },
        id,
        x: key('A'),
        e: key('a'),
    };
    let someone = Person {
        browser: Browser {
            cookie: String::new(),
            csrf: String::new(),
        },
        id: Uuid::new_v4(),
        x: key('A'),
        e: key('a'),
    };
    let (status, _) = f
        .json(
            "PUT",
            "/api/v1/identity",
            &alice,
            json!({"expected_version":0,"public":bundle(&someone),"sealed_private":"x"}),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = f
        .json(
            "PUT",
            "/api/v1/identity",
            &alice,
            json!({"expected_version":0,"public":bundle(&me),"sealed_private":"sealed"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    // A second device racing the first loses and reads the winner's.
    let (status, _) = f
        .json(
            "PUT",
            "/api/v1/identity",
            &alice,
            json!({"expected_version":0,"public":bundle(&me),"sealed_private":"other"}),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, record) = f.json("GET", "/api/v1/identity", &alice, json!({})).await?;
    assert_eq!(record["data"]["sealed_private"], "sealed");
    assert_eq!(record["data"]["public"], bundle(&me));
    Ok(())
}
