# Shared commands: in both `generate_handler!` lists

**Rule.** A Tauri command that both shells use is registered in both
`generate_handler!` lists in `src-tauri/src/lib.rs` (the desktop list at
twelve-space indent, the mobile list at eight). A command that only one
platform can run says so in `src-tauri/tests/shared_commands.rs`.

**Why.** The macro cannot `cfg` individual entries, so the two lists are kept
by hand. A command that lands in one list only compiles, ships, and then fails
on the phone with "command not found" the first time someone taps it. Search,
memory, imports, the archive: every fork feature since iOS shipped went in
twice.

**How to apply.** Add the line to both lists in the same commit. Insert by
block, never by `str.replace` on the eight-space line, which is a suffix of the
twelve-space line and lands twice in the desktop list. Then run
`cargo test --manifest-path src-tauri/Cargo.toml --test shared_commands`.

**Exceptions.** Platform-bound commands (HUDs, the updater, the Hermes bridge,
`photos_ios`, `share_ios`) live in one list and are named in the test's
allowlist with the reason.

**Held by.** `src-tauri/tests/shared_commands.rs`.
