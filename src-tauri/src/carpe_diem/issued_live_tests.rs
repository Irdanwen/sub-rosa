//! Opt-in proof that the three implementations of the partner contract agree:
//! this app's proof and thumbprint, the account service's assertion, and the
//! Carpe Diem operator's verification (`docs/carpe-diem-partner-contract.md`).
//!
//! It runs against disposable local services only: an operator started with a
//! throwaway database and the account service's `local_identity` fixture. The
//! fixture JSON holds their loopback addresses and freshly signed-in device
//! sessions. No keychain is read or written.
//!
//! Recipe (each test on a fresh operator database; the account service allows
//! five assertions a minute and Carpe Diem three issuances a day per account,
//! so space the runs):
//!
//! 1. A P-256 PKCS#8 key; its public JWK goes in the operator's
//!    `PARTNERS_JSON` with issuer `http://127.0.0.1:8088`.
//! 2. The operator's `buildApp()` on `127.0.0.1:3901` with
//!    `OPERATOR_PUBLIC_URL=http://127.0.0.1:3901`, `NODE_ENV=development`
//!    and a throwaway `DB_PATH`.
//! 3. `cargo run --example local_identity` in `subrosa-cloud` with
//!    `SUBROSA_TEST_PUBLIC_URL=http://127.0.0.1:8088`,
//!    `SUBROSA_TEST_CARPE_DIEM_AUDIENCE` and
//!    `SUBROSA_TEST_CARPE_DIEM_OPERATOR_URL` set to the operator, and
//!    `SUBROSA_TEST_CARPE_DIEM_KEY_FILE` to the key.
//! 4. For the consent test, first create a Carpe Diem email account for the
//!    fixture identity (`/auth/email/start` then `/auth/email/verify`) and add
//!    `"operator_log"` (the operator writes unsent mails there).
//! 5. Three native sign-ins through `/api/v1/device-login` (native), the
//!    fixture's identity page and `/device-login/exchange`, written as
//!    `{"account_base","operator_base":"…/v1","devices":[{"access_token","device_id"}]}`.
use super::*;

struct Fixture {
    account: String,
    base: String,
    /// The local operator's log, where it writes the mails it cannot send.
    operator_log: Option<String>,
    devices: Vec<String>,
    device_ids: Vec<String>,
}

