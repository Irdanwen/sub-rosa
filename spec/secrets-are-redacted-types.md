# A secret is a type, and it stays out of the environment

**Rule.** A credential in Rust is a `Redacted<T>` (`src-tauri/src/redacted.rs`):
its `Debug` prints a mask and it has no `Display`, so reading the value is an
explicit `expose_str()` that is visible in review. No credential is ever
written into this process's environment, and the backend child receives its
two credentials on stdin, not in `.env(...)`.

**Why.** The environment is copied into every child the app spawns, and the
app spawns children from about fifty places. A struct printed while debugging
should not be able to leak a key; a `bearer_auth(impl Display)` should not be
able to receive a mask by accident. The rules are shaped so the mistake does
not compile or does not pass the scan.

**How to apply.** Wrap a new secret in `Redacted` at the boundary where it
enters (keychain read, settings DTO), pass it as `&Redacted<String>`, and call
`expose_str()` only at the line that sends it. Never `set_var` anything with
a credential-shaped name. If a child needs a secret, give it a pipe.

**Exceptions.** The debug-only `SUBROSA_DEV_API_KEY` is read, never written,
and is compiled out of release builds.

**Held by.** `src-tauri/tests/no_secret_in_logs.rs`,
`src-tauri/tests/no_secrets_in_process_env.rs`,
`src-tauri/tests/sidecar_secrets_on_stdin.rs`.
