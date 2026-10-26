---
status: accepted
date: 2026-10-25
---

# ADR-0140: The jail writes nothing that is read outside it

Amends [ADR-0006](0006-embed-hermes-sandboxed-runtime.md) and
[ADR-0014](0014-per-session-working-folder.md). A security fix to 1.97.0,
shipped on its own, ahead of the two plans that hold numbers 0122 to 0139.

## Context

The sandboxed runtime runs under a Seatbelt write-jail. Until this ADR the
jail could write its whole home (`$HERMES_HOME`, `app_data/hermes`) and the
runtime's installation (`hermes-runtime/`, source and virtualenv); five names
were refused on another branch, nothing on main. Two audits, run for real
under the profile with no paid call, showed what that meant:

- A jailed process writes `config.yaml` (`command_allowlist: ["*"]`,
  `approvals.mode: off`) or `.env` (`HERMES_YOLO_MODE=1`), and the next
  dangerous command runs without asking: the approval mode is read at every
  call, the allowlist at every session, `.env` at every start.
- The home is read with authority by processes that are not jailed. The
  gateway, started by launchd outside the jail, runs `cron/jobs.json` (a
  `no_agent` job runs a `scripts/` file), loads `hooks/` and `plugins/`,
  executes `bin/tirith`, dispatches `kanban.db` tasks to full agents, and
  follows `active_profile` into `profiles/<p>/`, because the service
  definition the runtime writes names no profile. The unrestricted runtime
  shares the home and runs the same `bin/`, `node/`, `lsp/`, `mcp-installs/`.
  `memories/`, `SOUL.md`, `skills/` and the routines' prompts are read into
  the prompts of sessions that are not jailed.
- `.env` was never rewritten by the app, so a planted one survived restarts.

## Decision

1. **Inversion: inside its home, the jail writes only its working state.**
   The profile closes the home and the installation as a whole, after every
   other grant (temp folders, the working folder, the agent CLI opt-in), and
   re-opens only `workspace/`, `sessions/`, `logs/`, `cache/`, `images/`,
   `image_cache/`, `audio_cache/`, `state.db` and its SQLite side files,
   `verification_evidence.db` and its side files, and `auth.lock`
   (`hermes_bridge/sandbox_profile.rs`). Everything else, present or added by
   a future runtime, is read-only to the jail: `config.yaml`, `.env`,
   `profiles/`, `active_profile`, `cron/`, `scripts/`, `hooks/`, `bin/`,
   `plugins/`, `mcp-installs/`, `skills/`, `memories/`, `SOUL.md`,
   `auth.json`, `kanban.db`, `pairing/`, `node/`, `lsp/`.
   The list was measured, not guessed: the pinned runtime ran its dashboard,
   a session, and a turn played by a local fake model calling terminal,
   background process, file read, write, patch and search, todo, skills,
   session search, delegation and an image attachment, first under the
   old profile (to see every path written) and then under the list (to see
   that nothing it needs is refused and that nothing outside it is written).
   `scripts/jail-eval/runtime_lives.py` repeats the second run as a test.
2. **The runtime's installation is not a write root** (as in the CLI's own
   profile). Its bytecode caches are not written; nothing else was.
3. **Every command the app runs names `--profile default`**: the dashboard,
   `gateway start`, `mcp login`, `skills reset`, `skills tap` and the
   developer TUI, whatever profile the webview asked for (the app provisions
   no other). The runtime follows `active_profile` only in its command line
   when no profile is named (`hermes_cli/main.py`, `_apply_profile_override`),
   and the launchd service it writes names none, so the app also removes
   `active_profile` before every start and before the gateway starts; the jail
   cannot write it back.
4. **The app writes `.env` at every start** from its own record
   (`hermes-settings.json`, next to the home, outside the jail's reach), and
   the record keeps only the keys the pinned runtime declares Settings write:
   the credentials of its environment schema, the messaging platforms'
   settings, the tool providers' keys, the keys installed skills ask for and
   the MCP servers' tokens (`_env_schema` in `subrosa_admin.py`, refreshed
   before every start and with every change). An allowlist, not a denylist:
   a package index (`PIP_INDEX_URL`), a base address or any unknown key is
   refused, and `PUT /api/env` with such a key answers 422 with the reason
   before anything is written. Even declared, `HERMES_*`, `SUDO_*`,
   `TERMINAL_*` and `TIRITH_*` never pass, and on import who may command the
   messaging gateway (`*ALLOW*`) does not either. The existing file is set
   aside once in the app's data folder and imported when the runtime has
   declared its keys; a line added to `.env` afterwards, by anything, is gone
   at the next start. The files the app owns in the home (`config.yaml`,
   `.env`, `SOUL.md`, the guard plugin) are replaced, not followed, when a
   link stands in their place.
5. **The homes are not split in this fix.** Both runtime modes and the
   gateway keep one home. A home per mode would close the last channel (the
   transcripts and the caches the jail still writes are read by the
   unrestricted runtime and the gateway), but the session list, the messages
   of a session, the hydration and backfill that read `state.db` directly,
   temporary chats, routines and the unidirectional mode fallback all assume
   one store; splitting it in a hotfix would hide every unrestricted
   conversation whenever its runtime is not running. What remains, and the
   proposal, are under Consequences.
