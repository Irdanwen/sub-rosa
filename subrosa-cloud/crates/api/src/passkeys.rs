//! First-party WebAuthn on the account origin. OIDC remains the migration and
//! recovery route; a credential is linked only to an authenticated account UUID.
use super::*;
use axum::routing::delete;
use webauthn_rs::prelude::{
    DiscoverableAuthentication, DiscoverableKey, Passkey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Webauthn, WebauthnBuilder,
};

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/passkeys", get(list).post(register_start))
        .route("/api/v1/passkeys/register/finish", post(register_finish))
        .route("/api/v1/passkeys/authenticate/start", post(auth_start))
        .route("/api/v1/passkeys/authenticate/finish", post(auth_finish))
        .route("/api/v1/passkeys/native/start", post(native_start))
        .route("/api/v1/passkeys/native/finish", post(native_finish))
        .route("/api/v1/passkeys/{id}", delete(remove))
}

fn webauthn(s: &Service) -> Result<Webauthn> {
    let origin = url::Url::parse(&s.config.public_url).map_err(|_| Error::Unavailable)?;
    let rp_id = origin.host_str().ok_or(Error::Unavailable)?;
    let mut builder = WebauthnBuilder::new(rp_id, &origin).map_err(|_| Error::Unavailable)?;
    for fingerprint in &s.config.passkey_android_cert_fingerprints {
        let bytes = subrosa_config::fingerprint_bytes(fingerprint).ok_or(Error::Unavailable)?;
        let android_origin = url::Url::parse(&format!(
            "android:apk-key-hash:{}",
            URL_SAFE_NO_PAD.encode(bytes)
        ))
        .map_err(|_| Error::Unavailable)?;
        builder = builder.append_allowed_origin(&android_origin);
    }
    builder.build().map_err(|_| Error::Unavailable.into())
}
fn passkey(value: Value) -> Result<Passkey> {
    serde_json::from_value(value).map_err(|_| Error::Unavailable.into())
}

async fn list(State(s): State<Arc<Service>>, headers: HeaderMap) -> Result<Response> {
    let a = session(&s, &headers, false).await?;
    let keys = s.repository.passkey_summaries(a.account.id).await?;
    Ok(ok(
        json!({"credentials": keys.into_iter().map(|(id,created_at,last_used_at)| json!({
        "id": URL_SAFE_NO_PAD.encode(id), "created_at": created_at, "last_used_at": last_used_at,
    })).collect::<Vec<_>>()}),
    )
    .into_response())
}

async fn register_start(State(s): State<Arc<Service>>, headers: HeaderMap) -> Result<Response> {
    let a = session(&s, &headers, true).await?;
    if !a.browser {
        return Err(Error::Forbidden.into());
    }
    Service::recent(&a)?;
    let keys = s
        .repository
        .passkeys_for_account(a.account.id)
        .await?
        .into_iter()
        .map(passkey)
        .collect::<Result<Vec<_>>>()?;
    let exclude = keys.iter().map(|key| key.cred_id().clone()).collect();
    let (options, state) = webauthn(&s)?
        .start_passkey_registration(
            a.account.id,
            &a.account.email,
            &a.account.email,
            Some(exclude),
        )
        .map_err(|_| Error::Unavailable)?;
    let mut options = serde_json::to_value(options).map_err(|_| Error::Unavailable)?;
    // Native account selection has no username hint. Require a discoverable
    // credential at creation so that it can be selected on a new device.
    options["publicKey"]["authenticatorSelection"]["residentKey"] = json!("required");
    options["publicKey"]["authenticatorSelection"]["requireResidentKey"] = json!(true);
    let id = Uuid::now_v7();
    s.repository
        .save_passkey_attempt(
            id,
            "register",
            &serde_json::to_value(state).map_err(|_| Error::Unavailable)?,
            Some(a.account.id),
            Some(&a.token_hash),
            None,
        )
        .await?;
    Ok(ok(json!({"attempt_id":id,"options":options})).into_response())
}

#[derive(Deserialize)]
struct RegisterFinish {
    attempt_id: Uuid,
    credential: RegisterPublicKeyCredential,
}
async fn register_finish(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinish>,
) -> Result<Response> {
    let a = session(&s, &headers, true).await?;
    if !a.browser {
        return Err(Error::Forbidden.into());
    }
    Service::recent(&a)?;
    let (state, owner, token_hash, _) = s
        .repository
        .consume_passkey_attempt(body.attempt_id, "register")
        .await?;
    if owner != Some(a.account.id) || token_hash.as_deref() != Some(a.token_hash.as_slice()) {
        return Err(Error::Unauthorized.into());
    }
    let state: PasskeyRegistration =
        serde_json::from_value(state).map_err(|_| Error::Unavailable)?;
    let credential = webauthn(&s)?
        .finish_passkey_registration(&body.credential, &state)
        .map_err(|_| Error::Unauthorized)?;
    s.repository
        .save_passkey(
            a.account.id,
            credential.cred_id().as_ref(),
            &serde_json::to_value(&credential).map_err(|_| Error::Unavailable)?,
        )
        .await?;
    Ok(ok(json!({"registered":true})).into_response())
}

