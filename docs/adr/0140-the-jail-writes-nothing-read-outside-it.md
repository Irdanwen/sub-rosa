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
runtime's installation (`hermes-runtime/`, source and virtualenv), and that
home was shared with processes that are not jailed. Three audits, run for
real under the profile with no paid call, showed what that meant:

- A jailed process writes `config.yaml` (`command_allowlist: ["*"]`,
  `approvals.mode: off`) or `.env` (`HERMES_YOLO_MODE=1`), and the next
  dangerous command runs without asking: the approval mode is read at every
  call, the allowlist at every session, `.env` at every start.
- The gateway, started by launchd outside the jail, runs `cron/jobs.json` (a
  `no_agent` job runs a `scripts/` file), loads `hooks/` and `plugins/`,
  executes `bin/tirith`, dispatches `kanban.db` tasks to full agents,
  follows `active_profile` into `profiles/<p>/` (its service definition
  names no profile), and opens `logs/gateway.log` by name at every start.
  The unrestricted runtime runs the same `bin/`, `node/`, `lsp/`,
  `mcp-installs/`.
- Even with every one of those files read-only to the jail, the shared home
  stayed a way out: the gateway delivers, at its start and with no person,
  the delegation results it finds in `state.db` (`internal=True`, route and
  text chosen by whoever wrote the row) and resumes the turns its store
  marks interrupted, as full agents outside the jail; a folder of the jail's
  own, carrying links, could be renamed into the place of `logs/`, which
  launchd then writes through; and the jail could stop the gateway at will
  for launchd to start it again.

Closing those one file at a time had already failed twice. Their common
cause is one home written by the jail and read with authority by processes
that are not jailed.

## Decision

1. **One home per runtime mode.** The sandboxed runtime lives in
   `<app data>/hermes-sandboxed/`, with its own `state.db`, sessions,
   workspace and logs (`hermes_bridge/home_split.rs`). The unrestricted
   runtime, the gateway, routines, messaging, task boards and the app's
   settings changes keep `<app data>/hermes/`, the shared home, which the
   jail cannot write at all: its profile closes it as a whole, every
   ancestor included. No process outside the jail runs, resumes or delivers
   anything from the sandboxed home: the gateway is always started on the
   shared home, whichever runtime asks for it. The app reads the sandboxed
   home as data only (the list of conversations, a transcript, the files of
   the workspace), through the sandboxed runtime when it runs, or through a
   one-off reader when it does not, and never follows a link there to write.
   That reader runs under a profile of its own, written fresh at every start
   (`hermes-sandbox-reader.sb`): the jail of that home with no working folder
   and no agent CLI state, whatever the last session had, and one more write
   grant, its answer folder `<app data>/hermes-reader-results/` (never the
   temp folder the sandboxed runtime shares). Where sandboxed
   processes run jailed and that profile is missing, the reader does not run
   (it fails closed); it never reads the jail's home from outside the jail.
   When the app opens a runtime's `state.db` in its own process (a task's
   replies, the account backfill), it opens it read only, with
   `trusted_schema=OFF`, `cell_size_check=ON`, `query_only=ON`, SQLite's
   defensive mode and no extension, and attaches none of its own databases
   to it.
