import type { ReactNode } from "react";
import { number, t } from "../lib/i18n";

/** Charts are plain HTML and CSS: they prerender, read without JavaScript, keep
 * their text at reading size on a phone, and every value is also in the table
 * the reader can open under the chart. One accent marks the family the page is
 * about; everything else is the quiet gray (see the dataviz notes in style.css). */

export type ChartRow = {
  key: string;
  label: string;
  sub?: string;
  value: number;
  display: string;
  href?: string;
  focus?: boolean;
  hollow?: boolean;
};

type Frame = {
  title: string;
  note?: ReactNode;
  caption?: string;
  table: { head: string[]; rows: (string | number)[][] };
};

function ChartFrame({ title, note, caption, table, children }: Frame & { children: ReactNode }) {
  return (
    <figure className="chart">
      <figcaption>
        <strong>{title}</strong>
        {note && <span>{note}</span>}
      </figcaption>
      {children}
      {caption && <p className="chart-caption">{caption}</p>}
      <details className="chart-data">
        <summary>{t("See the numbers", "Voir les chiffres")}</summary>
        <div className="models-table-wrap">
          <table>
            <thead>
              <tr>
                {table.head.map((cell) => (
                  <th scope="col" key={cell}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={String(row[0])}>
                  {row.map((cell, index) => (
                    <td key={`${row[0]}-${table.head[index]}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const Mark = ({ row, children }: { row: ChartRow; children: ReactNode }) =>
  row.href ? (
    <a className="chart-row-link" href={row.href}>
      {children}
    </a>
  ) : (
    <span className="chart-row-link">{children}</span>
  );

/** Magnitudes with a real zero (an index out of 100, a percentage, a price): bars from the baseline. */
export function BarChart({
  rows,
  max,
  ...frame
}: Omit<Frame, "table"> & { rows: ChartRow[]; max?: number; valueHead: string }) {
  const top = max ?? Math.max(...rows.map((row) => row.value), 1);
  return (
    <ChartFrame
      {...frame}
      table={{
        head: [t("Model", "Modèle"), frame.valueHead],
        rows: rows.map((row) => [row.label, row.display]),
      }}
    >
      <ol className="chart-bars">
        {rows.map((row) => (
          <li key={row.key} className={row.focus ? "is-focus" : undefined}>
            <Mark row={row}>
              <span className="chart-label">
                {row.label}
                {row.sub && <small>{row.sub}</small>}
              </span>
              <span className="chart-track" aria-hidden="true">
                <span
                  className="chart-bar"
                  style={{ width: `${Math.max(1.5, (row.value / top) * 100)}%` }}
                />
              </span>
              <span className="chart-value">{row.display}</span>
            </Mark>
          </li>
        ))}
      </ol>
    </ChartFrame>
  );
}

/** Ratings without a natural zero (Elo): a dot on a shared axis, so a gap reads as what it is. */
export function DotChart({
  rows,
  ...frame
}: Omit<Frame, "table"> & { rows: ChartRow[]; valueHead: string }) {
  const values = rows.map((row) => row.value);
  const span = Math.max(...values) - Math.min(...values) || 1;
  const low = Math.min(...values) - span * 0.08;
  const high = Math.max(...values) + span * 0.08;
  const at = (value: number) => ((value - low) / (high - low)) * 100;
  const ticks = niceTicks(low, high, 4);
  return (
    <ChartFrame
      {...frame}
      table={{
        head: [t("Model", "Modèle"), frame.valueHead],
        rows: rows.map((row) => [row.label, row.display]),
      }}
    >
      <ol className="chart-dots">
        {rows.map((row) => (
          <li key={row.key} className={row.focus ? "is-focus" : undefined}>
            <Mark row={row}>
              <span className="chart-label">
                {row.label}
                {row.sub && <small>{row.sub}</small>}
              </span>
              <span className="chart-axis" aria-hidden="true">
                {ticks.map((tick) => (
                  <span className="chart-grid" key={tick} style={{ left: `${at(tick)}%` }} />
                ))}
                <span className="chart-dot" style={{ left: `${at(row.value)}%` }} />
              </span>
              <span className="chart-value">{row.display}</span>
            </Mark>
          </li>
        ))}
      </ol>
      <div className="chart-scale" aria-hidden="true">
        <span />
        <span className="chart-scale-axis">
          {ticks.map((tick) => (
            <span key={tick} style={{ left: `${at(tick)}%` }}>
              {number(tick, 0)}
            </span>
          ))}
        </span>
        <span className="chart-scale-end" />
      </div>
    </ChartFrame>
  );
}

export type ScatterPoint = {
  key: string;
  label: string;
  x: number;
  y: number;
  xDisplay: string;
  yDisplay: string;
  href?: string;
  focus?: boolean;
  hollow?: boolean;
  labelled?: boolean;
};

/** Quality against price. Price is on a log scale: the catalog spans a hundredfold. */
export function ScatterChart({
  points,
  xLabel,
  yLabel,
  higherIsBetter = true,
  legend,
  ...frame
}: Omit<Frame, "table"> & {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  higherIsBetter?: boolean;
  legend?: ReactNode;
}) {
  const xs = points.map((point) => Math.log10(point.x));
  const ys = points.map((point) => point.y);
  const pad = (low: number, high: number) => {
    const span = high - low || 1;
    return [low - span * 0.1, high + span * 0.1] as const;
  };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const left = (point: ScatterPoint) => ((Math.log10(point.x) - x0) / (x1 - x0)) * 100;
  const top = (point: ScatterPoint) =>
    higherIsBetter ? (1 - (point.y - y0) / (y1 - y0)) * 100 : ((point.y - y0) / (y1 - y0)) * 100;
  const yTicks = niceTicks(y0, y1, 4);
  const xTicks = logTicks(10 ** x0, 10 ** x1);
  // Direct labels only where they fit: a label too close to one already placed
  // (in the order the points were given) gives way, and its point keeps its tooltip.
  const placed: ScatterPoint[] = [];
  for (const point of points) {
    if (!point.labelled && !point.focus) continue;
    const crowded = placed.some(
      (other) => Math.abs(left(other) - left(point)) < 14 && Math.abs(top(other) - top(point)) < 7,
    );
    if (!crowded || point.focus) placed.push(point);
  }
  return (
    <ChartFrame
      {...frame}
      table={{
        head: [t("Model", "Modèle"), yLabel, xLabel],
        rows: points.map((point) => [point.label, point.yDisplay, point.xDisplay]),
      }}
    >
      {legend && <div className="chart-legend">{legend}</div>}
      <div className="chart-scatter">
        <span className="chart-y-label">{yLabel}</span>
        <div className="chart-plot">
          {yTicks.map((tick) => (
            <span
              key={`y${tick}`}
              className="chart-hline"
              style={{
                top: `${higherIsBetter ? (1 - (tick - y0) / (y1 - y0)) * 100 : ((tick - y0) / (y1 - y0)) * 100}%`,
              }}
            >
              <span>{number(tick, tick < 10 ? 1 : 0)}</span>
            </span>
          ))}
          {xTicks.map((tick) => (
            <span
              key={`x${tick}`}
              className="chart-vline"
              style={{ left: `${((Math.log10(tick) - x0) / (x1 - x0)) * 100}%` }}
            >
              <span>{number(tick, tick < 1 ? 2 : 0)}</span>
            </span>
          ))}
          <span className="chart-corner" aria-hidden="true">
            {t("Better and cheaper", "Meilleur et moins cher")}
          </span>
          {points.map((point) => {
            const body = (
              <>
                <span
                  className={`chart-point${point.focus ? " is-focus" : ""}${point.hollow ? " is-hollow" : ""}`}
                />
                <span className="chart-tip" role="tooltip">
                  <strong>{point.yDisplay}</strong> {point.label}
                  <small>{point.xDisplay}</small>
                </span>
              </>
            );
            const style = { left: `${left(point)}%`, top: `${top(point)}%` };
            const edge = left(point) > 66 ? " is-end" : "";
            const name = `${point.label}: ${point.yDisplay}, ${point.xDisplay}`;
            return point.href ? (
              <a
                className={`chart-hit${edge}`}
                href={point.href}
                style={style}
                key={point.key}
                aria-label={name}
              >
                {body}
              </a>
            ) : (
              <button
                type="button"
                className={`chart-hit${edge}`}
                style={style}
                key={point.key}
                aria-label={name}
              >
                {body}
              </button>
            );
          })}
          {placed.map((point) => (
            <span
              key={`label-${point.key}`}
              className={`chart-label-layer${left(point) > 66 ? " is-end" : ""}${point.focus ? " is-focus" : ""}`}
              style={{ left: `${left(point)}%`, top: `${top(point)}%` }}
              aria-hidden="true"
            >
              {point.label}
            </span>
          ))}
        </div>
        <span className="chart-x-label">{xLabel}</span>
      </div>
    </ChartFrame>
  );
}

export type TrendPoint = {
  key: string;
  label: string;
  date: string;
  value: number;
  display: string;
  inCatalog: boolean;
};

/** A family's score version after version, in time: what each release bought. */
export function TrendChart({
  points,
  higherIsBetter = true,
  valueHead,
  ...frame
}: Omit<Frame, "table"> & { points: TrendPoint[]; higherIsBetter?: boolean; valueHead: string }) {
  const time = (value: string) => Date.parse(value.length === 7 ? `${value}-15` : value);
  const xs = points.map((point) => time(point.date));
  const ys = points.map((point) => point.value);
  const xSpan = Math.max(...xs) - Math.min(...xs) || 1;
  const ySpan = Math.max(...ys) - Math.min(...ys) || 1;
  const x0 = Math.min(...xs) - xSpan * 0.06;
  const x1 = Math.max(...xs) + xSpan * 0.06;
  const y0 = Math.min(...ys) - ySpan * 0.2;
  const y1 = Math.max(...ys) + ySpan * 0.2;
  const px = (point: TrendPoint) => ((time(point.date) - x0) / (x1 - x0)) * 100;
  const py = (point: TrendPoint) =>
    higherIsBetter
      ? (1 - (point.value - y0) / (y1 - y0)) * 100
      : ((point.value - y0) / (y1 - y0)) * 100;
  const ordered = [...points].sort((a, b) => time(a.date) - time(b.date));
  return (
    <ChartFrame
      {...frame}
      table={{
        head: [t("Version", "Version"), t("Released", "Sortie"), valueHead],
        rows: ordered.map((point) => [point.label, point.date, point.display]),
      }}
    >
      <div className="chart-trend">
        <div className="chart-plot">
          <svg
            className="chart-line"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={ordered.map((point) => `${px(point)},${py(point)}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {ordered.map((point, index) => {
            const best = ordered.reduce((top, item) =>
              higherIsBetter
                ? item.value > top.value
                  ? item
                  : top
                : item.value < top.value
                  ? item
                  : top,
            );
            const last = ordered[ordered.length - 1];
            const nearLast = point !== last && Math.abs(px(point) - px(last)) < 12;
            const labelled = index === 0 || point === last || (point === best && !nearLast);
            return (
              <button
                type="button"
                className={`chart-hit${px(point) > 70 ? " is-end" : px(point) < 30 ? " is-start" : ""}`}
                key={point.key}
                style={{ left: `${px(point)}%`, top: `${py(point)}%` }}
                aria-label={`${point.label}, ${point.date}: ${point.display}`}
              >
                <span
                  className={`chart-point${index === ordered.length - 1 ? " is-focus" : ""}${point.inCatalog ? "" : " is-hollow"}`}
                />
                {labelled && (
                  <span className="chart-point-label">
                    {point.label} <b>{point.display}</b>
                  </span>
                )}
                <span className="chart-tip" role="tooltip">
                  <strong>{point.display}</strong> {point.label}
                  <small>{point.date}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </ChartFrame>
  );
}

/** Round tick values for a linear axis. */
function niceTicks(low: number, high: number, count: number) {
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.ceil(low / step) * step; tick <= high; tick += step)
    ticks.push(Number(tick.toFixed(6)));
  return ticks;
}

/** 1, 2, 5 per decade on a log axis, trimmed to the range. */
function logTicks(low: number, high: number) {
  const ticks: number[] = [];
  for (
    let exponent = Math.floor(Math.log10(low));
    exponent <= Math.ceil(Math.log10(high));
    exponent++
  )
    for (const factor of [1, 2, 5]) {
      const tick = factor * 10 ** exponent;
      if (tick >= low && tick <= high) ticks.push(Number(tick.toPrecision(3)));
    }
  return ticks;
}

/** A labelled number standing on its own: the form for one headline value. */
export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}
