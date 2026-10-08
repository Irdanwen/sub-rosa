import { t } from "./i18n";

/**
 * Data chat blocks — `subrosa:chart` and `subrosa:table` (ADR-0024, ADR-0086).
 *
 * The same envelope as every other chat block: a fenced JSON object in the
 * reply, validated here as untrusted model output. Nothing throws, every
 * string and list is capped, and a payload with nothing plottable returns
 * null so the call site shows the ordinary code block instead.
 *
 * Clamping beats rejecting: a chart with twelve series keeps the first eight
 * (the palette's size, never a generated ninth hue) and says so in `notice`,
 * a pie with fourteen slices folds the smallest into "Other", and a table
 * keeps its first rows. The person always learns that something was left out.
 */

export const CHART_TYPES = ["bar", "line", "area", "pie", "donut", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export type ChartSeries = { name: string; values: (number | null)[] };
export type ScatterSeries = { name: string; points: [number, number][] };

export type ChartChatBlock = {
  kind: "chart";
  type: ChartType;
  title?: string;
  xTitle?: string;
  yTitle?: string;
  /** Unit of the values (the y axis, or a pie's slices). */
  unit?: string;
  /** Unit of the x axis; scatter only. */
  xUnit?: string;
  /** Bars and areas stack instead of sitting side by side. */
  stacked: boolean;
  /** x labels for bar, line, area; slice labels for pie and donut. */
  categories: string[];
  /** One value per category. A pie reads only the first series. */
  series: ChartSeries[];
  /** Scatter only. */
  scatter: ScatterSeries[];
  source?: string;
  /** What the caps left out, said in the card ("8 of 12 series"). */
  dropped?: { series?: number; categories?: number; points?: number; slices?: number };
};

export type TableCell = string | number | null;
export type TableColumn = { label: string; numeric: boolean; unit?: string };

export type TableChatBlock = {
  kind: "table";
  title?: string;
  columns: TableColumn[];
  rows: TableCell[][];
  source?: string;
  dropped?: { rows?: number; columns?: number };
};

/** Categorical slots in the palette (tokens.css `--chart-1..8`). */
export const CHART_MAX_SERIES = 8;
/** Scatter compares every pair of colours, and only three stay apart for
 * colour-blind readers when all pairs matter (the dataviz palette's rule). */
export const SCATTER_MAX_SERIES = 3;
const MAX_BAR_CATEGORIES = 60;
const MAX_LINE_CATEGORIES = 400;
const MAX_PIE_SLICES = 8;
const MAX_SCATTER_POINTS = 2_000;
export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_COLUMNS = 12;
const MAX_TITLE = 120;
const MAX_AXIS_TITLE = 60;
const MAX_LABEL = 60;
const MAX_UNIT = 12;
const MAX_CELL = 200;
const MAX_SOURCE = 200;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function capped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A label the model wrote as a number or a date string still reads. */
function label(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return capped(value, MAX_LABEL);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function axis(payload: Record<string, unknown>, key: "x" | "y") {
  const raw = asObject(payload[key]);
  return {
    title: capped(raw?.title, MAX_AXIS_TITLE),
    unit: capped(raw?.unit, MAX_UNIT),
  };
}

function seriesList(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(payload.series)) return [];
  return payload.series.map(asObject).filter((entry) => entry !== null);
}

function withDropped<T extends { dropped?: Record<string, number | undefined> }>(block: T): T {
  const entries = Object.entries(block.dropped ?? {}).filter(([, count]) => (count ?? 0) > 0);
  if (entries.length === 0) {
    const { dropped: _unused, ...rest } = block;
    return rest as T;
  }
  return { ...block, dropped: Object.fromEntries(entries) };
}

function parseScatter(
  payload: Record<string, unknown>,
  base: Omit<ChartChatBlock, "categories" | "series" | "scatter">,
): ChartChatBlock | null {
  const raw = seriesList(payload);
  const scatter: ScatterSeries[] = [];
  let budget = MAX_SCATTER_POINTS;
  let droppedPoints = 0;
  for (const [index, entry] of raw.slice(0, SCATTER_MAX_SERIES).entries()) {
    const points: [number, number][] = [];
    for (const point of Array.isArray(entry.points) ? entry.points : []) {
      const pair = Array.isArray(point) ? point : null;
      const x = finite(pair?.[0] ?? asObject(point)?.x);
      const y = finite(pair?.[1] ?? asObject(point)?.y);
      if (x === null || y === null) continue;
      if (budget <= 0) {
        droppedPoints += 1;
        continue;
      }
      budget -= 1;
      points.push([x, y]);
    }
    if (points.length > 0) {
      scatter.push({
        name: label(entry.name) ?? t("Series {number}", { number: index + 1 }),
        points,
      });
    }
  }
  if (scatter.length === 0) return null;
  return withDropped({
    ...base,
    categories: [],
    series: [],
    scatter,
    dropped: {
      series: Math.max(0, raw.length - SCATTER_MAX_SERIES),
      points: droppedPoints,
    },
  });
}

/** Pie and donut: positive slices only, the smallest folded into "Other". */
function pieSlices(categories: string[], values: (number | null)[]) {
  const slices = categories
    .map((name, index) => ({ name, value: values[index] ?? null }))
    .filter((slice): slice is { name: string; value: number } => (slice.value ?? 0) > 0);
  if (slices.length <= MAX_PIE_SLICES) return { slices, folded: 0 };
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, MAX_PIE_SLICES - 1);
  const rest = sorted.slice(MAX_PIE_SLICES - 1);
  const other = rest.reduce((sum, slice) => sum + slice.value, 0);
  // Keep the model's order for the kept slices: it is usually meaningful.
  const keptNames = new Set(kept.map((slice) => slice.name));
  return {
    slices: [
      ...slices.filter((slice) => keptNames.has(slice.name)),
      { name: t("Other"), value: other },
    ],
    folded: rest.length,
  };
}

