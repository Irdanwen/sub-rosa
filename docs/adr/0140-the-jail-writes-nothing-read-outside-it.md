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
   that process may look up a marker service only this installation's jail
   profiles allow (`xyz.carpediem.subrosa.jail.<hash of the app's own
   executable path>`, held by nothing, so a development build beside the
   installed app neither sweeps nor is swept by the other) and is refused a canary
   no profile of the jail allows (`xyz.carpediem.subrosa.jail-canary`), so
   a tool's profile that allows everything is left alone, the system's
   services the app uses (WebKit's, under their own profiles) are spared
   whatever their name or path, and a copy of a program under a `.xpc` name
   is not (a path asked of another process is always answered "denied",
   measured; a service name is answered truly). An orphan of the jail is
   also a jailed process whose jailed parent is one, or whose parent has
   just ended: a loop that forks and exits leaves its newest pid with a
   parent still exiting; what a live runtime started has the runtime, then
   the app, above it and is spared. The sweep freezes (`SIGSTOP`) what it
   finds, with its whole process group when that group lives in a session
   other than the app's (every jailed spawn starts one, and no process can
   join a group of another session), and looks again, until several passes
   in a row find nothing new or five seconds have passed; then it kills
   (`SIGKILL`) everything frozen and the frozen groups. A sweep that ended
   quietly left everything it found stopped (a member of a frozen group or
   a child of a frozen process still running is found again, and a pass
   that finds one is not quiet), and a stopped process starts nothing; a
   frozen parent, unlike a killed one, keeps its children its own until
   the next pass finds them. A process that forks and exits in a
   tight loop lives a few microseconds under each pid, less than it takes
   to ask about it: a process is known by its pid and its start time, never
   its pid alone (such a loop reuses pids within seconds), and both are
   checked again just before each signal (see the second addendum of
   2026-11-03), an answer about a
   process that ended while being asked is not kept, and a pass that met
   one proves nothing. Measured: without these, a loop forking as fast as
   it can survived 18 sweeps out of 20 (each answer was about a pid already
   gone, and only a jailed orphan's group was frozen); with them, none of
   20 runs of the reaper's tests left anything. The sweep also runs at the app's start for
   each runtime an earlier run left a record of (what its jail left
   behind), and after a one-off reader (a reader runs when no sandboxed
   runtime is up); never over the whole machine without a floor (see the
   addendum of 2026-11-03). A sign-in's leftovers
   die by their mark only, its runtime being up. What stays open: a
   process that calls `setsid()` again at every fork, faster than a pass,
   could outrun the freeze until the deadline; it keeps the jail and none
   of the app's privacy grants.
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
   (`$TMPDIR/sr-jail`, made by the app, never through a link, and given as its `TMPDIR`,
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

   UDP is refused outright (final pass): a broadcast or a multicast datagram
   reached a listener of this machine on `0.0.0.0` (measured). Name
   resolution goes through `mDNSResponder`'s socket, not UDP, and HTTP/3
   clients fall back to TCP; a tool that sends its own DNS queries (`dig`)
   fails.

   The loopback (H2). TCP to the machine itself (`localhost`,
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
   app's `TMPDIR`, `/private/var/run`, nor anything under one), nor a folder
   of the person's that programs outside the jail run or read at login:
   `~/Library/LaunchAgents` (agents launchd starts), `~/Library/Application
   Support` (every app's data and scripts, Sub Rosa's own among them),
   `~/Library/Preferences`, `~/Library/Scripts`, `~/Library/Services`,
   `~/Library/Containers` and `~/Library/Group Containers`. A jailed process inherits neither `SSH_AUTH_SOCK`,
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
14. **Every `git` the app runs on a folder the jail writes is jailed and
   neutralized** (`hermes_bridge/jailed_git.rs`). The code review and the
   council read a session's working folder with git, outside the jail,
   and git obeys the folder: measured, a `[core] fsmonitor = <cmd>` the jail
   wrote into `.git/config` ran when the app ran `git status` (in 1.97.0
   and on main). Now each command carries its own configuration, which
   outranks the folder's (no system or global file, `core.fsmonitor=false`,
   hooks at `/dev/null`, no external diff, no ssh command, no protocol, no
   attributes file, in-tree attributes read from the empty tree with git
   2.42 and later, optional locks off, `LC_ALL=C`); diffs ask for no
   external diff and no textconv; a past file is read with `cat-file blob`,
   never through a filter. Before each command the configuration git
   would read is listed (includes followed), and a filter, a diff command,
   a textconv or a merge driver defined there refuses the folder: no
   setting turns those off, and `.git/info/attributes`, which the jail
   writes too, could name them. And on macOS git runs under a profile that
   refuses by default (on Apple's `system.sb`): it runs only git and its
   helpers, reads git's installation, the system's libraries, the
   repository (its working tree, and a linked worktree's store when the
   `.git` file names one under `<store>/worktrees/`, never anywhere else)
   and a temp folder of its own, writes only that folder, and reaches no
   network; a filter planted between the check and the command does not
   even start `/bin/sh` there. The profile is passed as an argument
   (`sandbox-exec -p`), never through a shared file another call could be
   rewriting. Each layer stops alone what it covers, measured with a
   planted script that leaves a mark, prints a secret file from outside
   the folder and calls a local listener (plain git does all three): the
   command's configuration and options stop what they outrank and keep git
   out of submodules and on its own working tree; the check stops a
   program defined in the configuration git reads for the folder, not one
   planted after it; the profile stops what runs, whenever it was planted.
   And every git the app runs has a time limit (see the second addendum of
   2026-11-03). The
   process keeps the app's privacy responsibility: measured, a git started
   with it disclaimed cannot read a folder under `~/Documents` ("Unable to
   read current working directory: Operation not permitted"), where
   working folders usually are; the profile bounds what those grants reach.
   What remains: what git prints of the repository goes to the review and
   the council, as before.

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
  put in the shared home, nothing the jail writes). A working folder is
  the person's project, written by the jail: what the person's own tools
  later run from it outside the jail (`.git/config`, hooks and
  `.gitattributes` for their own git, `.envrc` for direnv, a build script,
  an editor's workspace settings) is outside this ADR; only the app's own
  git is guarded. The machine's addresses other than 127.0.0.1, `0.0.0.0`
  and the Wi-Fi one (a VPN or Tailscale interface, a `lo0` alias) were not
  measured against the `localhost` rule. `confstr(DARWIN_USER_TEMP_DIR)`
  fails in the jail (its service is not on the allowlist); the jail's own
  `TMPDIR` is enough for the command-line tools' shims, which then print no
  warning (measured with `git` and `python3`).
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
  The final pass: neither the code review nor the council runs an
  fsmonitor, a filter, an external diff or a textconv planted in the
  working folder, each of the two layers alone holding
  (`jailed_git.rs`, `council/evidence.rs`, `code_review/tree.rs`); a
  process that forks and exits as fast as it can dies with the runtime,
  found by its mark or only as an orphan of the jail, and what a live
  runtime started survives the start sweep; a pass that met a process gone
  while asked is not quiet, and an answer about an ended process is never
  reused for its pid; the child of an orphan of the jail is one; a
  reader's leftover that dropped the mark dies with its frozen parent
  (`jail_reaper.rs`); each installation has its own marker, no datagram
  leaves the jail (`sandbox_profile_tests.rs`); no login folder is a
  working folder (`hermes_working_dir.rs`).
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

## Addendum 2026-11-03: a test barrier, a production belt, and the crashes they answer

**The incident.** The Mac froze and had to be restarted three times while
the reaper's mutation campaign ran on the live worktree. At least twice the
mutant in place was `if !under && false {` in `orphan_of_the_jail`: it
drops "does this process run under the jail?", so every process whose
chain of parents reaches launchd answers as an orphan of the jail. Tests
call `reap_jailed_orphans()` and `sweep(..., orphans = true)` for real, over
the whole machine: under that mutant the sweep froze (`SIGSTOP`) and then
killed the person's applications whose parent is launchd (the Dock, the
Finder, the terminal). A Mac whose Dock and applications are frozen is a
frozen Mac. Each crash also left the mutant in the worktree until the
coordinator restored it from the run's journal. Nothing in the code under
test could stop that, because the code under test was what had been
mutated; and even without a mutant, a test that sweeps the whole machine
while the person works, next to an installed Sub Rosa whose own runtime is
jailed, was dangerous by construction.

**The test barrier** (`jail_reaper_gate.rs`). Every signal the reaper sends
(`kill`, `killpg`) goes through one module. In tests it consults the pids
and sessions the test itself registered when it spawned them (the test
harness's `LoopGuard`, never the code under test), refuses anything else
without sending it, and fails the test naming the process it would have
hit ("the reaper would have frozen pid N, comm X"); a group is let through
only when the test created it. A thread can ask to note refusals instead
of failing (the test below), and `SUBROSA_GATE_NOTE_ONLY=1` makes a whole
run a census. The module is never mutated: the mutation runs work on a
copy made with `git archive` and check the module with `cmp` before and
after each mutant. Measured: the reaper's 17 tests sent no signal outside
what they created, except in the one test that makes every process answer
as the jail's, where the barrier blocked the two processes newer than the
spawn that the test had not created (a compiler and a `sleep`), and the
belt spared the 351 older ones.

**The production belt** (`Belt` in `jail_reaper.rs`), independent of the
"is it the jail's?" answer: the reaper never signals pid 1 or below, the
app or one of its ancestors, a process of another user, or a process that
started before the spawn the sweep is for. That floor is the mark's birth:
`new_mark()` writes the time it was made into the mark
(`jail-<seconds>-<microseconds>-<token>`), less a second for a clock that
stepped, so a record an earlier run left carries its floor with its mark.
A mark without a birth (made before this format) gives no floor, and a
sweep without a floor signals nothing. A group is frozen whole only when
its leader, if it still runs, passes the belt too. Each refusal is logged
once. The start sweep no longer runs over the whole machine: it runs for
each runtime an earlier run left a record of, with that record's mark.

**What the belt does not do.** A process started after the spawn, of this
user, that wrongly answers as the jail's is still in reach of a broken
check; the belt bounds the damage to what started since, it does not
replace the check. The tests cover each guard alone
(`the_belt_refuses_each_process_it_guards`, `a_mark_carries_its_floor`,
`a_marked_process_older_than_its_mark_is_spared`) and the dangerous mutant
as a test (`a_sweep_that_takes_every_process_for_the_jails_touches_nothing_older`:
every process answers as the jail's, and the sweep aims at nothing older
than the spawn, spares the test's older orphan and still kills its newer
one).

**The app's git, the same day.** A security review found the profile of
decision 14 too wide: it allowed by default and refused only writes, the
network and credential stores, so a filter defined in a configuration the
jail wrote and named by `.git/info/attributes` would run with almost every
read. Decision 14 now describes the profile that refuses by default, the
check of the configuration before each command, and the profile passed as
an argument instead of a file rewritten at each call (a concurrent
`sandbox-exec` could have read it half written). The mutation runs found
two holes in the tests themselves, both fixed: the test of the profile alone
proved nothing (git, run without the command's configuration, stopped at once
on the person's `~/.gitconfig`, which the profile refuses; git now never
reads a system or global file, and each layer's test checks that git did
answer), and no test planted a program inside the repository, the only place
where the profile's exec rule, rather than its read rule, is what stops it
(measured: a script there runs through `/bin/sh`, and a compiled program
runs, when exec is open).

**The fifteen-hour survival** (same pass). A test process that forked in a
tight loop outlived its test for fifteen hours and held the harness's pipes
open. The cause, measured: the sweep then knew processes by pid alone and
froze a whole group only for an orphan whose profile it had confirmed; each
member of the loop lives a few microseconds, so each question was answered
about a pid already gone, four quiet passes came in about 180 ms, and the
sweep ended with the loop still running (18 failures and 2 hangs in 20
runs). The test then failed without killing the loop, which had inherited
the harness's stdout and stderr, so the harness waited for an end of file
that never came. Both are fixed: a process is known by pid and start time,
a pass that met a process gone while asked is not quiet, the group of any
process found in a session of the jail's is frozen, and every test process
has null stdio and a guard that kills its sessions whatever the outcome
(20 of 20 runs clean since).

## Addendum 2026-11-03: the app's reads of what the jail writes (independent audit)

An independent audit of this lot (6.5/10) found that the app still read,
outside the jail and with authority, what the jail writes. Decision 14
covered what git *runs*; nothing covered what the app *reads*.

**Reads through links (present in 1.97.0).** The council read the working
folder with calls that follow links: a `leak.md -> ~/.ssh/id_ed25519` the
jail planted was read outside the jail and sent to the seats (external
models), and a retake could copy it into the session's prompt. The code
review read through a folder on the way replaced by a link. Now every file
of a folder the jail writes that the app reads goes through one function,
`confined_read.rs`: opened one component at a time from a folder held open,
never following a link (`openat` with `O_NOFOLLOW`), a regular file only
(a pipe answers at once instead of never), at most a bound. It serves the
council (git and dates modes; the dates walk also skips links), the review
(`read_current`), and the Files panel's previews, the image sent to the
model, downloads and saves, which resolved and checked a path, then read
it: they now read it again from `/` without following a link, so one put
in between is refused. Measured: under a profile like the jail's (reads
and writes refused on a credential store), `ln` to a file there is refused,
so a hard link cannot stand in for a link. The two other readers found
read names only (the mentions list skips links). `code/confined.rs` on the
code plan's branch does the same; FORK_NOTES says to make them one.

**The mark is not a proof (new in this lot).** The reaper took for the
jail's any process whose arguments or environment held
`SUBROSA_JAIL_MARK=<mark>` anywhere: a person's process started in a folder
the jail named after its mark (`PWD`) would have been frozen and killed,
and the belt let it through. Now the mark counts only as one whole
environment entry, and only on a process under the jail's profile
(`runs_under_the_jail`): every mark is given to a jailed spawn and the
profile is inherited for good, so a carrier outside the jail got the mark
some other way. Tested through the barrier: processes outside the jail
with the mark in `PWD`, as an argument, or as the exact entry are never
aimed at; a jailed carrier is.

**Git could wait for ever.** A named pipe included by `.git/config` made
every git the app runs wait without end, and the check ran synchronously on
the async runtime's thread. Now each git has a time limit (30 s; the test
uses 2 s); past it git's process group is killed (through the test barrier
in tests, which also lets through a process descending from the test
process itself, never one of the person's applications); and async callers
run the check and git on a blocking thread.

**Each layer, exactly.** The check does not read a submodule's
configuration, and `status` and `diff` went into submodules: a filter
there ran with the first two layers, only the profile stopped it. Now
`status` and `diff` always get `--ignore-submodules=all` on the command
line (measured: the same setting in the command's configuration loses to a
`submodule.<name>.ignore = none` the folder sets). Decision 14 now says
what each layer covers.

**A working tree elsewhere.** A `core.worktree` the folder sets had the
app's git describe files outside the repository (whether they exist, their
size). Measured: neither `-c core.worktree` nor the command's
configuration outranks it, `GIT_WORK_TREE` does; the app sets it to the
tree it found, the check refuses a folder that names another, and the
profile refuses even looking up the credential stores.

**A refusal is said.** The review's start returned a refused folder as
"no repository" and copied the folder instead; the council fell back to
the files' dates without a word. Now the review shows the refusal, and the
council's verdict carries a notice the person reads (and the seats see it
in the evidence). The release notes said so before it was true.

