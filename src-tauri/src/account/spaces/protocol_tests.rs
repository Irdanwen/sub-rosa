//! Protocol rules, and the vectors the browser implementation is held to.
//! `SPACES_VECTORS_WRITE=1 cargo test vectors_match` rewrites
//! `tests/fixtures/spaces-v1.json` after a deliberate protocol change.
use super::*;
use serde_json::json;

const SPACE: &str = "0191d1a4-5a00-7000-8000-00000000a001";
const ALICE: &str = "0191d1a4-0000-7000-8000-0000000000a1";
const BOB: &str = "0191d1a4-0000-7000-8000-0000000000b2";
const CAROL: &str = "0191d1a4-0000-7000-8000-0000000000c3";
const INVITATION: &str = "0191d1a4-1000-7000-8000-00000000f001";
const CREATED: &str = "2026-10-08T12:00:00Z";

fn identity(seed: u8) -> IdentitySecret {
    IdentitySecret::from_seeds([seed; 32], [seed.wrapping_add(100); 32])
}
fn alice() -> IdentitySecret {
    identity(1)
}
fn bob() -> IdentitySecret {
    identity(2)
}
fn carol() -> IdentitySecret {
    identity(3)
}
fn member(secret: &IdentitySecret, account: &str, role: &str) -> HeadMember {
    HeadMember::from_bundle(&secret.bundle(account, CREATED), role)
}
fn key(epoch: u8) -> [u8; 32] {
    [0x40 + epoch; 32]
}

/// Epoch 1 (Alice alone), 2 (Bob admitted), 3 (Carol admitted), 4 (Bob left,
/// Carol rotated).
fn chain() -> Vec<EpochHead> {
    let e1 = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 1,
            prev: None,
            owner: ALICE,
            members: vec![member(&alice(), ALICE, ROLE_OWNER)],
            key: &key(1),
            author: ALICE,
            departures: vec![],
            created_at: CREATED,
        },
        &alice(),
    );
    let e2 = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 2,
            prev: Some(&e1),
            owner: ALICE,
            members: vec![
                member(&alice(), ALICE, ROLE_OWNER),
                member(&bob(), BOB, ROLE_MEMBER),
            ],
            key: &key(2),
            author: ALICE,
            departures: vec![],
            created_at: CREATED,
        },
        &alice(),
    );
    let e3 = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 3,
            prev: Some(&e2),
            owner: ALICE,
            members: vec![
                member(&alice(), ALICE, ROLE_OWNER),
                member(&bob(), BOB, ROLE_MEMBER),
                member(&carol(), CAROL, ROLE_MEMBER),
            ],
            key: &key(3),
            author: ALICE,
            departures: vec![],
            created_at: CREATED,
        },
        &alice(),
    );
    let e4 = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 4,
            prev: Some(&e3),
            owner: ALICE,
            members: vec![
                member(&alice(), ALICE, ROLE_OWNER),
                member(&carol(), CAROL, ROLE_MEMBER),
            ],
            key: &key(4),
            author: CAROL,
            departures: vec![Departure {
                account_id: BOB.into(),
                signature: leave_statement(&bob(), SPACE, 3, BOB),
            }],
            created_at: CREATED,
        },
        &carol(),
    );
    vec![e1, e2, e3, e4]
}