export function parseChartBlock(payload: Record<string, unknown>): ChartChatBlock | null {
  const type = CHART_TYPES.find((candidate) => candidate === payload.type);
  if (!type) return null;
  const x = axis(payload, "x");
  const y = axis(payload, "y");
  const base = {
    kind: "chart" as const,
    type,
    title: capped(payload.title, MAX_TITLE),
    xTitle: x.title,
    yTitle: y.title,
    unit: y.unit ?? capped(payload.unit, MAX_UNIT),
    xUnit: x.unit,
    stacked: payload.stacked === true && (type === "bar" || type === "area"),
    source: capped(payload.source, MAX_SOURCE),
  };
  if (type === "scatter") return parseScatter(payload, base);

  if (!Array.isArray(payload.categories)) return null;
  const allCategories = payload.categories.map((entry) => label(entry) ?? "");
  const maxCategories = type === "bar" ? MAX_BAR_CATEGORIES : MAX_LINE_CATEGORIES;
  const categories = allCategories.slice(0, maxCategories);
  if (categories.length === 0) return null;
  const raw = seriesList(payload);
  const maxSeries = type === "pie" || type === "donut" ? 1 : CHART_MAX_SERIES;
  const series: ChartSeries[] = [];
  for (const [index, entry] of raw.slice(0, maxSeries).entries()) {
    const values = Array.isArray(entry.values) ? entry.values : [];
    // Short series pad with gaps, long ones are cut to the categories.
    const aligned = categories.map((_, at) => finite(values[at]));
    if (aligned.every((value) => value === null)) continue;
    series.push({
      name: label(entry.name) ?? t("Series {number}", { number: index + 1 }),
      values: aligned,
    });
  }
  if (series.length === 0) return null;

  if (type === "pie" || type === "donut") {
    const { slices, folded } = pieSlices(categories, series[0].values);
    if (slices.length === 0) return null;
    return withDropped({
      ...base,
      categories: slices.map((slice) => slice.name),
      series: [{ name: series[0].name, values: slices.map((slice) => slice.value) }],
      scatter: [],
      dropped: { slices: folded },
    });
  }
  return withDropped({
    ...base,
    categories,
    series,
    scatter: [],
    dropped: {
      series: Math.max(0, raw.length - CHART_MAX_SERIES),
      categories: allCategories.length - categories.length,
    },
  });
}