6. **Settings changes are made by the app, outside the jail.** The admin
   routes the Settings screens call (MCP servers, the catalog install,
   skills, toolsets, `PUT /api/config`, `PUT`/`DELETE /api/env`, messaging
   platforms, routines) are no longer sent to the runtime's dashboard:
   `hermes_connection_json` hands them to `admin_once`, which runs the
   runtime's own route once in a short-lived process of the app
   (`hermes/subrosa_admin.py`, the dashboard application loaded in process,
   same home, `--profile` never followed), one change at a time. After a
   change that worked, the app copies the keys a person owns (their MCP
   servers, `mcp.exposure_policy`, `skills.disabled`, `platform_disabled`,
   `config`, `external_dirs`, `platform_toolsets` but `cron`,
   `platforms.<p>.enabled`) and the filtered `.env` into its record, and
   writes them back at every start (`admin_settings::apply_overlay`), so the
   approvals, the allowlist, hooks, plugins, the model and the routines' gate
   stay the app's whatever the file held. Before this ADR every such change
   was lost at the next start, because `config.yaml` is rewritten from
   scratch. Reads, a server's test and everything else still go to the
   runtime; profiles stay out of reach. The bundled skills, which the runtime
   copies into its home when it starts, are copied by the app before every
   start.

7. **No link where processes outside the jail open by name.** The runtime
   state is written by the jail but also opened by name from outside it (the
   gateway's logs and sessions, the session database, the app's uploads), so
   the profile refuses symbolic and hard links there (`file-write-create` of
   a `SYMLINK` vnode, `file-link`), renames included; the default workspace
   keeps its links (development tools need them), except its `uploads`
   folder. Links planted before this fix are swept at every start. The app
   writes an upload, and the text extracted beside it, only as a new file
   (`create_new`, which never follows what stands at the name), and its own
   logs (the runtime's output, the gateway's start, settings changes, the
   developer terminal launcher) live in its data folder, never in the home's
   `logs/`.

## Consequences

- **In a sandboxed session**, the runtime's own memory tool, its skill
  writer, its scheduling tool, its kanban and project tools, the scanner's
  self-install and the language servers' self-install fail with "operation
  not permitted"; the soul tells the assistant they are read-only and where
  the person changes them. Sub Rosa's own memory is unaffected. The scanner
  stays fail-open where it is not installed, as it was before it was
  downloaded.
- **Settings screens** no longer fail with a 500 from the jail; a change
  that fails reads "This change was not made", and no generic error copy
  names the runtime. A change takes about half a second more (a process
  starts). Changes apply when the runtime next discovers them, as before.
- **Still open, documented rather than closed:**
  - the shared home: a jailed process can still write transcripts
    (`state.db`, `sessions/`), the delegation records the next process
    delivers as a turn, caches, and files in the default workspace that an
    unrestricted session or a gateway agent reads into its prompt (context
    files). That is injection, not execution: nothing the jail can write is
    run outside it any more. **Proposal:** one home per mode, with the
    gateway on the unrestricted one; the session list and the message reads
    merge both stores (reading the other `state.db` directly when its
    runtime is not running), `state.db` and `sessions/` copied once into the
    sandboxed home so every conversation stays where the person left it, and
    routines moved with the gateway.
  - what a jailed process planted before this fix in `bin/`, `hooks/`,
    `scripts/`, `cron/`, `mcp-installs/` or `plugins/` (other than the
    guard, which the app rewrites) is not swept: the app does not own those
    files.
  - Windows has no jail; the unrestricted mode is not jailed by design.
- **Tests:** the profile's write grants are pinned by hand
  (`the_write_grants_are_exactly_the_declared_list`), the kernel refuses
  every vector, every link where others open by name, and allows the working
  state (`sandbox_profile_tests.rs`); the app sweeps left-over links, writes
  uploads only as new files and keeps its logs out of the home
  (`home_prep.rs`); only declared keys reach `.env`, and an undeclared one is
  refused before the change (`admin_settings.rs`, `admin_once.rs`);
  under the real runtime, no vector can be planted and the next session
  still asks, a left-over profile is neither followed nor kept, the runtime
  lives with its home read-only, and every settings change succeeds from the
  app while the same change from the jail is refused
  (`jail_runtime_tests.rs`, ignored, free).

## Alternatives rejected

- **A denylist of the files that grant rights** (the partial fix on
  `feat/code-p1-checks`): every file a future runtime starts reading would be
  writable by default, and the audits had already found more vectors than it
  named.
- **Patching the runtime** to read its settings from elsewhere or to pin its
  profile: the fork carries no new managed patch.
- **A second, unjailed dashboard kept running for settings**: a process
  lifecycle (ports, tokens, reaping) for a change a person makes a few times
  a month; a one-shot process costs half a second.