2. **Each conversation has one owner home, and is read and written there
   only** (`hermes_bridge/session_owner.rs`). The owner is, in order: the
   shared home for a routine's run (`cron_*`), whatever is recorded; the home
   the app recorded when the conversation was created or resumed
   (`hermes-session-homes.json` beside both homes, written by the app
   alone, from the mode of the runtime that did it); the shared home when its
   database has the conversation (one from before the split, a gateway's);
   otherwise the sandboxed home. A shared database that exists but cannot
   be read counts as having the conversation (it fails closed). The webview
   tells the app where a conversation was created or resumed, and the app
   refuses to move to the sandboxed home one the shared database has, unless
   it was copied at the split (`hermes-split-sessions.json`): a resume that
   worked on the sandboxed runtime proves nothing for an identifier the jail
   could have written. The app never asks the sandboxed home first
   and the shared one on a 404: the jail could otherwise answer for a
   conversation of the unrestricted side by writing one under its
   identifier. A conversation present in both homes (copied at the split)
   is listed, read, matched to a task and mirrored to the account from its
   owner only; the other copy is not read. The account backfill keys its
   progress by home.
3. **Inside its own home, the jail writes only its working state.** The
   profile closes the home and the installation as a whole, after every
   other grant (temp folders, the working folder, the agent CLI opt-in), and
   re-opens only `workspace/`, `sessions/`, `logs/`, `cache/`, `images/`,
   `image_cache/`, `audio_cache/`, `state.db` and its SQLite side files,
   `verification_evidence.db` and its side files, and `auth.lock`. What the
   jailed runtime itself reads with authority for its next sessions stays
   closed and is written by the app at every start: `config.yaml`, `.env`,
   `SOUL.md`, `plugins/`, `skills/`, `profiles/`, `active_profile`, `cron/`,
   `hooks/`, `memories/`, so a jailed session cannot turn off the approvals
   of the next one. The list was measured: the pinned runtime ran its
   dashboard, a session, and a turn played by a local fake model calling
   terminal, background process, file read, write, patch and search, todo,
   skills, session search, delegation and an image attachment;
   `scripts/jail-eval/runtime_lives.py` repeats that run as a test. In the
   re-opened state no link, pipe or socket may be made (the workspace keeps
   links, but for its `uploads`), a re-opened folder's own name can be
   neither replaced by a link nor removed or renamed over, and links left
   from before are swept at every start.
4. **The runtime's installation is not a write root** (as in the CLI's own
   profile).
5. **No signal leaves the jail.** The profile refuses signals to other
   processes (`(deny signal (target others))`) and allows those within the
   same sandbox, so the runtime still stops its own children, in their own
   process groups too, while the app, the gateway and the unrestricted
   runtime are out of its reach. For the kernel, "others" means another
   process group: so the runtime (and the one-off reader) starts in a
   session of its own (`setsid`, `sandbox_profile::own_session`), not only
   a group of its own, because `setpgid` cannot cross sessions and nothing
   it starts can then join the app's group, from where a signal to the app
   would no longer count as going to "others". Stopping a jailed runtime
   kills its group and, gathered before, every process descending from it,
   still in its session, or carrying the mark (`SUBROSA_JAIL_MARK`) each
   jailed spawn passes down (`jail_reaper.rs`); a one-off reader's or a
   sign-in's leftovers die when it ends. What escapes: a process that left
   the session, whose parent is gone, and whose environment the system
   hides (Apple-signed programs) or no longer carries the mark. It keeps
   the jail and none of the app's privacy grants.
