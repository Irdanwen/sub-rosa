import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * docs/parity/chatgpt.md is the definition of "no feature behind ChatGPT"
 * (ADR-0078). A matrix nobody checks is wrong the day after it is written, so
 * this reads it back: statuses come from a closed list, a `yes` must point at
 * files that exist, a gap must name the lot that closes it, an `equiv` must be
 * explained, and the gap count the document announces must be the real one.
 */
const doc = readFileSync("docs/parity/chatgpt.md", "utf8");

const STATUSES = new Set(["yes", "partial", "no", "equiv", "n/a"]);
const PLATFORMS = ["Desktop", "iOS", "Android", "Web"];

function section(title) {
  const start = doc.indexOf(`## ${title}`);
  if (start < 0) throw new Error(`docs/parity/chatgpt.md has no "## ${title}" section`);
  const rest = doc.slice(start + title.length + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function rows() {
  return section("Matrix")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const [feature, desktop, ios, android, web, evidence, lot] = cells;
      return {
        feature,
        cells,
        statuses: { Desktop: desktop, iOS: ios, Android: android, Web: web },
        paths: [...(evidence ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]),
        lot,
      };
    });
}

describe("the ChatGPT parity matrix", () => {
  const matrix = rows();

  it("has rows, each with seven cells and a unique feature", () => {
    expect(matrix.length).toBeGreaterThan(40);
    for (const row of matrix) expect(row.cells, row.feature).toHaveLength(7);
    const names = matrix.map((row) => row.feature);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses only the five statuses", () => {
    for (const row of matrix) {
      for (const platform of PLATFORMS) {
        expect(STATUSES.has(row.statuses[platform]), `${row.feature} / ${platform}`).toBe(true);
      }
    }
  });

  it("backs every yes with files that exist", () => {
    for (const row of matrix) {
      const claims = PLATFORMS.some((platform) =>
        ["yes", "partial"].includes(row.statuses[platform]),
      );
      if (!claims) continue;
      expect(row.paths.length, `${row.feature} claims support without evidence`).toBeGreaterThan(0);
      for (const path of row.paths) expect(existsSync(path), `${row.feature}: ${path}`).toBe(true);
    }
  });

  it("names the lot that closes every gap", () => {
    for (const row of matrix) {
      const gap = PLATFORMS.some((platform) => ["no", "partial"].includes(row.statuses[platform]));
      if (gap) expect(row.lot, row.feature).toMatch(/^P[0-9]$/);
    }
  });

  it("explains every assumed equivalence", () => {
    const explained = section("Assumed equivalences");
    for (const row of matrix) {
      if (PLATFORMS.some((platform) => row.statuses[platform] === "equiv")) {
        expect(explained, `${row.feature} is marked equiv`).toContain(`**${row.feature}**`);
      }
    }
  });

  it("announces the real gap count", () => {
    const gaps = matrix.reduce(
      (total, row) =>
        total +
        PLATFORMS.filter((platform) => ["no", "partial"].includes(row.statuses[platform])).length,
      0,
    );
    expect(doc, `the matrix has ${gaps} gap cells`).toContain(`Gaps: ${gaps}\n`);
  });
});