fn body(kind: &str, object_id: &str, author: &str, data: Value) -> ObjectBody {
    ObjectBody {
        v: 1,
        kind: kind.into(),
        object_id: object_id.into(),
        revision: "0191d1a4-2000-7000-8000-00000000e001".into(),
        parent_revision: None,
        author: author.into(),
        created_at: CREATED.into(),
        deleted: false,
        data,
    }
}
fn wire(body: &ObjectBody, epoch: u64, parts: &SealedParts) -> WireObject {
    WireObject {
        object_id: body.object_id.clone(),
        revision: body.revision.clone(),
        parent_revision: body.parent_revision.clone(),
        kind: body.kind.clone(),
        epoch,
        author_account_id: body.author.clone(),
        ciphertext: parts.ciphertext.clone(),
        signature: parts.signature.clone(),
        deleted: body.deleted,
    }
}
fn sample_objects() -> Vec<ObjectBody> {
    let conversation = "0191d1a4-3000-7000-8000-00000000c001";
    vec![
        body(
            "project",
            SPACE,
            ALICE,
            json!({"name":"Launch plan","instructions":"Answer in French. Keep it short."}),
        ),
        body(
            "note",
            "0191d1a4-3000-7000-8000-00000000d001",
            ALICE,
            json!({"title":"Venue","body":"Book the room by **Friday**."}),
        ),
        body(
            "file",
            "0191d1a4-3000-7000-8000-00000000d002",
            ALICE,
            json!({"name":"budget.csv","format":"csv","text":"item,cost\nroom,400"}),
        ),
        body(
            "conversation",
            conversation,
            ALICE,
            json!({"title":"Planning"}),
        ),
        body(
            "message",
            "0191d1a4-3000-7000-8000-00000000d003",
            CAROL,
            json!({"conversation_id":conversation,"role":"user","text":"Who brings the projector?"}),
        ),
        body(
            "message",
            "0191d1a4-3000-7000-8000-00000000d004",
            CAROL,
            json!({"conversation_id":conversation,"role":"assistant","text":"Nobody has said yet.","model":"zai-org-glm-4.6","paid_by":CAROL}),
        ),
        body(
            "profile",
            "0191d1a4-3000-7000-8000-00000000d005",
            CAROL,
            json!({"name":"Carol"}),
        ),
    ]
}

fn identity_vector(secret: &IdentitySecret, seed: u8, account: &str) -> Value {
    json!({
        "account_id": account,
        "x25519_secret": b64(&[seed; 32]),
        "ed25519_seed": b64(&[seed.wrapping_add(100); 32]),
        "created_at": CREATED,
        "bundle": secret.bundle(account, CREATED),
        "fingerprint": fingerprint_digits(&secret.bundle(account, CREATED)),
    })
}

/// Deterministic HPKE ephemerals for one rotation: `0xa0`, `0xa1`, ... in
/// the order `compose_rotation` asks for them.
fn ephemerals() -> impl FnMut() -> Zeroizing<[u8; 32]> {
    let mut next = 0xa0u8;
    move || {
        let value = Zeroizing::new([next; 32]);
        next = next.wrapping_add(1);
        value
    }
}
fn known_keys(
    epochs: std::ops::RangeInclusive<u8>,
) -> std::collections::BTreeMap<u64, Zeroizing<[u8; 32]>> {
    epochs
        .map(|e| (u64::from(e), Zeroizing::new(key(e))))
        .collect()
}

