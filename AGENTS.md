<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

# Sub Rosa — fork of June (read this first)

This repo is **Sub Rosa**, a rebranded fork of June (`open-software-network/os-june`, MIT)
wired for **Carpe Diem**. The June instructions below still describe the shared architecture
accurately — read them, but apply these fork overrides:

- **Product = Sub Rosa.** Bundle id `xyz.carpediem.subrosa`, deep-link scheme `subrosa://`.
  User-visible copy is "Sub Rosa", not "June". Technical identifiers stay upstream
  (`june-api` crate, `JUNE_*`/`OS_JUNE_*` env vars, `june://` events, `os-june:*` storage keys).
- **The Carpe Diem sidecar is the core of the fork.** The desktop does **not** call a hosted
  June API and does **not** use OS Accounts. At launch the app spawns `june-api` as an
  internal **sidecar** on a free loopback port with a random bearer token, pointed at Carpe
  Diem (an OpenAI-compatible endpoint — same model ids as Venice) using the user's `cdm_` key
  from the OS keychain. It re-points the June client via in-process env (`JUNE_API_URL`,
  `OS_JUNE_LOCAL_DEV*`). All fork logic lives in `src-tauri/src/carpe_diem/` (branding,
  keychain settings + IPC, the sidecar manager), `src/lib/branding.ts`, and
  `src/components/{carpe-diem/, settings/CarpeDiemSettings.tsx}`.
- **Onboarding = paste base_URL + `cdm_` key** (no `.env`, no sign-in). A first-run gate
  blocks the app until a key is stored. In debug, inject the key with
  `SUBROSA_DEV_API_KEY=cdm_… pnpm tauri:dev` (dev-only keychain bypass).
- **Read [`FORK_NOTES.md`](FORK_NOTES.md)** (every upstream file the fork modified + how to
  re-merge, plus product decisions like the curated-model-set and the macOS Hermes/helper
  signing) and **[`HANDOFF.md`](HANDOFF.md)** (signing/updater secrets) before touching
  branding, the sidecar, or the release pipeline.
- **Releases + updates.** Source repo: `Irdanwen/sub-rosa` (public → free CI). Tagging
  `vX.Y.Z` runs `.github/workflows/release.yml`: signed **and notarized** macOS (aarch64 +
  x86_64, x86_64 cross-compiled on Apple Silicon) + unsigned Windows NSIS + Tauri updater
  artifacts, published to the **public** `Irdanwen/sub-rosa-releases` (the updater endpoint).
  Notarization requires deep-signing the bundled Hermes runtime + the Swift helpers (see the
  signing steps in the workflow). Bump the version by editing `tauri.conf.json`,
  `src-tauri/Cargo.toml`, and `package.json` by hand — `scripts/bump-version.mjs`'s
  `import.meta.url` guard breaks on the space in the "Sub Rosa" path.
  `.github/workflows/upstream-sync.yml` opens PRs to track upstream June.
- **Non-goals (unchanged from June):** OS Accounts, billing, hosted June API, TEE attestation
  of the local backend. Local mode only; confidentiality comes from Carpe Diem's own backend.
- **Product autonomy is enforced, not just intended
  ([ADR-0017](docs/adr/0017-product-autonomy-from-june.md)).** Nothing the user sees names
  June or Open Software, and the binary contacts none of their infrastructure: OS Accounts
  is deleted (`os_accounts.rs` is a local-session shim kept at that path on purpose), the
  Hermes SOUL identifies as Sub Rosa and attributes TEE guarantees to Carpe Diem rather
  than restating them, `june_api_url()` has no remote fallback and fails closed, and
  `/verify` describes the loopback sidecar. `repository-hygiene.yml` fails any PR that
  reintroduces `opensoftware.co`, `os-june-releases`, `You are June` or `made by Open
  Software` outside its allowlist — when an upstream sync trips it, drop the change rather
  than adopting it or widening the allowlist.

## iOS app (fork addition, 2026-07-05)

Sub Rosa also ships an **iPhone app** from this repo (Tauri 2 iOS target, Xcode project
committed under `src-tauri/gen/apple/`). Full architecture + upstream-diff table: the
"Portage iOS" section of [`FORK_NOTES.md`](FORK_NOTES.md). The essentials:

