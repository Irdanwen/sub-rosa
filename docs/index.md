# June docs index

Read first, in order: **[CONTEXT.md](../CONTEXT.md)** (domain glossary) →
**[AGENTS.md](../AGENTS.md)** (agent guide) →
**[specs/003-conversation-turns/plan.md](../specs/003-conversation-turns/plan.md)**
(tech stack + structure).

## Architecture & decisions (ADRs)

Append-only; supersede with a new number or a dated addendum, never rewrite the
decision. See "When to add an ADR" in [AGENTS.md](../AGENTS.md).

- [adr/0001](adr/0001-auto-updates-via-tauri-updater.md) — auto-updates via the Tauri updater on a separate public releases repo
- [adr/0002](adr/0002-live-transcript-preview-strategy.md) — live transcript preview as an ephemeral companion, not the source of truth
- [adr/0003](adr/0003-release-candidate-channel-and-promotion.md) — rc channel + promote-to-stable (every stable release starts as an RC)
- [adr/0004](adr/0004-out-of-process-system-audio-helper.md) — macOS system audio via an out-of-process helper (file IPC + Unix signals)
- [adr/0005](adr/0005-source-separated-audio-capture.md) — one WAV per source, re-interleaved as turns
- [adr/0006](adr/0006-embed-hermes-sandboxed-runtime.md) — embed the pinned Hermes runtime as sandboxed child processes
- [adr/0007](adr/0007-model-capability-source-of-truth.md) — model capabilities come from the live Venice catalog, not marketing traits
- [adr/0008](adr/0008-studio-media-proxy-in-tauri.md) — Studio media calls go through a fork-owned Tauri proxy, not June API
- [adr/0009](adr/0009-local-cross-conversation-memory.md) — cross-conversation user memory: local SQLite, prompt-time injection, direct embeddings
- [adr/0010](adr/0010-videomaker-film-production.md) — film production via Videomaker Studio: direct client, app-managed wallet, SSE watcher
- [adr/0011](adr/0011-autonomous-film-run-supervision.md) — autonomous film-run supervision: a deterministic server-side guardian + driver hardening, not an in-app opus agent (phase 1 shipped; watchdog-resume deferred)
- [adr/0012](adr/0012-upstream-rate-limit-distinct-from-provider-failure.md) — upstream 429 rate limits become a distinct, retryable `upstream_rate_limited` error + "busy, retry / switch model" notice, not an opaque 502
- [adr/0013](adr/0013-mid-conversation-model-switching.md) — mid-conversation model switching: the model is a per-turn property; continuity via in-place switch + retry + fork-onto-another-model, not a live Hermes `/model` rebind
- [adr/0014](adr/0014-per-session-working-folder.md) — per-session working folder: a validated Seatbelt write grant + restart-on-mismatch routing, not process-per-folder or an unvalidated cwd grant
- [adr/0015](adr/0015-normalize-carpe-diem-router-responses.md) — june-api normalizes the Carpe Diem `/router` rail (null content + non-streamed JSON) into the Venice/OpenAI SSE contract instead of collapsing a 200 into a 502; a successful upstream never becomes a client-facing error
- [adr/0016](adr/0016-session-activity-comes-from-the-runtime.md) — only the runtime (`session.active_list`) or a terminal gateway event ends a run; the persisted transcript is a one-directional fallback, because an agent loop persists an assistant row at every step
- [adr/0017](adr/0017-product-autonomy-from-june.md) — the fork cuts every product-level dependency on June (identity, accounts, coordinates, release CI) but keeps upstream's technical identifiers, so cherry-picking upstream fixes keeps working; a CI guard enforces it
- [adr/0018](adr/0018-ios-background-work-is-durable-rows.md) — iOS freezes the webview and suspends the process, so anything that can outlive a foreground session writes a durable row first and is re-driven by one sweep (launch, resume, BGTaskScheduler); locking the phone costs time, never a result
- [adr/0019](adr/0019-shot-chains-are-parent-links.md) — a shot chain is never stored as a sequence: each clip records the one it continues (and where it took over) on its durable row, and the chain is derived, so it survives a render that outlives the session, a deleted clip, and a re-generation that forks
- [adr/0020](adr/0020-the-gallery-is-the-studio-exchange-format.md) — Studio surfaces exchange images through the gallery rather than through each other: a captured frame is written as an ordinary artifact (so export, edit, and reuse come free) and every image input pulls from the gallery instead of waiting to be pushed at
- [adr/0021](adr/0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md) — a workflow production is durable rows (`workflow_runs` + per-node state), its long renders ride the existing `media_jobs` pollers, and the webview stitches between them: a resume replays finished nodes and re-attaches to in-flight renders by job id, never re-buying either
- [adr/0022](adr/0022-model-inputs-follow-published-constraints.md) — which inputs a media model accepts is read from the constraints the operator publishes (`video_input`, `audio_input`) rather than inferred from its id, so a surface stops offering a reference-clip slot on the public-tier models that refuse clips and starts offering the reference audio they do take
- [adr/0023](adr/0023-cache-telemetry-crosses-the-sidecar-as-headers.md) — the operator reports its prompt-cache split inside `usage`, but the desktop forwards that body to the runtime as a stream, so the sidecar republishes each turn's metering as additive `x-june-*` headers and the shell keeps its own ledger from there; the gateway's session usage can never carry it ; addendum : le tableau de prix ne facture rien dans cette distribution (receipt toujours à 0, jamais lu) et sert en réalité de liste blanche de modèles et de ligne de prix du sélecteur, où le tarif de cache s'affiche désormais
- [adr/0024](adr/0024-chat-blocks-are-in-band-fenced-json.md) — rich cards in assistant replies are `subrosa:*` fenced JSON carried in the message text itself (both renderers intercept, invalid payloads degrade to a code block), with card data flowing through the june-api proxy and outbound clicks through `open_external_url`
- [adr/0025](adr/0025-the-calendar-is-context-on-a-note.md) — the app reads EventKit so a note knows its title, its scheduled time and who was invited, while the specs' exclusion of a calendar surface and a meeting object is honoured exactly: three nullable columns on `notes`, no screen, no second noun, retrieval (`search_calendar`) instead of injection, and a question instead of a guess when two meetings overlap
- [adr/0026](adr/0026-imported-media-is-decoded-in-process.md) — imported audio and video are decoded in-process by Symphonia into the 16 kHz mono WAV the transcription pipeline already wants, streaming so memory is independent of duration, instead of bundling ffmpeg (unsignable, unlicensable, impossible on iOS) or decoding in the webview; the 25 MB whole-file ceiling that made a one-hour import impossible disappears, and imports gain the silence skipping and chunking the recorder had
- [adr/0027](adr/0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md) — a conference or podcast needs the opposite editorial line from `note_generate.md`, so the map-reduce lives in the fork (`src-tauri/src/longform/`) against chat completions rather than in june-api, chunks on turn boundaries with overlap, and has the model tag chapters with a turn index the app resolves to a timestamp — the app owns the clock, the model owns the prose; the result is markdown on its own `note_summaries` row (searchable, resumable part by part, cancellable by deleting the row)
- [adr/0028](adr/0028-import-links-are-fetched-never-scraped.md) — files and published URLs (direct media, RSS enclosures) are fetched with the app's own HTTP client and work on every platform, while streaming-platform pages are reachable only through a `yt-dlp` the user already installed and switched on; no downloader is bundled or reimplemented, captions are preferred over paid transcription, and the fetch is a durable `ingests` row