/// The membership changes as the app composes them
/// (`client::compose_rotation`), with fixed keys, times and ephemerals, so
/// the browser's `composeRotation` is held to the same request bytes:
/// - the owner admits Carol at epoch 3 (her earlier keys sealed to her);
/// - the owner removes Bob at epoch 4 (no departure, no key for him);
/// - Carol rotates Bob out at epoch 4 after he signed a leave statement.
fn operations() -> Value {
    use crate::account::spaces::client::{compose_rotation, Admission};
    let heads = chain();
    let carol_bundle = carol().bundle(CAROL, CREATED);
    let invite_secret = [0x5a; 32];
    let carol_proof = acceptance_proof(&invite_secret, INVITATION, SPACE, &carol_bundle);
    verify_acceptance(
        &invite_secret,
        INVITATION,
        SPACE,
        &carol_bundle,
        &carol_proof,
    )
    .unwrap();
    let mut admitted_members = heads[1].members.clone();
    admitted_members.push(HeadMember::from_bundle(&carol_bundle, ROLE_MEMBER));
    let admission = compose_rotation(
        &alice(),
        ALICE,
        &heads[1],
        &known_keys(1..=2),
        admitted_members,
        vec![],
        Some(&Admission {
            invitation_id: INVITATION,
            member: &carol_bundle,
        }),
        &key(3),
        CREATED,
        ephemerals(),
    )
    .unwrap();
    assert_eq!(
        admission.head, heads[2],
        "an admission is the chain's epoch 3"
    );
    let removal = compose_rotation(
        &alice(),
        ALICE,
        &heads[2],
        &known_keys(1..=3),
        heads[2]
            .members
            .iter()
            .filter(|m| m.account_id != BOB)
            .cloned()
            .collect(),
        vec![],
        None,
        &key(4),
        CREATED,
        ephemerals(),
    )
    .unwrap();
    let departure = compose_rotation(
        &carol(),
        CAROL,
        &heads[2],
        &known_keys(1..=3),
        heads[3].members.clone(),
        heads[3].departures.clone(),
        None,
        &key(4),
        CREATED,
        ephemerals(),
    )
    .unwrap();
    assert_eq!(
        departure.head, heads[3],
        "a rotation after a leave is the chain's epoch 4"
    );
    // Every wrap opens for its recipient against the head it names.
    for (rotation, others) in [
        (&admission, &heads),
        (&removal, &heads),
        (&departure, &heads),
    ] {
        for wrapped in &rotation.wrapped_keys {
            let account = wrapped["account_id"].as_str().unwrap();
            let epoch = wrapped["epoch"].as_u64().unwrap();
            let secret = [(ALICE, alice()), (BOB, bob()), (CAROL, carol())]
                .into_iter()
                .find(|(id, _)| *id == account)
                .unwrap()
                .1;
            let head = if epoch == rotation.head.epoch {
                &rotation.head
            } else {
                &others[usize::try_from(epoch).unwrap() - 1]
            };
            unwrap_key(&secret, wrapped["sealed"].as_str().unwrap(), head, account).unwrap();
        }
    }
    let expires_at = "2026-10-15T12:00:00Z";
    let payload = InvitePayload {
        v: 1,
        space_id: SPACE.into(),
        space_name: "Launch plan".into(),
        inviter: alice().bundle(ALICE, CREATED),
        expires_at: expires_at.into(),
    };
    json!({
        "ephemerals_from": b64(&[0xa0u8; 32]),
        "invitation_request": {
            "id": INVITATION,
            "token_hash": token_hash(&invite_token(&invite_secret, INVITATION)),
            "payload": seal_payload_with_nonce(&invite_secret, INVITATION, &payload, [4u8; 12]).unwrap(),
            "expires_at": expires_at,
        },
        "acceptance_carol": {"member": carol_bundle, "proof": carol_proof},
        "admission": {
            "prev_epoch": 2,
            "known_epochs": [1, 2],
            "key": b64(&key(3)),
            "request": admission.body(),
            "hash": admission.head.hash(),
        },
        "removal": {
            "prev_epoch": 3,
            "removed": BOB,
            "key": b64(&key(4)),
            "request": removal.body(),
            "hash": removal.head.hash(),
        },
        "departure": {
            "prev_epoch": 3,
            "author": CAROL,
            "key": b64(&key(4)),
            "request": departure.body(),
        },
    })
}

