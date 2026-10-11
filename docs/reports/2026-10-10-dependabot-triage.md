# Dependabot and stale PR triage (2026-10-10, audit W7)

State of every open dependency PR and of the two stale branches named in the
audit (finding M9), with what each one waits on. CI status was read from
`gh pr checks` on 2026-10-10; re-check before acting, because the base moves.

## Already acted on during the audit

Before the release-wave rule ("merge and close in the release wave only")
reached this package, five actions were taken on GitHub:

| PR | Action | Why |
|---|---|---|
| #295 rustls 0.23.44 to 0.23.45 (`subrosa-cloud`) | merged (90fe3907) | patch, rebased, all checks green; closes alert #38 (TLS 1.3 handshake) |
| #312 cargo minor/patch group (`june-api`: clap, thiserror, tokio, zeroize) | merged (cb02dd8d) | patch group, all checks green, `june-api/Cargo.lock` only |
| #313 cargo minor/patch group (`src-tauri`: tauri 2.11.6, tokio, uuid, cc...) | merged (a50646d5) | minor/patch group, all checks green (clippy, tests, iOS, Windows), `src-tauri/Cargo.lock` only |
| #126 website 1.65.0 downloads | closed | superseded: `website/src/releases.json` on main lists v1.89.0 |
| #305 pdfjs-dist 6 in `/website` | closed | duplicate of #306 without the shared `pnpm-lock.yaml` (`ERR_PNPM_OUTDATED_LOCKFILE`) |

#209 and #230 (the older cargo groups) were closed by Dependabot itself when
asked to rebase, and replaced by #312 and #313.

## Open: minor and patch

| PR | CI | Verdict |
|---|---|---|
| #307 npm minor/patch group (26 updates) | red: Biome check | Hold. Biome 2.5.15 adds `noDescendingSpecificity` errors across `website/src/style.css`. The group also moves `@tauri-apps/api` and `@tauri-apps/cli` to 2.12 while the `tauri` crate is on 2.11.6; the npm package and the crate must share a minor, so take the 2.12 JS packages together with `tauri` 2.12 in `src-tauri/Cargo.toml`, or exclude the Tauri packages from the group. |
| #119 actions group | red: every Rust job | Close once `fix/audit-w7` lands. Dependabot moved `dtolnay/rust-toolchain` to the head of `master`, which needs a `toolchain` input; the branch pins setup-java v5.7.0 and setup-android v4.0.4 (node24) by SHA instead and makes Dependabot ignore `dtolnay/rust-toolchain`. |

## Open: majors (merged by hand only)

| PR | CI | Waits on |
|---|---|---|
| #100 vitest 3.2.7 to 4.1.11 | red | `@vitest/coverage-v8` must move to 4.x with it (the coverage run crashes in 3.2.7, `fetchCache`); `src/test/recording-sounds.test.ts` fails 4 tests; two mock typings fail `tsc` (`app-meeting-start.test.tsx:275`, `hermes-session-compress.test.tsx:74`). Worth doing soon: it closes alerts #26 to #28 and drops tinypool, which makes the `tinypool` override on `fix/audit-w7` removable. |
| #96 framer-motion 12 to 13 | green, conflicting | Rebase (`@dependabot rebase`), then walk the animated surfaces of the eight files that use it; jsdom runs no animation, so green tests prove little. Peers still accept React 18. |
| #306 pdfjs-dist 5.7 to 6.2 (`website`) | green | High-severity advisory (alerts #39, #40): should not wait long. The tests swap out `pdfJsReader` (`website/src/client/documents/read.ts`), so green CI does not prove a PDF opens: read a real PDF in the web client on this branch, then merge. |
| #94 typescript 5.9 to 7.0 | red | TS 7 has no JavaScript compiler API; `scripts/i18n/*.mjs` use `ts.createSourceFile` and `ts.ScriptTarget.Latest`. Needs another parser, or `typescript@5` kept for the tooling. |
| #95 @vitejs/plugin-react 4 to 5 | green | Changelog review, then hot reload checked on the desktop shell and the website. |
| #97 base64 0.22 to 0.23 | green | Breaking under 0.x; read the changelog for engine and padding changes (sync blobs, data URLs). |
| #98 symphonia 0.5 to 0.6 | red | Port `src-tauri/src/audio/decode.rs` and `track_shape.rs` to the new probe and codec APIs (ADR-0026). |
| #99 quick-xml 0.41 to 0.42 | red, conflicting | Port the readers in `voice/requests.rs`, `assistants/references.rs`, `ingest/feed.rs`, `finance/camt.rs`, `deliverables/tests_support.rs`. |
| #106 aes-gcm 0.10 to 0.11 | red | `Nonce::from_slice` is deprecated (clippy `-D warnings`): move `account/crypto.rs` and `account/spaces/protocol.rs` to `TryFrom`, and decrypt data written by the current release in a test. |
| #167 jsonwebtoken 10 to 11 (`june-api`) | green | `june-api/` is re-merged from upstream; take it when upstream does. |