async fn auth_start(State(s): State<Arc<Service>>) -> Result<Response> {
    let (options, state) = webauthn(&s)?
        .start_discoverable_authentication()
        .map_err(|_| Error::Unavailable)?;
    let id = Uuid::now_v7();
    s.repository
        .save_passkey_attempt(
            id,
            "authenticate",
            &serde_json::to_value(state).map_err(|_| Error::Unavailable)?,
            None,
            None,
            None,
        )
        .await?;
    Ok(ok(json!({"attempt_id":id,"options":options})).into_response())
}

#[derive(Deserialize)]
struct AuthFinish {
    attempt_id: Uuid,
    credential: PublicKeyCredential,
}
async fn verify_auth(s: &Service, state: Value, credential: &PublicKeyCredential) -> Result<Uuid> {
    let webauthn = webauthn(s)?;
    let (owner, credential_id) = webauthn
        .identify_discoverable_authentication(credential)
        .map_err(|_| Error::Unauthorized)?;
    let old = s.repository.passkey_by_id(owner, credential_id).await?;
    let mut key = passkey(old.clone())?;
    let state: DiscoverableAuthentication =
        serde_json::from_value(state).map_err(|_| Error::Unavailable)?;
    let result = webauthn
        .finish_discoverable_authentication(credential, state, &[DiscoverableKey::from(&key)])
        .map_err(|_| Error::Unauthorized)?;
    if !result.user_verified() || !key.update_credential(&result).is_some() {
        return Err(Error::Unauthorized.into());
    }
    let updated = serde_json::to_value(key).map_err(|_| Error::Unavailable)?;
    s.repository
        .update_passkey(owner, credential_id, &old, &updated)
        .await?;
    Ok(owner)
}

async fn auth_finish(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Json(body): Json<AuthFinish>,
) -> Result<Response> {
    // This route sets a browser cookie. A cross-site assertion must not log a
    // browser into a different account behind an unlocked tab's back.
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(s.config.public_url.as_str())
    {
        return Err(Error::Forbidden.into());
    }
    let (state, _, _, _) = s
        .repository
        .consume_passkey_attempt(body.attempt_id, "authenticate")
        .await?;
    let owner = verify_auth(&s, state, &body.credential).await?;
    let token = subrosa_services::random_secret();
    s.repository
        .browser_session_for_account(owner, &hash(token.expose()))
        .await?;
    let mut response = ok(json!({"authenticated":true})).into_response();
    set_cookie(
        &mut response,
        &s,
        s.config.session_cookie(),
        token.expose(),
        true,
        43200,
    )?;
    set_cookie(
        &mut response,
        &s,
        "subrosa_csrf",
        &csrf_for(token.expose()),
        false,
        43200,
    )?;
    Ok(response)
}

#[derive(Deserialize)]
struct NativeStart {
    request_id: Uuid,
    verifier: String,
}
async fn native_start(
    State(s): State<Arc<Service>>,
    Json(body): Json<NativeStart>,
) -> Result<Response> {
    if !(43..=128).contains(&body.verifier.len())
        || !body
            .verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return Err(Error::Invalid.into());
    }
    let challenge = hash(&body.verifier);
    s.repository
        .native_request_for_passkey(body.request_id, &challenge)
        .await?;
    let (options, state) = webauthn(&s)?
        .start_discoverable_authentication()
        .map_err(|_| Error::Unavailable)?;
    let id = Uuid::now_v7();
    s.repository
        .save_passkey_attempt(
            id,
            "native",
            &serde_json::to_value(state).map_err(|_| Error::Unavailable)?,
            None,
            None,
            Some(body.request_id),
        )
        .await?;
    Ok(ok(json!({"attempt_id":id,"options":options})).into_response())
}
async fn native_finish(
    State(s): State<Arc<Service>>,
    Json(body): Json<AuthFinish>,
) -> Result<Response> {
    let (state, _, _, request_id) = s
        .repository
        .consume_passkey_attempt(body.attempt_id, "native")
        .await?;
    let request_id = request_id.ok_or(Error::Unauthorized)?;
    let owner = verify_auth(&s, state, &body.credential).await?;
    let return_code = subrosa_services::random_secret();
    s.repository
        .approve_native_passkey(owner, request_id, &hash(return_code.expose()))
        .await?;
    Ok(ok(json!({"request_id":request_id,"return_code":return_code.expose()})).into_response())
}

async fn remove(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let a = session(&s, &headers, true).await?;
    if !a.browser {
        return Err(Error::Forbidden.into());
    }
    Service::recent(&a)?;
    let id = URL_SAFE_NO_PAD.decode(id).map_err(|_| Error::Invalid)?;
    s.repository.delete_passkey(a.account.id, &id).await?;
    Ok(ok(json!({"removed":true})).into_response())
}
