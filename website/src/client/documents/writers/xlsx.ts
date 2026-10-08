/**
 * A workbook as an Excel file: a port of `deliverables/xlsx.rs` (ADR-0090).
 * Inline strings, formulas with no cached value and a recalculation on load,
 * number formats, ISO dates as serial dates, bold, widths, a frozen header;
 * a formula that reaches outside the file is written as the text it is.
 */
import { coreXml, DOCUMENTS, DocumentInvalid, type Part } from "./exported";
import {
  asciiUpper,
  chars,
  isControl,
  isObject,
  type Json,
  jsonCompact,
  lines,
  rustFloat,
  take,
  trim,
  trimMatches,
  xmlText,
} from "./text";

const MAX_SHEETS = 20;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 200;
const MAX_CELL_CHARS = 32_767;
const MAX_FORMAT_CHARS = 64;

type CellValue =
  | { kind: "empty" }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "formula"; value: string };
interface Cell {
  value: CellValue;
  format: string | null;
  bold: boolean;
}
interface Column {
  width: number | null;
  format: string | null;
}
interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
  header: boolean;
  freezeHeader: boolean;
}

const capped = (text: string) => take(text, MAX_CELL_CHARS);

function cleanFormat(raw: string): string | null {
  const format = trim(raw);
  return format && chars(format).length <= MAX_FORMAT_CHARS && !chars(format).some(isControl)
    ? format
    : null;
}

function daysFromEpoch(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const epoch = new Date(0);
  epoch.setUTCFullYear(1899, 11, 30);
  epoch.setUTCHours(0, 0, 0, 0);
  return Math.round((date.getTime() - epoch.getTime()) / 86_400_000);
}

/** `2026-10-08` or `2026-10-08T14:30[:00]` as days since 1899-12-30. */
export function isoDateSerial(text: string): number | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 10 || bytes[4] !== 0x2d || bytes[7] !== 0x2d) return null;
  if (bytes.length === 10) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    return match ? daysFromEpoch(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?| +(\d{1,2}):(\d{1,2}))$/.exec(
      text,
    );
  if (!match) return null;
  const days = daysFromEpoch(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4] ?? match[7]);
  const minute = Number(match[5] ?? match[8]);
  const second = Number(match[6] ?? 0);
  if (days === null || hour > 23 || minute > 59 || second > 59) return null;
  return (days * 86_400 + hour * 3600 + minute * 60 + second) / 86_400;
}

function formulaCell(raw: string): Cell {
  const formula = trim(trim(raw).replace(/^=+/, ""));
  const upper = asciiUpper(formula);
  const reachesOut =
    formula.includes("|") ||
    ["WEBSERVICE", "FILTERXML", "CALL(", "REGISTER", "EXEC(", "RTD(", "DDE"].some((word) =>
      upper.includes(word),
    );
  return {
    value:
      !formula || reachesOut
        ? { kind: "text", value: capped(raw) }
        : { kind: "formula", value: capped(formula) },
    format: null,
    bold: false,
  };
}

function textCell(text: string): Cell {
  if (text.startsWith("=") && text.length > 1) return formulaCell(text);
  const serial = isoDateSerial(trim(text));
  if (serial !== null)
    return {
      value: { kind: "number", value: serial },
      format: new TextEncoder().encode(trim(text)).length > 10 ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd",
      bold: false,
    };
  return { value: { kind: "text", value: capped(text) }, format: null, bold: false };
}

function parseCell(value: Json): Cell {
  const plain = (cell: CellValue): Cell => ({ value: cell, format: null, bold: false });
  if (value === null) return plain({ kind: "empty" });
  if (typeof value === "boolean") return plain({ kind: "bool", value });
  if (typeof value === "number")
    return plain(Number.isFinite(value) ? { kind: "number", value } : { kind: "empty" });
  if (typeof value === "string") return textCell(value);
  if (Array.isArray(value)) return plain({ kind: "text", value: capped(jsonCompact(value)) });
  const cell =
    typeof value.formula === "string"
      ? formulaCell(value.formula)
      : "value" in value && !isObject(value.value)
        ? parseCell(value.value)
        : plain({ kind: "empty" });
  const format = typeof value.format === "string" ? cleanFormat(value.format) : null;
  if (format) cell.format = format;
  cell.bold = value.bold === true;
  return cell;
}

const asciiEq = (a: string, b: string) =>
  a.length === b.length &&
  a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A sheet name Excel accepts, unique in the workbook. */
