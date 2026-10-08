import { IconFileDownload } from "central-icons/IconFileDownload";
import { IconTable } from "central-icons/IconTable";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../../styles/chat-data.css";
import {
  arcPath,
  barPath,
  formatPercent,
  formatTick,
  formatValue,
  labelStride,
  niceTicks,
  scale,
  shortLabel,
  stackSeries,
  valueExtent,
  xExtent,
} from "../../lib/chart-geometry";
import { type ChartChatBlock, chartAsTable, tableToCsv } from "../../lib/chat-blocks-data";
import { exportChatData, standaloneSvg, svgToPngBase64 } from "../../lib/chat-data-export";
import { t } from "../../lib/i18n";
import { DataAction, DataTable, DroppedNotice } from "./TableCard";

/** Width of one character of 11-12px UI text, for layout before paint. */
const CHAR = 6.6;
const FALLBACK_WIDTH = 560;

type Active = { series: number; index: number };

type Frame = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(Math.floor(element.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Fixed slot order, never cycled: the parser caps series at the palette. */
function slot(index: number) {
  return `chat-chart-s${(index % 8) + 1}`;
}

type LegendEntry = { name: string; slot: number };

/** Swatch + name rows that wrap to the width. Drawn in the SVG so a saved
 * chart keeps its key. */
function legendLayout(entries: LegendEntry[], width: number) {
  const items: { entry: LegendEntry; x: number; y: number }[] = [];
  let x = 0;
  let row = 0;
  for (const entry of entries) {
    const span = 16 + shortLabel(entry.name, 28).length * CHAR + 16;
    if (x > 0 && x + span > width) {
      x = 0;
      row += 1;
    }
    items.push({ entry, x, y: row * 18 });
    x += span;
  }
  return { items, height: entries.length > 0 ? (row + 1) * 18 + 8 : 0 };
}

function Legend({ layout }: { layout: ReturnType<typeof legendLayout> }) {
  return (
    <g className="chat-chart-legend" aria-hidden>
      {layout.items.map(({ entry, x, y }) => (
        <g key={`${entry.slot}-${entry.name}`} transform={`translate(${x} ${y})`}>
          <rect className={slot(entry.slot)} x={0} y={3} width={10} height={10} rx={2} />
          <text x={16} y={12}>
            {shortLabel(entry.name, 28)}
          </text>
        </g>
      ))}
    </g>
  );
}

function YAxis({
  ticks,
  y,
  frame,
  unit,
  title,
}: {
  ticks: number[];
  y: (value: number) => number;
  frame: Frame;
  unit?: string;
  title?: string;
}) {
  return (
    <g className="chat-chart-axis" aria-hidden>
      {title ? (
        <text x={0} y={frame.top - 8} className="chat-chart-axis-title">
          {unit && unit !== "%" ? `${title} (${unit})` : title}
        </text>
      ) : null}
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            className={tick === 0 ? "chat-chart-baseline" : "chat-chart-grid"}
            x1={frame.left}
            x2={frame.width - frame.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text x={frame.left - 6} y={y(tick) + 4} textAnchor="end">
            {formatTick(tick, title && unit !== "%" ? undefined : unit)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XTitle({ frame, title }: { frame: Frame; title?: string }) {
  if (!title) return null;
  return (
    <text
      className="chat-chart-axis chat-chart-axis-title"
      x={frame.left + (frame.width - frame.left - frame.right) / 2}
      y={frame.height - 4}
      textAnchor="middle"
      aria-hidden
    >
      {title}
    </text>
  );
}

function typeLabel(type: ChartChatBlock["type"]): string {
  switch (type) {
    case "bar":
      return t("Bar chart");
    case "line":
      return t("Line chart");
    case "area":
      return t("Area chart");
    case "pie":
      return t("Pie chart");
    case "donut":
      return t("Donut chart");
    case "scatter":
      return t("Scatter plot");
  }
}

/** Everything a category chart (bar, line, area) needs to draw. */
function categoryLayout(block: ChartChatBlock, width: number) {
  const legend = legendLayout(
    block.series.length > 1
      ? block.series.map((series, index) => ({ name: series.name, slot: index }))
      : [],
    width,
  );
  const ticks = niceTicks(...valueExtent(block));
  const tickUnit = block.yTitle && block.unit !== "%" ? undefined : block.unit;
  const left = Math.max(...ticks.map((tick) => formatTick(tick, tickUnit).length)) * CHAR + 12;
  // Lines name themselves at their right end when there are few enough to
  // read apart; the legend stays for the rest.
  const endLabels =
    block.type !== "bar" && block.series.length > 1 && block.series.length <= 4 && width >= 420;
  const right = endLabels
    ? Math.min(110, Math.max(...block.series.map((series) => series.name.length)) * CHAR + 14)
    : 12;
  const top = legend.height + (block.yTitle ? 24 : 10);
  const bottom = 24 + (block.xTitle ? 18 : 0);
  const height = (width < 480 ? 220 : 260) + legend.height;
  const frame: Frame = { width, height, left, right, top, bottom };
  const plotWidth = Math.max(10, width - left - right);
  const y = scale([ticks[0], ticks[ticks.length - 1]], [height - bottom, top]);
  const count = block.categories.length;
  const band = plotWidth / count;
  const x =
    block.type === "bar"
      ? (index: number) => left + band * (index + 0.5)
      : (index: number) =>
          count === 1 ? left + plotWidth / 2 : left + (index * plotWidth) / (count - 1);
  return { legend, ticks, frame, y, x, band, plotWidth, endLabels };
}

type CategoryLayout = ReturnType<typeof categoryLayout>;

function XLabels({ block, layout }: { block: ChartChatBlock; layout: CategoryLayout }) {
  const longest = Math.min(12, Math.max(...block.categories.map((label) => label.length)));
  const stride = labelStride(block.categories.length, layout.plotWidth, longest * CHAR + 10);
  const baseline = layout.frame.height - layout.frame.bottom + 16;
  return (
    <g className="chat-chart-axis" aria-hidden>
      {block.categories.map((category, index) =>
        index % stride === 0 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: categories may repeat
          <text key={index} x={layout.x(index)} y={baseline} textAnchor="middle">
            {shortLabel(category, 12)}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Bars({
  block,
  layout,
  active,
}: {
  block: ChartChatBlock;
  layout: CategoryLayout;
  active: Active | null;
}) {
  const zero = layout.y(
    Math.max(layout.ticks[0], Math.min(0, layout.ticks[layout.ticks.length - 1])),
  );
  const marks: ReactNode[] = [];
  if (block.stacked) {
    const stacks = stackSeries(block);
    const barWidth = Math.max(1, Math.min(24, layout.band * 0.7));
    block.categories.forEach((_, index) => {
      const outermost = new Map<boolean, number>();
      stacks.forEach((stack, seriesIndex) => {
        const [from, to] = stack[index];
        if (from !== to) outermost.set(to >= 0, seriesIndex);
      });
      stacks.forEach((stack, seriesIndex) => {
        const [from, to] = stack[index];
        if (from === to) return;
        // The 2px surface gap between touching segments.
        const gap = from !== 0 && Math.abs(layout.y(to) - layout.y(from)) > 3 ? 2 : 0;
        const start = layout.y(from) + (to >= 0 ? -gap : gap);
        marks.push(
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: marks are positional
            key={`${seriesIndex}-${index}`}
            className={slot(seriesIndex)}
            d={barPath(
              layout.x(index) - barWidth / 2,
              barWidth,
              start,
              layout.y(to),
              outermost.get(to >= 0) === seriesIndex,
            )}
          />,
        );
      });
    });
  } else {
    const count = block.series.length;
    const barWidth = Math.max(1, Math.min(24, (layout.band * 0.8 - 2 * (count - 1)) / count));
    const total = count * barWidth + 2 * (count - 1);
    block.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, index) => {
        if (value === null) return;
        const x = layout.x(index) - total / 2 + seriesIndex * (barWidth + 2);
        marks.push(
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: marks are positional
            key={`${seriesIndex}-${index}`}
            className={slot(seriesIndex)}
            d={barPath(x, barWidth, zero, layout.y(value))}
          />,
        );
      });
    });
  }
  return (
    <g aria-hidden>
      {active ? (
        <rect
          className="chat-chart-band"
          x={layout.x(active.index) - layout.band / 2}
          y={layout.frame.top}
          width={layout.band}
          height={layout.frame.height - layout.frame.top - layout.frame.bottom}
        />
      ) : null}
      {marks}
    </g>
  );
}

/** The least distance between two points, in chart units, that still draws a
 * dot on each: three dot diameters. */
const MIN_MARKER_SPACING = 24;

/** Line or area paths, broken at every gap rather than bridging it. */
function Lines({
  block,
  layout,
  active,
}: {
  block: ChartChatBlock;
  layout: CategoryLayout;
  active: Active | null;
}) {
  const stacks = block.stacked ? stackSeries(block) : null;
  const zero = layout.y(
    Math.max(layout.ticks[0], Math.min(0, layout.ticks[layout.ticks.length - 1])),
  );
  // A dot per point only while the points stand apart: closer than a few
  // dot widths, the dots overlap and hide the line they mark (26 weeks on a
  // phone read as beads with no line). The pointer still marks the hovered one.
  const spacing =
    block.categories.length > 1 ? Math.abs(layout.x(1) - layout.x(0)) : Number.POSITIVE_INFINITY;
  const markers = block.categories.length <= 40 && spacing >= MIN_MARKER_SPACING;
  const lastY: { name: string; y: number; series: number }[] = [];
  const paths = block.series.map((series, seriesIndex) => {
    const upper = (index: number) => {
      const value = series.values[index];
      if (value === null) return null;
      return stacks ? stacks[seriesIndex][index][1] : value;
    };
    const lower = (index: number) => (stacks ? layout.y(stacks[seriesIndex][index][0]) : zero);
    const runs: number[][] = [];
    let run: number[] = [];
    series.values.forEach((_, index) => {
      if (upper(index) === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(index);
    });
    if (run.length) runs.push(run);
    const line = runs
      .map((indices) =>
        indices
          .map(
            (index, at) =>
              `${at ? "L" : "M"} ${layout.x(index).toFixed(2)} ${layout.y(upper(index) ?? 0).toFixed(2)}`,
          )
          .join(" "),
      )
      .join(" ");
    const area =
      block.type === "area"
        ? runs
            .map((indices) => {
              const top = indices
                .map(
                  (index, at) =>
                    `${at ? "L" : "M"} ${layout.x(index).toFixed(2)} ${layout.y(upper(index) ?? 0).toFixed(2)}`,
                )
                .join(" ");
              const back = [...indices]
                .reverse()
                .map((index) => `L ${layout.x(index).toFixed(2)} ${lower(index).toFixed(2)}`)
                .join(" ");
              return `${top} ${back} Z`;
            })
            .join(" ")
        : null;
    const last = [...series.values.keys()].reverse().find((index) => upper(index) !== null);
    if (last !== undefined)
      lastY.push({ name: series.name, y: layout.y(upper(last) ?? 0), series: seriesIndex });
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: series are positional
      <g key={seriesIndex} className={slot(seriesIndex)}>
        {area ? <path className="chat-chart-area" d={area} /> : null}
        <path className="chat-chart-line" d={line} />
        {series.values.map((_, index) => {
          const value = upper(index);
          const hot = active?.index === index;
          if (value === null || (!markers && !hot)) return null;
          return (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
              key={index}
              className="chat-chart-dot"
              cx={layout.x(index)}
              cy={layout.y(value)}
              r={hot ? 5 : 4}
            />
          );
        })}
      </g>
    );
  });
  // Direct labels only when they do not collide: nudged labels detach from
  // their lines, so a crowded right edge falls back to the legend.
  const sorted = [...lastY].sort((a, b) => a.y - b.y);
  const apart = sorted.every((entry, index) => index === 0 || entry.y - sorted[index - 1].y >= 13);
  return (
    <g aria-hidden>
      {active ? (
        <line
          className="chat-chart-crosshair"
          x1={layout.x(active.index)}
          x2={layout.x(active.index)}
          y1={layout.frame.top}
          y2={layout.frame.height - layout.frame.bottom}
        />
      ) : null}
      {paths}
      {layout.endLabels && apart
        ? lastY.map((entry) => (
            <text
              key={entry.series}
              className="chat-chart-end-label"
              x={layout.frame.width - layout.frame.right + 8}
              y={entry.y + 4}
            >
              {shortLabel(entry.name, 16)}
            </text>
          ))
        : null}
    </g>
  );
}

function pieLayout(block: ChartChatBlock, width: number) {
  const values = block.series[0]?.values ?? [];
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const legend = legendLayout(
    block.categories.map((name, index) => ({
      name: `${name} ${formatPercent((values[index] ?? 0) / (total || 1))}`,
      slot: index,
    })),
    width,
  );
  const radius = width < 480 ? 88 : 104;
  const height = legend.height + radius * 2 + 16;
  const cx = width / 2;
  const cy = legend.height + 8 + radius;
  let angle = 0;
  const slices = values.map((value, index) => {
    const sweep = ((value ?? 0) / (total || 1)) * Math.PI * 2;
    const slice = { index, start: angle, end: angle + sweep };
    angle += sweep;
    return slice;
  });
  return { legend, radius, height, cx, cy, slices, total };
}

function Pie({
  block,
  layout,
  active,
}: {
  block: ChartChatBlock;
  layout: ReturnType<typeof pieLayout>;
  active: Active | null;
}) {
  const inner = block.type === "donut" ? layout.radius * 0.6 : 0;
  return (
    <g aria-hidden>
      {layout.slices.map((slice) => {
        const hot = active?.index === slice.index;
        const middle = (slice.start + slice.end) / 2;
        const nudge = hot ? 4 : 0;
        return (
          <path
            key={slice.index}
            className={`${slot(slice.index)} chat-chart-slice`}
            transform={`translate(${(Math.sin(middle) * nudge).toFixed(2)} ${(-Math.cos(middle) * nudge).toFixed(2)})`}
            d={arcPath(layout.cx, layout.cy, layout.radius, inner, slice.start, slice.end)}
          />
        );
      })}
      {inner > 0 ? (
        <text className="chat-chart-total" x={layout.cx} y={layout.cy + 5} textAnchor="middle">
          {formatValue(layout.total, block.unit)}
        </text>
      ) : null}
    </g>
  );
}

function scatterLayout(block: ChartChatBlock, width: number) {
  const legend = legendLayout(
    block.scatter.length > 1
      ? block.scatter.map((series, index) => ({ name: series.name, slot: index }))
      : [],
    width,
  );
  const yTicks = niceTicks(...valueExtent(block));
  const xTicks = niceTicks(...xExtent(block));
  const tickUnit = block.yTitle && block.unit !== "%" ? undefined : block.unit;
  const left = Math.max(...yTicks.map((tick) => formatTick(tick, tickUnit).length)) * CHAR + 12;
  const top = legend.height + (block.yTitle ? 24 : 10);
  const bottom = 24 + (block.xTitle ? 18 : 0);
  const height = (width < 480 ? 240 : 280) + legend.height;
  const frame: Frame = { width, height, left, right: 16, top, bottom };
  const x = scale([xTicks[0], xTicks[xTicks.length - 1]], [left, width - 16]);
  const y = scale([yTicks[0], yTicks[yTicks.length - 1]], [height - bottom, top]);
  return { legend, frame, x, y, xTicks, yTicks };
}

function Scatter({
  block,
  layout,
  active,
}: {
  block: ChartChatBlock;
  layout: ReturnType<typeof scatterLayout>;
  active: Active | null;
}) {
  const dense = block.scatter.reduce((sum, series) => sum + series.points.length, 0) > 300;
  const stride = labelStride(layout.xTicks.length, layout.frame.width - layout.frame.left, 48);
  return (
    <g aria-hidden>
      <g className="chat-chart-axis">
        {layout.xTicks.map((tick, index) =>
          index % stride === 0 ? (
            <text
              key={tick}
              x={layout.x(tick)}
              y={layout.frame.height - layout.frame.bottom + 16}
              textAnchor="middle"
            >
              {formatTick(tick, block.xTitle ? undefined : block.xUnit)}
            </text>
          ) : null,
        )}
      </g>
      {block.scatter.map((series, seriesIndex) => (
        <g key={series.name} className={slot(seriesIndex)}>
          {series.points.map(([px, py], index) => {
            const hot = active?.series === seriesIndex && active.index === index;
            return (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
                key={index}
                className="chat-chart-dot"
                cx={layout.x(px)}
                cy={layout.y(py)}
                r={hot ? 6 : dense ? 3 : 4}
              />
            );
          })}
        </g>
      ))}
    </g>
  );
}

/** The sentence a tooltip and the screen reader give for the active datum. */
function describe(
  block: ChartChatBlock,
  active: Active,
  total: number,
): { title: string; rows: { slot: number; name: string; value: string }[] } {
  if (block.type === "scatter") {
    const series = block.scatter[active.series];
    const [x, y] = series?.points[active.index] ?? [0, 0];
    return {
      title: series?.name ?? "",
      rows: [
        { slot: -1, name: block.xTitle ?? "x", value: formatValue(x, block.xUnit) },
        { slot: -1, name: block.yTitle ?? "y", value: formatValue(y, block.unit) },
      ],
    };
  }
  if (block.type === "pie" || block.type === "donut") {
    const value = block.series[0]?.values[active.index] ?? 0;
    return {
      title: block.categories[active.index] ?? "",
      rows: [
        {
          slot: active.index,
          name: formatPercent(value / (total || 1)),
          value: formatValue(value, block.unit),
        },
      ],
    };
  }
  const rows = block.series.map((series, index) => ({
    slot: index,
    name: series.name,
    value: formatValue(series.values[active.index] ?? null, block.unit),
  }));
  if (block.stacked && block.series.length > 1) {
    const sum = block.series.reduce((acc, series) => acc + (series.values[active.index] ?? 0), 0);
    rows.push({ slot: -1, name: t("Total"), value: formatValue(sum, block.unit) });
  }
  return { title: block.categories[active.index] ?? "", rows };
}

export function ChartCard({ block }: { block: ChartChatBlock }) {
  const plot = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(plot);
  const [active, setActive] = useState<Active | null>(null);
  const [showData, setShowData] = useState(false);
  const name = block.title || typeLabel(block.type);

  const view = useMemo(() => {
    if (block.type === "pie" || block.type === "donut") {
      return { kind: "pie" as const, layout: pieLayout(block, width) };
    }
    if (block.type === "scatter")
      return { kind: "scatter" as const, layout: scatterLayout(block, width) };
    return { kind: "category" as const, layout: categoryLayout(block, width) };
  }, [block, width]);

  const height = view.kind === "pie" ? view.layout.height : view.layout.frame.height;
  const total = view.kind === "pie" ? view.layout.total : 0;
  const pointCount = (series: number) =>
    block.type === "scatter"
      ? (block.scatter[series]?.points.length ?? 0)
      : block.categories.length;
  const seriesCount = block.type === "scatter" ? block.scatter.length : block.series.length;

  const pick = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    if (view.kind === "category") {
      const { layout } = view;
      const count = block.categories.length;
      const raw =
        block.type === "bar"
          ? Math.floor((px - layout.frame.left) / layout.band)
          : Math.round(((px - layout.frame.left) / layout.plotWidth) * (count - 1));
      setActive({ series: active?.series ?? 0, index: Math.max(0, Math.min(count - 1, raw)) });
    } else if (view.kind === "pie") {
      const { layout } = view;
      const dx = px - layout.cx;
      const dy = py - layout.cy;
      if (Math.hypot(dx, dy) > layout.radius + 6) return setActive(null);
      const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
      const slice = layout.slices.find((entry) => angle >= entry.start && angle < entry.end);
      setActive(slice ? { series: 0, index: slice.index } : null);
    } else {
      const { layout } = view;
      let best: Active | null = null;
      let distance = 24;
      block.scatter.forEach((series, seriesIndex) => {
        series.points.forEach(([x, y], index) => {
          const gap = Math.hypot(layout.x(x) - px, layout.y(y) - py);
          if (gap < distance) {
            distance = gap;
            best = { series: seriesIndex, index };
          }
        });
      });
      setActive(best);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    const current = active ?? { series: 0, index: -1 };
    const last = pointCount(current.series) - 1;
    let next: Active | null = current;
    switch (event.key) {
      case "ArrowRight":
        next = { ...current, index: Math.min(last, current.index + 1) };
        break;
      case "ArrowLeft":
        next = { ...current, index: Math.max(0, current.index - 1) };
        break;
      case "ArrowDown":
      case "ArrowUp": {
        if (seriesCount < 2) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const series = (current.series + step + seriesCount) % seriesCount;
        next = { series, index: Math.max(0, Math.min(pointCount(series) - 1, current.index)) };
        break;
      }
      case "Home":
        next = { ...current, index: 0 };
        break;
      case "End":
        next = { ...current, index: last };
        break;
      case "Escape":
        next = null;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActive(next);
  };

  const detail = active && active.index >= 0 ? describe(block, active, total) : null;
  const anchorX =
    active && active.index >= 0
      ? view.kind === "category"
        ? view.layout.x(active.index)
        : view.kind === "scatter"
          ? view.layout.x(block.scatter[active.series]?.points[active.index]?.[0] ?? 0)
          : view.layout.cx
      : 0;

  const save = async (format: "png" | "svg") => {
    if (!svg.current) return;
    const text = standaloneSvg(svg.current, block.title);
    return exportChatData(name, format, format === "svg" ? text : await svgToPngBase64(text));
  };

  const dropped = [
    block.dropped?.series
      ? t("{count} more series were left out", { count: block.dropped.series })
      : null,
    block.dropped?.categories
      ? t("{count} more categories were left out", { count: block.dropped.categories })
      : null,
    block.dropped?.points
      ? t("{count} more points were left out", { count: block.dropped.points })
      : null,
    block.dropped?.slices
      ? t("The {count} smallest slices are grouped as Other", { count: block.dropped.slices })
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className="chat-block chat-data" aria-label={name}>
      {block.title ? <h4 className="chat-block-title">{block.title}</h4> : null}
      <figure
        ref={plot}
        className="chat-chart-plot"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is read with the arrow keys, one stop for every point
        tabIndex={0}
        aria-label={t("{chart}. Use the arrow keys to read the values.", {
          chart: typeLabel(block.type),
        })}
        onKeyDown={onKey}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setActive(null);
        }}
        onBlur={() => setActive(null)}
      >
        <svg
          ref={svg}
          className="chat-chart"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden
        >
          {view.kind === "category" ? (
            <>
              <Legend layout={view.layout.legend} />
              <YAxis
                ticks={view.layout.ticks}
                y={view.layout.y}
                frame={view.layout.frame}
                unit={block.unit}
                title={block.yTitle}
              />
              {block.type === "bar" ? (
                <Bars block={block} layout={view.layout} active={active} />
              ) : (
                <Lines block={block} layout={view.layout} active={active} />
              )}
              <XLabels block={block} layout={view.layout} />
              <XTitle frame={view.layout.frame} title={block.xTitle} />
            </>
          ) : view.kind === "pie" ? (
            <>
              <Legend layout={view.layout.legend} />
              <Pie block={block} layout={view.layout} active={active} />
            </>
          ) : (
            <>
              <Legend layout={view.layout.legend} />
              <YAxis
                ticks={view.layout.yTicks}
                y={view.layout.y}
                frame={view.layout.frame}
                unit={block.unit}
                title={block.yTitle}
              />
              <Scatter block={block} layout={view.layout} active={active} />
              <XTitle
                frame={view.layout.frame}
                title={
                  block.xTitle && block.xUnit ? `${block.xTitle} (${block.xUnit})` : block.xTitle
                }
              />
            </>
          )}
        </svg>
        {detail ? (
          <div
            className="chat-chart-tooltip"
            data-side={anchorX > width * 0.6 ? "left" : "right"}
            style={{ left: anchorX }}
            aria-hidden
          >
            <strong>{detail.title}</strong>
            {detail.rows.map((row) => (
              <span key={`${row.slot}-${row.name}`} className="chat-chart-tooltip-row">
                {row.slot >= 0 ? <i className={`chat-chart-key ${slot(row.slot)}`} /> : null}
                <span>{row.name}</span>
                <b>{row.value}</b>
              </span>
            ))}
          </div>
        ) : null}
        <p className="chat-data-live" aria-live="polite">
          {detail
            ? `${detail.title}. ${detail.rows.map((row) => `${row.name}: ${row.value}`).join(", ")}`
            : ""}
        </p>
      </figure>
      <DroppedNotice parts={dropped} />
      {block.source ? (
        <p className="chat-data-source">{t("Source: {source}", { source: block.source })}</p>
      ) : null}
      {showData ? (
        <DataTable table={chartAsTable(block)} label={t("Data for {name}", { name })} />
      ) : null}
      <div className="chat-data-actions">
        <button
          type="button"
          className="chat-data-action"
          aria-expanded={showData}
          onClick={() => setShowData((shown) => !shown)}
        >
          <span aria-hidden>
            <IconTable size={13} />
          </span>
          {showData ? t("Hide data") : t("Show data")}
        </button>
        <DataAction
          icon={<IconFileDownload size={13} />}
          label={t("Save as PNG")}
          run={() => save("png")}
        />
        <DataAction
          icon={<IconFileDownload size={13} />}
          label={t("Save as SVG")}
          run={() => save("svg")}
        />
        <DataAction
          icon={<IconFileDownload size={13} />}
          label={t("Save as CSV")}
          run={() => exportChatData(name, "csv", tableToCsv(chartAsTable(block)))}
        />
      </div>
    </section>
  );
}
