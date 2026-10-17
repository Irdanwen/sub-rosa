// The parity matrix with ComfyUI (docs/parity/comfyui.md) is a promise the
// repository keeps: every row has a status and something to point at, and
// no row is left to do.

import { describe, expect, it } from "vitest";
import matrix from "../../docs/parity/comfyui.md?raw";

const STATUSES = new Set(["done", "adapted", "refused", "external"]);

function rows(): Array<{ what: string; status: string; where: string }> {
  return matrix
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("| ") && !line.startsWith("| ComfyUI |") && !line.startsWith("| What |"),
    )
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map((cells) => ({ what: cells[1], status: cells[3], where: cells[4] }));
}

describe("the ComfyUI parity matrix", () => {
  it("has a status and a reference on every row, and nothing left to do", () => {
    const table = rows();
    expect(table.length).toBeGreaterThanOrEqual(50);
    for (const row of table) {
      expect([row.what, STATUSES.has(row.status)]).toEqual([row.what, true]);
      expect([row.what, /#\d+|ADR-\d{4}|\.md\)/.test(row.where)]).toEqual([row.what, true]);
    }
    expect(table.filter((row) => row.status === "todo")).toEqual([]);
  });

  it("refuses with a reason, and adapts on purpose", () => {
    const table = rows();
    expect(table.filter((row) => row.status === "refused").length).toBeGreaterThanOrEqual(9);
    expect(table.filter((row) => row.status === "done").length).toBeGreaterThan(30);
  });
});
