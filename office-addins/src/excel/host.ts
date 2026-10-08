/**
 * The Excel calls the pane makes (ExcelApi 1.1 and 1.4), behind an adapter the
 * tests replace. Reading is free; writing a formula or a sheet runs only from
 * a confirmed proposal.
 */

export type Cell = string | number | boolean | null;

export interface ExcelRange {
  address: string;
  values: unknown[][];
  formulas: unknown[][];
  rowCount: number;
  columnCount: number;
  load(properties: string[] | string): void;
  getCell(row: number, column: number): ExcelRange;
}
export interface ExcelWorksheet {
  name: string;
  load(properties: string): void;
  getRange(address: string): ExcelRange;
  getUsedRange(valuesOnly?: boolean): ExcelRange;
  activate(): void;
}
export interface ExcelContext {
  workbook: {
    getSelectedRange(): ExcelRange;
    worksheets: {
      items: ExcelWorksheet[];
      load(properties: string): void;
      getActiveWorksheet(): ExcelWorksheet;
      getItem(name: string): ExcelWorksheet;
      add(name: string): ExcelWorksheet;
    };
  };
  sync(): Promise<void>;
}
export interface ExcelApi {
  run<T>(batch: (context: ExcelContext) => Promise<T>): Promise<T>;
}

export function excelGlobal(): ExcelApi | null {
  return (globalThis as { Excel?: ExcelApi }).Excel ?? null;
}

/** At most this many cells are read for an analysis. */
export const MAX_CELLS = 200_000;

export interface Selection {
  /** `Sheet1!B2:D9`, as Excel writes it. */
  address: string;
  values: unknown[][];
  formulas: unknown[][];
  rowCount: number;
  columnCount: number;
}

export class TooManyCells extends Error {}

/** `'My sheet'!B2:C3` -> `["My sheet", "B2:C3"]`. */
export function splitAddress(address: string): [string, string] {
  const bang = address.lastIndexOf("!");
  if (bang < 0) return ["", address];
  let sheet = address.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return [sheet, address.slice(bang + 1)];
}

/** The first cell of an address: `Sheet1!B2:D9` -> `Sheet1!B2`. */
export function firstCell(address: string): string {
  const [sheet, cells] = splitAddress(address);
  const first = cells.split(":")[0];
  return sheet ? `${quoteSheet(sheet)}!${first}` : first;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** `A`, `B`, ..., `Z`, `AA`. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * A value as a cell keeps it: text that starts like a formula is written with
 * Excel's leading apostrophe, so a model's table can never put a formula (or a
 * link that runs one) into the workbook.
 */
export function cellValue(value: Cell): string | number | boolean {
  if (value === null) return "";
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** Rows padded to one width, every value made safe. */
export function sheetMatrix(rows: Cell[][]): (string | number | boolean)[][] {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, i) => cellValue(row[i] ?? null)));
}

/** A sheet name not yet taken, within Excel's 31 characters. */
export function freeSheetName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  const clean = base.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);
  if (!lower.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
    if (!lower.has(name.toLowerCase())) return name;
  }
}

export function excelHost(excel: ExcelApi) {
  return {
    async readSelection(maxCells = MAX_CELLS): Promise<Selection> {
      return excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load(["address", "rowCount", "columnCount"]);
        await context.sync();
        if (range.rowCount * range.columnCount > maxCells) throw new TooManyCells();
        range.load(["values", "formulas"]);
        await context.sync();
        return {
          address: range.address,
          values: range.values,
          formulas: range.formulas,
          rowCount: range.rowCount,
          columnCount: range.columnCount,
        };
      });
    },
    /** The first rows of the active sheet, for writing a formula in context. */
    async sheetPreview(rows = 6, columns = 12): Promise<{ address: string; values: unknown[][] }> {
      return excel.run(async (context) => {
        const used = context.workbook.worksheets.getActiveWorksheet().getUsedRange(true);
        used.load(["address", "values"]);
        await context.sync();
        return {
          address: used.address,
          values: used.values.slice(0, rows).map((row) => row.slice(0, columns)),
        };
      });
    },
    /** Writes `formula` into the one cell the proposal named. */
    async writeFormula(address: string, formula: string): Promise<void> {
      await excel.run(async (context) => {
        const [sheet, cell] = splitAddress(firstCell(address));
        const worksheet = sheet
          ? context.workbook.worksheets.getItem(sheet)
          : context.workbook.worksheets.getActiveWorksheet();
        worksheet.getRange(cell).formulas = [[formula]];
        await context.sync();
      });
    },
    /** A new sheet holding `rows`, shown to the person. Returns its name. */
    async addSheet(base: string, rows: Cell[][]): Promise<string> {
      return excel.run(async (context) => {
        const sheets = context.workbook.worksheets;
        sheets.load("items/name");
        await context.sync();
        const name = freeSheetName(
          base,
          sheets.items.map((sheet) => sheet.name),
        );
        const sheet = sheets.add(name);
        const matrix = sheetMatrix(rows.length ? rows : [[""]]);
        const end = `${columnName(matrix[0].length - 1)}${matrix.length}`;
        sheet.getRange(`A1:${end}`).values = matrix;
        sheet.activate();
        await context.sync();
        return name;
      });
    },
  };
}
export type ExcelHost = ReturnType<typeof excelHost>;
