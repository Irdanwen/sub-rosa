import {
  arcPath,
  barPath,
  formatPercentIn,
  formatTickIn,
  formatValueIn,
  labelStride,
  niceTicks,
  scale,
  shortLabel,
  stackSeries,
  valueExtent,
  xExtent,
} from "@subrosa/chat-core/chart-geometry";
import {
  type ChartChatBlock,
  chartAsTable,
  type DataBlockWords,
  parseChartBlock,
  parseTableBlock,
  type TableCell,
  type TableChatBlock,
  tableToCsv,
} from "@subrosa/chat-core/chat-blocks-data";
import { useMemo, useState } from "react";
import { t, websiteLocale } from "./i18n";
import "./data-cards.css";

/**
 * Chart and table cards on the website (ADR-0086): the app's parser and
 * arithmetic (`@subrosa/chat-core`), drawn here in SVG and HTML of the
 * site's own, as ADR-0052 keeps components per surface. Everything is text
 * or geometry computed from numbers: nothing is fetched and nothing the
 * model wrote becomes markup. Colours are classes (`series-1` to
 * `series-8`), never a style attribute, which the site's policy refuses.
 */

const WORDS: DataBlockWords = {
  series: (number) => t(`Series ${number}`, `Série ${number}`),
  other: () => t("Other", "Autre"),
};
const locale = () => (websiteLocale() === "fr" ? "fr-FR" : "en-US");
const value = (amount: number | null, unit?: string) =>
  formatValueIn(locale(), t("No value", "Aucune valeur"), amount, unit);

export function parseDataBlock(
  name: string,
  payload: Record<string, unknown> | null,
): ChartChatBlock | TableChatBlock | null {
  if (payload?.v !== 1) return null;
  if (name === "chart") return parseChartBlock(payload, WORDS);
  if (name === "table") return parseTableBlock(payload);
  return null;
}

const WIDTH = 560;
const HEIGHT = 260;
const PAD = { top: 12, right: 12, bottom: 36, left: 52 };

/** Series colours by position: a card is drawn once from fixed data and never
 * reordered, so a position is an identity here. */
const seriesClass = (position: number) => `series-${(position % 8) + 1}`;

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  const items: JSX.Element[] = [];
  for (let position = 0; position < names.length; position++)
    items.push(
      <li key={`legend-${position}`}>
        <span className={`data-swatch ${seriesClass(position)}`} aria-hidden="true" />
        {names[position]}
      </li>,
    );
  return <ul className="data-legend">{items}</ul>;
}

function Cartesian({ block }: { block: ChartChatBlock }) {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const [min, max] = valueExtent(block);
  const ticks = niceTicks(min, max);
  const y = scale([ticks[0], ticks[ticks.length - 1]], [PAD.top + plotHeight, PAD.top]);
  const count = block.categories.length;
  const band = plotWidth / Math.max(1, count);
  const stride = labelStride(count, plotWidth, 64);
  const stacks = block.stacked ? stackSeries(block) : null;
  const center = (index: number) => PAD.left + band * index + band / 2;
  const marks: JSX.Element[] = [];
  if (block.type === "bar") {
    const groups = stacks ? 1 : block.series.length;
    const width = Math.max(2, (band * 0.7) / groups);
    for (let s = 0; s < block.series.length; s++) {
      const series = block.series[s];
      for (let index = 0; index < series.values.length; index++) {
        const amount = series.values[index];
        if (amount === null) continue;
        const [from, to] = stacks ? stacks[s][index] : [0, amount];
        const x = PAD.left + band * index + band * 0.15 + (stacks ? 0 : width * s);
        marks.push(
          <path
            key={`b-${s}-${index}`}
            className={`data-mark ${seriesClass(s)}`}
            d={barPath(x, width, y(from), y(to))}
          >
            <title>{`${series.name}, ${block.categories[index]}: ${value(amount, block.unit)}`}</title>
          </path>,
        );
      }
    }
  } else {
    for (let s = 0; s < block.series.length; s++) {
      const series = block.series[s];
      const points: [number, number, number, number][] = [];
      for (let index = 0; index < series.values.length; index++) {
        const amount = series.values[index];
        if (amount === null) continue;
        const top = stacks ? stacks[s][index][1] : amount;
        points.push([center(index), y(top), amount, index]);
      }
      if (!points.length) continue;
      const line = points
        .map(([px, py], at) => `${at ? "L" : "M"} ${px.toFixed(1)} ${py.toFixed(1)}`)
        .join(" ");
      if (block.type === "area") {
        const base = y(0).toFixed(1);
        const first = points[0][0].toFixed(1);
        const last = points[points.length - 1][0].toFixed(1);
        marks.push(
          <path
            key={`a-${s}`}
            className={`data-area ${seriesClass(s)}`}
            d={`${line} L ${last} ${base} L ${first} ${base} Z`}
          />,
        );
      }
      marks.push(<path key={`l-${s}`} className={`data-line ${seriesClass(s)}`} d={line} />);
      for (const [px, py, amount, index] of points)
        marks.push(
          <circle
            key={`p-${s}-${index}`}
            className={`data-dot ${seriesClass(s)}`}
            cx={px}
            cy={py}
            r={3}
          >
            <title>{`${series.name}, ${block.categories[index]}: ${value(amount, block.unit)}`}</title>
          </circle>,
        );
    }
  }
  const labels: JSX.Element[] = [];
  for (let index = 0; index < block.categories.length; index += stride)
    labels.push(
      <text
        key={`c-${index}`}
        className="data-tick"
        x={center(index)}
        y={HEIGHT - PAD.bottom + 16}
        textAnchor="middle"
      >
        {shortLabel(block.categories[index], 12)}
      </text>,
    );
  return (
    <svg
      className="data-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={block.title ?? t("Chart", "Graphique")}
    >
      {ticks.map((tick) => (
        <g key={`t-${tick}`}>
          <line
            className="data-grid"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text className="data-tick" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
            {formatTickIn(locale(), tick, block.unit)}
          </text>
        </g>
      ))}
      {marks}
      {labels}
    </svg>
  );
}

