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
| `--mode build\|plan` | `build` (default) may change the folder. `plan` keeps it read-only: the folder is not granted to the write jail, so the agent cannot write it, and it answers with a plan. Plan mode needs the jail and refuses to start without it. |
| `--budget <usd>` | The run budget, in dollars, required for a new run (at most 100). |
| `--resume <run_id>` | A new turn on an earlier run's Hermes session. The folder and the model stay the run's; the mode and the budget may change. |
| `--prompt <text>` / `--prompt-file <path>` | What to do. `--prompt-file -` reads stdin. |
| `--data-dir <folder>` | The app's data folder, when not this build's default. |
| `--approvals deny\|once` | What a command the runtime flags as dangerous gets, since no one is there to answer: `deny` (default) or `once`. |

Exit codes: `0` completed, `1` failed, `2` usage, `3` budget reached, `130`
interrupted (Ctrl-C or SIGTERM stop the turn cleanly, then the run ends).

### The key

`SUBROSA_DEV_API_KEY=cdm_…` first, in every build, without reading the
keychain: a keychain prompt would hang a run no one watches, and a CI runner or
a server has no keychain. Otherwise the key the app stored (the debug keychain
for a debug build). The base URL is the app's (`carpe-diem.json`), or the
default.

### The budget

What a run spent is what Carpe Diem metered on every completion that went
through the run's own proxy, plus what earlier invocations of the run spent.
A `usage` line reports it as it moves. Once it reaches the budget the turn is
interrupted and the run ends with `budget_exceeded`; since a completion is
metered when it ends, the run can end over the budget by at most one
completion. A model whose completions carry no price stops the run: the budget
could not be enforced.

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

Under `<data>/code-cli/`, outside the agent's write jail:

- `runs/<run_id>.json`: the run's state (folder, model, mode, budget, spent,
  Hermes session, last line number). `--resume` reads it.
- `hermes/`: the CLI's own Hermes home, apart from the app's (the app rewrites
  its home's `config.yaml` with its own proxy port at every start). Its
  `logs/dashboard.log` holds the runtime's output.
- `hermes-sandbox.sb`: the Seatbelt profile of the last run.
- `june-api.log`: the backend's log.
- `run.lock`: one run at a time per data folder. A lock left by a crashed run
  is taken over when its process is gone (on Windows, delete it by hand).

## What it does not do yet

- It runs Hermes only; Claude Code and opencode come with the ACP adapter (P4).
- No `step.recorded`: the step timeline is P1.
- No question goes to a person: the `clarify` toolset is off, sudo and secret
  requests are denied, and a flagged command follows `--approvals`.
- Without the macOS write jail (Linux, Windows, or
  `JUNE_HERMES_DISABLE_SANDBOX=1`), a build run writes anywhere the user can
  and says so on stderr, and plan mode refuses to run.
- The first run in a data folder seeds the CLI's Hermes home (skills, and the
  security scanner the runtime downloads on first use).

## Debugging

`SUBROSA_CODE_TRACE=<file>` appends every raw gateway frame, one per line. It
holds the conversation in clear: keep it local. It is how
`src/lib/code/fixtures/hermes-v0.19-run.frames.json` was recorded.
