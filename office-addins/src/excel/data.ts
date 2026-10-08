/**
 * What an Excel request sends and what comes back: the range as CSV and as a
 * cell listing for the prompt, and the tables of an answer as rows for a
 * new sheet.
 */
import { chatBlockKindOf } from "@subrosa/chat-core/chat-block-fence";
import {
  chartAsTable,
  ENGLISH_DATA_BLOCK_WORDS,
  parseChartBlock,
  parseTableBlock,
} from "@subrosa/chat-core/chat-blocks-data";
import { type Cell, columnName, splitAddress } from "./host";

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The range as the CSV mounted for Python. */
export function rangeCsv(values: unknown[][]): string {
  return values.map((row) => row.map((cell) => csvField(text(cell))).join(",")).join("\n");
}

/** The first rows as `B2: value` lines, each value clipped. */
export function cellListing(
  address: string,
  values: unknown[][],
  rows = 20,
  formulas?: unknown[][],
): string {
  const [, cells] = splitAddress(address);
  const match = /^\$?([A-Z]+)\$?(\d+)/.exec(cells);
  const startColumn = match
    ? [...match[1]].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1
    : 0;
  const startRow = match ? Number(match[2]) : 1;
  const lines: string[] = [];
  for (const [r, row] of values.slice(0, rows).entries())
    for (const [c, value] of row.entries()) {
      const formula = text(formulas?.[r]?.[c]);
      const shown = formula.startsWith("=") ? `${formula} -> ${text(value)}` : text(value);
      if (!shown) continue;
      const clipped = shown.length > 120 ? `${shown.slice(0, 120)}...` : shown;
      lines.push(`${columnName(startColumn + c)}${startRow + r}: ${clipped}`);
    }
  return lines.join("\n");
}

/**
 * The tables an answer carries (`subrosa:table`, or a chart's data), as rows
 * for a sheet: a title row when there is one, the column labels, the values.
 */
export function answerTables(answer: string): Cell[][][] {
  const tables: Cell[][][] = [];
  for (const match of answer.matchAll(/```([^\n`]*)\n([\s\S]*?)\n```/g)) {
    const kind = chatBlockKindOf(match[1].trim());
    if (kind !== "table" && kind !== "chart") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(match[2]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const table =
      kind === "table"
        ? parseTableBlock(payload)
        : (() => {
            const chart = parseChartBlock(payload, ENGLISH_DATA_BLOCK_WORDS);
            return chart ? chartAsTable(chart) : null;
          })();
    if (!table) continue;
    const rows: Cell[][] = [];
    if (table.title) rows.push([table.title]);
    rows.push(
      table.columns.map((column) =>
        column.unit ? `${column.label} (${column.unit})` : column.label,
      ),
    );
    for (const row of table.rows) rows.push(row.map((cell) => cell));
    tables.push(rows);
  }
  return tables;
}

/** The answer without its card blocks, for reading in the pane. */
export function answerProse(answer: string): string {
  return answer
    .replace(/```subrosa:[^\n`]*\n[\s\S]*?\n```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What a new sheet receives: the tables one under the other, or the
 * answer's paragraphs when it has none. */
export function sheetRows(answer: string): Cell[][] {
  const tables = answerTables(answer);
  if (!tables.length)
    return answerProse(answer)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line]);
  return tables.flatMap((rows, index) => (index ? [[], ...rows] : rows));
}

/** The JSON a formula request answers, read leniently (a fence around it). */
export function parseFormulaAnswer(
  answer: string,
): { formula: string; explanation: string } | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
    const formula = typeof value.formula === "string" ? value.formula.trim() : "";
    const explanation = typeof value.explanation === "string" ? value.explanation.trim() : "";
    if (formula && !formula.startsWith("=")) return null;
    return { formula, explanation };
  } catch {
    return null;
  }
}
