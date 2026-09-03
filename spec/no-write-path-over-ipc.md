# No command accepts a place to write

**Rule.** A Tauri command never takes a destination path from the webview.
When a command has to write a file the user chooses, it opens the native save
dialog on the Rust side and writes where the dialog returned. Read paths are
resolved through `path_confinement` and must sit under an allowed root.

**Why.** A path parameter is a forgeable destination: a hostile model response,
a chat block, or a compromised renderer could point a write at any file the
process can reach. Removing the parameter removes the class of bug; filtering
it would only narrow it. The three commands that used to take one
(`save_hermes_bridge_file`, `carpe_diem_media_export_artifact`,
`export_timeline_bundle`) now open the dialog themselves.

**How to apply.** Any new export (the archive, the diagnostics bundle, a
Markdown export) follows the same shape: no `path` in the request DTO, a
`rfd`/Tauri dialog call in the command, a write under the returned path, and
the returned path in the response for the UI to reveal.

**Exceptions.** None. A command that reads a path the user picked earlier
(a recording, an import) resolves it with `path_confinement` before opening it.

**Held by.** `src-tauri/tests/ipc_write_paths.rs`,
`src-tauri/tests/path_confinement.rs`.
