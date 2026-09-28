//! A migration file that `db/migrations.rs` never names is a migration no
//! database ever takes. It compiles, every test that builds its own schema
//! passes, and production fails on the first query that needs it —
//! `026_account_device_renewal.sql` did exactly that, and every device renewal
//! broke on a missing column for a week.
//!
//! This is that rule, enforced: every file under `migrations/` is named in the
//! runner, either replayed or folded into an `ensure_column` next to a comment
//! that says so.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn every_migration_file_is_named_by_the_runner() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let runner = std::fs::read_to_string(root.join("src/db/migrations.rs")).unwrap();
    let mut missing = Vec::new();
    for entry in std::fs::read_dir(root.join("migrations")).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.ends_with(".sql") && !runner.contains(&name) {
            missing.push(name);
        }
    }
    missing.sort();
    assert!(
        missing.is_empty(),
        "migration files the runner never applies: {missing:?}"
    );
}