- **No subprocesses on iOS**, so the sidecar runs **in-process**: the june-api composition
  root lives in `june-api/crates/embed/` (`june-embed`, `config.toml` baked in via
  `include_str!`), and `carpe_diem/sidecar.rs` has two backends — `#[cfg(desktop)]` spawns
  the binary (unchanged), `#[cfg(mobile)]` runs `june_embed::serve` on a tokio task. Same
  env-var contract, same `/livez`, same status events.
- **No Hermes on mobile.** The chat is **agent-lite** (`src-tauri/src/agent_lite/`): a tool
  loop over the chat-completions proxy with `search_notes` (local SQLite retrieval) and
  `web_search`. Sessions share the desktop's `agent_tasks`/`agent_messages` tables.
  Desktop-impossible surfaces (system audio, HUDs, tray, global hotkeys, updater) are
  `#[cfg(desktop)]`-gated in `src-tauri/src/lib.rs`.
- **Two `generate_handler!` lists in `lib.rs`** (desktop = 12-space indent, mobile =
  8-space): the macro can't cfg individual entries, so **every new shared command must be
  added to both**. Capability files under `src-tauri/capabilities/` must keep their
  `platforms` field — tauri-build validates all of them for the iOS target.
- **Audio**: cpal records on iOS once `audio/ios_session.rs` configures AVAudioSession
  (permission prompt included); `UIBackgroundModes: audio` keeps lock-screen recording
  alive. Native iOS bridges: `photos_ios.rs` (save to photo library), `share_ios.rs`
  (share sheet for note export).