fn vectors() -> Value {
    let heads = chain();
    let recipient_secret = [9u8; 32];
    let (enc, ct) = hpke::seal_with_ephemeral(
        &[7u8; 32],
        &hpke::public_key(&recipient_secret),
        b"subrosa:space-key:v1:vector",
        b"",
        &[0x42; 32],
    )
    .unwrap();
    let objects: Vec<Value> = sample_objects()
        .iter()
        .enumerate()
        .map(|(i, body)| {
            let epoch = 4;
            let signer = if body.author == ALICE {
                alice()
            } else {
                carol()
            };
            let nonce = [u8::try_from(i).unwrap() + 1; 12];
            let parts =
                seal_object_with_nonce(&key(4), SPACE, epoch, body, &signer, nonce).unwrap();
            json!({
                "body": body,
                "plaintext": serde_json::to_string(body).unwrap(),
                "nonce": b64(&nonce),
                "wire": wire(body, epoch, &parts),
            })
        })
        .collect();
    let invite_secret = [0x5a; 32];
    let token = invite_token(&invite_secret, INVITATION);
    let payload = InvitePayload {
        v: 1,
        space_id: SPACE.into(),
        space_name: "Launch plan".into(),
        inviter: alice().bundle(ALICE, CREATED),
        expires_at: "2026-10-15T12:00:00Z".into(),
    };
    let bob_bundle = bob().bundle(BOB, CREATED);
    json!({
        "v": 1,
        "about": "Generated by src-tauri/src/account/spaces/protocol_tests.rs. Both implementations must reproduce every value.",
        "hkdf": {
            "ikm": b64(b"input keying material"),
            "info": "subrosa:vector",
            "okm": b64(hpke::hkdf32(b"input keying material", b"subrosa:vector").as_slice()),
        },
        "hpke": {
            "recipient_secret": b64(&recipient_secret),
            "recipient_public": b64(&hpke::public_key(&recipient_secret)),
            "ephemeral_secret": b64(&[7u8; 32]),
            "info": "subrosa:space-key:v1:vector",
            "plaintext": b64(&[0x42; 32]),
            "enc": b64(&enc),
            "ct": b64(&ct),
        },
        "identities": {
            "alice": identity_vector(&alice(), 1, ALICE),
            "bob": identity_vector(&bob(), 2, BOB),
            "carol": identity_vector(&carol(), 3, CAROL),
        },
        "sealed_identity": {
            "vault_key": b64(&[0x77; 32]),
            "account_id": ALICE,
            "nonce": b64(&[3u8; 12]),
            "plaintext": alice().keyring_value().to_string(),
            "envelope": alice().seal_with_nonce(&[0x77; 32], ALICE, [3u8; 12]).unwrap(),
        },
        "safety_number": {
            "alice_bob": safety_number(&alice().bundle(ALICE, CREATED), &bob().bundle(BOB, CREATED)),
        },
        "space": {
            "space_id": SPACE,
            "keys": (1..=4).map(|e| b64(&key(e))).collect::<Vec<_>>(),
            "heads": heads,
            "hashes": heads.iter().map(EpochHead::hash).collect::<Vec<_>>(),
            "leave_statement_bob_epoch_3": leave_statement(&bob(), SPACE, 3, BOB),
            "wrapped_epoch_2_for_bob": {
                "ephemeral_secret": b64(&[8u8; 32]),
                "sealed": wrap_key_with(&[8u8; 32], &key(2), &bob().bundle(BOB, CREATED).x25519, SPACE, 2, BOB).unwrap(),
            },
            "objects": objects,
        },
        "invitation": {
            "invitation_id": INVITATION,
            "secret": b64(&invite_secret),
            "code": invitation_code(INVITATION, &invite_secret),
            "token": b64(token.as_slice()),
            "token_hash": token_hash(&token),
            "payload": payload,
            "payload_plaintext": serde_json::to_string(&payload).unwrap(),
            "payload_nonce": b64(&[4u8; 12]),
            "sealed_payload": seal_payload_with_nonce(&invite_secret, INVITATION, &payload, [4u8; 12]).unwrap(),
            "acceptance_bob": acceptance_proof(&invite_secret, INVITATION, SPACE, &bob_bundle),
        },
        "operations": operations(),
        "profile_id": {
            "space_id": SPACE,
            "account_id": CAROL,
            "id": crate::account::spaces::commands::profile_id(SPACE, CAROL),
        },
    })
}

