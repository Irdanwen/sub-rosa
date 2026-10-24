# `subrosa-code`: a code run without a window

`subrosa-code run` runs Sub Rosa's agent on a folder, with no app window, and
writes what happens as JSON lines on stdout: one [code event](adr/0123-code-events-are-one-neutral-contract-with-two-adapters.md)
per line. It is what the code bench (C0.1), the GitHub workflow (C5.2) and the
server mode (C6.4) are built on. Diagnostics go to stderr; stdout carries
events only.

## Build

The binary is behind a Cargo feature, so the app bundle never includes it:

```sh
cd src-tauri
cargo build --features code-cli --bin subrosa-code            # debug
cargo build --release --features code-cli --bin subrosa-code  # release
```

It needs what the app already installed: the Hermes runtime under the data
folder (`<data>/hermes-runtime`, written the first time Sub Rosa starts the
agent) and the `june` backend.

- A **debug** build uses the debug data folder (`…/xyz.carpediem.subrosa-dev`)
  and runs `june-api/target/debug/june`, or `cargo run -p june` from
  `june-api/` when there is none. Set `SUBROSA_JUNE_API_BIN` to a built `june`
  to skip that (`$CARGO_TARGET_DIR/debug/june` when the target folder is
  shared).
- A **release** build uses the app's data folder and looks for `june-api`
  beside itself, with `config.toml` in `../Resources` (the app bundle's
  layout) or beside the binary. `SUBROSA_JUNE_API_BIN` overrides the program.

## Run

```sh
subrosa-code run --dir ~/src/project --model kimi-k2-7-code --budget 0.50 \
  --prompt "Add a --verbose flag to the CLI and a test for it"
```

| Option | Meaning |
|---|---|
| `--dir <folder>` | The folder the run works in. Refused like a Code mode folder: not a system folder, not the app's data folder, nothing that holds a credential store. |
| `--model <id>` | A Carpe Diem model id. |
| `--mode build\|plan` | `build` (default) may change the folder. `plan` keeps it read-only: the folder is not granted to the write jail and is denied by name at the end of the profile (so a folder under `/tmp` or `$TMPDIR` stays read-only too), and the agent answers with a plan. Plan mode needs the jail and refuses to start without it. It protects the local disk only: the network stays open, so a command that changes something elsewhere (a `git push`, an API call) is still possible when `--approvals once` lets a flagged command through. |
| `--budget <usd>` | The run budget, in dollars, required for a new run (at most 100). |
| `--resume <run_id>` | A new turn on an earlier run's Hermes session. The folder and the model stay the run's; the mode and the budget may change. |
| `--prompt <text>` / `--prompt-file <path>` | What to do. `--prompt-file -` reads stdin. |
| `--data-dir <folder>` | The app's data folder, when not this build's default. |
| `--approvals deny\|once` | What a command the runtime flags as dangerous gets, since no one is there to answer: `deny` (default) or `once`. |

Exit codes: `0` completed, `1` failed, `2` usage, `3` budget reached, `130`
interrupted. A first Ctrl-C or SIGTERM interrupts the turn and gives it up to
15 seconds to close; a second one stops the run at once. Either way the
backend and the runtime are stopped, and a run that crashed before stopping
them has them stopped by the next run in the same data folder (their pids are
recorded in `june-api.pid` and `hermes.pid`, and a process is stopped only if
it still runs the recorded program and nothing else owns it).

### The key

`SUBROSA_DEV_API_KEY=cdm_…` first, in every build, without reading the
keychain: a keychain prompt would hang a run no one watches, and a CI runner or
a server has no keychain. Otherwise the key the app stored (the debug keychain
for a debug build). The base URL is the app's (`carpe-diem.json`), or the
default.

The variable is taken out of the CLI's environment as soon as it is read,
before any thread or child starts, and its bytes are overwritten first:
`unsetenv` alone leaves the value in the environment block that `ps eww`
reads. The key then reaches the `june` backend on its stdin only, as the
app's sidecar does, and no child inherits a credential-shaped variable
(`child_env::scrub`). Seatbelt cannot help here: measured on macOS 26, its
`process-info*` rules do not cover `KERN_PROCARGS2`, so the jailed agent can
read the environment of any process of the user, which is why the key must
not be in one.

### The budget

What a run spent is what Carpe Diem metered on every completion that went
through the run's own proxy, plus what earlier invocations of the run spent.
A `usage` line reports it as it moves, and the run's state file records it at
the same moment, so a run killed outright resumes from what it had spent.
Once it reaches the budget the turn is interrupted and the run ends with
`budget_exceeded`.

The budget is a stop line, not a guaranteed ceiling. A completion is metered
when it ends, so the run sees the line only after the completion that crossed
it, and whatever else was in flight then is billed as well: the run can end
over the budget by what was in flight. A completion cut before its usage
arrived (an interrupt, a lost connection, a killed process) may still be
billed by the operator; the run cannot know how much, and `run.finished` then
carries `cost_incomplete: true`. A run killed with `kill -9` writes no
`run.finished` at all and loses the completion it was in.

