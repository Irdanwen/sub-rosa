// Attached files as the Python code sees them under /data (ADR-0086).
//
// A phone attachment is text by the time the turn holds it: a CSV as it is,
// a spreadsheet as the cell listing the document reader writes ("[Sheet 1]"
// then "A1: Budget"). That listing is turned back into one CSV per sheet, so
// `pd.read_csv("/data/budget.sheet1.csv")` works the way a person would
// expect; nothing has to know about the reader's format.

import type { PythonInputFile } from "./protocol";

export const DATA_DIR = "/data";

/** A name that is safe as one path segment and still recognisable. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return cleaned || "file";
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The reader's "[Sheet N]" + "A1: value" listing as one CSV per sheet, or
 * null when the text is not such a listing. */
export function sheetListingToCsv(text: string): { sheet: number; csv: string }[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!/^\[Sheet \d+\]$/.test(lines[0]?.trim() ?? "")) return null;
  const sheets: { sheet: number; cells: Map<number, Map<number, string>> }[] = [];
  let last: { row: Map<number, string>; column: number } | null = null;
  for (const line of lines) {
    const header = /^\[Sheet (\d+)\]$/.exec(line.trim());
    if (header) {
      sheets.push({ sheet: Number(header[1]), cells: new Map() });
      last = null;
      continue;
    }
    const current = sheets[sheets.length - 1];
    const cell = /^([A-Z]{1,3})(\d{1,7}): ?(.*)$/.exec(line);
    if (cell && current) {
      const rowNumber = Number(cell[2]) - 1;
      const column = columnIndex(cell[1]);
      const row = current.cells.get(rowNumber) ?? new Map<number, string>();
      row.set(column, cell[3]);
      current.cells.set(rowNumber, row);
      last = { row, column };
    } else if (last && line !== "") {
      // A value with a line break continues on the next line.
      last.row.set(last.column, `${last.row.get(last.column) ?? ""}\n${line}`);
    }
  }
  return sheets.map(({ sheet, cells }) => {
    const rowNumbers = [...cells.keys()].sort((a, b) => a - b);
    const width = Math.max(
      0,
      ...[...cells.values()].flatMap((row) => [...row.keys()].map((c) => c + 1)),
    );
    const csv = rowNumbers
      .map((rowNumber) => {
        const row = cells.get(rowNumber) ?? new Map<number, string>();
        return Array.from({ length: width }, (_, column) => csvField(row.get(column) ?? "")).join(
          ",",
        );
      })
      .join("\n");
    return { sheet, csv: csv ? `${csv}\n` : "" };
  });
}

/** Every attachment as the files written under /data. */
export function mountedFiles(files: PythonInputFile[]): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const taken = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n += 1)
      candidate = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
    taken.add(candidate);
    return `${DATA_DIR}/${candidate}`;
  };
  for (const file of files) {
    const safe = safeFileName(file.name);
    const sheets = /\.(xlsx|xlsm|xls)$/i.test(file.name) ? sheetListingToCsv(file.text) : null;
    if (sheets) {
      const stem = safe.replace(/\.[^.]*$/, "");
      for (const { sheet, csv } of sheets)
        out.push({ path: unique(`${stem}.sheet${sheet}.csv`), text: csv });
    } else {
      out.push({ path: unique(safe), text: file.text });
    }
  }
  return out;
}
