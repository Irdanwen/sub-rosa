# ADR-0125: Feedback after an edit runs in the jail

Date: 2026-10-24. Status: accepted. Lot C1.3 of the Code plan, its
environment half (language-server diagnostics, builds and tests under the
jail); the formatter and the tree-sitter veto are added to this record by an
addendum when the next lot ships them. Builds on
[ADR-0014](0014-per-session-working-folder.md) (the working folder grant),
[ADR-0122](0122-the-code-plan-is-measured-on-a-local-bench.md) (the bench)
and [ADR-0123](0123-code-events-are-one-neutral-contract-with-two-adapters.md)
(the headless runtime). No migration.

## Context

The pinned Hermes already returns a language server's errors to the model
after `write_file` and `patch` (`agent/lsp/`, read in
[hermes-code-surface.md](../hermes-code-surface.md) §2), and already runs the
project's builds and tests through its terminal. In Sub Rosa neither worked:

- the runtime of an app started from the Dock has the launchd `PATH`, so
  every install logged "npm not on PATH" and no server ever started;
- with npm on `PATH`, the install still failed: npm writes `~/.npm`, Go
  writes `~/go` and `~/Library/Caches/go-build`, Cargo writes
  `~/.cargo/registry`, and the Seatbelt profile denies all of them;
- an install that did run happened inside the first edit's 8 s baseline
  budget, and a timeout there marks the server broken until the runtime
  restarts;
- TypeScript 7 (this repository's, and npm's latest) has no `tsserver.js`,
  which typescript-language-server needs;
- on the P0 bench, a Rust task in Sandboxed mode could not compile at all.

The plan's invariant is that language servers run inside the jail
(rust-analyzer runs build scripts, tsserver loads project plugins), and that
nothing is added as a managed Hermes patch.

## Decision

1. **One runtime environment, for the app and the CLI**
   (`src-tauri/src/code/toolchain.rs`, `apply_runtime_env`, called after
   `apply_isolated_hermes_env` by the app's spawn and by
   `hermes_bridge/headless.rs`):
   - `PATH` is the person's login-shell `PATH` (read once per app process
     with `$SHELL -l -i -c` under a Seatbelt profile that refuses every
     write, because the startup files it sources can sit in a folder the
     jail writes; bounded to 5 s, between markers), then the usual
     install folders that exist, then what the app inherited, then the
     system folders, and Hermes' own Node last as a fallback.
   - Every cache points inside the runtime's home, which the jail lets it
     write: `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GOPATH`,
     `GOMODCACHE`, `GOCACHE`, and a `CARGO_HOME` of its own
     (`$HERMES_HOME/cache/...`).
   - Cargo builds into `CARGO_TARGET_DIR=$HERMES_HOME/cache/cargo-target/<folder>-<hash>`,
     one per working folder: a plan run, which cannot write its folder, can
     still build and test it, and a run never fights the person's editor for
     `./target`.
   - `RUSTUP_HOME` stays the person's; `RUSTUP_AUTO_INSTALL=0` makes a
     toolchain the project pins and the machine lacks fail at once.
   - The environment hint tells the model that builds land in
     `$CARGO_TARGET_DIR`.
2. **The toolchains are read and run, never written.** The profile denies
   writes to `~/.cargo/bin` and the rustup home by name, after every grant,
   so even a working folder that spans `~/.cargo` leaves them read-only (the
   last matching rule wins). Reads stay open. Cargo's registry tokens
   (`~/.cargo/credentials.toml`, `~/.cargo/credentials`) join the credential
   stores the jail denies outright: a build never needs them. The profile's
   text moved, unchanged otherwise, to `hermes_bridge/sandbox_profile.rs`.
3. **The `lsp:` key is written explicitly** at every spawn (`lsp_config_block`):
   `enabled: true`, `wait_mode: document`, `wait_timeout: 5.0`,
   `install_strategy: auto` (Hermes' own install, now able to succeed in the
   jail, stays the fallback), and per server:
   - `typescript`: a launcher the app writes beside the Hermes home
     (`<data>/code-toolchain/typescript-lsp`, a folder the jail cannot write,
     so a run cannot rewrite what Hermes executes). From the server's root it
     looks for the project's TypeScript: without `tsserver.js` (TypeScript 7)
     it runs the project's `tsc --lsp`; otherwise typescript-language-server,
     which loads the project's own tsserver;
   - `pyright` and `gopls`: the preinstalled binaries, used when present;
   - `rust-analyzer`: the toolchain's real binary when the machine has one
     (rustup's proxy is resolved with `rustup which`, because it exists on
     every rustup machine and fails without the component), else
     `disabled: true`. It is never downloaded.
   The key is the same in both modes and with or without a working folder:
   Hermes gates the servers on a git worktree itself.