**The final kill.** It went to frozen pids and group numbers without
looking again; a frozen process can be killed by another of the jail and
its pid reused. Now each signal checks the pid and start time just before,
and a frozen group's members are killed one by one, never by the group's
number.

**Still open.** The review's revert checks the file and resolves its
folder, then writes: a folder on the way swapped for a link in between
could still carry that write elsewhere (not measured). Copying a Files
panel item to the clipboard hands Finder a path it reads later. The app's
git no longer reads the person's global configuration, so a repository's
git-lfs filter from there is not applied (its files whose dates changed
show as changed) and files ignored only by the global excludes file show
as new, which the council reads and sends to its seats. Trust in the
reaper rests on `sandbox_check`, a private interface.

## Addendum 2026-11-03: the person's ignores, secret files, and the revert's write

Two points the addendum above left open, closed in the same lot.

**The person's global excludes (a regression of this lot).** The app's git
stopped reading the person's global configuration, so a file ignored only
by their global excludes (an `.env`) showed as new, and the council read
it and sent it to its seats. Two independent layers now:

- The app's git reads the person's excludes file again, as a list of
  patterns. Its path is found without running git on the global
  configuration: `core.excludesFile` read as text from
  `$XDG_CONFIG_HOME/git/config`, then `~/.gitconfig` (the later wins),
  each `[include] path` followed as text, `~/` expanded; otherwise the
  default `$XDG_CONFIG_HOME/git/ignore`. It is passed as the command's
  `core.excludesFile`, and git's profile may read that file and no other.
  What cannot be resolved this way is said, not guessed: an
  `[includeIf]` (it depends on the repository) is not followed, and a
  relative path or `~user` is not resolved; then the default applies.
