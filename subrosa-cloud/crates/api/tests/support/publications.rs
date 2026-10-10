//! Public pages, sites, profiles, the assistant catalog, reports and
//! takedowns (ADR 0097), against a real `PostgreSQL`.
use super::*;
use subrosa_services::publication::TakedownTarget;

const PAGES_HOST: &str = "127.0.0.1:8789";

impl Fixture {
    /// A GET as a reader's browser sends it, to `host`.
    async fn read(&self, host: Option<&str>, path: &str) -> Result<(StatusCode, String, Response)> {
        let mut request = Request::builder().uri(path);
        if let Some(host) = host {
            request = request.header(header::HOST, host);
        }
        let response = self.call(request.body(Body::empty())?).await?;
        let status = response.status();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 4 * 1024 * 1024).await?;
        Ok((
            status,
            String::from_utf8_lossy(&bytes).into_owned(),
            Response::from_parts(parts, Body::empty()),
        ))
    }
    async fn anonymous(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<(StatusCode, Value)> {
        decode_response(
            self.call(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&body)?))?,
            )
            .await?,
        )
        .await
    }
}

fn page_body(slug: &str, title: &str, source: &str, markdown: &str) -> Value {
    json!({"slug":slug,"title":title,"kind":"note","source_id":source,"markdown":markdown})
}

#[tokio::test]
async fn a_page_is_sanitized_served_apart_and_taken_back() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bob = f.login("bob").await?;
    let id = Uuid::new_v4();
    let path = format!("/api/v1/publications/pages/{id}");
    let hostile = "Hello <script>alert(1)</script>\n\n[click](javascript:alert(1)) [ok](https://example.org)\n\n![pixel](https://evil.example/p.gif)";
    let (status, body) = f
        .json(
            "PUT",
            &path,
            &alice,
            page_body("alice-notes", "Alice's notes", "note-1", hostile),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["slug"], "alice-notes");
    let first_digest = body["data"]["source_digest"].clone();

    // Anyone can read it, on the public origin only.
    let (status, html, response) = f.read(Some(PAGES_HOST), "/p/alice-notes").await?;
    assert_eq!(status, StatusCode::OK);
    let headers = response.headers();
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()?
            .starts_with("text/html")
    );
    let policy = headers[header::CONTENT_SECURITY_POLICY].to_str()?;
    assert!(policy.starts_with("default-src 'none'"), "{policy}");
    assert!(!policy.contains("script-src"));
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("javascript:"), "{html}");
    assert!(!html.contains("evil.example"), "{html}");
    assert!(html.contains("&lt;script&gt;"), "{html}");
    assert!(html.contains("href=\"https://example.org\""), "{html}");
    assert!(html.contains("Alice&#39;s notes"), "{html}");
    for host in [None, Some("localhost:8787")] {
        assert_eq!(
            f.read(host, "/p/alice-notes").await?.0,
            StatusCode::NOT_FOUND,
            "served on {host:?}"
        );
    }
    let (status, css, _) = f.read(Some(PAGES_HOST), "/_pub/style.css").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(css.contains("--paper"));

    // An address belongs to whoever took it, and an id to whoever made it.
    let (status, body) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
            &bob,
            page_body("alice-notes", "Mine now", "bob-1", "text"),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "slug_taken");
    let (status, _) = f
        .json(
            "PUT",
            &path,
            &bob,
            page_body("bob-page", "Hijack", "bob-2", "text"),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    // One page per source: a second device of Alice updates, never duplicates.
    let (status, _) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
            &alice,
            page_body("alice-notes-2", "Dup", "note-1", "text"),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);

    // The documented rules, named in the refusal.
    let key = format!("my key: cdm_{}", "Ab1".repeat(10));
    for (markdown, rule) in [
        (key.as_str(), "credential"),
        ("A forbidden phrase in here", "blocked_term"),
        ("   ", "empty"),
    ] {
        let (status, body) = f
            .json(
                "PUT",
                &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
                &alice,
                page_body("refused-page", "Refused", "note-9", markdown),
            )
            .await?;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "content_policy");
        assert_eq!(body["error"]["rule"], rule);
    }
    let (status, body) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
            &alice,
            page_body("Bad Slug", "Refused", "note-8", "text"),
        )
        .await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["rule"], "shape");
    let (status, _) = f
        .anonymous("PUT", &path, page_body("x-y-z", "No", "n", "text"))
        .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // "Publish changes" replaces what the page shows.
    let (status, body) = f
        .json(
            "PUT",
            &path,
            &alice,
            page_body(
                "alice-notes",
                "Alice's notes",
                "note-1",
                "Second **version**",
            ),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body["data"]["source_digest"], first_digest);
    let (_, html, _) = f.read(Some(PAGES_HOST), "/p/alice-notes").await?;
    assert!(html.contains("Second <strong>version</strong>"));
    assert!(!html.contains("alert"));

    // The owner sees it; nobody else does.
    let (_, mine) = f
        .json("GET", "/api/v1/publications", &alice, json!({}))
        .await?;
    assert_eq!(mine["data"]["pages"].as_array().map(Vec::len), Some(1));
    assert_eq!(mine["data"]["publication_url"], PAGES_ORIGIN);
    let (_, theirs) = f
        .json("GET", "/api/v1/publications", &bob, json!({}))
        .await?;
    assert_eq!(theirs["data"]["pages"].as_array().map(Vec::len), Some(0));

    // Unpublishing removes it at once; the stored text goes with it.
    assert_eq!(
        f.json("DELETE", &path, &bob, json!({})).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("DELETE", &path, &alice, json!({})).await?.0,
        StatusCode::OK
    );
    let (status, html, response) = f.read(Some(PAGES_HOST), "/p/alice-notes").await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()?
            .starts_with("text/html")
    );
    assert!(!html.contains("Second"));
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM published_pages")
        .fetch_one(&f.pool)
        .await?;
    assert_eq!(left, 0);
    Ok(())
}

