#!/usr/bin/env node
//
// Builds the `june-api` backend as a release binary and stages it as a Tauri
// `externalBin` sidecar named `binaries/june-api-<target-triple>` so it is
// bundled (and, on macOS, signed) with the Sub Rosa app.
//
// Usage:
//   node scripts/build-sidecar.mjs                 # host target triple
//   node scripts/build-sidecar.mjs --target <triple>
//   node scripts/build-sidecar.mjs --check         # warn if the staged binary
//                                                  # is older than june-api
//
// The `--check` mode exists because nothing in the local loop rebuilds this
// binary: `pnpm tauri:dev` runs the app against whatever was last staged here,
// and the build itself only ever runs in `release.yml`. So a fix landed in
// `june-api/` can be committed, tested and merged while the running app keeps
// executing a months-old sidecar — which is exactly how a corrected model
// price stayed invisible in the desktop picker long after the fix.
//
// Tauri resolves `externalBin: ["binaries/june-api"]` to
// `binaries/june-api-<triple>` at bundle time, so the suffix must match the
// triple Tauri builds the app for.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(rootDir, "june-api");
const binariesDir = join(rootDir, "src-tauri", "binaries");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const target = optionValue(args, "--target") ?? hostTargetTriple();
const isWindows = target.includes("windows");
const exeSuffix = isWindows ? ".exe" : "";

if (checkOnly) {
  process.exit(reportStaleness(join(binariesDir, `june-api-${target}${exeSuffix}`)));
}

console.log(`[build-sidecar] building june-api for ${target}`);

ensureTargetInstalled(target);

const build = spawnSync(
  "cargo",
  ["build", "-p", "june", "--release", "--locked", "--target", target],
  { cwd: apiDir, stdio: "inherit" },
);
if (build.status !== 0) {
  console.error("[build-sidecar] cargo build failed");
  process.exit(build.status ?? 1);
}

const builtBinary = join(apiDir, "target", target, "release", `june${exeSuffix}`);
if (!existsSync(builtBinary)) {
  console.error(`[build-sidecar] expected binary not found: ${builtBinary}`);
  process.exit(1);
}

mkdirSync(binariesDir, { recursive: true });
const dest = join(binariesDir, `june-api-${target}${exeSuffix}`);
copyFileSync(builtBinary, dest);
if (!isWindows) chmodSync(dest, 0o755);
console.log(`[build-sidecar] staged ${dest}`);

function optionValue(argv, option) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option) return argv[index + 1];
    if (argv[index].startsWith(`${option}=`)) return argv[index].slice(option.length + 1);
  }
  return undefined;
}

function hostTargetTriple() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /host:\s*(\S+)/.exec(out.stdout ?? "");
  if (!match) {
    console.error("[build-sidecar] could not determine host target triple");
    process.exit(1);
  }
  return match[1];
}

function ensureTargetInstalled(triple) {
  // Run rustup FROM the june-api dir so it operates on the toolchain pinned by
  // june-api/rust-toolchain.toml (currently 1.95.0), not the ambient default.
  // Cross-compiling the sidecar otherwise fails with "can't find crate for
  // `core`" because the target was only added to `stable`.
  const installed = spawnSync("rustup", ["target", "list", "--installed"], {
    cwd: apiDir,
    encoding: "utf8",
  });
  if (installed.status === 0 && !installed.stdout.split(/\s+/).includes(triple)) {
    console.log(`[build-sidecar] installing rust target ${triple} for june-api's toolchain`);
    spawnSync("rustup", ["target", "add", triple], { cwd: apiDir, stdio: "inherit" });
  }
}

/**
 * Compare the staged binary against the newest source file under `june-api/`.
 *
 * Returns 0 when it is current (or when there is nothing to compare), 1 when
 * it is stale. Deliberately a warning rather than a build step: rebuilding
 * takes minutes, and the person who just edited `june-api/` is the one who
 * should decide when to pay for it. What they must not do is not know.
 */
function reportStaleness(binaryPath) {
  if (!existsSync(binaryPath)) {
    console.warn(
      `[build-sidecar] no sidecar staged at ${binaryPath}\n` +
        "[build-sidecar] the app will fail to start its backend. Run: make sidecar",
    );
    return 1;
  }
  const staged = statSync(binaryPath).mtimeMs;
  const newest = newestSourceMtime(apiDir);
  if (newest === null || newest <= staged) {
    return 0;
  }
  const days = Math.round((newest - staged) / 86_400_000);
  console.warn(
    `[build-sidecar] the staged sidecar is OLDER than june-api/ by ${days} day(s).\n` +
      "[build-sidecar] the running app is executing the old backend, so any june-api\n" +
      "[build-sidecar] fix since then is not in effect. Run: make sidecar",
  );
  return 1;
}

/** Newest mtime of any source file under `dir`, ignoring build output. */
function newestSourceMtime(dir) {
  let newest = null;
  const skip = new Set(["target", "node_modules", ".git"]);
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(rs|toml|md|lock)$/.test(entry.name)) continue;
      const mtime = statSync(full).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    }
  };
  walk(dir);
  return newest;
}