export function sheetName(wanted: string, index: number, taken: string[]): string {
  const cleaned = chars(wanted)
    .filter((c) => !"[]:*?/\\".includes(c) && !isControl(c))
    .join("");
  const stripped = trim(trimMatches(trim(cleaned), "'"));
  const base = stripped ? take(stripped, 31) : `Sheet${index + 1}`;
  const clashes = (name: string) => taken.some((item) => asciiEq(item, name));
  if (!clashes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const name = `${take(base, 31 - chars(suffix).length)}${suffix}`;
    if (!clashes(name)) return name;
  }
}

/** `0` is `A`, `25` is `Z`, `26` is `AA`. */
export function columnLetters(index: number): string {
  let letters = "";
  let rest = index;
  for (;;) {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    if (rest < 26) break;
    rest = Math.floor(rest / 26) - 1;
  }
  return letters;
}

function parseSheets(title: string, content: Json): Sheet[] {
  let raw: Json[] = [];
  if (isObject(content)) {
    if (Array.isArray(content.sheets)) raw = content.sheets;
    else if ("rows" in content) raw = [content];
  } else if (Array.isArray(content)) raw = [content];
  if (!raw.length)
    throw new DocumentInvalid(
      "A spreadsheet needs content.sheets, each with rows (an array of rows, each an array of cells).",
    );
  const names: string[] = [];
  const sheets: Sheet[] = [];
  raw.slice(0, MAX_SHEETS).forEach((value, index) => {
    const rowsValue = Array.isArray(value) ? value : isObject(value) ? value.rows : undefined;
    if (!Array.isArray(rowsValue))
      throw new DocumentInvalid(`Sheet ${index + 1} has no rows array.`);
    const field = (key: string): Json | undefined => (isObject(value) ? value[key] : undefined);
    const columnsValue = field("columns");
    const columns: Column[] = Array.isArray(columnsValue)
      ? columnsValue.slice(0, MAX_COLUMNS).map((column) => {
          const width = isObject(column) ? column.width : undefined;
          const format = isObject(column) ? column.format : undefined;
          return {
            width:
              typeof width === "number" && Number.isFinite(width)
                ? Math.min(120, Math.max(2, width))
                : null,
            format: typeof format === "string" ? cleanFormat(format) : null,
          };
        })
      : [];
    const headerValue = field("header");
    const header = typeof headerValue === "boolean" ? headerValue : true;
    const freezeValue =
      isObject(value) && "freezeHeader" in value ? value.freezeHeader : field("freeze_header");
    const freezeHeader = typeof freezeValue === "boolean" ? freezeValue : header;
    const rows: Cell[][] = rowsValue.slice(0, MAX_ROWS).map((row, rowIndex) => {
      const cells = Array.isArray(row)
        ? row.slice(0, MAX_COLUMNS).map(parseCell)
        : [parseCell(row)];
      return cells.map((cell, column) => {
        if (header && rowIndex === 0) cell.bold = true;
        else if (cell.format === null) cell.format = columns[column]?.format ?? null;
        return cell;
      });
    });
    const named = field("name");
    const wanted = typeof named === "string" ? named : index === 0 ? title : "";
    const name = sheetName(wanted, index, names);
    names.push(name);
    sheets.push({ name, columns, rows, header, freezeHeader });
  });
  return sheets;
}

const BUILTIN_FORMATS: Record<string, number> = {
  General: 0,
  "0": 1,
  "0.00": 2,
  "#,##0": 3,
  "#,##0.00": 4,
  "0%": 9,
  "0.00%": 10,
  "0.00E+00": 11,
  "mm-dd-yy": 14,
  "d-mmm-yy": 15,
  "h:mm": 20,
  "@": 49,
};

class Styles {
  customFormats: string[] = [];
  xfs: [number, boolean][] = [];
  index = new Map<string, number>();

  formatId(format: string): number {
    const builtin = BUILTIN_FORMATS[format];
    if (builtin !== undefined && Object.hasOwn(BUILTIN_FORMATS, format)) return builtin;
    let position = this.customFormats.indexOf(format);
    if (position < 0) {
      this.customFormats.push(format);
      position = this.customFormats.length - 1;
    }
    return 164 + position;
  }

  style(cell: Cell): number | null {
    const format = cell.format === null ? 0 : this.formatId(cell.format);
    if (format === 0 && !cell.bold) return null;
    const key = `${format}:${cell.bold}`;
    const known = this.index.get(key);
    if (known !== undefined) return known;
    this.xfs.push([format, cell.bold]);
    this.index.set(key, this.xfs.length);
    return this.xfs.length;
  }