#[tokio::test]
async fn a_site_navigates_its_own_pages_and_an_app_publishes_with_its_bearer() -> Result<()> {
    let f = Fixture::new().await?;
    let token = app_device(&f, "carol", "Carol phone").await?;
    let access = &token["access_token"];
    let (home, other) = (Uuid::new_v4(), Uuid::new_v4());
    for (id, slug, title) in [
        (home, "carol-home", "Welcome"),
        (other, "carol-recipes", "Recipes"),
    ] {
        let (status, body) = bearer(
            &f.app,
            "PUT",
            &format!("/api/v1/publications/pages/{id}"),
            access,
            page_body(slug, title, &format!("src-{slug}"), "Some text"),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let site = Uuid::new_v4();
    let site_path = format!("/api/v1/publications/sites/{site}");
    let (status, body) = bearer(
        &f.app,
        "PUT",
        &site_path,
        access,
        json!({"title":"Carol's <kitchen>","home_page_id":home,"page_ids":[home,other]}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, html, _) = f.read(Some(PAGES_HOST), "/p/carol-recipes").await?;
    assert!(html.contains("Carol&#39;s &lt;kitchen&gt;"), "{html}");
    assert!(html.contains("href=\"/p/carol-home\""));
    assert!(html.contains("aria-current=\"page\""));

    // A site holds only its owner's pages, once each, with its home among them.
    let alice = f.login("alice").await?;
    let theirs = Uuid::new_v4();
    f.json(
        "PUT",
        &format!("/api/v1/publications/pages/{theirs}"),
        &alice,
        page_body("alice-page", "Alice", "a-1", "text"),
    )
    .await?;
    for (pages, home_page) in [
        (json!([home, theirs]), json!(home)),
        (json!([home, home]), json!(home)),
        (json!([other]), json!(home)),
        (json!([]), Value::Null),
    ] {
        let (status, body) = bearer(
            &f.app,
            "PUT",
            &site_path,
            access,
            json!({"title":"T","home_page_id":home_page,"page_ids":pages}),
        )
        .await?;
        assert!(status.is_client_error(), "{pages} {body}");
    }

    // Deleting a site leaves its pages published on their own.
    assert_eq!(
        bearer(&f.app, "DELETE", &site_path, access, json!({}))
            .await?
            .0,
        StatusCode::OK
    );
    let (status, html, _) = f.read(Some(PAGES_HOST), "/p/carol-recipes").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("kitchen"));
    Ok(())
}

#[tokio::test]
async fn a_profile_and_a_listing_are_found_imported_reported_and_taken_down() -> Result<()> {
    let f = Fixture::new().await?;
    let alice = f.login("alice").await?;
    let bob = f.login("bob").await?;

    // An opt-in profile, with an address nobody else may take.
    let (status, body) = f
        .json(
            "PUT",
            "/api/v1/publications/profile",
            &alice,
            json!({"handle":"Alice-Writes","display_name":"Alice","bio":"I write <b>things</b>."}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["handle"], "alice-writes");
    for (handle, code) in [
        ("alice-writes", "slug_taken"),
        ("subrosa", "content_policy"),
    ] {
        let (_, body) = f
            .json(
                "PUT",
                "/api/v1/publications/profile",
                &bob,
                json!({"handle":handle,"display_name":"Bob"}),
            )
            .await?;
        assert_eq!(body["error"]["code"], code, "{handle}");
    }
    let upload = async |bytes: &'static [u8]| -> Result<StatusCode> {
        Ok(f.call(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/publications/profile/avatar")
                .header(header::COOKIE, &alice.cookie)
                .header(header::ORIGIN, "http://localhost:8787")
                .header("x-csrf-token", &alice.csrf)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(bytes))?,
        )
        .await?
        .status())
    };
    assert_eq!(
        upload(b"<svg onload=alert(1)>").await?,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        upload(b"\x89PNG\r\n\x1a\nnot-really").await?,
        StatusCode::OK
    );
    let (status, _, response) = f.read(Some(PAGES_HOST), "/u/alice-writes/avatar").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");

    // A listing, with only the permissions the app knows how to grant.
    let listing = Uuid::new_v4();
    let listing_path = format!("/api/v1/publications/assistants/{listing}");
    let definition = json!({
        "source_id":"assistant-1","name":"Plain editor","description":"Tightens prose without changing the voice.",
        "category":"writing","instructions":"Edit for clarity. Keep the author's voice.","starter":"Paste a paragraph.",
        "permissions":["web","notes","web"],"references":[{"name":"Style guide","text":"Short sentences."}]
    });
    let mut with_connector = definition.clone();
    with_connector["permissions"] = json!(["connector:mail-x1"]);
    let (status, _) = f.json("PUT", &listing_path, &alice, with_connector).await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) = f.json("PUT", &listing_path, &alice, definition).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["permissions"], json!(["notes", "web"]));

    // Found by search and by category, named by its author's profile.
    for query in [
        "/api/v1/catalog/assistants?q=editor",
        "/api/v1/catalog/assistants?q=PROSE",
        "/api/v1/catalog/assistants?category=writing",
        "/api/v1/catalog/assistants",
    ] {
        let (status, body) = f.anonymous("GET", query, json!({})).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"][0]["id"], json!(listing), "{query}");
        assert_eq!(body["data"][0]["author"]["handle"], "alice-writes");
        assert_eq!(body["data"][0]["reference_count"], 1);
    }
    for query in [
        "/api/v1/catalog/assistants?q=nothing-like-it",
        "/api/v1/catalog/assistants?category=coding",
        "/api/v1/catalog/assistants?q=%25",
    ] {
        let (_, body) = f.anonymous("GET", query, json!({})).await?;
        assert_eq!(body["data"], json!([]), "{query}");
    }
    assert_eq!(
        f.anonymous(
            "GET",
            "/api/v1/catalog/assistants?category=weapons",
            json!({})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );

    // Importing returns the definition and counts once; reading does not.
    let (_, read) = f
        .anonymous(
            "GET",
            &format!("/api/v1/catalog/assistants/{listing}"),
            json!({}),
        )
        .await?;
    assert_eq!(read["data"]["import_count"], 0);
    assert_eq!(read["data"]["source_id"], "");
    let (status, imported) = f
        .anonymous(
            "POST",
            &format!("/api/v1/catalog/assistants/{listing}/import"),
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(imported["data"]["import_count"], 1);
    assert_eq!(
        imported["data"]["references"][0]["text"],
        "Short sentences."
    );
    // Anybody may import, but one address counts at most ten a minute: the
    // eleventh is refused and counts nothing, so a script cannot inflate the
    // public count. Reading stays open.
    let import = format!("/api/v1/catalog/assistants/{listing}/import");
    for expected in 2..=10 {
        let (status, body) = f.anonymous("POST", &import, json!({})).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["import_count"], expected);
    }
    let (status, body) = f.anonymous("POST", &import, json!({})).await?;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "slow_down");
    let (_, read) = f
        .anonymous(
            "GET",
            &format!("/api/v1/catalog/assistants/{listing}"),
            json!({}),
        )
        .await?;
    assert_eq!(read["data"]["import_count"], 10);

    // The profile lists what its owner published.
    let page = Uuid::new_v4();
    f.json(
        "PUT",
        &format!("/api/v1/publications/pages/{page}"),
        &alice,
        page_body("alice-essay", "An essay", "note-essay", "Words."),
    )
    .await?;
    let (status, html, _) = f.read(Some(PAGES_HOST), "/u/alice-writes").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.contains("I write &lt;b&gt;things&lt;/b&gt;."),
        "{html}"
    );
    assert!(html.contains("href=\"/p/alice-essay\""));
    assert!(html.contains(&format!("/assistants/{listing}")));

    // Reports: from the JSON route and from the form at the foot of a page.
    let (status, _) = f
        .anonymous(
            "POST",
            "/api/v1/reports",
            json!({"target_kind":"assistant","target_id":listing,"reason":"spam","detail":"ads"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = f
        .anonymous(
            "POST",
            "/api/v1/reports",
            json!({"target_kind":"page","target":"no-such-page","reason":"spam"}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let form = f
        .call(
            Request::builder()
                .method("POST")
                .uri("/_pub/report")
                .header(header::HOST, PAGES_HOST)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(
                    "kind=page&target=alice-essay&reason=abuse&detail=rude",
                ))?,
        )
        .await?;
    assert_eq!(form.status(), StatusCode::OK);
    let open = f.service.open_reports().await?;
    assert_eq!(open.len(), 2);
    assert!(open.iter().any(|r| r.label.starts_with("alice-essay")));

    // A takedown hides at once, closes the reports, and sticks: the same id
    // and an identical copy elsewhere are both refused.
    f.service
        .take_down(TakedownTarget::Page("alice-essay"), "operator test")
        .await?;
    assert_eq!(
        f.read(Some(PAGES_HOST), "/p/alice-essay").await?.0,
        StatusCode::NOT_FOUND
    );
    let (status, body) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{page}"),
            &alice,
            page_body("alice-essay", "An essay", "note-essay", "Words, edited."),
        )
        .await?;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("taken_down"))
    );
    let (status, body) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
            &bob,
            page_body("bobs-copy", "An essay", "bob-essay", "Words."),
        )
        .await?;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("taken_down"))
    );
    assert_eq!(f.service.open_reports().await?.len(), 1);

    // Three takedowns suspend publishing for the account.
    f.service
        .take_down(TakedownTarget::Assistant(listing), "operator test")
        .await?;
    let (status, _) = f
        .anonymous(
            "GET",
            &format!("/api/v1/catalog/assistants/{listing}"),
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    f.service
        .take_down(TakedownTarget::Profile("alice-writes"), "operator test")
        .await?;
    assert_eq!(
        f.read(Some(PAGES_HOST), "/u/alice-writes").await?.0,
        StatusCode::NOT_FOUND
    );
    let (status, body) = f
        .json(
            "PUT",
            &format!("/api/v1/publications/pages/{}", Uuid::new_v4()),
            &alice,
            page_body("alice-fresh", "Fresh", "note-fresh", "New words."),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "publishing_suspended");
    // Bob may not claim the address that was taken down either.
    let (_, body) = f
        .json(
            "PUT",
            "/api/v1/publications/profile",
            &bob,
            json!({"handle":"alice-writes","display_name":"Bob"}),
        )
        .await?;
    assert_eq!(body["error"]["code"], "taken_down");
    Ok(())
}