#[test]
fn vectors_match_the_shared_fixture() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/spaces-v1.json");
    let generated = vectors();
    if std::env::var("SPACES_VECTORS_WRITE").as_deref() == Ok("1") {
        std::fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&generated).unwrap()),
        )
        .unwrap();
    }
    let committed: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).unwrap();
    assert_eq!(
        generated, committed,
        "regenerate with SPACES_VECTORS_WRITE=1"
    );
}

#[test]
fn a_whole_chain_verifies_from_its_anchor() {
    let heads = chain();
    let latest = verify_chain(None, &heads, Some(&alice().bundle(ALICE, CREATED))).unwrap();
    assert_eq!(latest.epoch, 4);
    // From a trusted middle, too.
    assert_eq!(
        verify_chain(Some(&heads[1]), &heads, None).unwrap().epoch,
        4
    );
}

#[test]
fn an_anchor_that_is_not_the_owner_is_refused() {
    let heads = chain();
    assert!(verify_chain(None, &heads, Some(&bob().bundle(BOB, CREATED))).is_err());
}

#[test]
fn an_older_head_than_the_trusted_one_is_a_rollback() {
    let heads = chain();
    let error = verify_chain(Some(&heads[2]), &heads[..2], None).unwrap_err();
    assert_eq!(error.code, "space_rollback");
}

#[test]
fn a_different_head_at_a_trusted_epoch_is_a_fork() {
    let heads = chain();
    let mut forked = heads.clone();
    forked[2] = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 3,
            prev: Some(&heads[1]),
            owner: ALICE,
            members: vec![member(&alice(), ALICE, ROLE_OWNER)],
            key: &key(9),
            author: ALICE,
            departures: vec![],
            created_at: CREATED,
        },
        &alice(),
    );
    let error = verify_chain(Some(&heads[2]), &forked[..3], None).unwrap_err();
    assert_eq!(error.code, "space_rollback");
}

#[test]
fn a_member_who_is_not_the_owner_cannot_add_anyone() {
    let heads = chain();
    let forged = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 3,
            prev: Some(&heads[1]),
            owner: ALICE,
            members: vec![
                member(&alice(), ALICE, ROLE_OWNER),
                member(&bob(), BOB, ROLE_MEMBER),
                member(&carol(), CAROL, ROLE_MEMBER),
            ],
            key: &key(3),
            author: BOB,
            departures: vec![],
            created_at: CREATED,
        },
        &bob(),
    );
    assert!(verify_next(Some(&heads[1]), &forged).is_err());
}

#[test]
fn a_member_cannot_remove_someone_who_did_not_leave() {
    let heads = chain();
    let forged = EpochHead::sign(
        HeadDraft {
            space_id: SPACE,
            epoch: 4,
            prev: Some(&heads[2]),
            owner: ALICE,
            members: vec![
                member(&alice(), ALICE, ROLE_OWNER),
                member(&carol(), CAROL, ROLE_MEMBER),
            ],
            key: &key(4),
            author: CAROL,
            // Carol signs Bob's departure herself.
            departures: vec![Departure {
                account_id: BOB.into(),
                signature: leave_statement(&carol(), SPACE, 3, BOB),
            }],
            created_at: CREATED,
        },
        &carol(),
    );
    assert!(verify_next(Some(&heads[2]), &forged).is_err());
}

#[test]
fn a_leave_statement_is_bound_to_its_epoch() {
    let heads = chain();
    let mut replayed = heads[3].clone();
    replayed.departures[0].signature = leave_statement(&bob(), SPACE, 2, BOB);
    replayed.signature = carol().sign(replayed.transcript().bytes());
    assert!(verify_next(Some(&heads[2]), &replayed).is_err());
}

#[test]
fn any_change_to_a_signed_head_is_refused() {
    let heads = chain();
    let mut tampered = heads[1].clone();
    tampered.members[1].x25519 = b64(&[0x11; 32]);
    assert!(verify_next(Some(&heads[0]), &tampered).is_err());
    let mut skipped = heads[2].clone();
    skipped.epoch = 4;
    assert!(verify_next(Some(&heads[1]), &skipped).is_err());
    let mut unsorted = heads[2].clone();
    unsorted.members.reverse();
    assert!(verify_next(Some(&heads[1]), &unsorted).is_err());
}