A completion that comes without the operator's price stops the run: the
budget could not be enforced on it. A free model is priced (at zero) and
runs. Only streamed completions can tell the two apart; a buffered one always
reads as priced, because the backend writes its cost header as 0 when the
operator sent none (Hermes streams every turn).

## Output

Each line is a `CodeEventLine`: `schema` (1), `run_id`, `seq` (continued across
`--resume`), `at`, and the event's `type` and fields. The types and fields are
in `src/lib/code/events.ts` and `src-tauri/src/code/event.rs`. The stream
always ends with `run.finished`, also when the run failed before it started.

A real run, abridged (the `schema`, `run_id` and `at` of each line left out):

```json
{"seq":1,"type":"run.started","engine":"hermes","model":"kimi-k2-7-code","mode":"build","dir":"/work/e2e","budget_usd":0.02,"resumed":false,"sandboxed":true,"session_id":"20261023_102912_67b49a"}
{"seq":2,"type":"turn.started","turn_id":"turn-1"}
{"seq":3,"type":"message.delta","channel":"reasoning","text":"Simple"}
{"seq":10,"type":"tool.started","call_id":"write_file:0","name":"write_file","kind":"edit","label":"Writing hello.py"}
{"seq":11,"type":"tool.completed","call_id":"write_file:0","name":"write_file","kind":"edit","ok":true,"detail":{"path":"hello.py","edit":{"added":1,"removed":0,"diff":"--- a/hello.py\n+++ b/hello.py\n@@ -0,0 +1 @@\n+print(\"bonjour\")\n"}},"duration_ms":140}
{"seq":12,"type":"usage","input_tokens":11669,"output_tokens":86,"cached_tokens":0,"cost_usd":0.003912,"budget_usd":0.02}
{"seq":16,"type":"terminal.output","call_id":"terminal:0","text":"bonjour","exit_code":0,"truncated":false}
{"seq":44,"type":"message.completed","text":"J'ai créé `hello.py` …","interim":false}
{"seq":45,"type":"turn.finished","turn_id":"turn-1","status":"completed"}
{"seq":47,"type":"run.finished","status":"completed","cost_usd":0.006402,"turns":1}
```

## Where things are

Under `<data>/code-cli/`. Everything there is outside the agent's write jail
except `hermes/`, which is the runtime's own home and so one of its write
roots:

- `runs/<run_id>.json`: the run's state (folder, model, mode, budget, spent,
  Hermes session, last line number). `--resume` reads it.
- `hermes/` (writable by the agent): the CLI's own Hermes home, apart from the
  app's (the app rewrites its home's `config.yaml` with its own proxy port at
  every start). Its `logs/dashboard.log` holds the runtime's output. Its
  `cache/` holds the run's package caches, Cargo home and Cargo target
  folders (`cache/cargo-target/<folder>-<hash>`, so `./target` stays
  untouched), and `lsp/subrosa/` the language servers preinstalled in the
  background at each start (`logs/lsp-preinstall.log`). See ADR-0125.
- `code-toolchain/typescript-lsp`: the TypeScript language-server launcher
  Hermes runs (outside the jail's write roots).
- `hermes-sandbox.sb`: the Seatbelt profile of the last run.
- `june-api.log`: the backend's log.
- `june-api.pid`, `hermes.pid`: the processes the current run started, for
  the next run to stop if this one crashed.
- `run.lock`: one run at a time per data folder, an advisory `flock` the
  system releases when the run's process ends, crash included (on Windows, a
  plain file: delete it by hand after a crash).

The app's runtime folder (`<data>/hermes-runtime`, the venv the app itself
runs) is read and executed by a code run but never writable from it, in
either mode: an injected instruction must not change code the app will run
later.

## What it does not do yet

- It runs Hermes only; Claude Code and opencode come with the ACP adapter (P4).
- No `step.recorded`: the step timeline is P1.
- No question goes to a person: the `clarify` toolset is off, sudo and secret
  requests are denied, and a flagged command follows `--approvals`.
- No subagents: the `delegation` toolset is off. A delegated task can outlive
  the turn that started it, and the CLI stops everything when the turn ends;
  subagents come back with their own lifecycle in the Code surface (P3).
- Protected mode applies as in the app (`protected-mode.json` is read from
  the app's config folder): quiet hours refuse the run's completions and the
  memory switch is honoured.
- Without the macOS write jail (Linux, Windows, or
  `JUNE_HERMES_DISABLE_SANDBOX=1`), a build run writes anywhere the user can
  and says so on stderr, and plan mode refuses to run.
- The first run in a data folder seeds the CLI's Hermes home (skills, and the
  security scanner the runtime downloads on first use).

## Debugging

`SUBROSA_CODE_TRACE=<file>` appends every raw gateway frame, one per line. It
holds the conversation in clear, so the file is created (or narrowed) to
owner-only (`0600`): keep it local. It is how
`src/lib/code/fixtures/hermes-v0.19-run.frames.json` was recorded.