function Pie({ block }: { block: ChartChatBlock }) {
  const values = block.series[0]?.values ?? [];
  const total = values.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) || 1;
  let angle = 0;
  const cx = HEIGHT / 2;
  const slices: JSX.Element[] = [];
  for (let index = 0; index < values.length; index++) {
    const amount = values[index];
    const start = angle;
    angle += ((amount ?? 0) / total) * Math.PI * 2;
    slices.push(
      <path
        key={`s-${index}`}
        className={`data-mark ${seriesClass(index)}`}
        d={arcPath(cx, cx, cx - 8, block.type === "donut" ? cx * 0.55 : 0, start, angle)}
      >
        <title>{`${block.categories[index]}: ${value(amount, block.unit)} (${formatPercentIn(locale(), (amount ?? 0) / total)})`}</title>
      </path>,
    );
  }
  return (
    <svg
      className="data-chart data-pie"
      viewBox={`0 0 ${HEIGHT} ${HEIGHT}`}
      role="img"
      aria-label={block.title ?? t("Chart", "Graphique")}
    >
      {slices}
    </svg>
  );
}

function Scatter({ block }: { block: ChartChatBlock }) {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const [ymin, ymax] = valueExtent(block);
  const [xmin, xmax] = xExtent(block);
  const yTicks = niceTicks(ymin, ymax);
  const xTicks = niceTicks(xmin, xmax);
  const y = scale([yTicks[0], yTicks[yTicks.length - 1]], [PAD.top + plotHeight, PAD.top]);
  const x = scale([xTicks[0], xTicks[xTicks.length - 1]], [PAD.left, PAD.left + plotWidth]);
  const dots: JSX.Element[] = [];
  for (let s = 0; s < block.scatter.length; s++) {
    const series = block.scatter[s];
    for (let index = 0; index < series.points.length; index++) {
      const [px, py] = series.points[index];
      dots.push(
        <circle
          key={`d-${s}-${index}`}
          className={`data-dot ${seriesClass(s)}`}
          cx={x(px)}
          cy={y(py)}
          r={3.5}
        >
          <title>{`${series.name}: ${value(px, block.xUnit)}, ${value(py, block.unit)}`}</title>
        </circle>,
      );
    }
  }
  return (
    <svg
      className="data-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={block.title ?? t("Chart", "Graphique")}
    >
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line
            className="data-grid"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text className="data-tick" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
            {formatTickIn(locale(), tick, block.unit)}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text
          key={`x-${tick}`}
          className="data-tick"
          x={x(tick)}
          y={HEIGHT - PAD.bottom + 16}
          textAnchor="middle"
        >
          {formatTickIn(locale(), tick, block.xUnit)}
        </text>
      ))}
      {dots}
    </svg>
  );
}

type Sort = { column: number; direction: "ascending" | "descending" };

function compareCells(a: TableCell, b: TableCell, direction: Sort["direction"]): number {
  // Empty cells sit at the bottom whichever way the column is sorted.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), locale(), { numeric: true, sensitivity: "base" });
  return direction === "ascending" ? order : -order;
}