#[test]
fn a_wrapped_key_must_match_the_heads_commitment() {
    let heads = chain();
    let bob_x = bob().bundle(BOB, CREATED).x25519;
    let sealed = wrap_key(&key(2), &bob_x, SPACE, 2, BOB).unwrap();
    assert_eq!(
        *unwrap_key(&bob(), &sealed, &heads[1], BOB).unwrap(),
        key(2)
    );
    // A service that seals a key of its own to Bob's public key is caught by
    // the commitment, although the sealed box itself opens.
    let substituted = wrap_key(&[0x13; 32], &bob_x, SPACE, 2, BOB).unwrap();
    assert!(unwrap_key(&bob(), &substituted, &heads[1], BOB).is_err());
    // And a wrap for another epoch does not open as this one.
    assert!(unwrap_key(&bob(), &sealed, &heads[2], BOB).is_err());
}

#[test]
fn a_removed_member_cannot_read_what_is_written_after() {
    let heads = chain();
    // Bob holds the epoch 3 key; nothing for epoch 4 was ever wrapped to him.
    let bob_x = bob().bundle(BOB, CREATED).x25519;
    let bobs = unwrap_key(
        &bob(),
        &wrap_key(&key(3), &bob_x, SPACE, 3, BOB).unwrap(),
        &heads[2],
        BOB,
    )
    .unwrap();
    assert!(heads[3].member(BOB).is_none());
    let message = body(
        "message",
        "0191d1a4-3000-7000-8000-00000000d0ff",
        CAROL,
        json!({"conversation_id":"0191d1a4-3000-7000-8000-00000000c001","role":"user","text":"After Bob left"}),
    );
    let parts = seal_object(&key(4), SPACE, 4, &message, &carol()).unwrap();
    let w = wire(&message, 4, &parts);
    let carol_entry = heads[3].member(CAROL).unwrap();
    assert!(open_object(&bobs, SPACE, &w, carol_entry).is_err());
    // Relabelling it as an epoch 3 object does not help either.
    let mut relabelled = w.clone();
    relabelled.epoch = 3;
    assert!(open_object(&bobs, SPACE, &relabelled, carol_entry).is_err());
    assert_eq!(
        open_object(&key(4), SPACE, &w, carol_entry).unwrap(),
        message
    );
}

#[test]
fn an_object_is_bound_to_its_place_and_its_author() {
    let heads = chain();
    let note = body(
        "note",
        "0191d1a4-3000-7000-8000-00000000d001",
        ALICE,
        json!({"title":"Venue","body":"Book it"}),
    );
    let parts = seal_object(&key(4), SPACE, 4, &note, &alice()).unwrap();
    let w = wire(&note, 4, &parts);
    let alice_entry = heads[3].member(ALICE).unwrap();
    assert!(open_object(&key(4), SPACE, &w, alice_entry).is_ok());
    let mut moved = w.clone();
    moved.object_id = "0191d1a4-3000-7000-8000-00000000d00e".into();
    assert!(open_object(&key(4), SPACE, &moved, alice_entry).is_err());
    let mut reattributed = w.clone();
    reattributed.author_account_id = CAROL.into();
    assert!(open_object(
        &key(4),
        SPACE,
        &reattributed,
        heads[3].member(CAROL).unwrap()
    )
    .is_err());
    // A member with the space key cannot write in someone else's name: the
    // signature is the author's.
    let forged = seal_object(&key(4), SPACE, 4, &note, &carol()).unwrap();
    assert!(open_object(&key(4), SPACE, &wire(&note, 4, &forged), alice_entry).is_err());
    assert!(open_object(
        &key(4),
        "0191d1a4-5a00-7000-8000-00000000a002",
        &w,
        alice_entry
    )
    .is_err());
}

