# Hermes code surface (v0.19.0)

What the pinned Hermes runtime already gives a code surface, checked against
its source, and what that means for the Code plan (lot C0.4). Redo this sheet
at every runtime bump: the plan's P1 decisions depend on it.

- **Pinned source read:** Hermes Agent v0.19.0, commit `3ef6bbd2`
  (`HERMES_AGENT_INSTALL_COMMIT` in `src-tauri/src/hermes_bridge.rs`, pin note
  [hermes-upstream-v2026.7.20.md](hermes-upstream-v2026.7.20.md)), installed
  under `~/Library/Application Support/xyz.carpediem.subrosa-dev/hermes-runtime/hermes-agent`.
- **Compared with:** v0.17.0, commit `2bd1977d` (the copy the plan was first
  written from), left over since July in the production app's
  `hermes-runtime` folder, which the app no longer runs: the installed app
  launches the 0.19.0 runtime bundled in
  `Sub Rosa.app/Contents/Resources/native/hermes/` (`bundled_hermes_command`
  comes first in `hermes_bridge.rs`).
- **Method:** source reading, plus small experiments run under a Seatbelt
  profile shaped like Sub Rosa's (allow default, deny every write, re-grant a
  scratch folder and the temp dirs) with the pinned venv's Python. No Hermes
  file was modified and no paid call was made. Measured numbers come from
  toy repositories and only show orders of magnitude; P1 measures the p95 on
  real repositories.
- Paths below are relative to the Hermes source root unless they start with
  `src/` or `src-tauri/`.

## What Sub Rosa gives the runtime today

`render_hermes_config` (`src-tauri/src/hermes_bridge.rs`) plus
`guard::config_block` (`src-tauri/src/hermes_bridge/guard.rs`) write, at every
spawn, only these keys: `model.*`, `agent.max_turns: 200`,
`agent.gateway_timeout: 7200`, `agent.gateway_timeout_warning: 3600`,
`agent.gateway_auto_continue_freshness: 10800`, the vision keys,
`agent.disabled_toolsets: [browser]`, `approvals.mode: manual`,
`approvals.cron_mode: deny`, `display.skin: mono`,
`display.busy_input_mode: queue`, `platform_toolsets.cron`,
`skills.external_dirs`, `mcp_servers`, `plugins.enabled: [subrosa_guard]`,
and the memory switches under protected mode. Hermes deep-merges its
`DEFAULT_CONFIG` (`hermes_cli/config.py`) under them, so **every key this sheet
discusses (`lsp`, `checkpoints`, `tool_output`, `tool_loop_guardrails`,
`delegation`, `agent.coding_context`, `agent.verify_on_stop`,
`approvals.timeout`) runs at the Hermes default.**

`build_sandbox_profile` renders `(allow default)` then `(deny file-write*)`,
and re-grants writes to: `$HERMES_HOME`, the runtime dir, `/private/tmp`,
`/private/var/tmp`, `$TMPDIR`, `config.yaml` and its atomic temp, the
session's validated working folder (ADR-0014) when one is granted, and the
agent CLI state folders when the user opted in. Credential stores are denied
for read and write, last. Consequences used throughout this sheet:

- network, process exec and reads are open;
- `~/.npm`, `~/go`, `~/Library/Caches/*`, `~/.cargo` and `~/.rustup` are
  **not writable**;
- the child inherits the app's environment through
  `apply_isolated_hermes_env`, which removes credential-shaped variables but
  sets no `PATH`, `npm_config_cache`, `GOPATH` or `GOCACHE`. An app launched
  from the Dock has the launchd `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`).

## 1. Tolerant replacement: `tools/fuzzy_match.py`

**Exists:** yes (950 lines). Called by `ShellFileOperations.patch_replace`
(`tools/file_operations.py:1593`) and by the V4A applier
(`tools/patch_parser.py:298` validation, `:567` and `:582` application).

**API:**
`fuzzy_find_and_replace(content, old_string, new_string, replace_all=False) -> (new_content, match_count, strategy_name, error)`.
Pure function, no I/O.

**Strategies, in order** (first one with a match wins):

1. `exact`
2. `line_trimmed`: strip each line.
3. `whitespace_normalized`: collapse runs of spaces and tabs.
4. `indentation_flexible`: ignore leading indentation.
5. `escape_normalized`: turn literal `\n`, `\t`, `\r` in `old_string` into
   control characters (skipped when there is nothing to unescape).
6. `trimmed_boundary`: trim the first and last line only.
7. `unicode_normalized`: smart quotes, en and em dashes, ellipsis, NBSP
   folded to ASCII.
8. `block_anchor`: first and last lines must match after strip; the middle is
   scored with `difflib.SequenceMatcher`, threshold **0.50** for one
   candidate, **0.70** when several (no Levenshtein, no 0.65).
9. `context_aware`: a block matches when at least 50 % of its lines have a
   `SequenceMatcher` ratio of at least 0.80.

The module docstring still lists 8 items (it omits `unicode_normalized`); the
code runs 9.

**Guards:**

- uniqueness: more than one match without `replace_all` is refused
  ("Found N matches ... Provide more context"). There is no "disproportionate
  match" guard of the opencode kind;
- escape drift (`_detect_escape_drift`, only when the strategy is not
  `exact`): if `\'` or `\"` appear in both `old_string` and `new_string` but
  not in the matched region, the edit is refused with an error asking the
  model to re-read the file;
- `\t` and `\r` in `new_string` are unescaped only where the matched region
  holds the real control character (`_maybe_unescape_new_string`); `\n` never;
- non-exact matches re-indent `new_string` to the file's indentation
  (`_reindent_replacement`);
- **new in 0.19:** after `unicode_normalized`, the replacement keeps the
  file's Unicode characters in the unchanged parts
  (`_preserve_unicode_in_replacement`);
