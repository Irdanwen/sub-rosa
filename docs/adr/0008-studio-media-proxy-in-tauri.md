---
status: accepted
date: 2026-07-04
---

# Studio media calls go through a fork-owned Tauri proxy, not June API

> **Fork-only ADR (Sub Rosa).** This decision lives entirely inside the fork's
> `src-tauri/src/carpe_diem/` module and does not change June API.

The Studio views (image, video, music, workflows) call the media surface of the
configured backend (Carpe Diem for `cdm_` keys, Venice direct otherwise) through
**one generic, allowlisted proxy command in the Tauri process**
(`src-tauri/src/carpe_diem/media.rs`, `carpe_diem_media_request`), plus a merged
catalog command and on-disk artifact commands. They do **not** go through the
`june-api` sidecar, and the webview never sees the API key.

## Why

- **Upstream drift.** `june-api` is synced weekly with upstream June
  (`upstream-sync.yml`). The media surface is ~15 endpoints (generate, edit,
  upscale, three async queue/retrieve trios, speech, styles, quotes); modeling
  each one through June API's four layers (domain trait, service, provider,
  handler) would put hundreds of fork-only lines into the hottest merge paths.
  The fork's stated architecture concentrates fork logic in
  `src-tauri/src/carpe_diem/` — the proxy adds exactly one file there plus
  registration lines.
- **The sidecar adds nothing on this path.** June API's value is metering,
  auth, and prompt ownership for June's own features. Studio calls are
  passthrough JSON with the same key the Tauri process already holds (it spawns
  the sidecar with it); interposing the sidecar would only add a hop and a
  second place to keep wire shapes.
- **Key custody is unchanged.** The `cdm_` key stays in the OS keychain, read
  by Rust per request. The proxy enforces a strict path allowlist (`/models`,
  `/image/*`, `/video/*`, `/audio/*`, `/chat/completions` for workflow chat
  nodes) so the webview cannot reach key-management or account endpoints, and
  the bearer is only attached to downloads on the backend's own host.
- **Constraints need a second catalog anyway.** Carpe Diem's `/v1/models` has
  no generation constraints; the proxy's catalog command merges it with
  Venice's public catalog (identical model ids, verified 283/283 on
  2026-07-04) and Carpe Diem's public `/pricing`. That cross-backend merge has
  no natural home in June API's Venice provider.

## Trade-off

- The desktop process now speaks to the media backend directly, so June's
  "all AI calls go through June API" boundary has a fork-scoped exception.
  Accepted because the fork already routes key custody and sidecar spawning
  through `carpe_diem/`, and the exception is confined to that module.
- Workflow chat nodes call `/chat/completions` through the proxy rather than
  the sidecar, duplicating the transport (not the contract) of the agent path.
  Accepted to keep the Studio self-contained; revisit if the two paths ever
  need shared metering.
