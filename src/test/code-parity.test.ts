// The code parity matrix (docs/parity/code.md) is a promise the repository
// keeps while the 2026-10-23 code plan runs: every row has a status and
// something to point at, an open row names the lot that closes it, and the
// number of open rows only goes down.

import { describe, expect, it } from "vitest";
import matrix from "../../docs/parity/code.md?raw";

const STATUSES = new Set(["done", "hidden", "partial", "todo", "adapted", "refused", "external"]);
const OPEN = new Set(["hidden", "partial", "todo"]);
const COMPETITOR = new Set(["yes", "partial", "no"]);

// Lower this as lots ship; the plan is finished at zero.
const OPEN_CEILING = 39;

type Row = { what: string; competitors: string[]; status: string; where: string };

function rows(): Row[] {
  return matrix
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Capability |"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map((cells) => ({
      what: cells[1],
      competitors: cells.slice(2, 5),
      status: cells[5],
      where: cells[6],
    }));
}

describe("the code parity matrix", () => {
  it("has a known status and a reference on every row", () => {
    const table = rows();
    expect(table.length).toBeGreaterThanOrEqual(50);
    for (const row of table) {
      expect([row.what, STATUSES.has(row.status)]).toEqual([row.what, true]);
      expect([row.what, row.competitors.every((cell) => COMPETITOR.has(cell))]).toEqual([
        row.what,
        true,
      ]);
      expect([row.what, /C\d\.\d|#\d+|ADR-\d{4}|\.md\)/.test(row.where)]).toEqual([row.what, true]);
    }
  });

  it("names the lot that closes every open row", () => {
    for (const row of rows().filter((r) => OPEN.has(r.status))) {
      expect([row.what, /C\d\.\d/.test(row.where)]).toEqual([row.what, true]);
    }
  });

  it("only ever closes rows", () => {
    const open = rows().filter((row) => OPEN.has(row.status)).length;
    expect(open).toBeLessThanOrEqual(OPEN_CEILING);
  });
});
