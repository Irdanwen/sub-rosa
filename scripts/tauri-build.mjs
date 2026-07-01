#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platformBundles = {
  darwin: ["app", "dmg"],
  win32: ["nsis"],
};

const platformConfigs = {
  darwin: "src-tauri/tauri.macos.conf.json",
  win32: "src-tauri/tauri.windows.conf.json",
};

const rawUserArgs = process.argv.slice(2);
const userArgs = rawUserArgs[0] === "--" ? rawUserArgs.slice(1) : rawUserArgs;
const target = optionValue(userArgs, "--target");
const buildPlatform = platformForTarget(target) ?? process.platform;

// Sub Rosa fork: stage the june-api sidecar (externalBin) before bundling so it
// ships inside the app and is signed with it. Skippable via SKIP_SIDECAR_BUILD
// (e.g. when the CI already produced the binaries in a matrix step).
if (process.env.SKIP_SIDECAR_BUILD !== "1") {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sidecarArgs = ["build-sidecar.mjs"];
  if (target) sidecarArgs.push("--target", target);
  const sidecar = spawn(process.execPath, sidecarArgs, {
    cwd: scriptDir,
    stdio: "inherit",
  });
  const code = await new Promise((resolvePromise) => {
    sidecar.on("exit", (exitCode) => resolvePromise(exitCode ?? 0));
    sidecar.on("error", () => resolvePromise(1));
  });
  if (code !== 0) {
    console.error("Sidecar build failed; aborting bundle.");
    process.exit(code);
  }
}
const bundles = platformBundles[buildPlatform];
const config = platformConfigs[buildPlatform];
const hasBundleOverride = userArgs.some(
  (arg) => arg === "--bundles" || arg.startsWith("--bundles="),
);
const hasConfigOverride = userArgs.some((arg) => arg === "--config" || arg.startsWith("--config="));
const args = ["build"];
if (config && !hasConfigOverride) {
  args.push("--config", config);
}
if (bundles && !hasBundleOverride) {
  args.push("--bundles", bundles.join(","));
}
args.push(...userArgs);

const child = spawn(tauriCommand(), args, {
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

function optionValue(args, option) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === option) {
      return args[index + 1];
    }
    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1);
    }
  }
  return undefined;
}

function platformForTarget(targetTriple) {
  if (!targetTriple) {
    return undefined;
  }
  if (targetTriple.includes("windows")) {
    return "win32";
  }
  if (targetTriple.includes("apple-darwin")) {
    return "darwin";
  }
  return undefined;
}

function tauriCommand() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const binary = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const localBinary = resolve(scriptDir, "..", "node_modules", ".bin", binary);
  return existsSync(localBinary) ? localBinary : "tauri";
}