fn fixture() -> Fixture {
    let path = std::env::var("SUBROSA_TEST_PARTNER_FIXTURE").unwrap();
    let bytes = Zeroizing::new(std::fs::read(path).unwrap());
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    for url in [&value["account_base"], &value["operator_base"]] {
        let url = reqwest::Url::parse(url.as_str().unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"), "loopback only");
    }
    Fixture {
        account: value["account_base"].as_str().unwrap().into(),
        base: value["operator_base"].as_str().unwrap().into(),
        operator_log: value["operator_log"].as_str().map(str::to_string),
        devices: value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["access_token"].as_str().unwrap().to_string())
            .collect(),
        device_ids: value["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["device_id"].as_str().unwrap_or_default().to_string())
            .collect(),
    }
}

async fn assertion(f: &Fixture, token: &str, jkt: &str) -> Redacted<String> {
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/carpe-diem/assertion", f.account))
        .bearer_auth(token)
        .json(&json!({ "jkt": jkt }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    crate::account::carpe_diem_link::parse_assertion(&body["data"]).unwrap()
}

/// Whether Carpe Diem takes the key. `/v1/billing/purchases` authenticates the
/// key and reads only the ledger, so it answers on a local operator that has
/// no chain to read balances from (where `/v1/credits` answers 503).
async fn credits_status(f: &Fixture, key: &Redacted<String>) -> u16 {
    reqwest::Client::new()
        .get(format!("{}/v1/billing/purchases", partner_root(&f.base)))
        .bearer_auth(key.expose_str())
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

fn issued(answer: Answer) -> Redacted<String> {
    match answer {
        Answer::Issued { key, .. } => key,
        other => panic!("expected a key, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local Carpe Diem operator and account service; set SUBROSA_TEST_PARTNER_FIXTURE"]
async fn a_device_key_is_born_from_a_real_account_and_dies_alone() {
    let f = fixture();
    assert!(f.devices.len() >= 2, "two signed-in devices");
    assert!(capabilities(&f.base).await.key_issuance);

    // Device A: the assertion is minted for this key, and Carpe Diem accepts
    // the proof this code signs.
    let a = Ephemeral::generate();
    let assertion_a = assertion(&f, &f.devices[0], &a.jkt()).await;
    let key_a = issued(post_keys(&f.base, &a, &assertion_a).await.unwrap());
    assert_eq!(credits_status(&f, &key_a).await, 200);

    // The same assertion twice is a replay, never a second key.
    assert_eq!(
        post_keys(&f.base, &a, &assertion_a).await.unwrap(),
        Answer::Replayed
    );

    // An assertion carried by anyone but the key it names is worthless.
    let a_again = Ephemeral::generate();
    let bound_to_a_again = assertion(&f, &f.devices[0], &a_again.jkt()).await;
    let thief = Ephemeral::generate();
    assert!(post_keys(&f.base, &thief, &bound_to_a_again).await.is_err());

    // Device B gets its own key, on the same account.
    let b = Ephemeral::generate();
    let assertion_b = assertion(&f, &f.devices[1], &b.jkt()).await;
    let key_b = issued(post_keys(&f.base, &b, &assertion_b).await.unwrap());
    assert_ne!(key_a.expose_str(), key_b.expose_str());
    assert_eq!(credits_status(&f, &key_b).await, 200);

    // Signing out of A kills A's key and nothing else.
    self_revoke(&f.base, &key_a).await;
    assert_eq!(credits_status(&f, &key_a).await, 401);
    assert_eq!(credits_status(&f, &key_b).await, 200);

    // Re-issuing for B rotates it: the previous key of that device stops.
    let b2 = Ephemeral::generate();
    let assertion_b2 = assertion(&f, &f.devices[1], &b2.jkt()).await;
    let key_b2 = issued(post_keys(&f.base, &b2, &assertion_b2).await.unwrap());
    assert_eq!(credits_status(&f, &key_b).await, 401);
    assert_eq!(credits_status(&f, &key_b2).await, 200);
}

/// The other half of the promise: a device revoked from the account loses its
/// Carpe Diem key, through the account service's durable outbox, without the
/// app being involved at all (it may be lost or stolen).
#[tokio::test]
#[ignore = "requires a local Carpe Diem operator and an account service delivering revocations; set SUBROSA_TEST_PARTNER_FIXTURE"]
async fn a_device_revoked_from_the_account_loses_its_key() {
    let f = fixture();
    assert!(f.devices.len() >= 3, "a third, disposable device");
    let lost = Ephemeral::generate();
    let assertion_lost = assertion(&f, &f.devices[2], &lost.jkt()).await;
    let key = issued(post_keys(&f.base, &lost, &assertion_lost).await.unwrap());
    assert_eq!(credits_status(&f, &key).await, 200);

    // Revoked from another device of the same account.
    let response = reqwest::Client::new()
        .delete(format!("{}/api/v1/devices/{}", f.account, f.device_ids[2]))
        .bearer_auth(&f.devices[0])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if credits_status(&f, &key).await == 401 {
            break;
        }
        assert!(Instant::now() < deadline, "the key outlived its device");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn operator_post(f: &Fixture, path: &str, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(format!("{}{path}", partner_root(&f.base)))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The consent token of the last link mail the local operator "sent".
fn last_consent_token(f: &Fixture) -> String {
    let log = std::fs::read_to_string(f.operator_log.as_ref().expect("operator_log")).unwrap();
    let at = log.rfind("/link?r=").expect("a consent mail");
    log[at + "/link?r=".len()..]
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .collect()
}

/// An email that already has a Carpe Diem account (made there, not through
/// Sub Rosa) is never linked on the account service's word alone: the person
/// confirms by mail, typing the code this device shows, and only the device
/// holding the attempt's key receives the key.
#[tokio::test]
#[ignore = "requires a local Carpe Diem operator (with a pre-existing email account for the fixture identity) and account service; set SUBROSA_TEST_PARTNER_FIXTURE"]
async fn an_existing_carpe_diem_account_is_linked_only_with_consent() {
    let f = fixture();
    let device = Ephemeral::generate();
    let signed = assertion(&f, &f.devices[0], &device.jkt()).await;
    let Answer::Confirm {
        link_request_id,
        code,
        expires_at,
        email_hint,
    } = post_keys(&f.base, &device, &signed).await.unwrap()
    else {
        panic!("an existing account must ask for consent");
    };
    let pending = Pending {
        base: f.base.clone(),
        ephemeral: device,
        link_request_id: link_request_id.clone(),
        code: code.clone(),
        expires_at: expires_at.clone(),
        email_hint: email_hint.clone(),
    };
    assert_eq!(post_poll(&f.base, &pending).await.unwrap(), Answer::Pending);

    // Someone who learned the request id but holds another key gets nothing.
    let intruder = Pending {
        base: f.base.clone(),
        ephemeral: Ephemeral::generate(),
        link_request_id: link_request_id.clone(),
        code: code.clone(),
        expires_at,
        email_hint,
    };
    assert!(post_poll(&f.base, &intruder).await.is_err());

    let token = last_consent_token(&f);
    assert_eq!(token.len(), 64);
    let (status, described) =
        operator_post(&f, "/partner/link/describe", json!({"token": token})).await;
    assert_eq!(status, 200);
    assert_eq!(described["partner"], "Sub Rosa");
    let wrong = if code == "AAAAAA" { "BBBBBB" } else { "AAAAAA" };
    let (status, _) = operator_post(
        &f,
        "/partner/link/confirm",
        json!({"token": token, "code": wrong}),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(post_poll(&f.base, &pending).await.unwrap(), Answer::Pending);
    let (status, _) = operator_post(
        &f,
        "/partner/link/confirm",
        json!({"token": token, "code": code}),
    )
    .await;
    assert_eq!(status, 200);

    let key = issued(post_poll(&f.base, &pending).await.unwrap());
    assert_eq!(credits_status(&f, &key).await, 200);
    // The attempt is spent: polling again issues nothing more.
    assert!(!matches!(
        post_poll(&f.base, &pending).await,
        Ok(Answer::Issued { .. })
    ));
}