  xml(): string {
    let xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (this.customFormats.length) {
      xml += `<numFmts count="${this.customFormats.length}">`;
      this.customFormats.forEach((format, position) => {
        xml += `<numFmt numFmtId="${164 + position}" formatCode="${xmlText(format)}"/>`;
      });
      xml += "</numFmts>";
    }
    xml +=
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
    xml += `<cellXfs count="${this.xfs.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
    for (const [format, bold] of this.xfs)
      xml += `<xf numFmtId="${format}" fontId="${bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${format === 0 ? "" : ' applyNumberFormat="1"'}${bold ? ' applyFont="1"' : ""}/>`;
    xml +=
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    return xml;
  }
}

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function fittedWidth(sheet: Sheet, column: number): number {
  let longest = 0;
  for (const row of sheet.rows) {
    const cell = row[column];
    if (!cell) continue;
    const value = cell.value;
    const length =
      value.kind === "text"
        ? Math.max(0, ...lines(value.value).map((line) => chars(line).length))
        : value.kind === "number"
          ? Math.max(rustFloat(value.value).length, 10)
          : value.kind === "formula"
            ? 12
            : value.kind === "bool"
              ? 5
              : 0;
    longest = Math.max(longest, length);
  }
  return Math.min(60, Math.max(8, longest + 2));
}

function sheetXml(sheet: Sheet, selected: boolean, styles: Styles) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetViews><sheetView${selected ? ' tabSelected="1"' : ""} workbookViewId="0">`;
  if (sheet.freezeHeader && sheet.header && sheet.rows.length > 1)
    xml += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  xml += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
  const widthCount = Math.max(0, ...sheet.rows.map((row) => row.length), sheet.columns.length);
  if (widthCount > 0) {
    xml += "<cols>";
    for (let column = 0; column < widthCount; column++) {
      const width = sheet.columns[column]?.width ?? fittedWidth(sheet, column);
      xml += `<col min="${column + 1}" max="${column + 1}" width="${width.toFixed(2)}" customWidth="1"/>`;
    }
    xml += "</cols>";
  }
  xml += "<sheetData>";
  sheet.rows.forEach((row, rowIndex) => {
    const number = rowIndex + 1;
    xml += `<row r="${number}">`;
    row.forEach((cell, column) => {
      const reference = `${columnLetters(column)}${number}`;
      const index = styles.style(cell);
      const style = index === null ? "" : ` s="${index}"`;
      const value = cell.value;
      if (value.kind === "empty") {
        if (style) xml += `<c r="${reference}"${style}/>`;
      } else if (value.kind === "number")
        xml += `<c r="${reference}"${style}><v>${rustFloat(value.value)}</v></c>`;
      else if (value.kind === "bool")
        xml += `<c r="${reference}"${style} t="b"><v>${value.value ? 1 : 0}</v></c>`;
      else if (value.kind === "text")
        xml += `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value.value)}</t></is></c>`;
      else xml += `<c r="${reference}"${style}><f>${xmlText(value.value)}</f></c>`;
    });
    xml += "</row>";
  });
  return `${xml}</sheetData></worksheet>`;
}

function workbookXml(sheets: Sheet[]): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>`;
  sheets.forEach((sheet, index) => {
    xml += `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`;
  });
  return `${xml}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
}

function workbookRels(count: number): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (let n = 1; n <= count; n++)
    xml += `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`;
  return `${xml}<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function contentTypes(count: number): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';
  for (let n = 1; n <= count; n++)
    xml += `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  return `${xml}</Types>`;
}

/** The workbook's parts, and what it holds in a few words. */
export function buildXlsx(
  title: string,
  content: Json,
  now?: Date,
): { parts: Part[]; detail: string } {
  const sheets = parseSheets(title, content);
  const styles = new Styles();
  const sheetParts = sheets.map((sheet, index) => sheetXml(sheet, index === 0, styles));
  const parts: Part[] = [
    { name: "[Content_Types].xml", text: contentTypes(sheets.length) },
    { name: "_rels/.rels", text: DOCUMENTS.templates.xlsx.rootRels },
    { name: "docProps/core.xml", text: coreXml(title, now) },
    { name: "xl/workbook.xml", text: workbookXml(sheets) },
    { name: "xl/_rels/workbook.xml.rels", text: workbookRels(sheets.length) },
    { name: "xl/styles.xml", text: styles.xml() },
    ...sheetParts.map((text, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, text })),
  ];
  const rows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  return {
    parts,
    detail: `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}, ${rows} row${rows === 1 ? "" : "s"}`,
  };
}
