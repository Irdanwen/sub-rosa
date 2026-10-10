// Rewrites the "Gaps: N", "Gated: N" and "Unverified: N" lines of
// docs/parity/chatgpt.md from its matrix (ADR-0078). `node
// scripts/parity-gaps.mjs` after changing a status;
// src/test/parity-matrix.test.mjs fails when the lines and the matrix disagree.
// `Gaps` counts `no` and `partial` cells only: a gated or unverified cell is
// neither parity nor a gap, and has a counter of its own.
import { readFileSync, writeFileSync } from "node:fs";

const path = "docs/parity/chatgpt.md";
const doc = readFileSync(path, "utf8");
const start = doc.indexOf("## Matrix");
const end = doc.indexOf("\n## ", start + 1);
const cells = doc
  .slice(start, end)
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .slice(2)
  .flatMap((line) => line.split("|").slice(2, 6))
  .map((cell) => cell.trim());
const count = (...statuses) => cells.filter((cell) => statuses.includes(cell)).length;
const counters = {
  Gaps: count("no", "partial"),
  Gated: count("gated"),
  Unverified: count("unverified"),
};
let next = doc;
for (const [name, value] of Object.entries(counters)) {
  const line = new RegExp(`^${name}: \\d+$`, "m");
  if (!line.test(next)) throw new Error(`${path} has no "${name}: N" line`);
  next = next.replace(line, `${name}: ${value}`);
}
writeFileSync(path, next);
for (const [name, value] of Object.entries(counters)) console.log(`${name}: ${value}`);
