//! The web client's finances, as Rust says it (see `mod.rs`): the two
//! read-only tools' declarations, the categories that are not spending, and
//! the travelling tables of synchronised statements (ADR-0099).

fn export() -> serde_json::Value {
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/finance.rs",
        "tools": crate::finance::tool::definitions(),
        "categories": crate::finance::CATEGORIES,
        "notSpending": crate::finance::NOT_SPENDING,
        "uncategorized": "uncategorized",
        "searchLimit": crate::finance::tool::SEARCH_LIMIT,
        "topMerchants": crate::finance::summary::TOP_MERCHANTS,
        "tables": super::tables(&["transactions", "finance_rules"]),
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("finance", export());
}
