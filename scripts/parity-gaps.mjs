// Rewrites the "Gaps: N" line of docs/parity/chatgpt.md from its matrix
// (ADR-0078). `node scripts/parity-gaps.mjs` after changing a status;
// src/test/parity-matrix.test.mjs fails when the line and the matrix disagree.
import { readFileSync, writeFileSync } from "node:fs";

const path = "docs/parity/chatgpt.md";
const doc = readFileSync(path, "utf8");
const start = doc.indexOf("## Matrix");
const end = doc.indexOf("\n## ", start + 1);
const gaps = doc
  .slice(start, end)
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .slice(2)
  .flatMap((line) => line.split("|").slice(2, 6))
  .filter((cell) => ["no", "partial"].includes(cell.trim())).length;
writeFileSync(path, doc.replace(/^Gaps: \d+$/m, `Gaps: ${gaps}`));
console.log(`Gaps: ${gaps}`);
