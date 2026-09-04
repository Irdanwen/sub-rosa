// Biome warnings are a ratchet: per rule, the count may only go down.
//
// biome.json downgrades twenty-one rules to "warn" because six hundred sites
// predate them. A warning nobody reads is not a rule, so this script holds the
// line: `check` fails when any rule's count is above the number recorded in
// biome-warnings.json, and `update` lowers the recorded numbers to what the
// tree has now (never raises them). When a rule reaches zero here, promote it
// to "error" in biome.json and drop it from the file.
//
//   node scripts/biome-ratchet.mjs check
//   node scripts/biome-ratchet.mjs update

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RATCHET_FILE = "biome-warnings.json";

/** Count warnings per rule from Biome's JSON reporter output. */
export function countByRule(report) {
  const counts = {};
  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.severity !== "warning") continue;
    const rule = diagnostic.category ?? "unknown";
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

/** Rules whose count rose above the recorded one, as messages. */
export function regressions(recorded, current) {
  const out = [];
  for (const [rule, count] of Object.entries(current)) {
    const allowed = recorded[rule] ?? 0;
    if (count > allowed) out.push(`${rule}: ${count} warnings, ${allowed} allowed`);
  }
  return out.sort();
}

/** The recorded counts after an update: each one the lower of the two. */
export function lowered(recorded, current) {
  const next = {};
  const rules = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  for (const rule of rules) {
    const value = Math.min(recorded[rule] ?? Number.POSITIVE_INFINITY, current[rule] ?? 0);
    if (value > 0) next[rule] = value;
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

function runBiome() {
  let stdout;
  try {
    stdout = execFileSync(
      "pnpm",
      ["exec", "biome", "check", ".", "--reporter=json", "--max-diagnostics=5000"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    // Biome exits non-zero when it finds errors; the JSON is still on stdout.
    stdout = error.stdout;
    if (!stdout) throw error;
  }
  return JSON.parse(stdout);
}

function main() {
  const command = process.argv[2];
  if (!["check", "update"].includes(command)) {
    throw new Error("Usage: node scripts/biome-ratchet.mjs <check|update>");
  }
  const path = resolve(RATCHET_FILE);
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  const current = countByRule(runBiome());
  if (command === "check") {
    const failures = regressions(recorded, current);
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    process.stdout.write(`${total} Biome warnings across ${Object.keys(current).length} rules.\n`);
    if (failures.length > 0) {
      process.stderr.write(
        `${failures.join("\n")}\nFix the new sites, or run \`pnpm biome:ratchet\` only if a count truly went down elsewhere.\n`,
      );
      process.exit(1);
    }
    return;
  }
  const next = lowered(recorded, current);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    `${RATCHET_FILE} updated: ${Object.keys(next).length} rules still carry warnings.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