function parseColumn(entry: unknown): { label: string; unit?: string } | null {
  if (typeof entry === "string" || typeof entry === "number") {
    const text = label(entry);
    return text ? { label: text } : null;
  }
  const item = asObject(entry);
  const text = label(item?.label ?? item?.name);
  return text ? { label: text, unit: capped(item?.unit, MAX_UNIT) } : null;
}

function cell(value: unknown): TableCell {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string")
    return value.length > MAX_CELL ? `${value.slice(0, MAX_CELL - 1)}…` : value;
  return null;
}

export function parseTableBlock(payload: Record<string, unknown>): TableChatBlock | null {
  if (!Array.isArray(payload.columns) || !Array.isArray(payload.rows)) return null;
  const parsedColumns = payload.columns.map(parseColumn);
  // A column with no label is a hole the rows still index through.
  if (parsedColumns.length === 0 || parsedColumns.some((column) => column === null)) return null;
  const width = Math.min(parsedColumns.length, TABLE_MAX_COLUMNS);
  const rows: TableCell[][] = [];
  let validRows = 0;
  for (const entry of payload.rows) {
    const values = Array.isArray(entry) ? entry : null;
    if (!values) continue;
    validRows += 1;
    if (rows.length >= TABLE_MAX_ROWS) continue;
    rows.push(Array.from({ length: width }, (_, index) => cell(values[index])));
  }
  if (rows.length === 0) return null;
  const columns = parsedColumns.slice(0, width).map((column, index) => {
    const filled = rows.map((row) => row[index]).filter((value) => value !== null);
    return {
      label: column?.label ?? "",
      unit: column?.unit,
      // Numbers only: "1,200" stays text rather than guessing a locale.
      numeric: filled.length > 0 && filled.every((value) => typeof value === "number"),
    };
  });
  return withDropped({
    kind: "table" as const,
    title: capped(payload.title, MAX_TITLE),
    columns,
    rows,
    source: capped(payload.source, MAX_SOURCE),
    dropped: {
      rows: validRows - rows.length,
      columns: parsedColumns.length - width,
    },
  });
}

/** The chart's data as table rows: the "Show data" view and the CSV. */
export function chartAsTable(block: ChartChatBlock): TableChatBlock {
  if (block.type === "scatter") {
    return {
      kind: "table",
      title: block.title,
      columns: [
        { label: "Series", numeric: false },
        { label: block.xTitle ?? "x", numeric: true, unit: block.xUnit },
        { label: block.yTitle ?? "y", numeric: true, unit: block.unit },
      ],
      rows: block.scatter.flatMap((series) =>
        series.points.map(([x, y]): TableCell[] => [series.name, x, y]),
      ),
    };
  }
  return {
    kind: "table",
    title: block.title,
    columns: [
      { label: block.xTitle ?? "", numeric: false },
      ...block.series.map((series) => ({ label: series.name, numeric: true, unit: block.unit })),
    ],
    rows: block.categories.map((category, index) => [
      category,
      ...block.series.map((series) => series.values[index] ?? null),
    ]),
  };
}

function csvField(value: TableCell): string {
  if (value === null) return "";
  let text = String(value);
  // Defuse spreadsheet formulas a model might have written into a cell.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function headerLabel(column: TableColumn): string {
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

export function tableToCsv(block: TableChatBlock): string {
  const lines = [
    block.columns.map((column) => csvField(headerLabel(column))).join(","),
    ...block.rows.map((row) => row.map(csvField).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function markdownField(value: TableCell): string {
  if (value === null) return "";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function tableToMarkdown(block: TableChatBlock): string {
  const header = `| ${block.columns.map((column) => markdownField(headerLabel(column))).join(" | ")} |`;
  const rule = `| ${block.columns.map((column) => (column.numeric ? "---:" : "---")).join(" | ")} |`;
  const rows = block.rows.map((row) => `| ${row.map(markdownField).join(" | ")} |`);
  return [header, rule, ...rows].join("\n");
}

/** What a copied reply carries in place of the fence. */
export function dataBlockPlainText(block: ChartChatBlock | TableChatBlock): string[] {
  const table = block.kind === "chart" ? chartAsTable(block) : block;
  const title = block.title ?? (block.kind === "chart" ? "Chart" : "Table");
  return [title, "", tableToMarkdown(table)];
}
