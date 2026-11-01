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
   other grant (its temp folder, the working folder, the agent CLI opt-in), and
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
   `scripts/jail-eval/runtime_lives.py` repeats that run as a test. What the
   rules guarantee, exactly: in the re-opened state other than the
   workspace (and in the workspace's `uploads`), the kernel refuses to
   create a symbolic link, a pipe or a socket (`file-write-create` of those
   node types) and to make a hard link (`file-link`); the workspace itself
   is the session's folder and may hold all of them, since nothing outside
   the jail opens its files by name with authority (the app writes uploads
   as new files only). The name of each re-opened folder cannot be created
   as a symbolic link, nor removed or renamed (`file-write-unlink` on that
   name), so no folder of the jail's choosing takes its place. Links,
   second names, pipes, sockets and devices left from before are removed
   at every start of the sandboxed home.
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
   jailed spawn passes down (`jail_reaper.rs`), and every orphan whose
   profile is the jail's, whoever is responsible for it (a spawn with the
   private disclaim attribute changes nothing): the kernel is asked whether
   that process may look up a marker service only the jail's profiles allow
   (`xyz.carpediem.subrosa.jail`, held by nothing) and is refused a canary
   no profile of the jail allows (`xyz.carpediem.subrosa.jail-canary`), so
   a tool's profile that allows everything is left alone, the system's
   services the app uses (WebKit's, under their own profiles) are spared
   whatever their name or path, and a copy of a program under a `.xpc` name
   is not (a path asked of another process is always answered "denied",
   measured; a service name is answered truly). The orphans are asked for
   again until none is left. A one-off reader's or a sign-in's leftovers
   die when it ends. A jailed process cannot change its profile, so it
   cannot stop answering as the jail's.
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
   network over IP to other machines, and so any service listening there;
   reading the person's files but for credential stores.

   The temp folders (H1). The jail writes one temp folder, its own
   (`$TMPDIR/sr-jail`, made fresh by the app and given as its `TMPDIR`,
   short so a socket path in it stays under 104 bytes), and not
   `/private/tmp`, `/private/var/tmp` or the app's `TMPDIR`: other programs
   keep their sockets there (a database's `.s.PGSQL.5432`, a terminal
   multiplexer's, a browser bridge's), and a jail allowed to write such a
   folder could rename one of them, or the folder holding it, into its own
   and connect there (measured by the audit). Nor can it plant a fake
   server where a multiplexer looks for its own. The folder's own name (and
   the reader's answer folder's) is closed to the jail (`(literal ...)` after
   the grant): it writes inside, never removes, renames or chmods the
   folder, nor puts a link in its place; and the app makes it without
   following a link (made with its mode, opened `O_NOFOLLOW|O_DIRECTORY`,
   its mode set on that descriptor, checked as a folder of this account).
   What breaks: a tool that writes `/tmp` or `/var/tmp` by name rather than
   through `TMPDIR`.

   The loopback (H2). TCP and UDP to the machine itself (`localhost`,
   which the kernel matches for 127.0.0.1, `::1` and the machine's own
   addresses) are refused but for the ports the app names at each start:
   its proxy (models and the built-in MCP servers), the runtime's own
   dashboard, and the local MCP servers the person set (from the app's
   record). Every port is known before the runtime starts; when one
   changes (the proxy restarted), the runtime is started again with a new
   profile. IPv6 is refused outside them (`tcp6`, `udp6`): an IPv4-mapped
   address (`::ffff:127.0.0.1`) would reach any local port, and the
   `ip6` filter, measured, makes the loopback rule lapse; clients fall back
   to IPv4 for the internet. What breaks: a local server a sandboxed
   session starts itself and then calls, a local database, an IPv6-only
   network. What remains: a service of this machine listening on another
   machine's reach (all interfaces) is reachable from the network as from
   any other machine on it. And a limit of the rule language: a network
   filter names only `*` or `localhost` (measured: "host must be * or
   localhost"), so the machine's other addresses are refused only as far as
   the kernel counts them as `localhost`. Measured: 127.0.0.1, `0.0.0.0` and
   the Wi-Fi address (en0) are; a VPN or Tailscale interface's address and
   a `lo0` alias (127.0.0.2, which needs root to exist) could not be
   measured here, none being up. A sign-in address, on the other hand, is
   accepted only on a public, global unicast address.

   Unix sockets are a door of their own (M1): the ssh agent behind
   launchd's per-user listener answered the jail, so did gpg's, and a
   container engine's, a terminal multiplexer's or an editor server's
   would run a command outside it. The profile refuses every unix-socket
   connection but to the jail's own temp folder, its home, its working
   folder, name resolution (`/private/var/run/mDNSResponder`, without which
   `getaddrinfo` fails) and the system log; and, whatever a grant spans,
   never to a credential store, launchd's listeners
   (`com.apple.launchd.*/` under `/private/var/run` and `/private/tmp`),
   `/private/var/run/docker.sock` or a container engine's folder (Colima,
   OrbStack, Rancher, Lima), every app's container and group container
   (`~/Library/Containers`, `~/Library/Group Containers`, Docker Desktop's
   among them) and Podman's (`~/.local/share/containers`). Since the jail writes no
   shared temp folder (H1), no other program's socket can be brought into
   those places, and a working folder may be no temp or run folder of the
   system (`/private/tmp`, `/private/var/tmp`, `/private/var/folders`, the
   app's `TMPDIR`, `/private/var/run`, nor anything under one). A jailed process inherits neither `SSH_AUTH_SOCK`,
   `GPG_AGENT_INFO`, `DOCKER_HOST` nor a multiplexer's variables. Measured
   without breakage: Python (multiprocessing's own sockets included), Node,
   git and curl over HTTPS, and the runtime's session.

   launchd answers `launchctl kickstart`, `kill`, `bootout` and `disable`
   from a sandboxed process (measured on a test agent the measurement
   created and removed): they go over the bootstrap port every process
   holds, which no profile rule filters (`mach-bootstrap`, `job-creation`,
   `system-privilege`, `mach-priv*` and others measured, none refuses them;
   `process-info*` only crashes the client). The profile refuses running
   `/bin/launchctl`, and a copy of it is killed by the system for leaving
   its signed place. What remains: a program that speaks launchd's private
   protocol itself could stop, restart or disable one of the person's
   agents or the app (availability, not a program run outside the jail:
   launchd starts only what an agent already declares).

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
   gateway is restarted to take them. A link, a pipe, a socket or a device,
   or a folder holding one, is never put back. The app writes a file it
   owns only when no folder on the way from the home is a link.
11. **Each side signs in to an MCP server on its own.** `mcp login` runs in
   the home of the session that asks, under the reader's jail for a
   sandboxed one; its tokens stay in that home (`mcp-tokens/`, runtime
   state). No refresh token is copied from the shared home into the jail's,
   so nothing the unrestricted side was granted becomes the jail's. The
   authorization address the sign-in prints opens by itself only when it is
   a plain address (ASCII, no control character, backslash or user
   information) whose origin is the MCP server's own or an authorization
   server it declares (RFC 9728 metadata, then that server's own, at most
   four, none with a query, fragment or dot segment), the server taken from
   the app's record of the person's settings; what opens is the address as
   the app re-serialized it. A local or private origin counts only when it
   is the configured server's own host and port: every other address is
   judged by its text (`localhost`, with or without a final dot, `.local`)
   and by every address its name resolves to, which must all be public
   global unicast (IPv4 outside the reserved ranges, IPv6 within 2000::/3
   outside Teredo, documentation and 6to4; an IPv4-mapped one judged by the
   IPv4 inside; IPv4-compatible, NAT64, site-local, unique local and
   link-local refused),
   and each metadata request goes to the addresses so checked, never
   resolved again. Any other address is shown to the person with its host,
   and they decide.
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
  simulated keys or clicks fail, as do the person's ssh and gpg agents,
  container engines, terminal multiplexers and editor servers; the soul and
  the session's environment note tell the assistant so, and to give the
  link or the path instead, and the "In a sandboxed session" line of
  Settings › Agent tells the person. The
  app still opens the links it shows. Writing a preference fails. Writing
  `/tmp` or `/var/tmp` by name fails (temp files go to the session's own
  `TMPDIR`), and so does reaching a local port the app did not open: a
  local database, a server the session started itself. The internet, TLS
  and file watching work as before.
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
  (`jail_runtime_tests.rs`, ignored, free; `runtime_lives.py` now also
  reaches a real host, refuses a local port it was not given and a write in
  `/private/tmp`). The sixth pass adds: no outside socket can be renamed or
  linked into the jail, nor a fake multiplexer planted; only the loopback
  ports given answer, not one through an IPv4-mapped address; no grant is
  ever written empty (`sandbox_profile_tests.rs`); a copy under a `.xpc`
  name dies with the runtime and an orphan of another profile is spared
  (`jail_reaper.rs`); a temp or run folder is no working folder
  (`hermes_working_dir.rs`); a name is judged by every address it resolves
  to (`mcp_oauth_origin.rs`); the developer terminal gets the jail's
  environment (`hermes_bridge.rs`). The seventh: the jail cannot remove,
  rename, chmod or replace its temp folder, and the app never makes one
  through a link; no app container's socket answers; a disclaimed orphan
  dies and an allow-everything profile is spared (`jail_reaper.rs`); only
  a public global unicast address passes (`mcp_oauth_origin.rs`). The pass
  before adds: no agent's,
  engine's or multiplexer's unix socket answers the jail while its own do,
  no agent variable is inherited, `launchctl` does not run, a Python that
  resolves users and names still lives (`sandbox_profile_tests.rs`); an
  orphan Apple program without the mark dies with the runtime
  (`jail_reaper.rs`); a pipe or a socket is never put back
  (`quarantine.rs`); a link higher on the way to an owned file is refused,
  the guard plugin is never written through a linked `plugins`
  (`home_prep.rs`, `guard.rs`); a session identifier is taken exactly or
  refused (`session_owner.rs`); only a plain address opens, as
  re-serialized, and no private issuer is asked (`mcp_oauth_origin.rs`).
  Each test was checked by breaking the rule it holds.

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
