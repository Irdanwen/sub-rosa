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