- on a plain "not found", `format_no_match_hint` appends "Did you mean one of
  these sections?" with the closest lines; `patch_tool` adds an escalating
  `_hint` after 3 consecutive failures on the same path.

**Which strategy was used: not exposed.** Both callers bind it to `_strategy`
and drop it; the module logs nothing; `PatchResult.to_dict()` has no field for
it; the gateway's `tool.complete` cannot carry it. The only way to know it
without a managed patch is to recompute it: `fuzzy_find_and_replace` is pure
and deterministic, so the `subrosa_code` plugin can call it at `pre_tool_call`
for `patch` in `mode="replace"` on the file's current content and record the
strategy against `tool_call_id` (and refuse nothing). V4A hunks go through the
same function per hunk (`_apply_update`), so the same trick works hunk by hunk
but costs a V4A parse in the plugin.

**Seatbelt:** nothing to say, the module is pure; the write goes through
`write_file` (see section 2).

**Since 0.17:** chain unchanged (already 9 strategies); Unicode preservation
added.

**Verdict:** the chain is **Déjà dans Hermes**. Recording the strategy is
**Porter** (small): recomputed by the plugin, not read from Hermes.

## 2. Diagnostics after an edit: `agent/lsp/`

**Exists:** yes (`__init__.py`, `manager.py`, `client.py`, `servers.py`,
`install.py`, `workspace.py`, `range_shift.py`, `reporter.py`, `eventlog.py`,
`cli.py`, `protocol.py`; 4,599 lines).

**Config key** (`hermes_cli/config.py:3284`, read by
`LSPService.create_from_config`):

```yaml
lsp:
  enabled: true            # default true: LSP is ON in Sub Rosa today
  wait_mode: document      # "document" or "full" (adds workspace pulls)
  wait_timeout: 5.0        # seconds to wait for fresh diagnostics
  install_strategy: auto   # "auto" | "manual" | "off" (off = manual)
  servers:                 # per server_id: pyright, typescript, gopls, rust-analyzer, ...
    <server_id>:
      disabled: true
      command: ["/abs/path/to/binary"]   # ONLY command[0] is used, must exist
      env: {KEY: value}                  # env of the server process, not of the install
      initialization_options: {...}
```

`command` is not a full argv: `_resolve_override` (`servers.py:807`) keeps
`command[0]` when that path exists and the spawn builder appends its own
arguments (`--stdio` for TypeScript). Arguments of your own need a wrapper
script.

**When it runs:** inside `ShellFileOperations.write_file`, only on the local
backend (`_lsp_local_only`). `patch` (replace mode) and each file of a V4A
patch go through `write_file`, so all three get it; `terminal` and
`execute_code` writes never do. Sequence:

1. before the write, `snapshot_baseline(path)` opens the file in its server
   and stores the current diagnostics (outer budget `max(8, wait_timeout + 3)`
   seconds);
2. the write; then the syntax tier (`_check_lint_delta`);
3. only if that tier is `success` or `skipped`, `get_diagnostics_sync(path,
   delta=True, line_shift=...)` waits up to `wait_timeout` (outer budget
   `wait_timeout + 2`) for **fresh** diagnostics, remaps the baseline through
   a line-shift map and keeps only the new ones.

**Gating:** the file must be inside a git worktree, found from the process
cwd or from the file itself (`workspace.py`), and some server must claim the
extension. A `(server_id, root)` pair that fails to spawn, initialise or
answer in the outer budget goes into a broken set **for the life of the
process** (`hermes lsp restart` or a runtime restart clears it).

**Returned to the model:** a separate `lsp_diagnostics` key in the tool's JSON
result (next to `lint` and `diff`):

```
LSP diagnostics introduced by this edit:
<diagnostics file="/abs/path">
ERROR [line:col] message [code] (source)
...
... and N more
</diagnostics>
```

ERROR severity only, at most 20 per file, 4,000 characters in total; message,
code and source are sanitised and HTML-escaped (new in 0.19). When the server
gives no verdict in time the result says nothing (no stale diagnostics, new in
0.19).

**Installation** (`install.py`), when a binary is on neither `PATH` nor
`$HERMES_HOME/lsp/bin`: npm (`npm install --prefix $HERMES_HOME/lsp`, 300 s
timeout, symlinked into `lsp/bin`) for pyright, typescript-language-server
(+ `typescript`), vue, svelte, astro, yaml, bash, intelephense, dockerfile;
`go install` with `GOBIN=$HERMES_HOME/lsp/bin` (600 s) for gopls; manual for
rust-analyzer, clangd, lua-language-server, powershell. No server uses the pip
path today. `hermes lsp install <id>`, `install-all`, `status --json` and
`which` exist (`agent/lsp/cli.py`).

**Under Sub Rosa's Seatbelt, verified:**

- **It has never worked in production.** The production runtime's
  `logs/agent.log` holds, from July to August:
  `[install] cannot install typescript-language-server: npm not on PATH` and
  the same for pyright; `$HERMES_HOME/lsp/bin` is empty. The app launched from
  the Dock has no npm on its `PATH`, although Hermes ships one in
  `$HERMES_HOME/node/bin`, which `install.py` does not look at.
- **npm install fails in the jail even with npm on `PATH`:** `npm install`
  writes its cache to `~/.npm`, which the profile denies
  (`EPERM ... /Users/<user>/.npm/_cacache/tmp/...`, reproduced). With
  `npm_config_cache` pointed inside a write root, the same install succeeds
  (pyright, about 2.5 s on a warm network).
- **go install would fail the same way** (`~/go`, `~/Library/Caches/go-build`
  not writable): `GOPATH`, `GOMODCACHE` and `GOCACHE` must point inside
  `$HERMES_HOME`. Not reproduced: Go is not installed on this Mac.
