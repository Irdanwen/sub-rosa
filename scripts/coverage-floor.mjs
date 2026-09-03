// Coverage is a ratchet, not a target.
//
// The instrumentation had been paid for since the first week (vitest's v8
// reporter, cargo-llvm-cov, a coverage workflow) and nothing ever read the
// numbers, so a PR could quietly drop a suite and no one would know. This
// script gives the numbers one job: they may only go up.
//
//   node scripts/coverage-floor.mjs check frontend coverage/frontend/coverage-summary.json
//   node scripts/coverage-floor.mjs check rust    src-tauri/target/llvm-cov/summary.json
//   node scripts/coverage-floor.mjs raise frontend coverage/frontend/coverage-summary.json
//
// `check` fails when the measured line coverage is below the floor recorded
// in coverage-floor.json. `raise` writes the measured value back as the new
// floor when it is higher (it never lowers one). The floor file is committed,
// so lowering it is a visible diff a reviewer has to accept.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FLOOR_FILE = "coverage-floor.json";

// A measured value has to clear the floor by this much before the floor
// moves: it keeps a run-to-run wobble of a few hundredths from rewriting the
// file on every merge.
const RAISE_STEP = 0.1;

/** Line coverage percentage from vitest's `json-summary` reporter. */
export function frontendLinePercent(summary) {
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== "number" || Number.isNaN(pct)) {
    throw new Error("coverage summary has no total.lines.pct");
  }
  return pct;
}

/** Line coverage percentage from `cargo llvm-cov --json --summary-only`. */
export function rustLinePercent(report) {
  const pct = report?.data?.[0]?.totals?.lines?.percent;
  if (typeof pct !== "number" || Number.isNaN(pct)) {
    throw new Error("llvm-cov report has no data[0].totals.lines.percent");
  }
  return pct;
}

export function readPercent(kind, document) {
  if (kind === "frontend") return frontendLinePercent(document);
  if (kind === "rust") return rustLinePercent(document);
  throw new Error(`unknown coverage kind: ${kind}`);
}

/**
 * Decide what a measurement means against the floor.
 * Returns { ok, floor, measured, message } and never throws on a plain miss.
 */
export function compare(kind, floors, measured) {
  const floor = floors[kind];
  if (typeof floor !== "number") {
    return {
      ok: true,
      floor: undefined,
      measured,
      message: `${kind}: no floor recorded yet; measured ${measured.toFixed(2)}%`,
    };
  }
  if (measured + 1e-9 < floor) {
    return {
      ok: false,
      floor,
      measured,
      message: `${kind}: line coverage ${measured.toFixed(2)}% is below the floor of ${floor.toFixed(2)}%. Add tests for what you changed, or lower the floor in ${FLOOR_FILE} and say why in the PR.`,
    };
  }
  return {
    ok: true,
    floor,
    measured,
    message: `${kind}: line coverage ${measured.toFixed(2)}% (floor ${floor.toFixed(2)}%)`,
  };
}

/** The floors after a `raise`: only ever higher, and only by a real step. */
export function raised(kind, floors, measured) {
  const current = floors[kind];
  const rounded = Math.floor(measured * 100) / 100;
  if (typeof current !== "number" || rounded >= current + RAISE_STEP) {
    return { ...floors, [kind]: rounded };
  }
  return floors;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [command, kind, reportPath] = process.argv.slice(2);
  if (!command || !kind || !reportPath || !["check", "raise"].includes(command)) {
    throw new Error(
      "Usage: node scripts/coverage-floor.mjs <check|raise> <frontend|rust> <report.json>",
    );
  }
  const floorPath = resolve(FLOOR_FILE);
  const floors = await readJson(floorPath);
  const measured = readPercent(kind, await readJson(reportPath));

  if (command === "check") {
    const result = compare(kind, floors, measured);
    process.stdout.write(`${result.message}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  const next = raised(kind, floors, measured);
  if (next !== floors) {
    await writeFile(floorPath, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`${kind}: floor raised to ${next[kind].toFixed(2)}%\n`);
  } else {
    process.stdout.write(
      `${kind}: floor stays at ${floors[kind].toFixed(2)}% (measured ${measured.toFixed(2)}%)\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