## Stale branches

| PR | Verdict |
|---|---|
| #126 website 1.65.0 downloads | Obsolete (closed, see above). |
| #122 Carpe Diem key status pill | **Not obsolete**: main's Carpe Diem card in `website/src/pages/account.tsx` still has no status pill, the old empty-state copy and the bare `carpe-diem.xyz` link. It conflicts with the reworked account page; redo it on the current card (after checking that `https://carpe-diem.xyz/key` is still the right page), then close #122. |

## Security updates that Dependabot could not open

- `tinypool` (alerts #35, #36, critical): vitest 3.2.7 asks for `^1.1.1` and
  the fix exists only in 2.1.2, so no in-range update exists. `fix/audit-w7`
  adds `pnpm.overrides.tinypool: ^2.1.2` (2.0 only dropped Node 18; the
  suites pass on it). Remove the override with vitest 4.
- `source-map-js` (alert #37): 1.2.2 is inside `postcss`'s `^1.2.1`, but
  Dependabot runs `pnpm update source-map-js@1.2.2`, which pnpm 9 does not
  apply to a transitive dependency. `fix/audit-w7` refreshes it (and
  `brace-expansion`, alerts #33, #34) in the lockfile.

## Resolution, 2026-10-11

Every PR above was settled; each port was checked against the version it
replaced on real inputs, not only by CI.

| PR | Outcome |
|---|---|
| #316 actions | merged |
| #95 plugin-react 5, #167 jsonwebtoken 11, #97 base64 0.23 | merged after `@dependabot rebase` |
| #96 framer-motion (rebased to 14.0.0) | merged; 14 only removes internal APIs, and the desktop shell, `?mobile=1` and `note-lab.html` render with no new console error (pixel-identical except the random suggestion chips) |
| #306 pdfjs-dist 6 | merged; `pdfJsReader` extracts identical text from 77 pages of real PDFs on 5.7 and 6.2 |
| #106 aes-gcm | #320: `Nonce::from` / `TryFrom`; `account-vault-v1.json` and `spaces-v1.json` (written with 0.10) still hold byte for byte |
| #99 quick-xml | #321: ported; 10 feeds, 3 camt.053 and 11 Office files give byte-identical results; a pre-existing bug found on the way (a feed title with an entity was cut at the entity) fixed in the same PR |
| #317 + #307 | #322: Tauri 2.12 on both sides; the Tauri JS packages take `~` ranges and `tauri-versions.test.ts` holds each npm package on its crate's minor (a caret had resolved `plugin-notification` 2.6 over a 2.5 crate); Biome kept at 2.5.11 and excluded from the group (2.5.12 to 2.5.15 widen `noDescendingSpecificity` from 98 to 386 sites on unchanged CSS); `src-tauri/Cargo.lock` follows jsonwebtoken 11 |
| #94 typescript 7 | #328: TS 7 type-checks root, website and office-addins (same file sets as 5.9); the i18n scripts use a `typescript5` alias for the compiler API |
| #100 vitest 4 | #331: mock typings, an `Audio` mock that must be constructible, an `agent-hud` test that counted microtasks, coverage include scoped to `src/`; frontend floor re-based to 74.7 because v4 counts lines from the AST (80.86 under v3, 74.76 under v4, same tests) |
| #98 symphonia 0.6 | #330: ported; PCM bit-identical to 0.5 on 29 real files once `opt-simd` is left out and Vorbis keeps its trimming; AAC-LC in `.caf` now decodes |
| #122 key pill | merged after a rebase onto the current card, with its sentences in the six catalogs |

Still open: the decision on Biome 2.5.15 (re-baseline that one rule, or
stay), and the majors Dependabot opened on 2026-10-11 (#324
`@simplewebauthn/browser` 14, #325 vite 8, #327 `ed25519-dalek` 3).

