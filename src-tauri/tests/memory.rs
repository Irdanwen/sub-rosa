use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::MemorySource;
use sqlx_sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

#[tokio::test]
async fn inserts_trim_clamp_and_list_newest_first() {
    let repos = repos().await;
    let first = repos
        .insert_memory("  Speaks French.  ", MemorySource::Auto, 4)
        .await
        .expect("insert first");
    assert_eq!(first.text, "Speaks French.");
    assert_eq!(first.source, MemorySource::Auto);
    assert!(!first.disabled);
    assert!(!first.has_embedding);

    let clamped = repos
        .insert_memory("Prefers dark mode.", MemorySource::Manual, 42)
        .await
        .expect("insert clamped");
    assert_eq!(clamped.importance, 10, "importance clamps to 1..=10");

    let items = repos.list_memories().await.expect("list");
    assert_eq!(items.len(), 2);
    // Same-timestamp inserts fall back to rowid DESC: newest insert first.
    assert_eq!(items[0].id, clamped.id);
    assert_eq!(items[1].id, first.id);
}

#[tokio::test]
async fn detects_duplicate_text_case_insensitively() {
    let repos = repos().await;
    repos
        .insert_memory("Works on the Lexion project.", MemorySource::Auto, 3)
        .await
        .expect("insert");
    assert!(repos
        .memory_with_text_exists("  works on the lexion PROJECT.  ")
        .await
        .expect("dedup check"));
    assert!(!repos
        .memory_with_text_exists("Works on Sub Rosa.")
        .await
        .expect("dedup check"));
}

#[tokio::test]
async fn top_memories_ranks_important_first_and_skips_disabled() {
    let repos = repos().await;
    let trivial = repos
        .insert_memory("Likes espresso.", MemorySource::Auto, 8)
        .await
        .expect("insert trivial");
    let essential = repos
        .insert_memory("Always answers in French.", MemorySource::Auto, 1)
        .await
        .expect("insert essential");
    let hidden = repos
        .insert_memory("Old workplace.", MemorySource::Auto, 2)
        .await
        .expect("insert hidden");
    repos
        .update_memory(&hidden.id, None, Some(true))
        .await
        .expect("disable");

    let top = repos.top_memories(10).await.expect("top");
    assert_eq!(
        top.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec![essential.id.as_str(), trivial.id.as_str()],
        "importance ASC ranks 1 before 8 and the disabled memory is excluded"
    );
}

#[tokio::test]
async fn update_edits_text_toggles_disabled_and_clears_embedding() {
    let repos = repos().await;
    let memory = repos
        .insert_memory("Uses a Mac.", MemorySource::Auto, 5)
        .await
        .expect("insert");
    repos
        .set_memory_embedding(&memory.id, &[0, 0, 128, 63])
        .await
        .expect("set embedding");
    let listed = repos.list_memories().await.expect("list");
    assert!(listed[0].has_embedding);

    let updated = repos
        .update_memory(&memory.id, Some("Uses a Mac and an iPhone."), Some(true))
        .await
        .expect("update");
    assert_eq!(updated.text, "Uses a Mac and an iPhone.");
    assert!(updated.disabled);
    assert!(
        !updated.has_embedding,
        "a text edit invalidates the stored vector"
    );

    let missing = repos
        .update_memory("nope", Some("x"), None)
        .await
        .expect_err("unknown id");
    assert_eq!(missing.code, "memory_not_found");
}

#[tokio::test]
async fn deletes_one_or_all_memories() {
    let repos = repos().await;
    let keep = repos
        .insert_memory("Keep.", MemorySource::Manual, 3)
        .await
        .expect("insert keep");
    let remove = repos
        .insert_memory("Remove.", MemorySource::Manual, 3)
        .await
        .expect("insert remove");

    repos.delete_memory(&remove.id).await.expect("delete");
    let error = repos
        .delete_memory(&remove.id)
        .await
        .expect_err("double delete");
    assert_eq!(error.code, "memory_not_found");

    let items = repos.list_memories().await.expect("list");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, keep.id);

    repos.delete_all_memories().await.expect("clear");
    assert!(repos.list_memories().await.expect("list").is_empty());
}

#[tokio::test]
async fn search_matches_enabled_memories_and_escapes_like_wildcards() {
    let repos = repos().await;
    repos
        .insert_memory("Ships releases at 100% coverage.", MemorySource::Auto, 2)
        .await
        .expect("insert");
    repos
        .insert_memory("Enjoys hiking.", MemorySource::Auto, 6)
        .await
        .expect("insert other");

    let hits = repos.search_memories("100%", 10).await.expect("search");
    assert_eq!(hits.len(), 1, "the literal % must not match everything");
    assert!(hits[0].text.contains("coverage"));

    let none = repos.search_memories("skiing", 10).await.expect("search");
    assert!(none.is_empty());
}

#[tokio::test]
async fn embedding_backfill_finds_only_unembedded_enabled_memories() {
    let repos = repos().await;
    let pending = repos
        .insert_memory("Pending vector.", MemorySource::Auto, 4)
        .await
        .expect("insert pending");
    let done = repos
        .insert_memory("Vector stored.", MemorySource::Auto, 4)
        .await
        .expect("insert done");
    repos
        .set_memory_embedding(&done.id, &[0, 0, 128, 63])
        .await
        .expect("set embedding");

    let missing = repos.memories_missing_embedding(10).await.expect("missing");
    assert_eq!(
        missing.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec![pending.id.as_str()]
    );

    let rows = repos.memories_with_embeddings().await.expect("rows");
    assert_eq!(rows.len(), 2);
    let stored = rows
        .iter()
        .find(|row| row.memory.id == done.id)
        .expect("stored row");
    assert_eq!(stored.embedding.as_deref(), Some(&[0u8, 0, 128, 63][..]));
    let empty = rows
        .iter()
        .find(|row| row.memory.id == pending.id)
        .expect("pending row");
    assert!(empty.embedding.is_none());
}
