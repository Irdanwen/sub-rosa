#!/usr/bin/env node
//
// Builds the `june-api` backend as a release binary and stages it as a Tauri
// `externalBin` sidecar named `binaries/june-api-<target-triple>` so it is
// bundled (and, on macOS, signed) with the Sub Rosa app.
//
// Usage:
//   node scripts/build-sidecar.mjs                 # host target triple
//   node scripts/build-sidecar.mjs --target <triple>
//
// Tauri resolves `externalBin: ["binaries/june-api"]` to
// `binaries/june-api-<triple>` at bundle time, so the suffix must match the
// triple Tauri builds the app for.

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(rootDir, "june-api");
const binariesDir = join(rootDir, "src-tauri", "binaries");

const args = process.argv.slice(2);
const target = optionValue(args, "--target") ?? hostTargetTriple();
const isWindows = target.includes("windows");
const exeSuffix = isWindows ? ".exe" : "";

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
