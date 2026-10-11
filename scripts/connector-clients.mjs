// The app's own OAuth clients, as a release build sees them (ADR-0092 and its
// addendum of 2026-10-10).
//
// Google, Microsoft and GitHub sign in with client ids compiled into the app
// (`option_env!` in src-tauri/src/connectors/). 1.89.0 shipped without all
// three and nothing said so. This script is the workflows' half of the guard
// whose other half is src-tauri/build.rs:
//
//   node scripts/connector-clients.mjs build --platform <macos|ios|windows|android> [--overlay <file>]
//     Annotates the run with a warning for every connector the build will
//     leave out, and writes a Tauri config overlay that registers Google's
//     redirect scheme in the bundle (an empty object when there is none).
//
//   node scripts/connector-clients.mjs check
//     Fails unless all three ids are present and well formed. Run once by
//     connectors-check.yml after the owner sets the repository secrets.
//
// The ids are read from SUBROSA_GOOGLE_CLIENT_ID, SUBROSA_MS_CLIENT_ID and
// SUBROSA_GITHUB_CLIENT_ID. Their values are never printed.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CLIENTS = [
  {
    variable: "SUBROSA_GOOGLE_CLIENT_ID",
    connector: "Google",
    // Google's iOS client type serves the Mac too, and it is the only type
    // Google sends back to an app's own scheme.
    platforms: ["macos", "ios"],
    format: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    expected: "an iOS-type client id ending in .apps.googleusercontent.com",
  },
  {
    variable: "SUBROSA_MS_CLIENT_ID",
    connector: "Microsoft",
    platforms: [],
    format: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    expected: "the application (client) id, a GUID",
  },
  {
    variable: "SUBROSA_GITHUB_CLIENT_ID",
    connector: "GitHub",
    platforms: [],
    format: /^(Ov2[0-9][A-Za-z0-9]{16}|[0-9a-f]{20})$/,
    expected: "an OAuth app client id (Ov23li... or 20 hex characters)",
  },
];

export const PLATFORMS = ["macos", "ios", "windows", "android"];

const WHY_NOT_GOOGLE = {
  windows:
    "Google is not offered on Windows: its Desktop client type returns only to a loopback address, which the app does not listen on (ADR-0092).",
  android:
    "Google is not offered on Android: Google no longer sends an Android client back to a custom scheme (ADR-0092).",
};

/** A variable that holds something: blank counts as unset. */
export function configured(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

export function appliesTo(client, platform) {
  return client.platforms.length === 0 || client.platforms.includes(platform);
}

/** Google's redirect for an iOS-type client: its reversed client id. Mirrors
 * `google_redirect_for` in src-tauri/src/connectors/build_clients.rs. */
export function googleScheme(clientId) {
  const id = configured(clientId);
  const suffix = ".apps.googleusercontent.com";
  if (!id?.endsWith(suffix)) return null;
  const prefix = id.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(prefix)) return null;
  return `com.googleusercontent.apps.${prefix}`;
}

/** What a build for `platform` will carry, as annotations. Never includes a
 * value. */
export function review(env, platform) {
  const annotations = [];
  for (const client of CLIENTS) {
    if (!appliesTo(client, platform)) {
      if (WHY_NOT_GOOGLE[platform] && client.connector === "Google") {
        annotations.push({ level: "notice", message: WHY_NOT_GOOGLE[platform] });
      }
      continue;
    }
    const value = configured(env[client.variable]);
    if (!value) {
      annotations.push({
        level: "warning",
        message: `${client.variable} is not set: this ${platform} build does not offer the ${client.connector} connector (HANDOFF.md, OAuth clients).`,
      });
    } else if (!client.format.test(value)) {
      annotations.push({
        level: "warning",
        message: `${client.variable} is not ${client.expected}: the ${client.connector} sign-in will fail.`,
      });
    }
  }
  return annotations;
}

/** The strict check: every id present and well formed, whatever the platform. */
export function check(env) {
  const failures = [];
  for (const client of CLIENTS) {
    const value = configured(env[client.variable]);
    if (!value) failures.push(`${client.variable} is missing.`);
    else if (!client.format.test(value))
      failures.push(`${client.variable} is not ${client.expected}.`);
  }
  return failures;
}

/** A Tauri config overlay registering Google's scheme next to the app's own,
 * or an empty object when the build carries no Google id for `platform`. */
export function overlay(env, platform, deepLink) {
  const google = CLIENTS[0];
  if (!appliesTo(google, platform)) return {};
  const scheme = googleScheme(env[google.variable]);
  if (!scheme) return {};
  const mobile = structuredClone(deepLink.mobile ?? []);
  const custom = mobile.find((entry) => !entry.appLink);
  if (custom) custom.scheme = [...new Set([...(custom.scheme ?? []), scheme])];
  else mobile.push({ scheme: [scheme], appLink: false });
  const desktopSchemes = [...new Set([...(deepLink.desktop?.schemes ?? []), scheme])];
  return {
    plugins: {
      "deep-link": {
        ...deepLink,
        mobile,
        desktop: { ...deepLink.desktop, schemes: desktopSchemes },
      },
    },
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const failures = check(process.env);
    for (const failure of failures) process.stdout.write(`::error::${failure}\n`);
    if (failures.length > 0) process.exit(1);
    process.stdout.write("Google, Microsoft and GitHub client ids are present and well formed.\n");
    return;
  }
  const platform = option(args, "--platform");
  if (command !== "build" || !PLATFORMS.includes(platform)) {
    throw new Error(
      `Usage: node scripts/connector-clients.mjs build --platform <${PLATFORMS.join("|")}> [--overlay <file>] | check`,
    );
  }
  for (const { level, message } of review(process.env, platform)) {
    process.stdout.write(`::${level}::${message}\n`);
  }
  const out = option(args, "--overlay");
  if (out) {
    const config = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const result = overlay(process.env, platform, config.plugins?.["deep-link"] ?? {});
    const scheme = googleScheme(process.env[CLIENTS[0].variable]);
    // The scheme carries the client id, which the secret mask does not cover.
    if (scheme && Object.keys(result).length > 0) process.stdout.write(`::add-mask::${scheme}\n`);
    writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      Object.keys(result).length > 0
        ? "Google's redirect scheme is registered in the bundle.\n"
        : "No redirect scheme to add.\n",
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