- Whatever git says, the council and the review never send a secret
  file's content: `path_confinement::SECRET_FILE_PATTERNS` (`.env`,
  `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `.npmrc`,
  `.pypirc`, `.netrc`, `credentials*`) and anything in a credential
  folder (`.ssh`, `.aws`...). The council leaves them out of its diff and
  its stat (git pathspecs built from the same list) and names them
  "content not sent: sensitive file"; the review lists them with no diff.
  The list lives in one place, with the Files panel's, for later reuse.

**The revert's write.** The code review's revert checked the file and its
folder, then wrote through paths: a folder on the way replaced by a link
in between would have carried the write elsewhere. It now writes the way a
confined read reads (`confined_read::write_beneath`): every folder on the
way opened without following a link (made when missing), the bytes written
to a new file beside the target, renamed over it within that folder; a
link at the name or on the way refuses the write. Removing a file goes the
same way. Tested with a folder replaced by a link between the checks and
the write: nothing lands outside.

What stays open is unchanged otherwise: the clipboard hands Finder a path,
the network rule names no address, launchd's private protocol, no jail on
Windows, and `sandbox_check` is a private interface.

## Addendum 2026-11-03: the re-audit (one list, one deadline, a strict barrier)

The re-audit (7.5/10) found no escape and no read of a file the jail
cannot read, confirmed D1 to D8, and left four points, closed here.

**One list of secret files.** `is_secret_file` checked the new patterns
but not the exact names and suffixes kept beside them in the same file, so
the council still sent `id_ecdsa`, `id_dsa`, `secrets.json`,
`.git-credentials`, `*.pfx`. `SECRET_FILE_PATTERNS` is now the only list,
for the council, the review, their git pathspecs and the Files panel, with
`*.env`, `.env-*`, `*.jks`, `*.ppk`, `*.keystore`, `.pgpass`, `secrets.*`
and `*service-account.json` added, compared without case (the file systems
of macOS and Windows do not tell case apart). `*.lock` is not a secret and
stays a Files panel lock only. These files are recognized by their name
only: a secret copied or hard-linked under a plain name in the working
folder is not recognized, and its content is read like any other file's.

**One deadline for git and its pipes.** The time limit covered git's exit
but not its pipes: a process git started that kept stdout open made a call
last as long as that process (6 s for a 1 s limit, measured by the
re-audit). Now one deadline covers both; past it, git's process group is
killed and the pipes are not waited on.

**The person's configuration read confined.** The person's git
configuration files were read with a plain read on every git call: a named
pipe they include would have blocked it. They are now read through the
confined reader (a regular file of a bounded size; a pipe answers at once),
after resolving the path (the person's `~/.gitconfig` may be a link to
their dotfiles, and the jail cannot write it), and the excludes file is
found once per start.

**The reaper's barrier strict again.** To let `jailed_git` stop its own
git in tests, the barrier had been widened to any process descending from
the test process. That is withdrawn: the barrier again lets through only
what the test registered. A separate entry, `killpg_child`, takes the
`Child` the caller spawned and holds and signals that child's own process
group and nothing else; `jailed_git` uses it for its time limit, the
reaper never does.

## Addendum 2026-11-04: three points of the security review

An automated security review of the pushed branch found three medium
points; the auditor confirmed the first and the third as medium, the
second as low. All three are closed at their cause.

**A task bound to a conversation the jail forged.** A task whose
conversation was not bound yet was matched by title and start time, in
the jail's home first, then in the shared one. The jail can read an
unrestricted conversation's title and start in the shared `state.db`, and
write in its own home a conversation with the same title and time: the app
bound the unrestricted task to it. Now a task is matched in the home of
the mode it was created in and only there; the app records that mode
(`hermes-task-homes.json`, beside the conversations' record, written by
the app alone) when the caller states it (`unrestricted` on task
creation). A task whose mode the app does not know (every task made
before this record) is matched in the shared home only, which only
processes outside the jail write, never in the jail's: a task created in
the jail and never bound stays unbound, which is safe. Tested with that
exact case: the real conversation in the shared home and its forged copy in
the jail's, same title, same time; the task gets the real one.

**Git's check failed open.** When `git config --list` failed (a
configuration git cannot read or parse), the folder was taken as safe.
It is now refused, with the message the person already reads.

**A local MCP server vouched for itself.** For a sign-in run from the
jail, the configured server is often a loopback or private address, and
its own origin vouched for itself: a jailed process listening on that
port could answer as the server and have the browser open an address of
its choosing. Two layers now. For a sign-in run from the jail, a server
that is local by its text or by any address it resolves to vouches for
nothing (neither itself nor what its metadata declares): the address is
shown to the person. And the jail's profile refuses to listen
(`network-bind`) anywhere but on its own unix sockets and the runtime's
dashboard port. Measured: `(deny network-bind)` followed by an allow by
port keeps that port alone, while a `(local ip "*:*")` deny also refuses
the allowed port; a unix socket needs its own allow; outbound HTTPS and
Python's multiprocessing are unaffected; with nothing bound, nothing comes
in, so no `network-inbound` rule is needed.

**And two secret names** (the auditor's): `*.tfvars` and `.htpasswd`.

**And the reaper on a loaded or different machine (CI, #479).** Two mark
sweeps found their carrier on the CI runner and stopped nothing. The cause,
measured locally: in its first milliseconds a process spawned by
`sandbox-exec` is not under the jail yet (the profile is applied after the
process starts, then a shim execs into its program, under the same pid and
start time), and the sweep kept its first "no" for the whole sweep. On the
runner the mark was visible in that window, so the sweep asked then, and
never again. A "no" about a process younger than a second is now asked
again on the next pass; a settled process's "no" is kept, so passes stay
fast enough for a process that forks in a loop. A second defect, found on
the way and not the CI's cause (the failing sweep lasted well under the
deadline): a pass that outlasted the five-second deadline (a loaded
machine) ended the sweep before freezing what it had found. The deadline
is now checked after the pass's finds are frozen: it makes a sweep
shorter, never more permissive. Both have a deterministic test, proved by
mutation.


## Addendum 2026-11-06: the shared home's plugin, rewritten whichever home starts

The first start under this ADR sets aside what a jailed process could have
planted in the shared home, but spares the app's own plugin folder
(`plugins/subrosa_guard`), which only the starting home's runtime rewrote.
When the sandboxed home starts first, a file planted there before this ADR
(a module beside the plugin, a `__pycache__` whose bytecode compiled
unchecked is loaded without its source) stayed for the gateway to load
outside the jail. `home_prep::prepare` now makes the shared home's plugin
folder exactly the app's two files right after the set-aside, whichever
home starts, and so does every gateway start (`before_the_gateway`).
Found by the security audit of the merge with the code plan.

## Addendum 2026-11-07: a gateway already running

Rewriting the shared home's plugin folder does not unload what a running
gateway loaded before. When a start finds there what was not the app's
(removed, `__pycache__` included, or one of the app's files holding
something else), it says so in the log and asks the shared home's gateway
to restart once (`quarantine::ask_gateway_restart`), which the next runtime
start does, on the shared home whichever home starts. A clean folder asks
nothing. Found by the re-audit of the merge with the code plan.
