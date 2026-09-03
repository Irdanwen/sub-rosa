# Threat model

What Sub Rosa protects, from whom, and what it deliberately does not protect
against. One page, so that a reader outside the project can check the claims
rather than take them.

The short version: **everything you write, say, and record stays on your
machine, except the requests you make of a model, which go to the endpoint you
configured and nowhere else.** The rest of this page is what that sentence
costs.

## Assets

| Asset | Where it lives | What losing it means |
| --- | --- | --- |
| The Carpe Diem API key (`cdm_…`) | The OS keychain, service `xyz.carpediem.subrosa.carpe-diem` | Someone spends your credits, and sees what you ask the model |
| Prompts, transcripts, notes, memories | SQLite in the app data directory | Someone reads what you said and wrote |
| Recorded audio and generated media | Files in the app data directory | Same, plus your voice |
| The local backend's bearer token | Process memory only, for one run | Someone talks to the inference backend as you |
| The signing keys for releases | GitHub Actions secrets, never in the repo | Someone ships an update that is not ours |

## Boundaries

Five, and each is a place where something is checked rather than assumed.

1. **The keychain.** The API key never enters the webview; the settings DTO
   carries `hasApiKey: bool` and nothing else. In Rust it moves as
   `Redacted<String>`, whose `Debug` prints a mask, so a struct printed while
   debugging cannot leak it. Reading it is `expose_str()`, which is visible in
   review. `tests/no_secret_in_logs.rs` holds this.

2. **Loopback plus a bearer.** The backend binds `127.0.0.1` on an ephemeral
   port with a 256-bit token generated per run. The token lives in process
   memory (`carpe_diem::local_session`), *not* in the environment, because the
   environment is copied into every child process the app spawns. The children
   that run code we did not write — the agent runtime, its MCP servers, the
   dictation helper — have their environments scrubbed on top of that
   (`child_env`). `tests/no_secrets_in_process_env.rs` holds this.

3. **The webview, under CSP.** `script-src 'self'` plus a pinned hash, and no
   `eval`. Model output is rendered as escaped React nodes, never as HTML. A
   URL becomes a link only if it passes `safeExternalUrl`, and leaves the app
   only through `open_external_url`, which re-checks it in Rust.
   `tests/csp.rs` and `src/test/external-link.test.tsx` hold this.

4. **The disk.** Every command that reads a path resolves it and proves it sits
   under an allowed root (`path_confinement`). No command accepts a place to
   *write*: the two that used to now open the native picker in Rust, so there
   is no destination to forge. `tests/path_confinement.rs` and
   `tests/ipc_write_paths.rs` hold this.

5. **The network.** Every HTTP client comes from one factory, and every host
   the binary can reach is a declared constant with a stated reason.
   `tests/egress.rs` holds this, and Settings › Privacy shows the same list to
   the user.

## In scope

- **A hostile model response.** Everything a model returns is untrusted input:
  markdown links, chat-block payloads, tool-reported artifact paths, MCP
  sign-in URLs. None of them can execute script, navigate the app away, or name
  a file outside the workspace.
- **A hostile import.** A pasted link is fetched, never scraped: HTTPS only,
  with a DNS preflight that requires every resolved address to be public, so an
  import cannot be pointed at `169.254.169.254` or a machine on the LAN.
- **A compromised helper process.** The dictation helper, the system-audio
  helper, and the agent runtime hold no credential and inherit none.
- **A tampered update.** The updater checks a minisign signature against a key
  pinned in the binary, and refuses a version older than the one installed.
- **A local process listing the environment of the backend child.** The
  credentials the child needs arrive on a pipe and are read before it serves
  a single request; its environment names the port and the mode, nothing
  secret.
- **A silent change of destination.** `june_api_url()` has no remote fallback.
  If the local backend is not up, requests fail; they are never redirected
  somewhere else (ADR-0017).

## Out of scope

Named, because a threat model that claims everything protects nothing.

- **An attacker who already runs code as you.** They can read the app's files,
  attach a debugger, and ask the keychain for the key with the app's own
  identity. Nothing in a desktop app survives this, and pretending otherwise
  would be the dishonest part.
- **A stolen or seized unlocked device.** The database is not encrypted at
  rest; full-disk encryption is the assumption (FileVault on macOS, BitLocker
  on Windows, hardware encryption on iOS). See
  [ADR-0039](adr/0039-the-database-is-not-encrypted-at-rest.md) for why, and
  what would change the answer.
- **The endpoint you configured.** Sub Rosa sends your requests to the Carpe
  Diem base you entered. What happens there is Carpe Diem's confidentiality
  story, not this app's — the app's job is to make sure your requests reach
  that endpoint and no other. `validate_base_url` requires `https` for anything
  that is not loopback, so the key does not cross the network in the clear.
- **Traffic analysis.** An observer on your network learns that you contacted
  the base, when, and roughly how much. TLS hides the content, not the shape.
- **The operating system and the hardware.** A malicious OS update, firmware,
  or keyboard is below this app.
- **A same-user process reading another process's memory.** Since
  2026-09-03 the backend child receives the upstream key and the session
  bearer on its standard input (`JUNE_SECRETS_ON_STDIN`), not in its
  environment, so `ps eww` shows neither; `tests/sidecar_secrets_on_stdin.rs`
  holds this. What remains is a process that can read another process's
  memory, which is the "already runs code as you" case above.

## How to check these claims

```
make verify          # the full gate: lint, types, frontend and Rust tests
make audit           # cargo audit + cargo deny on both workspaces
cargo test --manifest-path src-tauri/Cargo.toml \
  --test path_confinement --test ipc_write_paths --test egress \
  --test no_secrets_in_process_env --test no_secret_in_logs --test csp
pnpm vitest run src/test/external-link.test.tsx
```

Each of those files opens with the finding it exists to prevent.

## History

This page was written after a security audit of the app in September 2026. The
audit found no critical vulnerability and three real hardening gaps; the
findings, what they turned out to be worth once replayed against the code, and
what was done about each are recorded in `plan-durcissement.html` at the
repository root.