- **Background work is durable rows, never long-lived tasks**
  ([ADR-0018](docs/adr/0018-ios-background-work-is-durable-rows.md)). iOS freezes the
  webview and suspends the process, so **nothing long may live in a JS promise or a bare
  tokio task** — in particular, never add a polling loop under `src/lib/studio/`. Anything
  that can outlast a foreground session writes a row first (`notes`, `media_jobs`,
  `pending_dictations`, `agent_tasks`), and `crate::background::sweep` re-drives all of
  them on cold launch, on `Resumed`, and from the BGTaskScheduler launch handlers
  registered in `ios_background.rs` (whose identifiers must match
  `BGTaskSchedulerPermittedIdentifiers` in the Info.plist). Long work holds an
  `ios_background::BackgroundTask` guard for the grace window; whether a row is *live* is
  an in-process question (`domain::processing::is_processing`, agent-lite's `TurnClaim`),
  never a database one, or a warm resume double-runs it. Studio's poll, download and
  "it's ready" notification live in `carpe_diem/jobs.rs`; the webview only queues and
  observes.
- **Mobile shell**: `src/main.tsx` picks `MobileApp` (`src/app/mobile/`, screens in
  `src/components/mobile/`) via `isMobilePlatform()`; `?mobile=1` forces it in a browser.
  Desktop `App.tsx` is untouched. Shared pieces reused: `notesReducer`, `src/lib/tauri.ts`,
  `NoteEditor`, `CarpeDiemSettings`, the whole `src/lib/studio/` lib (incl. the workflow
  engine, rendered as guided "Flows" instead of the canvas).
- **iOS gallery caveat**: never persist absolute paths — the app's data container path
  changes across reinstalls (`listArtifacts` re-derives paths from the disk listing; the
  asset protocol doesn't resolve in the iOS webview, media renders via base64 data URLs).
- **Dev loops**: simulator `pnpm tauri ios dev "iPhone 17 Pro"`; inject a key with
  `SIMCTL_CHILD_SUBROSA_DEV_API_KEY=cdm_… xcrun simctl launch booted xyz.carpediem.subrosa`.
  Device: `pnpm tauri ios dev "iPhone de Morgan" --host` (vite must NOT be pinned to
  127.0.0.1 — the `dev` script honors `TAURI_DEV_HOST`). Standalone install:
  `pnpm tauri ios build --export-method debugging` then
  `xcrun devicectl device install app --device <id> ".../gen/apple/build/arm64/Sub Rosa.ipa"`.
  Signing uses `bundle.iOS.developmentTeam` in `tauri.ios.conf.json` (team `H6N5V777LL`);
  regenerating `gen/apple` (`tauri ios init`) wipes the Info.plist additions (microphone,
  `UIBackgroundModes`, photo library) — re-apply them.
- **iOS checks**: `cargo check --target aarch64-apple-ios --lib` (and `-sim`) must stay
  green next to the desktop checks; toolchain ≥ 1.95 (june-api workspace pin).

## Cross-conversation memory (fork addition, 2026-07-10)

Sub Rosa remembers durable facts about the user across conversations, on both
shells (shipped in v1.4.0). Design + rejected alternatives:
[`docs/adr/0009-local-cross-conversation-memory.md`](docs/adr/0009-local-cross-conversation-memory.md);
re-merge checklist: the memory entries in [`FORK_NOTES.md`](FORK_NOTES.md). The
essentials for anyone touching chat, prompts, or the DB:

- **Store**: the `memories` table (migration `010_memory.sql`, repository
  methods in `db/repositories.rs`). All writes go through the Rust process —
  the `june_context` MCP reads the same SQLite file read-only, never write to
  it from Python. Migration comments must contain **no semicolons**
  (`run_migrations` splits statements on `;`).
- **Module**: `src-tauri/src/memory/` — `mod.rs` (settings `memory.json`:
  `enabled`/`auto_extract`, CRUD commands, the shared `prompt_block`),
  `extract.rs` (every-3rd-assistant-reply extraction over the last 5+5
  messages; importance 1-10 where LOWER is more important, > 8 discarded),
  `recall.rs` (BGE-M3 embeddings via a **direct Carpe Diem `/embeddings`
  call** — the ADR-0008 pattern, NOT the sidecar — f32 LE blobs, hybrid
  LIKE + cosine merged with RRF, keyword-only fallback when offline).
- **Injection seams** (don't invent new ones): desktop = the `user_memory`
  param of `sync_june_soul` in `hermes_bridge.rs` (written at Hermes spawn, so
  mid-session facts land next start); mobile = `build_system_prompt` in
  `agent_lite/mod.rs` (rebuilt every turn). On-demand recall beyond the
  injected top-20: `search_user_memories` in `june_context_mcp.py` (withheld
  via the `--memory=off` argv when the master toggle is off) and the
  `search_memories` agent-lite tool.
- **Extraction triggers**: mobile is a Rust post-turn hook
  (`maybe_extract_after_agent_lite_turn`); desktop transcripts live in Hermes,
  so the trigger is the frontend (`src/lib/memory.ts`,
  `noteAssistantTurnCompleted` wired into AgentWorkspace's terminal-event
  handler) calling the `memory_extract` command. Keep the cadence/window
  constants in `src/lib/memory.ts` in sync with `memory/extract.rs`.
- **Everything is best-effort**: extraction, embedding backfill, and recall
  failures log and degrade — they must never break a chat turn or surface as
  UI errors.
- **UI**: Settings › Memory (`MemorySettingsSection.tsx`; the tab must exist
  in BOTH `AppSettings.tsx` and `SETTINGS_SIDEBAR_GROUPS` in `Sidebar.tsx`)
  and the mobile Settings section (`components/mobile/MemorySettings.tsx`).
  Disabling memory stops using it but never deletes; deletion is the explicit
  "forget" actions only.
- **Vocabulary**: "memory (user memory)" is a CONTEXT.md term — distinct from
  Hermes' own memory *directory*. Memory commands are shared commands: any new
  one goes in **both** `generate_handler!` lists.

## Imports and long-form summaries (fork addition, 2026-08-23)

Sub Rosa can turn something it did not record — a dropped file, a podcast, a
conference video — into an ordinary note, and read a long transcript the way a
reader wants rather than the way a meeting note-taker does. Three ADRs carry
the decisions; read them before touching any of it:
[ADR-0026](docs/adr/0026-imported-media-is-decoded-in-process.md) (decoding),
[ADR-0027](docs/adr/0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)
(summarizing), [ADR-0028](docs/adr/0028-import-links-are-fetched-never-scraped.md)
(fetching). The essentials:

- **No ffmpeg, ever, and no bundled downloader.** `src-tauri/src/audio/decode.rs`
  decodes containers in-process with Symphonia and writes the 16 kHz mono WAV
  the pipeline already wants, streaming, so a three-hour file costs the same
  memory as a three-minute one. Opus and HE-AAC are genuinely unsupported —
  say so, do not paper over it. Anything undecodable falls back to the
  pre-existing whole-file transcription route.
- **An import is a note.** No new product noun, no second surface. The moment
  it has a transcript it is searchable, readable by the agent, and eligible for
  memory extraction like any other note. `ingests` is the durable row for the
  steps *before* transcription only (ADR-0018 applies); `ProcessingStatus`
  gains nothing.
- **Vocabulary is tight and already collided once.** "media" means Studio's
  generated media (`media_jobs`, `carpe_diem/media.rs`), never an import;
  "source" is an audio lane, never a thing you imported. The nouns are
  **import** (the note), **ingest** (the work), **import link** (the URL),
  **long-form summary**, **chapter**. See the "Imports (fork)" section of
  [CONTEXT.md](CONTEXT.md).
- **The long-form summary is fork-side.** `src-tauri/src/longform/` talks to
  `/v1/chat/completions` through the sidecar with its own prompt and its own
  prompt version. **Do not add a route or a prompt to `june-api/` for it** —
  every line there is a line `upstream-sync.yml` re-merges forever. It applies
  to any long transcript, not only to imports. It lives on its own
  `note_summaries` row, resumes part by part, and is cancelled by deleting that
  row.
- **Published captions beat paid transcription.** When the extractor rail finds
  captions, `ingest/vtt.rs` turns their cues into turn rows and
  `process_captioned_import` skips transcription entirely — free, and the
  chapters keep their timings. The rail picks an M4A/MP3 stream with a
  **format selector**, never `-x --audio-format`: Symphonia cannot decode Opus
  (which these platforms serve by default), and converting would need an
  ffmpeg this app does not ship and the user may not have.
- **The app owns the clock.** A map pass returns chapter headings tagged with a
  turn index it was handed; the app resolves the index to `start_ms`. Never ask
  the model for a timestamp, and clamp an out-of-range index rather than
  trusting it.
- Import and long-form commands are shared commands: every new one goes in
  **both** `generate_handler!` lists in `lib.rs`. `src-tauri/tests/shared_commands.rs`
  now fails the build when a command lands in only one of them, so a
  genuinely platform-bound command has to say so there.

---

# June — Agent Instructions

## Project

June is a private-by-architecture **Tauri desktop app** for meeting notes: it
records a meeting or dictation, transcribes the audio, turns the transcript
into a structured note, and hosts an AI agent you can chat with over your
notes. The frontend is **React** (`src/`), the native shell is **Rust**
(`src-tauri/`), and a confidential **Rust backend, June API** (`june-api/`),
proxies all upstream AI and runs metered billing. Identity and credits come
from **OS Accounts**; the agent brain is an embedded, pinned build of the
**Hermes** runtime; AI models are served through **Venice**. June API runs
inside a TEE (Phala) so prompt data is not readable by its own infra.

> Read **[CONTEXT.md](CONTEXT.md)** before naming anything, and
> **[docs/index.md](docs/index.md)** to find the doc for the area you touch.

## Structure

```
os-june/
├── src/                     # React frontend
│   ├── app/                 # app shell, routing, update-decision
│   │   └── mobile/          # (fork) iPhone shell: MobileApp + tab/stack navigation
│   ├── components/          # agent (chat), settings, account, onboarding, note-editor, recorder, sidebar, ...
│   │   └── mobile/          # (fork) mobile chrome + screens (notes, dictation, chat, studio, flows)
│   ├── lib/                 # hermes-gateway, hermes-control-plane/, model-privacy, tauri bindings, ...
│   ├── styles/              # app.css + tokens.css (design tokens) + mobile.css (fork)
│   └── test/                # vitest suites (all frontend tests live here)
├── src-tauri/               # Rust native shell (Cargo package `os-june`)
│   ├── src/audio/           # recording, source separation, turn detection, live preview (+ ios_session.rs)
│   ├── src/hermes_bridge.rs # spawns + sandboxes the embedded Hermes agent runtime (desktop only)
│   ├── src/agent_lite/      # (fork) mobile chat: tool loop over chat completions, no Hermes
│   ├── src/memory/          # (fork) cross-conversation user memory: settings, extraction, hybrid recall
│   ├── src/os_accounts.rs   # OS Accounts login (PKCE), keychain token store
│   ├── src/providers/       # model-settings persistence
│   ├── src/commands.rs      # the Tauri command surface
│   ├── native/              # macOS system-audio helper (Swift) + dictation helper
│   └── gen/apple/           # (fork) committed iOS Xcode project (Info.plist, entitlements)
├── june-api/                # Rust backend (Cargo workspace, crates prefixed `june-`)
│   └── crates/              # domain / services / providers / config / api / app / embed  (hexagonal)
├── docs/                    # see docs/index.md — ADRs, subsystem docs, runbooks, PRDs, QA
├── specs/                   # Spec Kit feature specs (001-003)
├── spec/                    # enforceable coding rules (see spec/index.md) — distinct from specs/
├── scripts/                 # build / dev / release tooling
├── CONTEXT.md               # domain glossary — canonical names
├── AGENTS.md                # this file (canonical); CLAUDE.md is a symlink to it
└── .agents/skills/          # vendored agent skills, symlinked into .claude/skills/
```

## Domain & decisions — read before writing code

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary / ubiquitous language.
  Read before naming anything; terms are canonical and the `_Avoid_` lists are
  binding (dictation vs note transcription, Source vs channel, Hermes vs "the
  model", credit price vs cost, stored vs runtime session id).
- **[docs/index.md](docs/index.md)** — the annotated index of every doc: ADRs,
  subsystem docs, release/ops runbooks, PRDs, QA, and the feature specs.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read the ADRs for
  the area you are touching before proposing structural change; **do not
  re-litigate accepted decisions.** Append-only: supersede with a new ADR (or a
  dated addendum), never rewrite the decision. Numbering: scan `docs/adr/` for
  the highest `NNNN-*.md` and increment.
- **[specs/003-conversation-turns/plan.md](specs/003-conversation-turns/plan.md)**
  — the current feature spec; its plan doubles as the tech-stack and
  shell-command reference for new agents.

### When to add an ADR (proactive)

Record a decision as an ADR when **all three** hold:

1. **Hard to reverse** — real cost to change later (architectural shape, an
   integration/wire contract, tech lock-in, a boundary).
2. **Surprising without context** — a future reader will ask "why on earth is
   it done this way?".
3. **A real trade-off** — genuine alternatives existed and one was chosen for
   specific reasons.

Skip it if the change is easily reversible, the obvious choice, or had no real
alternative. Offer an ADR proactively (do not wait to be asked) when you reject
a refactor for a load-bearing reason, deviate deliberately from the obvious
path, or encode a constraint not visible in the code. If you sharpen or add a
domain term mid-discussion, update **CONTEXT.md** in the same change.

## Specs (enforceable rules)

Enforceable coding rules live in **[spec/index.md](spec/index.md)**, one file
per rule (Rule / Why / How to apply / Exceptions). **Read every spec in your
scope before writing code; violations should fail review.** When you add,
rename, or remove a spec, update `spec/index.md` in the same commit. (These are
distinct from the `specs/` Spec Kit feature specs.)

- [sentence-case](spec/sentence-case.md) — sentence case for all UI labels (never ALL CAPS / uppercase)
- [no-typographic-dashes](spec/no-typographic-dashes.md) — no en/em dashes in user-facing copy (hyphen or "to")
- [icons-central-only](spec/icons-central-only.md) — icons from `central-icons` / `central-icons-filled` only (never lucide)
- [design-tokens](spec/design-tokens.md) — use the variables in `src/styles/tokens.css`

## PR and description conventions

When drafting PR titles, PR descriptions, issue summaries, release notes, or
other project copy, avoid naming or comparing against other products unless the
user explicitly asks for that context or the reference is required for a
concrete integration, compatibility note, migration, or legal attribution.
Prefer describing the behavior, workflow, or category generically.

Every PR description should state (the template in
`.github/pull_request_template.md` has these sections):

- whether the change was **tested visually** — for UI changes, attach a
  screenshot or recording;
- whether it **needs a June API (backend) deploy** to work end to end (a desktop
  change that depends on an unshipped June API change will not work until June
  API is deployed);
- the **root cause**, for bug fixes (the actual cause, not just the symptom);
- what is deliberately **out of scope**;
- any **followups** it sets up or defers (link issues where possible).

## Skills

Vendored agent skills live in **`.agents/skills/`** (the single source of truth)
and **every skill is symlinked into `.claude/skills/`**. A skill must never exist
only under `.claude/`, and a `.claude/skills/<name>` entry must always be a
symlink to `../../.agents/skills/<name>` — never a real directory. Add a new
skill under `.agents/skills/<name>/` and create the `.claude/skills/<name>`
symlink in the same change. Current project skills: `os-platform`,
`os-accounts-integration`, `os-rust-backend`, `os-rust-backend-ci`,
`os-task-prep`, `repo-build-pr`, `browser-test-tauri-fe`, `agent-e2e-qa`, plus
the Spec Kit workflow skills (`speckit-*`). `make skills-update` /
`skills-restore` / `skills-sync` (thin wrappers over `npx skills`) refresh,
restore from the lockfile, or re-link them.

## Build, test, lint

Package manager: `pnpm` (a `bun.lock` also exists; the scripts are
runner-agnostic).

- **Run the app:** `pnpm tauri:dev` (builds `src-tauri` and launches the native
  app; the first build is slow). `pnpm dev` runs the Vite frontend only.
- **Frontend tests:** `pnpm test` (vitest; all suites live in `src/test/**`).
  The runner can exit non-zero from `hud-meeting.test.ts` teardown noise despite
  0 real failures — judge by the failure count. Composer/ProseMirror tests can
  flake with a `localsInner` crash under machine load (a `@tiptap/pm` duplicate,
  not a regression).
- **Rust tests:** `pnpm test:rust` (src-tauri) and `pnpm test:june-api` (the
  backend workspace).
- **Hermes pin gate:** `pnpm test:hermes-smoke` + `pnpm hermes:upgrade-check`
  before bumping the pinned Hermes runtime (see
  [docs/hermes-upgrade-checklist.md](docs/hermes-upgrade-checklist.md)).
- **Lint / format:** `pnpm check` (Biome: format + lint for `src/` and
  `scripts/`, including the lucide import ban) and `pnpm typecheck`
  (`tsc --noEmit`); `pnpm format` / `pnpm check:write` apply Biome fixes. Rust
  uses `cargo fmt` / `cargo clippy` (config lives under `src-tauri/` and
  `june-api/`). Biome ratchets high-volume retrofit rules (a11y, hook-deps,
  non-null assertions) to `warn` in `biome.json`; keep new code clean and fix
  the warnings incrementally. Never leave checks broken.
- **CI parity:** `make verify` runs the full gate locally (Biome, typecheck,
  vitest, and `cargo fmt`/`clippy`/`test` for both Rust crates); `make help`
  lists every target. A green `make verify` should mean green CI.

## Boundaries

- **Upstream provider keys live only in June API, never in the desktop binary.**
  The app calls June API over `/v1/*`; June API holds the Venice/OpenAI keys and
  the OS Accounts App API key.
- **June API must stay backward-compatible — no breaking changes.** June ships
  and auto-updates in production, so installs in the wild keep calling older
  `/v1/*` contracts. Never remove or repurpose an existing endpoint, request
  field, or response shape; add new optional fields or new endpoints instead. A
  breaking API change strands every app version that has not updated yet.
- **June presents as June, never as Hermes.** The embedded runtime is an
  implementation detail; an injected `SOUL.md` asserts June's identity.
- **Identity and credits are OS Accounts'.** June is an on-device client of OS
  Accounts and never owns user or wallet state. The dependency arrow points
  June → OS Accounts, never the reverse.
