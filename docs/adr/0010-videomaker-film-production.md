---
status: accepted
date: 2026-07-11
---

# Film production through Videomaker Studio: direct client + app-managed wallet

> **Fork-only ADR (Sub Rosa).** This decision lives entirely inside the fork
> (`src-tauri/src/videomaker/`, `src/lib/films/`, `src/components/studio/`) and
> does not change June API. Videomaker Studio (`studio.furetier.com`) is a
> first-party service (same owner as this fork), not a third-party dependency.

Sub Rosa exposes end-to-end AI film production (brief → production bible →
assets → shotlist → storyboard → shots → final cut) as a **Film studio**
surface inside the existing Studio view, by driving the Videomaker Studio REST
API (`https://studio.furetier.com/api`) from a fork-owned Tauri module. Three
structural choices:

1. **Direct, typed client in the Tauri process** (`src-tauri/src/videomaker/`),
   not a june-api route and not the generic media proxy.
2. **An app-managed Ethereum wallet** as the Videomaker identity: a secp256k1
   key generated silently on first activation, stored in the OS keychain, used
   only to sign SIWE (EIP-4361) messages. It holds no funds and is never shown
   to, or exportable by, the user.
3. **The user's existing Carpe Diem `cdm_` key is registered with Videomaker**
   (`POST /api/me/key`) after an explicit in-app consent step; all production
   spend bills that key in DIEM. Sub Rosa never handles money itself.

## Why

- **Direct client, not the sidecar.** Same reasoning as
  [ADR-0008](0008-studio-media-proxy-in-tauri.md): june-api is the hottest
  upstream-merge path and its value (metering, prompt custody) does not apply —
  Videomaker meters spend itself against the `cdm_` key and enforces budget
  ceilings server-side. Unlike the media proxy, the surface is *not* a generic
  passthrough: several routes move money (`/produce`, `/retake`, `/runs`), so
  the module exposes **typed commands** with the cost-confirmation handshake
  and idempotency implemented in Rust, plus a read-only allowlisted GET proxy
  for display data. The webview never sees the `vmk_` token, the wallet key, or
  the `cdm_` key.
- **App-managed wallet.** Videomaker accounts are Ethereum addresses (SIWE).
  Sub Rosa users do not have wallets and must not need to know what one is. A
  locally generated identity key gives every install its own Videomaker account
  (which also matches Videomaker's per-wallet limits: 20 projects, 1 production
  daemon). Loss is low-stakes: the wallet holds no funds and Videomaker purges
  idle projects after 7 days, so account continuity across machines is not
  worth a key-export surface (decision: no export/import).
- **Cookie session only for credential management, PAT for everything else.**
  Videomaker deliberately rejects PAT auth on `POST /api/me/key`. The module
  opens a short-lived cookie session (nonce → SIWE sign → `/api/auth/verify`,
  reqwest cookie store, never persisted) exactly when registering or
  re-registering the `cdm_` key, then mints a long-lived `vmk_` PAT
  (`read,write,produce`) for all other calls. A 401 self-heals by re-signing
  with the stored wallet key.
- **SSE watcher, not webhooks.** Videomaker webhooks require a public HTTPS
  endpoint; a desktop app has none. A Rust task per active project consumes
  `GET /api/projects/{slug}/events/stream`, re-emits Tauri events to the
  webview, reconnects with backoff (re-fetching `/status` on each reconnect),
  and falls back to polling. Active project slugs are persisted so watchers
  resume on app start — production continues server-side while the app is
  closed, and the final film is auto-downloaded into the Studio artifacts
  gallery on completion (Videomaker's 7-day TTL makes prompt download
  load-bearing, not a nicety).

## Alternatives rejected

- **A webview onto studio.furetier.com** — no gallery/agent integration, a
  second onboarding (wallet + manual key paste), foreign UX inside the app.
- **Proxying through june-api** — adds fork-only lines to the upstream-sync
  hot path for zero metering/custody benefit (see ADR-0008).
- **Reusing the generic `carpe_diem_media_request` proxy** — wrong host, wrong
  auth (bearer `vmk_`, not `cdm_`), and money-moving POSTs must not be
  reachable from the webview behind a generic passthrough.
- **Shipping Videomaker's official MCP server as the only integration** — the
  MCP cannot read the app keychain, and film production deserves a first-class
  surface, not a chat-only one. (A thin built-in MCP for Hermes *wraps* the
  same Rust module later; it does not replace the UI.)
- **User-managed wallet (paste a private key / connect a wallet)** — hostile
  onboarding for zero benefit; the wallet is identity, not custody.

## Trade-offs accepted

- A second fork-scoped exception to June's "all AI calls go through June API"
  boundary, confined to `src-tauri/src/videomaker/` (the first is ADR-0008).
- New crypto dependencies in the desktop binary (`k256`, `sha3`) solely for
  EIP-191 signing and EIP-55 checksumming (~150 LOC, test-vectored). Full
  ethers/alloy stacks were rejected as dead weight.
- The `cdm_` key is stored (encrypted) by Videomaker server-side. Accepted
  because the service is first-party and consent is explicit; the settings UI
  recommends a dedicated, limited-balance key and offers deactivation
  (delete the server-side key + revoke the PAT).
- Desktop-only (`#[cfg(desktop)]`): the surface targets macOS + Windows. The
  module avoids subprocesses and desktop-only APIs so a later mobile port is
  possible (it would need the mobile `generate_handler!` list + UI work).

---

**Addendum, 2026-08-24.** Superseded by
[ADR-0029](0029-film-production-is-local.md): film production moved into the
app and the remote studio was removed. The reasoning below is kept as the
record of why it was built that way.