6. **The jail reaches only the system services it was measured to need.**
   A jailed process inherits the profile, but a service it asks to act runs
   outside it: LaunchServices started an application (`open -n X.app`),
   Shortcuts ran a shell script, and the privacy grants the app holds
   (Accessibility, posting events, recording the screen) answered yes under
   the jail, so a jailed process could type into another application or
   drive the dictation helper. The profile is `(deny mach-lookup)` with an
   allowlist (`ALLOWED_MACH_SERVICES`):
   - `com.apple.system.opendirectoryd.libinfo`: users, groups and name
     resolution; without it nothing starts.
   - `com.apple.cfprefsd.agent` and `com.apple.cfprefsd.daemon`: reading
     preferences.
   - `com.apple.FSEvents`: watching files (Node, language servers).
   - `com.apple.trustd.agent`: certificate trust for Go, Swift and
     Security-framework TLS.

   It was measured by removing each candidate in turn (the auditor's
   nineteen and more) under Python (users, name resolution, subprocesses,
   TLS to a real host), Node (child processes, TLS, `fs.watch`), git and
   curl over HTTPS, a Go binary's TLS and `defaults read`, then confirmed by
   the pinned runtime's own session with every tool, TLS to a real host,
   file watching, a refused `open` and a refused Accessibility check
   (`runtime_lives.py`). Everything else is refused: LaunchServices and
   Apple events, Shortcuts, login items, the Dock, the Services menu, the
   window server (no screenshot, no synthesized key or click: the display
   answers 0), the privacy daemon (every privacy preflight answers no), the
   pasteboard and the keychain daemon. And `(deny user-preference-write)`:
   preferences are written by `cfprefsd`, outside the jail, and read by
   every program that starts later. What needs no rule, measured and kept
   by a test: launchd refuses `launchctl bootstrap`, `load`, `submit` and
   `setenv` to any sandboxed process; setuid programs (`crontab`, `at`)
   cannot be executed under a profile. What stays reachable, by design: the
   network, and so any service listening on it (a remote login the person
   turned on); reading the person's files but for credential stores.

   Starting the jail with the app's privacy responsibility disclaimed
   (`responsibility_spawnattrs_setdisclaim`) was measured too: it also makes
   every preflight answer no, but the runtime then loses the folders macOS
   protects for the app (Documents, Desktop, Downloads: "Operation not
   permitted"), where a person's working folder usually is. The allowlist
   gives the same answers without that loss, so the spawn keeps the app's
   responsibility; see Alternatives.
7. **Every command the app runs names `--profile default`**: the dashboard,
   `gateway start`, `mcp login`, `skills reset`, `skills tap` and the
   developer terminal, whatever profile the webview asked for. The runtime
   follows `active_profile` only when no profile is named, and the launchd
   service it writes names none, so the app also removes `active_profile`
   before every start and before the gateway starts.
8. **The app writes `.env` at every start** from its own record
   (`hermes-settings.json`, in its data folder), which keeps only the keys
   the pinned runtime declares Settings write (`_env_schema` in
   `subrosa_admin.py`, refreshed before every start and with every change).
   An allowlist: a package index (`PIP_INDEX_URL`), a base address or any
   unknown key is refused, and `PUT /api/env` with such a key answers 422
   with the reason before anything is written. Never, whatever the source:
   `HERMES_*`, `SUDO_*`, `TERMINAL_*`, `TIRITH_*`, the gateway's network
   doors (`API_SERVER_*`, which would open a full agent on a local port,
   `WEBHOOK_*`, `GATEWAY_*`) and `*_PROXY`; no setting switches on the
   `api_server`, `webhook`, `msgraph_webhook` or `relay` platform. The
   import of the existing file and a skill's setup keep credentials only;
   a messaging platform's address, port, home channel or allowlist comes
   only from that platform's own setting.
9. **Settings changes are made by the app, outside the jail, on the shared
   home.** The admin routes the Settings screens call (MCP servers, the
   catalog install, skills, toolsets, `PUT /api/config`, `PUT`/`DELETE
   /api/env`, messaging platforms, routines) run once in a short-lived
   process of the app (`hermes/subrosa_admin.py`), one change at a time.
   After a change that worked, the app copies the keys a person owns into
   its record and writes them back at every start of either home
   (`admin_settings::apply_overlay`); the sandboxed home's `config.yaml` and
   `.env` are also written again right away from the base rendered at its
   last start (`admin_settings::reapply`). The approvals, the allowlist,
   hooks, plugins, the model and the routines' gate stay the app's.
   Skills a person installs land in the shared home and the sandboxed
   runtime reads them there; the bundled skills are copied into each home
   by the app before it starts.
10. **What a jailed process could plant in the shared home before this fix
   is set aside once.** First the links: every symbolic link of the shared
   home (a folder that is one included, `scripts/` or `skills/` say) is set
   aside without anything read through it, and every file with a second
   name (a hard link to `/private/tmp/...`) is replaced by a copy of itself,
   so its contents stay (the session database may be one) and the other
   name no longer reaches it; the person's workspace keeps its own links.
   And the app never writes a file it owns in place: it writes a new file
   beside it and renames it over (`home_prep::write_owned`), refuses a
   folder on the way that is a link. Then the app moves
   into `<app data>/quarantine/<date>/` (never deletes), writing the
   manifest one line per item as it goes: everything in `bin/`, `hooks/`,
   `scripts/`, `mcp-installs/`, `plugins/` (but the guard) and `profiles/`,
   the task board (`kanban.db`), who may write to the messaging gateway
   (`pairing/`, `platforms/pairing/`), `lsp/`, `node/`, `processes.json`,
   and the routines that run a script or no agent. Skills and memories a run
   may have written are flagged in `flagged.json` and left in place (a skill
   is the runtime's own only when its exact name is in the bundled
   manifest). The gateway is restarted once so nothing it loaded stays. A
   notice, once, as a banner where the app opens and in Settings › Agent,
   lists what was moved (without claiming none of it was the person's) and
   what was flagged, says what to do again, and lets the person put back
   the items they choose, one by one, after a confirmation that lists what
   will run outside the sandbox again: the app moves them from
   `quarantine/<date>/` into the shared home, outside the jail, and the
   gateway is restarted to take them. A link, or a folder holding one, is
   never put back.
11. **Each side signs in to an MCP server on its own.** `mcp login` runs in
   the home of the session that asks, under the reader's jail for a
   sandboxed one; its tokens stay in that home (`mcp-tokens/`, runtime
   state). No refresh token is copied from the shared home into the jail's,
   so nothing the unrestricted side was granted becomes the jail's. The
   authorization address the sign-in prints opens by itself only when its
   origin is the MCP server's own or an authorization server it declares
   (RFC 9728 metadata, then that server's own), the server taken from the
   app's record of the person's settings; any other address is shown to the
   person with its host, and they decide.
12. **The copy of the conversations at the split never stops a start.** A
   copy that fails is logged, said in the notice, and tried again at the
   next start while the sandboxed home has no database of its own; until
   then those conversations open from the shared home.
13. **Nothing resumes on its own.** In the shared home too, the gateway's
   window for re-running interrupted turns at its start is one second (0
   means "always" to the runtime) and its delivery ledger is off.

## What the person sees

- One list of conversations: both homes are merged, each conversation shown
  from its owner, a copy in the other home not shown. At the first start of the sandboxed home, the
  conversations of the shared home are copied into it once
  (`VACUUM INTO`), so a conversation from before continues in either mode:
  sandboxed in the copy, unrestricted in the original. The copy stops there:
  a conversation continued on one side after the split does not change on
  the other.
- Routines, messaging channels and task boards run on the unrestricted side,
  in the shared home, as before; the "In a sandboxed session" line in
  Settings › Agent says so. A sandboxed session's files are in its own
  workspace (the Files panel lists both workspaces); files you attach go to
  the shared home's `workspace/uploads`, which the sandboxed runtime reads
  and cannot change.
- In a sandboxed session the runtime's own memory tool, its skill writer,
  its scheduling tool, its kanban and project tools, the scanner's and the
  language servers' self-install fail with "operation not permitted"; the
  soul and Settings › Agent say where the person changes them. Sub Rosa's
  own memory is unaffected.
- A settings change takes about half a second more (a process starts) and
  now survives a restart.
- After the update, a notice says once what was set aside and what was
  flagged, offers to put it back, and says what to do again: pair messaging
  channels again (their pairing was set aside), install again the catalog
  MCP servers, restore the task boards if used, sign in again to MCP
  servers from a sandboxed session, find the former workspace as the
  "Unrestricted workspace" of the Files panel. The scanner and Node are
  downloaded again when needed.
- In a sandboxed session, opening a link, a file or an application from a
  tool (`open`, the runtime's own browser opening, `osascript`, Shortcuts),
  the clipboard (`pbcopy`, `pbpaste`), notifications, screenshots and
  simulated keys or clicks fail; the soul and the session's environment
  note tell the assistant so, and to give the link or the path instead. The
  app still opens the links it shows. Writing a preference fails. The
  network, TLS and file watching work as before.
- An MCP sign-in address that is not on the server's own origin, or one it
  declares, is not opened: the server row shows it with its host.

## Consequences

- **Still open:** Windows has no jail; the unrestricted mode is not jailed
  by design (its sessions read what the person and the unrestricted runtime
  put in the shared home, nothing the jail writes).
- **Tests:** the profile's write grants are pinned by hand and the shared
  home is never one (`the_write_grants_are_exactly_the_declared_list`); the
  kernel refuses every vector, every write in the shared home, a carrier
  folder in a re-opened folder's place and any signal to a process outside
  the jail, any join of the app's process group, every service that starts
  a program, the window server, the privacy daemon and the pasteboard (with
  a control that each allowed service answers), every privacy preflight,
  `open` of an application, `launchctl` and `defaults write`, a write by
  the runtime in the reader's answer folder; a sandboxed session is told to
  give links (`sandbox_profile_tests.rs`); a process that left the
  runtime's session dies with it (`jail_reaper.rs`); an owned file is
  replaced, never written through a link (`home_prep.rs`); a sign-in
  address opens only on a declared origin (`mcp_oauth_origin.rs`); the gateway starts on the shared
  home even when the sandboxed runtime asks, the routines and a
  conversation the jail does not own are never asked of the sandboxed
  runtime, the list keeps each conversation from its owner, the reader fails
  closed without its profile, the conversations from before are copied
  once and a failed copy is said and tried again (`home_split.rs`); the
  owner rules, the hardened read options with defensive mode, a sandboxed
  resume that cannot take a shared conversation, an unreadable shared
  database that fails closed (`session_owner.rs`); the
  backfill mirrors from the owner only (`account/conversations.rs`); each
  side signs in on its own home (`hermes_bridge.rs`); only
  declared keys reach `.env` and an import keeps no `API_SERVER_KEY`
  (`admin_settings.rs`, `admin_once.rs`, `home_prep.rs`); the shared home's
  plants are set aside once, its links set aside or cut, the notice says
  what to do again, the person puts back only what they choose and never a
  link, a skill is matched by its exact name
  (`quarantine.rs`); under the real runtime, in
  its own home, no vector (in either home) can be planted and the next
  session still asks, a left-over profile is neither followed nor kept, the
  runtime lives with its home read-only and the service allowlist (TLS to a
  real host, file watching, `open` refused, Accessibility answering no),
  the jailed reader reads the sandboxed home, and every settings change
  succeeds from the app while the same change from the jail is refused
  (`jail_runtime_tests.rs`, ignored, free). Each test was checked by
  breaking the rule it holds.

## Alternatives rejected

- **Closing the shared home file by file** (this ADR's first two passes): a
  denylist, then an allowlist inside a shared home; each audit found one
  more file a process outside the jail obeyed, then a database row it acted
  on. The cause was the sharing.
- **Patching the runtime** to read its settings from elsewhere, to pin its
  profile or to stop delivering delegations: the fork carries no new managed
  patch.
- **A second, unjailed dashboard kept running for settings**: a process
  lifecycle (ports, tokens, reaping) for a change a person makes a few times
  a month; a one-shot process costs half a second.
- **A denylist of system services** (the previous pass): it closed
  LaunchServices, Shortcuts and the rest by name, and left the window server
  and the privacy daemon open, through which the app's Accessibility and
  event grants reached the jail. A service macOS adds is refused by the
  allowlist until it is measured; a tool that needs one fails visibly.
- **Disclaiming the app's privacy responsibility at the spawn**: measured,
  it gives the same no to every preflight, and takes away the protected
  folders (Documents, Desktop, Downloads) a sandboxed session works in.
- **Reading a conversation from the sandboxed home first and the shared one
  on a 404**: simple, and it let the jail answer for any conversation of the
  unrestricted side by writing one under its identifier.
- **Copying the unrestricted side's MCP sign-ins into the jail's home**: it
  spared a second sign-in, and handed the jail refresh tokens it was never
  granted.
