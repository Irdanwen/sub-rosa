//! What the real catalog servers taught the sign-in.

use super::*;

/// Hugging Face answers `initialize` without a token (a public subset) and
/// publishes OAuth metadata for the person's own account. A connector added
/// to be signed in to is signed in to, rather than marked connected with no
/// credential, which offered none of its tools.
#[tokio::test]
async fn a_server_that_also_answers_anonymously_is_still_signed_in_to() {
    let (base, log) = serve(|base, request| mcp_handler(base, request, None)).await;
    let pool = pool().await;
    let row = connector("anonymous-too", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    let runtime::SignIn::Browser(url) = runtime::begin_sign_in(&pool, &row).await.unwrap() else {
        panic!("an OAuth connector opens the browser");
    };
    assert!(url.starts_with(&format!("{base}/authorize?")));
    assert!(log
        .lock()
        .unwrap()
        .iter()
        .any(|request| request.path == "/register"));
}

/// A server added for OAuth that has no OAuth at all says so, rather than
/// pretending to be connected.
#[tokio::test]
async fn a_server_without_any_sign_in_is_told_to_be_added_without_one() {
    let (base, _) = serve(|base, request| {
        if request.path.starts_with("/.well-known") {
            return status_resp(404);
        }
        mcp_handler(base, request, None)
    })
    .await;
    let pool = pool().await;
    let row = connector("no-oauth", &format!("{base}/mcp"), "oauth");
    insert(&pool, &row).await.unwrap();
    let failure = runtime::begin_sign_in(&pool, &row).await.err().unwrap();
    assert_eq!(failure.code, "connector_oauth_discovery");
}