4. **Servers are preinstalled in the background, under the runtime's own
   jail** (`start_preinstall`): at each runtime start with a working folder,
   the folder's markers (two levels deep) decide what is needed, and the
   pinned packages are installed into `$HERMES_HOME/lsp/subrosa`
   (typescript-language-server 6.0.2 with TypeScript 6.0.3, the last line
   with a `tsserver.js`; pyright 1.1.414; gopls through `go install` with
   `GOBIN` there). One install at a time per app process, `--ignore-scripts`,
   logged to `$HERMES_HOME/logs/lsp-preinstall.log`, nothing waits for it.
   A separate prefix from Hermes' own `lsp/`, so a first edit that beats the
   preinstall and installs by itself never shares an npm tree with it. In
   Full mode the runtime is unjailed, and so is its preinstall.
5. **The app starts no language server.** The only programs it runs outside
   the jail for this are the person's login shell (to read `PATH`) and
   `rustup which`. Hermes starts every server, inside the jail.
6. **Measured, free, on this machine** (the numbers are in
   [hermes-code-surface.md](../hermes-code-surface.md), "Measurements"):
   `scripts/code-eval/lsp_latency.py` runs inside the real profile with the
   real environment, `lsp:` key and preinstall
   (`cargo test --lib --features code-cli lsp_latency_under_the_jail -- --ignored --nocapture`),
   and times `ShellFileOperations.write_file`, the path of Hermes' own
   tools. On 2026-10-24 the delay from an edit to its diagnostics has a p95
   at most 0.51 s for TypeScript (both servers), Python and Rust: the P1 gate
   (1.5 s) holds.

## Consequences

- Rust in Sandboxed mode builds and tests now; the jail tests
  (`hermes_bridge/toolchain_jail_tests.rs`) run `cargo test` on a crate and
  `npx tsc --noEmit` on a project under the real profile, and check that a
  write to `~/.cargo/bin` fails, also when a grant spans `~/.cargo`.
- The runtime's Cargo home downloads a project's crates once (network and
  disk under `$HERMES_HOME/cache`); the app's home and the CLI's each have
  their own. A tool installed with `cargo install` from a run lands there,
  not in `~/.cargo/bin`.
- The first run in a TypeScript or Python folder downloads about 4 packages
  from npm (3.5 s measured); a folder without npm on the person's `PATH`
  falls back to Hermes' in-jail install at the first edit.
- typescript-language-server pays 5 s on about half the edits: when Hermes
  takes the baseline of a file whose content the server already holds, the
  server apparently publishes nothing new, and Hermes waits its full 5 s
  before the write (19 of 39 warm edits in the measurement).
  The diagnostics after the write are not delayed (p95 0.51 s), the edit as
  a whole is (p95 5.5 s). TypeScript 7's `tsc --lsp` and pyright republish
  and do not pay it. The likely fix is in Hermes' client (it sends `didSave`
  after the write, not before the baseline wait) or in the server, not in a
  managed patch; it is noted for the next runtime bump.
- A cold rust-analyzer returns no diagnostics for the first edit while it
  loads the workspace; the following edits are right.
- Go is coded and unit-tested, not measured: Go is not installed on the
  machine this was built on.
- Windows gets the environment but no TypeScript launcher (it is a shell
  script) and no jail.
- The Code surface does not show the diagnostics yet: the matrix row stays
  `partial` until the tool rows of C2.1 display them.

## Alternatives rejected

- **Make `~/.npm` and `~/.cargo/registry` writable to the jail.** The
  extracted crate sources there are what the person's own unjailed builds
  compile; a run could rewrite them and escape the jail through the next
  `cargo build`.
- **Preinstall outside the jail into the Hermes home.** The home is writable
  from inside a run, so an unjailed npm writing there follows whatever
  symlinks a run planted; and on the machine this was built on, the
  person's own `node` is a symlink into the runtime's home, so an unjailed
  install would have executed a file a run can rewrite. The background install
  under the runtime's own profile gives the same head start with no new
  write outside the jail.
- **`hermes lsp install` from the app.** Same problem: the Hermes CLI reads
  the home's config and plugins, which a run can write, outside the jail.
- **Put the preinstalled servers' `node_modules/.bin` on `PATH`.** It would
  shadow the person's `tsc` and `pyright` in every terminal command; the
  `lsp.servers.<id>.command` overrides reach only Hermes' LSP layer.
- **Download rust-analyzer.** Not ours to install on a person's machine;
  without it, Rust diagnostics are off and said so in the log.
- **Keep `./target` in the project.** A plan run could not build, and a
  run's build would contend with the person's editor for the same lock.

## Addendum 2026-10-24: what the app runs outside the jail

The app runs exactly two programs of the person's outside the runtime's
jail: the login-shell probe, itself confined by a profile that refuses every
write, and `rustup which rust-analyzer`, taken only from `~/.cargo/bin` (whose
writes the jail refuses by name), `$CARGO_HOME/bin` or a system prefix, never
from the runtime's `PATH`, which holds folders the jail can write. Every other
program, language servers and their installs included, runs in the jail.
Cargo targets in the runtime's home are bounded: three folders, fourteen days
unused.
