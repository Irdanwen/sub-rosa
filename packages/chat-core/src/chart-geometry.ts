// The arithmetic behind a `subrosa:chart` card: clean ticks, number
// formatting in the reader's locale, stacking, and pie arcs. Kept apart from
// the component so the shapes can be tested without a DOM. Shared by the app
// and the web client; the locale and the words are each surface's own.

import type { ChartChatBlock } from "./chat-blocks-data";

/** Round numbers for an axis: 0 / 250 / 500, never 0 / 237 / 474. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return niceTicks(min - pad, max + pad, count);
  }
  const span = max - min;
  const rough = span / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Rounded each step so floating error never prints 0.30000000000000004.
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

/** Linear map from a domain to a pixel range. */
export function scale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

const PREFIX_UNITS = new Set(["$", "£", "¥", "US$", "CHF"]);

function withUnit(number: string, locale: string, unit?: string): string {
  if (!unit) return number;
  if (unit === "%") return `${number}%`;
  if (PREFIX_UNITS.has(unit) && locale !== "fr-FR") return `${unit}${number}`;
  return `${number} ${unit}`;
}

/** A value as the tooltip and the table show it: full precision, grouped.
 * `noValue` is the surface's word for a gap. */
export function formatValueIn(
  locale: string,
  noValue: string,
  value: number | null,
  unit?: string,
): string {
  if (value === null) return noValue;
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 4;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return withUnit(number, locale, unit);
}

/** A tick label: short, so 1,200,000 reads 1.2M on a narrow axis. */
export function formatTickIn(locale: string, value: number, unit?: string): string {
  const number = new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) >= 10_000 ? 1 : 2,
  }).format(value);
  return withUnit(number, locale, unit);
}

export function formatPercentIn(locale: string, fraction: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: fraction < 0.1 ? 1 : 0,
  }).format(fraction);
}

/** Each series' [from, to] per category, positives stacking up from zero
 * and negatives stacking down, so a mixed column never overlaps itself. */
export function stackSeries(block: ChartChatBlock): [number, number][][] {
  const positive = block.categories.map(() => 0);
  const negative = block.categories.map(() => 0);
  return block.series.map((series) =>
    series.values.map((value, index): [number, number] => {
      const amount = value ?? 0;
      if (amount >= 0) {
        const from = positive[index];
        positive[index] += amount;
        return [from, positive[index]];
      }
      const from = negative[index];
      negative[index] += amount;
      return [from, negative[index]];
    }),
  );
}

/** The value range a chart's y axis must cover. Bars and areas always
 * include zero: a bar measured from anything else lies about its size. */
export function valueExtent(block: ChartChatBlock): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const take = (value: number | null) => {
    if (value === null) return;
    min = Math.min(min, value);
    max = Math.max(max, value);
  };
  if (block.type === "scatter") {
    for (const series of block.scatter) for (const [, y] of series.points) take(y);
  } else if (block.stacked) {
    for (const stack of stackSeries(block)) {
      for (const [from, to] of stack) {
        take(from);
        take(to);
      }
    }
  } else {
    for (const series of block.series) series.values.forEach(take);
  }
  if (!Number.isFinite(min)) return [0, 1];
  if (block.type === "bar" || block.type === "area") {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  return [min, max];
}

export function xExtent(block: ChartChatBlock): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const series of block.scatter) {
    for (const [x] of series.points) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
  }
  return Number.isFinite(min) ? [min, max] : [0, 1];
}

/** An SVG path for one ring segment (or pie slice when `inner` is 0),
 * angles in radians clockwise from twelve o'clock. */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  // A full circle cannot be drawn as one arc: its ends coincide.
  const sweep = Math.min(end - start, Math.PI * 2 - 1e-6);
  const stop = start + sweep;
  const point = (radius: number, angle: number) =>
    `${(cx + radius * Math.sin(angle)).toFixed(2)} ${(cy - radius * Math.cos(angle)).toFixed(2)}`;
  const large = sweep > Math.PI ? 1 : 0;
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, stop)} Z`;
  }
  return [
    `M ${point(outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, stop)}`,
    `L ${point(inner, stop)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)}`,
    "Z",
  ].join(" ");
}

/** A bar with a 4px rounded data end and a square base, growing up (or
 * down for a negative value) from `base`. */
export function barPath(x: number, width: number, base: number, end: number, round = true) {
  const height = Math.abs(end - base);
  const radius = round ? Math.min(4, width / 2, height) : 0;
  const up = end <= base;
  const top = up ? end : base;
  const bottom = up ? base : end;
  const right = x + width;
  if (radius === 0) return `M ${x} ${top} H ${right} V ${bottom} H ${x} Z`;
  if (up) {
    return `M ${x} ${bottom} V ${top + radius} Q ${x} ${top} ${x + radius} ${top} H ${right - radius} Q ${right} ${top} ${right} ${top + radius} V ${bottom} Z`;
  }
  return `M ${x} ${top} H ${right} V ${bottom - radius} Q ${right} ${bottom} ${right - radius} ${bottom} H ${x + radius} Q ${x} ${bottom} ${x} ${bottom - radius} Z`;
}

/** Which category labels fit on the x axis: every one, or every n-th. */
export function labelStride(count: number, plotWidth: number, labelWidth: number): number {
  if (count <= 1) return 1;
  return Math.max(1, Math.ceil((count * labelWidth) / Math.max(1, plotWidth)));
}

/** The label cut to fit an axis; the tooltip and the table keep it whole. */
export function shortLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