const TABLE_PAGE_ROWS = 20;

/** A sortable table: right-aligned numbers, a scroll of its own, twenty rows
 * at a time. */
export function DataTable({ table }: { table: TableChatBlock }) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [visible, setVisible] = useState(TABLE_PAGE_ROWS);
  const rows = useMemo(
    () =>
      sort
        ? [...table.rows].sort((a, b) =>
            compareCells(a[sort.column] ?? null, b[sort.column] ?? null, sort.direction),
          )
        : table.rows,
    [table.rows, sort],
  );
  const toggle = (column: number) =>
    setSort((current) =>
      current?.column !== column
        ? { column, direction: "ascending" }
        : current.direction === "ascending"
          ? { column, direction: "descending" }
          : null,
    );
  // A table is drawn from fixed rows: a position is its cell's identity.
  const headers: JSX.Element[] = [];
  for (let column = 0; column < table.columns.length; column++) {
    const { label, unit, numeric } = table.columns[column];
    headers.push(
      <th
        key={`h-${column}`}
        scope="col"
        aria-sort={sort?.column === column ? sort.direction : "none"}
        className={numeric ? "numeric" : undefined}
      >
        <button type="button" onClick={() => toggle(column)}>
          {label}
          {unit ? ` (${unit})` : ""}
        </button>
      </th>,
    );
  }
  const body: JSX.Element[] = [];
  const shown = rows.slice(0, visible);
  for (let r = 0; r < shown.length; r++) {
    const cells: JSX.Element[] = [];
    for (let c = 0; c < table.columns.length; c++) {
      const cell = shown[r][c] ?? null;
      cells.push(
        <td key={`c-${c}`} className={table.columns[c].numeric ? "numeric" : undefined}>
          {cell === null
            ? ""
            : typeof cell === "number"
              ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 6 }).format(cell)
              : cell}
        </td>,
      );
    }
    body.push(<tr key={`r-${r}`}>{cells}</tr>);
  }
  return (
    <div className="data-table-scroll">
      <table className="data-table">
        <thead>
          <tr>{headers}</tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
      {rows.length > visible && (
        <button
          className="button"
          type="button"
          onClick={() => setVisible((n) => n + TABLE_PAGE_ROWS)}
        >
          {t(
            `Show more (${rows.length - visible} left)`,
            `Afficher plus (${rows.length - visible} restantes)`,
          )}
        </button>
      )}
    </div>
  );
}

/** A CSV the browser saves itself: a data URL, nothing uploaded. */
function csvHref(table: TableChatBlock): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(tableToCsv(table))}`;
}

function fileStem(title: string | undefined, fallback: string): string {
  return (
    (title ?? fallback)
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || fallback
  );
}

/** One chart or table card. */
export function DataCard({ block }: { block: ChartChatBlock | TableChatBlock }) {
  const [showData, setShowData] = useState(false);
  const table = block.kind === "chart" ? chartAsTable(block) : block;
  const stem = fileStem(block.title, block.kind === "chart" ? "chart" : "table");
  return (
    <figure className="chat-block data-card" data-kind={block.kind}>
      {block.title && <figcaption className="data-title">{block.title}</figcaption>}
      {block.kind === "chart" ? (
        <>
          {block.type === "pie" || block.type === "donut" ? (
            <Pie block={block} />
          ) : block.type === "scatter" ? (
            <Scatter block={block} />
          ) : (
            <Cartesian block={block} />
          )}
          <Legend
            names={
              block.type === "pie" || block.type === "donut"
                ? block.categories
                : block.type === "scatter"
                  ? block.scatter.map((series) => series.name)
                  : block.series.map((series) => series.name)
            }
          />
          {showData && <DataTable table={table} />}
        </>
      ) : (
        <DataTable table={table} />
      )}
      {block.dropped && (
        <p className="quiet">
          {t(
            "Some of the data was left out to fit this card.",
            "Une partie des données a été laissée de côté pour tenir dans cette carte.",
          )}
        </p>
      )}
      {block.source && (
        <p className="quiet">
          {t("Source: ", "Source : ")}
          {block.source}
        </p>
      )}
      <div className="wc-row data-actions">
        {block.kind === "chart" && (
          <button
            className="button"
            type="button"
            aria-expanded={showData}
            onClick={() => setShowData((open) => !open)}
          >
            {showData
              ? t("Hide data", "Masquer les données")
              : t("Show data", "Afficher les données")}
          </button>
        )}
        <a className="button" href={csvHref(table)} download={`${stem}.csv`}>
          {t("Download CSV", "Télécharger en CSV")}
        </a>
      </div>
    </figure>
  );
}