#[test]
fn the_payer_of_a_reply_is_its_author() {
    let reply = body(
        "message",
        "0191d1a4-3000-7000-8000-00000000d0aa",
        CAROL,
        json!({"conversation_id":"0191d1a4-3000-7000-8000-00000000c001","role":"assistant","text":"Hi","model":"m","paid_by":ALICE}),
    );
    assert!(seal_object(&key(4), SPACE, 4, &reply, &carol()).is_err());
}

#[test]
fn an_acceptance_names_one_invitee_for_one_invitation() {
    let secret = [0x5a; 32];
    let bob_bundle = bob().bundle(BOB, CREATED);
    let proof = acceptance_proof(&secret, INVITATION, SPACE, &bob_bundle);
    assert!(verify_acceptance(&secret, INVITATION, SPACE, &bob_bundle, &proof).is_ok());
    // The service swapping in another account's keys.
    let carol_bundle = carol().bundle(CAROL, CREATED);
    assert!(verify_acceptance(&secret, INVITATION, SPACE, &carol_bundle, &proof).is_err());
    // A proof replayed against another invitation of the same space.
    assert!(verify_acceptance(
        &secret,
        "0191d1a4-1000-7000-8000-00000000f002",
        SPACE,
        &bob_bundle,
        &proof
    )
    .is_err());
    // Without the link, no proof.
    assert!(verify_acceptance(&[0x5b; 32], INVITATION, SPACE, &bob_bundle, &proof).is_err());
}

#[test]
fn an_invitation_code_is_found_in_a_link_and_refused_when_damaged() {
    let secret = [0x5a; 32];
    let code = invitation_code(INVITATION, &secret);
    let (id, parsed) = parse_invitation(&format!("https://example.test/app#join={code}")).unwrap();
    assert_eq!(id, INVITATION);
    assert_eq!(*parsed, secret);
    assert!(parse_invitation(&code[..code.len() - 3]).is_err());
    assert!(parse_invitation("srspace1.not-a-uuid.AAAA").is_err());
}

#[test]
fn the_sealed_payload_opens_only_with_its_link() {
    let secret = [0x5a; 32];
    let payload = InvitePayload {
        v: 1,
        space_id: SPACE.into(),
        space_name: "Launch plan".into(),
        inviter: alice().bundle(ALICE, CREATED),
        expires_at: "2026-10-15T12:00:00Z".into(),
    };
    let sealed = seal_payload(&secret, INVITATION, &payload).unwrap();
    assert_eq!(open_payload(&secret, INVITATION, &sealed).unwrap(), payload);
    assert!(open_payload(&[1; 32], INVITATION, &sealed).is_err());
    assert!(open_payload(&secret, "0191d1a4-1000-7000-8000-00000000f002", &sealed).is_err());
}

#[test]
fn identities_seal_under_the_vault_and_verify_themselves() {
    let vault = [0x77; 32];
    let sealed = alice().seal(&vault, ALICE).unwrap();
    let opened = IdentitySecret::open(&vault, ALICE, &sealed).unwrap();
    assert_eq!(opened.ed25519_public(), alice().ed25519_public());
    assert!(IdentitySecret::open(&vault, BOB, &sealed).is_err());
    let bundle = alice().bundle(ALICE, CREATED);
    assert!(bundle.verify().is_ok());
    let mut swapped = bundle.clone();
    swapped.x25519 = bob().bundle(BOB, CREATED).x25519;
    assert!(swapped.verify().is_err());
}

#[test]
fn safety_numbers_are_symmetric_and_sixty_digits() {
    let a = alice().bundle(ALICE, CREATED);
    let b = bob().bundle(BOB, CREATED);
    let number = safety_number(&a, &b);
    assert_eq!(number, safety_number(&b, &a));
    assert_eq!(number.len(), 60);
    assert!(number.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(grouped(&number).len(), 12);
    assert_ne!(number, safety_number(&a, &carol().bundle(CAROL, CREATED)));
}