- [adr/0029-film-production-is-local.md](adr/0029-film-production-is-local.md) — films are produced by the app; the remote studio is removed (supersedes 0010, 0011)
- [adr/0030-a-production-compiles-into-a-workflow.md](adr/0030-a-production-compiles-into-a-workflow.md) — a shot list compiles into the graph the canvas already runs
- [adr/0031-the-timeline-export-is-the-finishing-path.md](adr/0031-the-timeline-export-is-the-finishing-path.md) — FCPXML and xmeml bundles; the recorder is a preview
- [adr/0032-the-bible-is-local-rows-over-gallery-artifacts.md](adr/0032-the-bible-is-local-rows-over-gallery-artifacts.md) — persistent identities as pointers at gallery artifacts
- [adr/0033-the-mix-is-rendered-offline.md](adr/0033-the-mix-is-rendered-offline.md) — deterministic Web Audio mix, BS.1770 loudness, ducking as automation
- [adr/0034-the-council-issues-a-verifiable-mandate.md](adr/0034-the-council-issues-a-verifiable-mandate.md) — several model families read a request blind, the chair issues capped slots with acceptance criteria, one agent executes, the council judges the result (addendum 2026-08-29: the agent's reply is evidence when the work left no files)
- [adr/0035-the-desktop-agent-writes-notes-through-the-app.md](adr/0035-the-desktop-agent-writes-notes-through-the-app.md) — the read-only context MCP asks the app to write a note over the local proxy, so one process owns the database and both shells write the same way
- [adr/0036-reports-are-github-issues-filed-with-the-users-own-credential.md](adr/0036-reports-are-github-issues-filed-with-the-users-own-credential.md) — in-app reports open Issues on the fork's own tracker, with a keychain token or through GitHub's pre-filled form, and the UI names which happened
- [adr/0037-the-note-body-round-trips-through-a-document-not-the-dom.md](adr/0037-the-note-body-round-trips-through-a-document-not-the-dom.md) — the note's markdown seam serializes the ProseMirror document instead of walking the rendered DOM, escapes what it writes, covers the whole schema, and is gated by a round-trip property rather than a hand-written subset
- [adr/0038-a-note-rewrite-is-proposed-never-applied.md](adr/0038-a-note-rewrite-is-proposed-never-applied.md) — the model returns a revision the user accepts or discards, fork-side like the long-form summary, transient by design against ADR-0018, and bounded so a hostile note can at worst produce a bad rewrite
- [adr/0039-the-database-is-not-encrypted-at-rest.md](adr/0039-the-database-is-not-encrypted-at-rest.md) — the disk is out of scope and full-disk encryption is the assumption, written down rather than implied; SQLCipher rejected because a keychain-held key protects against nobody the app can beat, and a passphrase would be a different product

## Enforceable rules (spec/)

Coding rules that should fail review if violated (distinct from the `specs/`
feature specs). Full index: [spec/index.md](../spec/index.md).

- UI copy: [spec/sentence-case](../spec/sentence-case.md), [spec/no-typographic-dashes](../spec/no-typographic-dashes.md)
- UI styling: [spec/icons-central-only](../spec/icons-central-only.md), [spec/design-tokens](../spec/design-tokens.md)

## Subsystems

- [hermes-architecture.md](hermes-architecture.md) — the agent runtime: bridge, gateway, control plane, sessions, models
- [audio-pipeline.md](audio-pipeline.md) — capture → source separation → turns → transcription → note
- [june-api-prd.md](june-api-prd.md) — June API: upstream proxy + OS Accounts authorize/charge (the canonical backend spec)
- [configuration.md](configuration.md) — env + config reference (desktop client + June API)
- [os-accounts-login.md](os-accounts-login.md) — Login with Open Software: PKCE, keychain, account gates
- [onboarding-design.md](onboarding-design.md) — onboarding flow design (verify against what shipped)
- ~~os-accounts-backend.md~~ — historical; superseded by `june-api-prd.md`

## Hermes runtime (pin management)

- [hermes-upgrade-checklist.md](hermes-upgrade-checklist.md) — the gate for bumping the pinned runtime
- [hermes-upstream-template.md](hermes-upstream-template.md) — per-bump pin-note template
- [hermes-upstream-v2026.6.19.md](hermes-upstream-v2026.6.19.md) — current pin note (v2026.6.19)
- [hermes-tui-debug.md](hermes-tui-debug.md) — dev-only raw-TUI debug fallback

## Release & ops runbooks

- [release-macos.md](release-macos.md) / [release-windows.md](release-windows.md) — the release runbooks
- [desktop-release-runner.md](desktop-release-runner.md) — Mac Studio self-hosted runner setup for signed desktop releases
- [reproducible-builds.md](reproducible-builds.md) — June API source → TEE trust chain (Phase A shipped). **Does not apply to this fork**: June API runs as an embedded sidecar, not a deployed image; the `build-june-api`, `june-api-watchdog` and `promote-june-api` workflows were removed on 2026-09-02
- [threat-model.md](threat-model.md) — what the app protects, from whom, and what it deliberately does not:
  the five boundaries, what is in scope, what is out of it, and the commands that check each claim
- [github-security-readiness.md](github-security-readiness.md) — pre-public repo hardening checklist
- [settings-focus-runbook.md](settings-focus-runbook.md) — transient: settings tabs hidden while admin surfaces stabilize

## Upstream reports (defects filed with Carpe Diem)

Measured, reproducible findings written to be handed to the operator. Each one
pairs with the client-side compensation shipped for it, which stands whether or
not the upstream fix lands.

- [reports/2026-07-29-carpe-diem-router-rail.md](reports/2026-07-29-carpe-diem-router-rail.md) — `/router` vs `/v1`: `stream_options` rejected with 400 on externally-routed requests, no Carpe fallback on that 4xx, and no SSE on `/router` at all (pairs with the 2026-07-29 addendum to [ADR-0015](adr/0015-normalize-carpe-diem-router-responses.md))

## QA

- [qa/agent-driven-integration.md](qa/agent-driven-integration.md) — QA strategy (3 layers, skill-first agent-driven)
- `qa/feature-user-stories.tsv` — story → code → test traceability matrix
- `qa/agent-e2e-qa-runs/` — dated end-to-end QA run logs

## Feature specs (Spec Kit)

Each spec folder holds `spec / plan / research / data-model / quickstart /
tasks / contracts / checklists`.

- `specs/001-tauri-note-mvp` — Notes MVP (shipped)
- `specs/002-system-audio-source-mode` — audio source modes (shipped)
- `specs/003-conversation-turns` — dual-source conversation turns (current; the tech + structure entrypoint)

## Plans (dated, superseded by what ships)

- [plan-films-locaux-2026-08-24.md](plan-films-locaux-2026-08-24.md) — design: film production becomes local, Videomaker is removed (finishes ADR-0017)
- [IMPLEMENTATION-films-locaux-2026-08-24.md](IMPLEMENTATION-films-locaux-2026-08-24.md) — the executable spec for the above: five waves, verified seams, keyless smokes, DONE per wave

## Gaps (no doc yet — candidates for new docs/ADRs)

- **Roadmap / MVP scope** — no single sequenced source of truth across the active tracks (admin surfaces, reliability).
- **Dictation ADR** — the low-latency request shape + charge timing (flagged in CONTEXT.md).

## Security

- [../SECURITY.md](../SECURITY.md) — vulnerability reporting + supported versions
