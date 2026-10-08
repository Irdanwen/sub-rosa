//! What the web client's features read from Rust (WP20b), one file each.
//!
//! The rule of ADR-0101 applied to every feature the browser gained after the
//! chat: prompts, tool declarations, catalogs and the columns of the tables a
//! feature reads are Rust values, rendered here into
//! `packages/chat-core/web/<feature>.json` and never written a second time in
//! TypeScript. Each test fails when the committed file no longer matches what
//! Rust would say; run them with `SUBROSA_WRITE_WEB_EXPORT=1` to rewrite the
//! files after a change:
//!
//! ```sh
//! SUBROSA_WRITE_WEB_EXPORT=1 cargo test --lib web_features
//! ```

mod analysis;
mod assignments;
mod connectors;
mod documents;
mod finance;
mod protected;
mod research;
mod study;
mod voice;

/// The columns and routing kind of travelling tables, as the web codec reads
/// them (`website/src/client/codec.ts`, `registerTables`).
fn tables(names: &[&str]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = names
        .iter()
        .map(|name| {
            let (kind, columns) =
                crate::account::columns_of(name).expect("a web table is a travelling table");
            (
                name.to_string(),
                serde_json::json!({ "kind": kind, "columns": columns }),
            )
        })
        .collect();
    serde_json::Value::Object(map)
}

/// Compares `value` with the committed `packages/chat-core/web/<name>.json`,
/// or rewrites it when `SUBROSA_WRITE_WEB_EXPORT` is set.
fn written(name: &str, value: serde_json::Value) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/chat-core/web");
    let path = dir.join(format!("{name}.json"));
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&value).expect("the export serializes")
    );
    if std::env::var_os("SUBROSA_WRITE_WEB_EXPORT").is_some() {
        std::fs::create_dir_all(&dir).expect("the export folder exists");
        std::fs::write(&path, &rendered).expect("the export is written");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == rendered,
        "packages/chat-core/web/{name}.json is stale: run `cargo test --lib web_features` with SUBROSA_WRITE_WEB_EXPORT=1"
    );
}