- **The install runs synchronously on the LSP event loop, inside the 8 s
  baseline budget.** A slower install (typescript is the largest package)
  makes the first edit time out and marks the pair broken for the whole
  process; the binary is there at the next runtime start. Pre-installing from
  the app (outside the jail, with `hermes lsp install <id>` or npm directly)
  avoids it.
- **TypeScript 7 breaks the TypeScript server.** typescript-language-server
  6.0.2 needs `tsserver.js`; TypeScript 7.0.2 (the version in this repository
  and the one npm installs today) has none, so initialise fails ("provides no
  tsserver.js") and the pair is broken. TypeScript 7 serves LSP itself as
  `tsc --lsp --stdio`. A wrapper set as `lsp.servers.typescript.command`
  (`exec "$PWD/node_modules/.bin/tsc" --lsp "$@"`, the server's cwd is the
  project root) worked in the jail: diagnostics came back in 0.12 to 0.28 s on
  a toy project. `node` must be on `PATH` for the `.bin/tsc` shim.
- **Measured once it runs:** pyright in the jail, first write (cold spawn)
  0.5 s, following writes 0.06 to 0.11 s, delta correct (a fix returns no
  block).
- **rust-analyzer:** not measured (the rustup component is not installed on
  this Mac). It writes `target/` in the project (writable when the folder is
  granted) and may need `~/.cargo` for registry metadata (not writable).
- **Side effects when no server answers:** the shell syntax tier runs instead.
  For `.ts` it is `npx tsc --noEmit FILE`: with TypeScript 7 and a
  `tsconfig.json` it reports TS5112 on every edit as a pre-existing error, and
  in a project without a local TypeScript, `npx` downloads the unrelated
  `tsc` npm package (network egress on every `.ts` edit). For `.rs`,
  `rustfmt --check` reports formatting differences as lint errors.
- Network is open in the jail, so installs reach `registry.npmjs.org` and
  `proxy.golang.org`; P4's egress list must name them.

**Since 0.17:** the baseline budget follows `wait_timeout`, fresh-only
diagnostics (no ghost errors), sanitised diagnostic text, a PowerShell recipe,
and pip installs routed through `hermes_cli.tools_config._pip_install`.

**Verdict:** the mechanism is **Déjà dans Hermes**, but in Sub Rosa it is
**Adapter**, not "allumer": C1.3 must set `PATH` (with `$HERMES_HOME/node/bin`
and the user's toolchains), `npm_config_cache`, `GOPATH`/`GOMODCACHE`/`GOCACHE`
inside `$HERMES_HOME` on the runtime's environment (Rust side, outside
Hermes), pre-install servers outside the edit path, and ship a TypeScript 7
wrapper. The `lsp` key itself only needs writing to pin the values.

## 3. Checkpoints: `tools/checkpoint_manager.py`

**Exists:** yes (1,675 lines; unchanged since 0.17 apart from small fixes).

**Config key** (`hermes_cli/config.py:1355`):

```yaml
checkpoints:
  enabled: false           # default off; Sub Rosa does not set it
  max_snapshots: 20        # per working directory
  max_total_size_mb: 500
  max_file_size_mb: 10
  auto_prune: true
  retention_days: 7
  delete_orphans: true
```

**Format:** one shared shadow git store under `$HERMES_HOME/checkpoints/store`
(`refs/hermes/<hash16>` per project, `indexes/<hash16>` per project index,
`projects/<hash16>.json` with the workdir), driven with `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE` so nothing lands in the project. One commit
per checkpoint.

**When:** `ensure_checkpoint` at most once per directory per turn
(`new_turn()` resets it), before `write_file` and `patch`, and before a
`terminal` command that matches `_DESTRUCTIVE_PATTERNS` (`rm`, `mv`, `cp`,
`sed -i`, `git reset|clean|checkout`, overwrite redirects...). Restored through
the gateway's `rollback.list`, `rollback.diff`, `rollback.restore`.

**Seatbelt:** the store is under `$HERMES_HOME`, so it would work.

**Why it stays off:** it snapshots once per turn, not per step, misses every
write that does not match the destructive patterns (`npm install`, a code
generator, `execute_code`), and would be a second source of truth next to the
C1.1 timeline. The plan's decision holds.

**Verdict:** **Déjà dans Hermes**, deliberately unused.

## 4. Large outputs: `tools/tool_result_storage.py`

**Exists:** yes (254 lines), with `tools/budget_config.py` and
`tools/tool_output_limits.py`.

**Three layers, and the thresholds are not opencode's:**

1. inside the tool: `terminal` truncates its output to
   `tool_output.max_bytes` (**50,000 characters**, 40 % head and 60 % tail,
   the middle is **dropped**, not saved); `read_file` pages at
   `tool_output.max_lines` 2,000 and `max_line_length` 2,000;
2. per result (`maybe_persist_tool_result`, called in
   `agent/tool_executor.py:952` and `:1648`): above **100,000 characters**
   (the tool's registered `max_result_size_chars`, capped by the budget) the
   full text is written to `<temp>/hermes-results/<tool_call_id>.txt` and the
   model gets a `<persisted-output>` block with a 1,500-character preview and
   the path. `read_file` is pinned to never persist;
3. per turn (`enforce_turn_budget`): above **200,000 characters** across a
   turn's results, the largest are persisted the same way.

`budget_for_context_window` scales layers 2 and 3 to 15 % and 30 % of the
model's window (4 characters per token, floors 8,000 and 16,000). None of
these numbers is in `config.yaml` except `tool_output`.

**Where the file goes:** `LocalEnvironment.get_temp_dir()` returns `$TMPDIR`
first, so `$TMPDIR/hermes-results/<sanitised tool_call_id>.txt` (sanitising is
new in 0.19). `$TMPDIR` is a write root, so it works in the jail; nothing
cleans it.

**Can the app find it:** the path is only inside the tool message the model
reads (and the session database). But the gateway already has the full text:
`tool_complete_callback` runs **before** persistence (`tool_executor.py:945`
then `:952`), so `tool.complete`'s `payload.result` carries the whole result.
For layer 2 and 3 the app can also rebuild the path from `tool_id` and the
runtime's `$TMPDIR`. For `terminal`, the 50,000-character truncation happens
first and nothing keeps the middle.

**Verdict:** **Déjà dans Hermes** for persistence. C1.6's "Voir la sortie
complète" is **Adapter**: show `tool.complete`'s payload (or the rebuilt path);
keeping a terminal output longer than 50,000 characters is **Porter**
(the plugin's `transform_terminal_output` hook sees the bounded output only,
so a full copy needs the command run through something that tees it, or a
higher `tool_output.max_bytes`).

## 5. Plugins: `hermes_cli/plugins.py`

**Loading:** a user plugin is `$HERMES_HOME/plugins/<name>/plugin.yaml` plus
`__init__.py` with `register(ctx)`, loaded only when listed in
`plugins.enabled` (the manifest's `hooks:` list is informational).
`ctx.register_hook(name, fn)` warns on an unknown name but keeps it.
Callbacks are called with keyword arguments only, each in its own
`try/except` (a raising hook is logged and skipped, which fails open), and
every hook also receives `telemetry_schema_version`. Plugins are global to the
process: one gateway process serves every session, so a plugin must key
everything on the `session_id` it is given and be thread-safe.

**Hooks in 0.19** (`VALID_HOOKS`, `plugins.py:135`):

| Hook | Kwargs | What the return value can do |
| --- | --- | --- |
| `pre_tool_call` | `tool_name, args, task_id, session_id, tool_call_id, turn_id, api_request_id, middleware_trace` | `{"action": "block", "message": str}` vetoes (message becomes the tool result); `{"action": "approve", "message": str, "rule_key": str}` sends the call to the human approval gate (**new in 0.19**, ignored by 0.17); first valid directive wins; anything else is observation. Cannot rewrite args (use `tool_request` middleware). |
| `post_tool_call` | `tool_name, args, result, task_id, session_id, tool_call_id, turn_id, api_request_id, duration_ms, status, error_type, error_message, middleware_trace` | observer only; also fired for blocked calls (`status="blocked"`, `error_type` `plugin_block`, `tool_scope_block`, `guardrail_block`) |
| `transform_tool_result` | same as `post_tool_call` without `middleware_trace` | first `str` returned replaces the result. Runs inside `model_tools.handle_function_call` only, so **not** for the agent-loop tools (`todo`, `memory`, `session_search`, `delegate_task`, `clarify`, `read_terminal`, memory-provider and context-engine tools) |
| `transform_terminal_output` | `command, output, returncode, task_id, env_type` (no `session_id`) | first `str` replaces foreground terminal output, before the 50,000-character cap |
| `transform_llm_output` | from `agent/turn_finalizer.py` | first `str` replaces the final response text |
| `pre_llm_call` | from `agent/turn_context.py` | `{"context": str}` or a string is injected into the user message for this turn |
| `post_llm_call`, `pre_api_request`, `post_api_request`, `api_request_error` | per call site | observers |
| `pre_verify` (**new in 0.19**) | `session_id, platform, model, coding, attempt, final_response, changed_paths` | `{"action": "continue", "message": str}` (or `{"decision": "block", "reason": str}`) keeps the turn going, bounded by `agent.max_verify_nudges` (3) |
| `on_session_start` | `session_id, model, platform` | observer (brand-new sessions only) |
| `on_session_end`, `on_session_finalize`, `on_session_reset` | per call site | observers |
| `subagent_start` | `parent_session_id, parent_turn_id, parent_subagent_id, child_session_id, child_subagent_id, child_role, child_goal` | observer |
| `subagent_stop` | `parent_session_id, parent_turn_id, child_session_id, child_role, child_summary, child_status, duration_ms` | observer |
| `pre_gateway_dispatch` | `event, gateway, session_store` | messaging gateway only (`skip`, `rewrite`, `allow`); not the WS gateway Sub Rosa uses |
| `pre_approval_request`, `post_approval_response` | `command, description, pattern_key, pattern_keys, session_key, surface` (+ `choice`, `decided_by`) | observers; cannot answer the approval |
| `kanban_task_claimed`, `kanban_task_completed`, `kanban_task_blocked` (**new in 0.19**) | `task_id, board, assignee, run_id, profile_name` (+ `summary` or `reason`) | observers |

**Middleware** (`hermes_cli/middleware.py`, already in 0.17, registered with
`ctx.register_middleware(kind, fn)`): `tool_request` may return
`{"args": {...}}` to rewrite a call's arguments; `tool_execution` wraps the
execution itself and receives `tool_name, args, original_args, task_id,
session_id, tool_call_id, turn_id, api_request_id, next_call`. Unlike
`transform_tool_result`, `tool_execution` wraps **every** tool, the agent-loop
ones included (`tool_executor.py:295`), so it is the one place to take a
snapshot before **and** after a single call.

**Facts P1, P3 and P7 depend on:**

- `session_id` is the **stored** session id (the state.db key the agent was
  built with, `_make_agent(... session_id or key)`), not the gateway's
  8-character runtime `sid` that WS events carry. Compression rotates it to a
  new id whose `parent_session_id` is the old one, and a delegated child has
  its own id with `parent_session_id` set: a role ledger must walk the lineage,
  as `subrosa_guard.is_temporary` already does.
- `tool_call_id` is the provider's call id, the same value as `tool_id` in
  the `tool.start` and `tool.complete` events.
- `pre_tool_call` fires **before** `tool.start` is emitted, once per call, on
  every dispatch path (sequential, concurrent, and inside `handle_function_call`
  for MCP tools). In a concurrent batch, all the batch's `pre_tool_call` run
  first, then the calls execute in parallel (up to 8 workers; `write_file` and
  `patch` on different paths do run in parallel), so a snapshot at
  `pre_tool_call` cannot separate two edits of one batch; `tool_execution`
  middleware can.
- `delegate_task` from the top-level model now always returns at once and the
  children run in the background (section 6), and `terminal(background=true)`
  keeps writing after its call returns: a snapshot around those calls does not
  bound their writes. The children's own calls do fire the hooks, with the
  child's `session_id`.
- An `approve` directive from a plugin inside a subagent thread goes through
  `tools.approval._run_approval_gate`; whether it reaches the gateway or is
  auto-denied (`delegation.subagent_auto_approve: false`) was not verified and
  matters for P3.

**How `src-tauri/src/hermes/subrosa_guard.py` uses it today:** one hook,
`pre_tool_call(tool_name, session_id, args, **_)`. It reads
`$HERMES_HOME/subrosa-guard.json` on each guarded call and returns `block` for
`memory`, `skill_manage` and the gallery-saving `june_media` tools in a
temporary chat (lineage walked through state.db, 16 levels), for memory and
past-chat tools under protected mode, and for connector tools ruled `deny`;
it returns `approve` with `rule_key="subrosa_connector:<tool>"` for connector
tools ruled `ask` or unknown. It fails closed on its own errors. It also
installs a logging filter on `agent.turn_context`. The `approve` directive is
new in 0.19; a 0.17 runtime would ignore it and run the call, which is one more
reason the pin and the bundled runtime must move together.

**Verdict:** **Déjà dans Hermes.** P1's plugin (`subrosa_code`) has what it
needs: `pre_tool_call` to veto (tree-sitter) and to recompute the fuzzy
strategy, `tool_execution` middleware for per-call snapshots, and
`transform_tool_result` to append formatter output. It must be added to
`plugins.enabled` in `guard::config_block` or next to it.

## 6. Delegation: `delegate_task` (`tools/delegate_tool.py`)

**Schema in 0.19:** `goal`, `context`, `tasks[{goal, context, role}]`,
`role` (`leaf` | `orchestrator`), `background` (documented as ignored).
**0.17's `toolsets`, `acp_command` and `acp_args` parameters are gone.**

**Behaviour:**

- delegations from the top-level model always run in the background
  (`run_agent.py:6258`, `background=(not _is_subagent)`): the call returns
  handles, the work continues after the turn, and the results re-enter the
  conversation as a new message; an orchestrator child's own delegations stay
  synchronous;
- toolsets: a child inherits the parent's enabled toolsets minus
  `DELEGATE_BLOCKED_TOOLS` (`delegate_task`, `clarify`, `memory`,
  `send_message`, `execute_code`, `cronjob`); orchestrators keep delegation.
  There is no per-call or per-profile toolset any more;
- the child is an `AIAgent` with `platform="subagent"`,
  `skip_context_files=True` (it does not read `AGENTS.md`), `skip_memory=True`,
  its own `session_id` with `parent_session_id` set, approvals resolved
  non-interactively (auto-deny unless `delegation.subagent_auto_approve`);
- config (`delegation.*`, all defaults in Sub Rosa): `model`, `provider`,
  `base_url`, `api_key`, `api_mode` (global for every child),
  `inherit_mcp_toolsets: true`, `max_iterations: 50`,
  `max_summary_chars: 24000`, `child_timeout_seconds: 0`,
  `reasoning_effort`, `max_concurrent_children: 3`, `max_spawn_depth: 1`,
  `orchestrator_enabled: true`, `subagent_auto_approve: false`.

**Gateway events** (relayed from `tool_progress_callback`,
`tui_gateway/server.py` `_on_tool_progress`): `subagent.spawn_requested`,
`subagent.start`, `subagent.thinking`, `subagent.tool`, `subagent.progress`,
`subagent.complete` (and `subagent.text`, which is only mirrored to a child
window). Payload: `goal, task_count, task_index`, and when known
`subagent_id, parent_id, child_session_id, depth, model, tool_count,
toolsets, tool_name, text, tool_preview, status, summary, duration_seconds`,
and on completion `input_tokens, output_tokens, reasoning_tokens, api_calls,
files_read, files_written, output_tail`. A child's tool events carry its tool
name and a preview, **not** a tool call id, arguments or result. Plugin hooks
`subagent_start` and `subagent_stop` fire too. Method `subagent.interrupt`
stops one.

**Verdict:** delegation is **Déjà dans Hermes**; delegation **profiles**
(C3.3: a read-only `explore`, a model per profile) are **Porter**: the role
must be enforced by the plugin on the child's `session_id` and described in
the goal, since neither the schema nor the config can scope a child's tools.

## 7. V4A patches: `tools/patch_parser.py` and `patch`

**Exists:** yes. `patch` has `mode: "replace"` (default; `path`,
`old_string`, `new_string`, `replace_all`) and `mode: "patch"` (`patch`: a V4A
body, `*** Begin Patch` / `*** Update File:` / `*** Add File:` /
`*** Delete File:` / `*** Move File: a -> b` / `*** End Patch`). V4A is
validated in full before anything is written, applies hunks through
`fuzzy_find_and_replace`, and aggregates `lsp_diagnostics` per file. New in
0.19: context-only hunks are skipped, a patch with no change is refused, error
messages name the hunk number. V4A header paths with `..` are refused.

**How a model chooses:** by setting `mode`. The schema offers both modes to
every model; there is no config key, no per-model routing and no way to hide
one mode through config.

**Forcing a format:** only by prompt (C1.4's per-family block), or by the
plugin refusing the other mode at `pre_tool_call`. The hook does not receive
the model, so the plugin would read it from the session row (state.db
`sessions.model`) or from a ledger the app writes.

**Verdict:** **Déjà dans Hermes**; per-family routing is **Adapter** (prompt,
optional plugin veto), as planned.

## 8. ACP: `acp_adapter/`

**Exists:** yes (`server.py`, `session.py`, `events.py`, `tools.py`,
`permissions.py`, `edit_approval.py`, `provenance.py`, `auth.py`, `entry.py`;
all but `auth.py` and `provenance.py` changed since 0.17).

**Exposes:** `initialize`, `authenticate`, `new_session`, `load_session`,
`resume_session`, `fork_session`, `list_sessions`, `prompt`, `cancel`,
`set_session_model`, `set_session_mode` (Default, Accept Edits, Don't Ask,
mapped to edit approval policies), `set_config_option`; slash commands
`/help /model /tools /context /reset /compact /steer /queue /version`; tool
call start and completion updates with diffs for edits; the `todo` result as
an ACP `plan`; usage updates; session provenance when compression rotates the
internal id. Toolset `hermes-acp`. The agent does its own file I/O; ACP client
`fs` and `terminal` capabilities are not used.

**Lost compared with the WS gateway:**

- `clarify` (not in the `hermes-acp` toolset), sudo and secret prompts (no
  callbacks), `read_terminal`;
- subagent events (`make_tool_progress_cb` handles `tool.started` only;
  `subagent.*`, `tool.output_risk`, `reasoning.available` are dropped), and
  tool call ids are synthesised and matched by tool name in FIFO order;
- background process wake-up (`notify_on_complete`): no completion poller, no
  `agent.terminal.output`;
- `session.branch` and `session.compress` as methods: ACP has `fork_session`
  and `/compact` instead, which partly cover them; no `session.undo`,
  `rollback.*`, `process.*`, `session.steer` method (only `/steer` text).

**Concurrency defect:** `prompt` runs the agent on a shared
`ThreadPoolExecutor(max_workers=4)` (`server.py:90`) and sets the process-wide
`os.environ["HERMES_SESSION_ID"]` around each run (`server.py:1510-1531`), so
two concurrent prompts overwrite each other's value (read by
`tools/kanban_tools.py` and skill templating). 0.19 moved
`HERMES_INTERACTIVE` (the approval routing flag, a security issue in 0.17) to a
context variable; `HERMES_SESSION_ID` stays global. The gateway shares the same
variable through `agent/agent_init.py:1292`, so nothing should key on it.

**60-second approval:** `make_approval_callback(..., timeout=60.0)`
(`acp_adapter/permissions.py:114`) and
`make_acp_edit_approval_requester(..., timeout=60.0)`
(`acp_adapter/edit_approval.py:290`), called without override at
`server.py:1421` and `:1425`. A timeout answers `deny`. Not configurable
(`approvals.timeout` is not read there).

**Verdict:** the plan's reading holds: **keep the WS gateway** for Hermes.
ACP is fine for an external engine in its own process, one session per
process.

## 9. Output risk: `tool.output_risk` and `tools/threat_patterns.py`

**New in 0.19.** `make_tool_result_message`
(`agent/tool_dispatch_helpers.py:470`) wraps the output of untrusted tools in
`<untrusted_tool_result>` delimiters (output over 32 characters, embedded
delimiters defanged) and scans it with
`threat_patterns.scan_for_threats(text, scope="context")`. Untrusted tools are
`web_search`, `web_extract`, `browser_*` and `mcp_*` (Sub Rosa's built-in MCP
servers included). **`read_file`, `search_files` and `terminal` are not
scanned**, so instructions planted in a repository reach the model unmarked.

The result is metadata on the message (`_tool_output_risk`), never a block or
a redaction. When the risk is not `low`, the gateway emits
`tool.output_risk` with `{tool_id, name, risk: "high", findings: [pattern
ids], redacted: false}`. Pattern ids are deterministic
(`sys_prompt_override`, `html_comment_injection`, `hidden_div`,
`identity_override`, ...); the raw text is never included.
`src/lib/hermes-control-plane/event-classifier.ts` classifies the event as
`unsupported` on purpose.

**Verdict:** **Déjà dans Hermes** for web and MCP output; extending it to
repository content (C8.1) is **Porter**: call `scan_for_threats` from the
plugin's `transform_tool_result` on `read_file` and `terminal`.

## 10. Gateway events relevant to a code surface (`/api/ws`)

Frames are `{"jsonrpc": "2.0", "method": "event", "params": {"type",
"session_id" (runtime sid), "payload"}}` (`tui_gateway/server.py:1207`).

| Event | Payload in 0.19 | In the app today |
| --- | --- | --- |
| `tool.generating` | `{name}` while the model streams a call's arguments | not classified (falls to `unsupported`) |
| `tool.start` | `{tool_id, name, context}`, plus `args_text` when `display.tool_progress` is `verbose` | `tool` start |
| `tool.complete` | `{tool_id, name, args, duration_s, result}` (`result` is the parsed JSON: `diff`, `lint`, `lsp_diagnostics`, `files_modified`, `resolved_path`, `_warning`, `_hint`, `error`...), `summary`, `result_text` (verbose), `todos` (for `todo`), `inline_diff` (ANSI-coloured terminal rendering) | `tool` complete; `lsp_diagnostics`, `diff`, `todos`, `inline_diff` unread |
| `tool.progress` | **never emitted** by the 0.19 gateway (and not by 0.17): progress types other than those below are dropped | classified, dead path |
| `tool.output_risk` | see section 9 | `unsupported` on purpose |
| `agent.terminal.output` (**new in 0.19**) | `{process_id, chunk}` live output of **background** processes (`terminal(background=true)`), routed to the owning session | not handled |
| `terminal.close` (**new**) | `{process_id}` | `unsupported` (matrix) |
| `background.complete` | `{task_id, text}` for `prompt.background` | lifecycle |
| `subagent.*` | section 6 | `background_activity` |
| `approval.request`, `clarify.request`, `sudo.request`, `secret.request`, `terminal.read.request` | blocking requests | `pending_action` (not `terminal.read.request`) |
| `message.start`, `message.delta`, `message.interim` (**new**), `message.complete`, `thinking.delta`, `reasoning.delta`, `reasoning.available` | transcript | transcript and reasoning |
| `status.update`, `session.info`, `notification.show`, `notification.clear`, `error` | lifecycle | lifecycle or error |

**Foreground terminal output is not streamed**: a `terminal` call without
`background` produces its output only in `tool.complete`. Live output exists
only for background processes (`agent.terminal.output`) and through
`process.list` (method). The todo list arrives as `tool.complete.todos` for
`name == "todo"` (full list; `tool.start` args may be a partial merge).
Event emission for tools is gated by `display.tool_progress` (default `all`;
`off` suppresses `tool.start` and `tool.complete` unless there is an inline
diff).

## 11. Branch, undo, compress (gateway methods)

- `session.branch {session_id, name?}`: copies the **whole** history into a
  new stored session (`parent_session_id` = source, `_branched_from` marker)
  and returns `{session_id (runtime sid), title, parent}`. It has **no
  message parameter**: the `from_message_id` the app sends
  (`hermes-control-plane/methods.ts:139`) is ignored. The app reaches "Branch
  here" by branching, then sending `/undo N` through `command.dispatch`.
- `session.undo {session_id}`: refused while a turn runs (4009); pops the
  trailing assistant and tool messages and the last user message from the
  live history; returns `{removed}`. Turn granularity only: a step inside a
  turn cannot be undone. It edits the in-memory history; files are untouched.
- `session.compress {session_id, focus_topic?}`: manual compression.
- `rollback.list`, `rollback.diff {hash, file_path?}`,
  `rollback.restore {hash, file_path?}`: checkpoint manager (section 3), empty
  while checkpoints are off.
- Also: `session.steer {text}` (queued into the next tool result),
  `session.interrupt`, `process.list`, `process.kill {process_id}`,
  `process.stop`, `subagent.interrupt`, `spawn_tree.list|load|save`.

New methods since 0.17 (122 against 90): `session.context_breakdown`,
`usage.bars`, `verification.status`, `project.facts`, `projects.*`,
`learning.*`, `llm.oneshot`, `pet.*`, `subscription.*`; `credits.view` is gone.

## 12. Approval timeout on the gateway

Configurable: `approvals.timeout` (default **60** seconds, `config.py:2677`),
read by `tools.approval._get_approval_timeout()` for the gateway queue
(`approval.py:3115`); the wait touches the activity tracker every ~10 s so the
gateway inactivity timeout does not fire meanwhile. A timeout is a denial
("Silence is not consent"). Sub Rosa does not set it, so the gateway also
refuses after 60 s today. Other blocking requests in `tui_gateway` are
hard-coded in `_block`: `clarify` 300 s, `secret` 300 s, `sudo` 120 s,
`terminal.read` 30 s (`agent.clarify_timeout` only applies to the messaging
gateway). A long timeout still holds the agent thread: the turn cannot be
parked and resumed later, only kept waiting.

## Other things in 0.19 that the plan should know

- **Loop guardrails already exist** (`agent/tool_guardrails.py`, config
  `tool_loop_guardrails`): warnings on by default after 2 identical failures,
  3 failures of one tool, 2 idempotent no-progress calls; hard stops opt-in
  (5, 8, 5). Blocked calls report `error_type="guardrail_block"`. C1.6's doom
  loop card can start from these.
- **Fail-closed write gate:** `write_file` refuses JSON, YAML and TOML content
  that does not parse, before touching disk (new in 0.19). Python only gets a
  post-write report. C1.3's tree-sitter veto covers the other languages.
- **Coding posture** (`agent/coding_context.py`, `agent.coding_context:
  auto`, `agent.coding_instructions`): on interactive surfaces in a git repo or
  project root, Hermes already injects a coding brief and a git snapshot into
  the stable system prompt; `focus` also narrows toolsets. C1.4's per-family
  blocks come on top of it.
- **Verification closure** (`agent.verify_on_stop`, default `auto`, which is
  on for interactive coding surfaces, desktop included; config migrations 31
  and 32 switch it off on existing installs, and Sub Rosa rewrites
  `config.yaml` without the key at each spawn, so the effective value in the
  app was not established here): after edits, the agent is nudged to produce
  verification evidence; `pre_verify` lets a plugin keep the turn going. P7's
  app-run checks should pin this key explicitly.

## Plan assumptions against 0.19

| The plan assumes | True in 0.19 | Consequence for P1 |
| --- | --- | --- |
| fuzzy_match: 9 strategies, Levenshtein 0.65 anchors, uniqueness, disproportion refused, escape guard | 9 strategies; anchors scored by `SequenceMatcher` 0.50 / 0.70; uniqueness yes; no disproportion guard; escape-drift guard yes; Unicode preservation added | Mechanism usable as is |
| The bench can record the strategy of each edit | The strategy is computed then dropped; no field, no log | Plugin recomputes it at `pre_tool_call` (S, add to C0.1/C2.1) |
| LSP on by default in a git repo, servers auto-installed into `HERMES_HOME/lsp/bin`; "rendre la clé lsp" | On by default, but never worked in production: npm not on `PATH`, npm cache denied by the jail, install inside an 8 s budget, TypeScript 7 incompatible with typescript-language-server | C1.3 grows: env on the runtime process, pre-install outside the jail, TS 7 wrapper, server matrix to measure |
| Diagnostics: wait 5 s max, first 20 errors | 5 s fresh wait, ERROR only, 20 per file, 4,000 characters, delta against a pre-edit baseline | As planned |
| Checkpoints: shadow git, off | Yes; once per turn, before edits and destructive-looking commands | Stays off; C1.1 unchanged |
| tool_result_storage: above 2,000 lines or 50 KB, output saved, path to the model | 100,000 characters per result, 200,000 per turn, scaled to the window; terminal output cut at 50,000 characters before that, middle lost | "Voir la sortie complète" reads `tool.complete`; full terminal output needs its own capture |
| `pre_tool_call` and `transform_tool_result` hooks with `session_id` | Both exist; `pre_tool_call` gets `session_id` (stored id), `tool_call_id`, `turn_id`, can `block` or `approve`; `transform_tool_result` skips agent-loop tools | Plugin design holds; use `tool_execution` middleware for before/after snapshots |
| Snapshot at `pre_tool_call` of `terminal`, `patch`, `write_file`, `execute_code`, `delegate_task` bounds each step | Parallel batches run after all their pre-hooks; `delegate_task` is always background from the top level; background terminals keep writing | C1.1/C1.2: middleware per call plus the watcher; child calls attributed through their own `session_id` |
| Delegation profiles through `delegate_task` (C3.3) | No `toolsets` or `acp_command` parameter any more; children inherit parent toolsets minus a fixed blocklist; config is global | C3.3 becomes plugin enforcement by child `session_id` |
| Roles applied by `subrosa_guard.py` on `session_id` (P3, P7) | Works, but ids rotate on compression and children have their own ids | Ledger lookups must walk `parent_session_id` |
| V4A for GPT, search and replace for the others, chosen by prompt | Both modes offered to every model; no config to force | Prompt, optional plugin veto (needs the model from state.db or a ledger) |
| ACP loses clarify, sudo, secret, subagents, output_risk, compress, branch, wake-up; shares `os.environ`; refuses approvals after 60 s | Confirmed; ACP has `fork_session` and `/compact` as partial substitutes; `HERMES_INTERACTIVE` fixed, `HERMES_SESSION_ID` still global; 60 s hard-coded | Gateway stays the contract |
| Only ACP refuses approvals after 60 s | The gateway also refuses after 60 s by default, but `approvals.timeout` is configurable | Render `approvals.timeout`; parking a turn is still impossible |
| `session.branch` and `/undo` give a conversation rewind per step | Branch copies the whole history (no message parameter); undo removes whole user turns | C2.3's conversation rewind is per turn, not per step |
| Doom-loop detection is missing | `tool_loop_guardrails` exists (warnings on) | C1.6 can build its card on it |
| Streamed shell output | Only background processes stream (`agent.terminal.output`); foreground output comes at completion | Terminal panel (P2) needs background runs or its own streaming |
| `tool.output_risk` covers injection in results | Only web, browser and MCP output | C8.1 must scan repository reads itself |

## Gaps that require re-estimating a lot

1. **C1.3 (LSP and formatters):** from "write the `lsp` key" to environment
   work on the runtime spawn (`PATH` with `$HERMES_HOME/node/bin`,
   `npm_config_cache`, `GOPATH`/`GOMODCACHE`/`GOCACHE`), a pre-install step
   outside the jail and outside the 8 s edit budget, a TypeScript 7 wrapper
   (`tsc --lsp`), and a per-language check (rust-analyzer and gopls not yet
   measured under the jail). Stays M only if the formatter part is unchanged;
   likely M to L.
2. **C1.1 and C1.2 (timeline and attribution):** a `pre_tool_call` snapshot
   cannot separate parallel edits, nor bound background terminals or
   `delegate_task`, which now always runs after its call returns. Plan
   `tool_execution` middleware snapshots plus the watcher, and attribution of
   subagent writes by child `session_id`.
3. **C3.3 (delegation profiles):** `delegate_task` lost per-call toolsets and
   `acp_command`; profiles must be enforced by the plugin on child sessions.
   From M to M to L.
4. **C2.3 (rewind):** the conversation side rewinds whole user turns only
   (`session.branch` ignores `from_message_id`; `/undo` pops turns). A step
   inside a turn can be reverted on disk but not in the conversation.
5. **C0.1 and C2.1 (strategy in the bench and on the tool row):** the strategy
   is not exposed; add its recomputation in the plugin (S).
6. **C1.6 (full output link):** terminal output beyond 50,000 characters is
   lost before persistence; either raise `tool_output.max_bytes` or capture
   the output separately. Doom-loop detection can reuse
   `tool_loop_guardrails` (smaller than planned).
7. **P6 and the phone approval (section 5, invariants):** the gateway's
   approval wait is configurable (`approvals.timeout`) but still holds the
   agent thread; a parked turn needs the plugin to block and the app to
   re-issue the turn, not a longer timeout.
8. **C8.1 (classifier on trust labels):** `tool.output_risk` does not cover
   `read_file` or `terminal`; scanning repository content is extra work.

No module the plan relies on is missing in 0.19: `fuzzy_match`, `agent/lsp`,
`checkpoint_manager`, `tool_result_storage`, `patch_parser`, the plugin hooks
and `acp_adapter` are all present. The re-estimates come from behaviour, not
from absence.
