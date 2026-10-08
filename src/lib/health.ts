import { invoke } from "@tauri-apps/api/core";
import type { ChartChatBlock } from "./chat-blocks-data";
import { intlLocale, t } from "./i18n";

/**
 * Health (ADR-0099), for both shells. The phone reads the measures the
 * person picked from HealthKit or Health Connect, read only, and keeps one
 * summary a day on the device. The desktop has no health store: it shows
 * what a phone sent, measure by measure, only where the person switched that
 * measure's sync on. The commands live in `src-tauri/src/health/`.
 */

export const HEALTH_METRICS = [
  "steps",
  "sleep",
  "heart_rate",
  "resting_heart_rate",
  "workouts",
  "weight",
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];

export type HealthDay = {
  metric: HealthMetric;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  value: number;
  low?: number | null;
  high?: number | null;
  samples: number;
};

export type HealthMetricState = {
  metric: HealthMetric;
  enabled: boolean;
  sync: boolean;
  days: number;
  lastDay?: string | null;
};

export type HealthStatus = {
  /** `healthkit`, `health_connect`, or `none` on a computer. */
  source: "healthkit" | "health_connect" | "none";
  availability: "available" | "unavailable" | "update_required" | "elsewhere";
  metrics: HealthMetricState[];
};

export const healthStatus = () => invoke<HealthStatus>("health_status");
export const healthChoose = (metrics: HealthMetric[]) =>
  invoke<HealthStatus>("health_choose", { metrics });
export const healthRefresh = () => invoke<HealthStatus>("health_refresh");
export const healthSetSync = (metric: HealthMetric, sync: boolean) =>
  invoke<HealthStatus>("health_set_sync", { metric, sync });
export const healthForget = (metric?: HealthMetric) =>
  invoke<HealthStatus>("health_forget", { metric: metric ?? null });
export const healthDays = (from: string, to: string) =>
  invoke<HealthDay[]>("health_days", { from, to });

export function healthMetricLabel(metric: HealthMetric): string {
  switch (metric) {
    case "steps":
      return t("Step count");
    case "sleep":
      return t("Sleep");
    case "heart_rate":
      return t("Heart rate");
    case "resting_heart_rate":
      return t("Resting heart rate");
    case "workouts":
      return t("Workouts");
    case "weight":
      return t("Weight");
  }
}

/** The unit a chart's axis carries. */
export function healthMetricUnit(metric: HealthMetric): string {
  switch (metric) {
    case "steps":
      return t("steps");
    case "sleep":
    case "workouts":
      return t("min");
    case "heart_rate":
    case "resting_heart_rate":
      return t("bpm");
    case "weight":
      return t("kg");
  }
}

/** A day's value as a person reads it: "8,412 steps", "7 h 05", "62 bpm". */
export function formatHealthValue(metric: HealthMetric, value: number): string {
  const number = (digits: number) =>
    new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits }).format(value);
  switch (metric) {
    case "steps":
      return t("{count} steps walked", { count: number(0) });
    case "sleep":
    case "workouts": {
      const minutes = Math.round(value);
      const hours = Math.floor(minutes / 60);
      const rest = String(minutes % 60).padStart(2, "0");
      return hours > 0
        ? t("{hours} h {minutes}", { hours, minutes: rest })
        : t("{minutes} min", { minutes });
    }
    case "heart_rate":
    case "resting_heart_rate":
      return t("{count} bpm", { count: number(0) });
    case "weight":
      return t("{count} kg", { count: number(1) });
  }
}

/** YYYY-MM-DD in the local calendar. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The `days` days ending today, oldest first. */
export function dayRange(days: number, today = new Date()): string[] {
  const range: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    range.push(localDay(date));
  }
  return range;
}

function shortDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short" }).format(
    new Date(year, month - 1, date),
  );
}

/**
 * One measure over a run of days as the chat's chart block, so the view
 * draws it with the same card a chart in a reply uses. Totals are bars,
 * rates and weight a line; a day without a reading is a gap, never a zero.
 */
export function healthChart(
  metric: HealthMetric,
  days: HealthDay[],
  range: string[],
): ChartChatBlock {
  const byDay = new Map(days.filter((day) => day.metric === metric).map((day) => [day.day, day]));
  const line = metric === "heart_rate" || metric === "resting_heart_rate" || metric === "weight";
  const round = (value: number) =>
    metric === "weight" ? Math.round(value * 10) / 10 : Math.round(value);
  return {
    kind: "chart",
    type: line ? "line" : "bar",
    title: healthMetricLabel(metric),
    unit: healthMetricUnit(metric),
    stacked: false,
    categories: range.map(shortDay),
    series: [
      {
        name: healthMetricLabel(metric),
        values: range.map((day) => {
          const found = byDay.get(day);
          return found ? round(found.value) : null;
        }),
      },
    ],
    scatter: [],
  };
}

/** The mean of the days that have a reading, or null when none has. */
export function healthAverage(metric: HealthMetric, days: HealthDay[]): number | null {
  const values = days.filter((day) => day.metric === metric).map((day) => day.value);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
