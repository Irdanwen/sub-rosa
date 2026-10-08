/**
 * When an assignment is due: `assignments/schedule.rs`, ported. The app owns
 * the clock (ADR-0091): every time the page looks, it asks which is the
 * latest slot at or before now and whether it has run. A missed morning is
 * one late run, never seven, and a slot older than the latest has perished.
 *
 * Local time is a `Zone`, the browser's own in the page and a fixed offset in
 * the tests, so the Rust tests' vectors run unchanged.
 */
import { ASSIGNMENTS } from "./words";

export type Cadence = "hourly" | "daily" | "weekdays" | "weekly" | "every";
export const CADENCES: Cadence[] = ["hourly", "daily", "weekdays", "weekly", "every"];

export function parseCadence(raw: string): Cadence | null {
  return (CADENCES as string[]).includes(raw) ? (raw as Cadence) : null;
}

export interface Schedule {
  cadence: Cadence;
  /** Minutes after local midnight; hourly reads only the minute of the hour. */
  atMinute: number;
  /** 0 for Sunday to 6 for Saturday, for `weekly`. */
  weekday: number;
  /** The gap in hours for `every`, counted from the day's first slot. */
  everyHours: number;
}

export interface LocalParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 for Sunday. */
  weekday: number;
}

/** A time zone, as far as the clock needs one. */
export interface Zone {
  parts(instant: number): LocalParts;
  /** The instant of a local wall time: the earliest when it happens twice,
   * null when the clock skips it. */
  instant(year: number, month: number, day: number, hour: number, minute: number): number | null;
}

/** The browser's own zone. */
export const browserZone: Zone = {
  parts(instant) {
    const date = new Date(instant);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  },
  instant(year, month, day, hour, minute) {
    // ECMAScript resolves a repeated local time to its earlier instant, and
    // moves a skipped one forward: that one has no slot, as in Rust.
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute
    )
      return null;
    return date.getTime();
  },
};

/** A zone at a fixed offset east of UTC, in minutes. */
export function fixedZone(offsetMinutes: number): Zone {
  const shift = offsetMinutes * 60_000;
  return {
    parts(instant) {
      const date = new Date(instant + shift);
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        weekday: date.getUTCDay(),
      };
    },
    instant: (year, month, day, hour, minute) =>
      Date.UTC(year, month - 1, day, hour, minute) - shift,
  };
}

const DAY_MINUTES = 24 * 60;
/** A weekly cadence always finds a slot inside eight days. */
const SEARCH_DAYS = 8;
const MINUTE = 60_000;

/** The calendar day `offset` days from a local date. */
function shiftDay(parts: LocalParts, offset: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

/** The slots of one local day, in order. */
function slotsOn(
  schedule: Schedule,
  zone: Zone,
  date: { year: number; month: number; day: number; weekday: number },
): number[] {
  let minutes: number[];
  switch (schedule.cadence) {
    case "hourly":
      minutes = Array.from({ length: 24 }, (_, hour) => hour * 60 + (schedule.atMinute % 60));
      break;
    case "daily":
      minutes = [schedule.atMinute];
      break;
    case "weekdays":
      minutes = date.weekday === 0 || date.weekday === 6 ? [] : [schedule.atMinute];
      break;
    case "weekly":
      minutes = date.weekday === schedule.weekday % 7 ? [schedule.atMinute] : [];
      break;
    case "every": {
      const step = Math.min(24, Math.max(1, schedule.everyHours)) * 60;
      const first = Math.min(schedule.atMinute, DAY_MINUTES - 1);
      minutes = [];
      for (let minute = first; minute < DAY_MINUTES; minute += step) minutes.push(minute);
      break;
    }
  }
  const out: number[] = [];
  for (const raw of minutes) {
    const minute = Math.min(raw, DAY_MINUTES - 1);
    const at = zone.instant(date.year, date.month, date.day, Math.floor(minute / 60), minute % 60);
    if (at !== null) out.push(at);
  }
  return out;
}

/** The latest slot at or before `now`. */
export function latestAtOrBefore(schedule: Schedule, now: number, zone: Zone): number | null {
  const today = zone.parts(now);
  for (let back = 0; back <= SEARCH_DAYS; back++) {
    const slots = slotsOn(schedule, zone, shiftDay(today, -back)).filter((slot) => slot <= now);
    if (slots.length) return slots[slots.length - 1];
  }
  return null;
}

/** The first slot after `now`, for "next run" on a screen. */
export function nextAfter(schedule: Schedule, now: number, zone: Zone): number | null {
  const today = zone.parts(now);
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead++) {
    const slot = slotsOn(schedule, zone, shiftDay(today, ahead)).find((at) => at > now);
    if (slot !== undefined) return slot;
  }
  return null;
}

/** The key a slot is recorded under: UTC to the second, as Rust writes it,
 * so two devices write one key for one slot. */
export function slotKey(slot: number): string {
  return new Date(Math.floor(slot / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Who asks whether a slot is due. */
export type Role = "executor" | "fallback";

export interface Due {
  slot: number;
  late: boolean;
}

/**
 * `schedule::due`: nothing before the assignment was active, only the latest
 * slot, never one already run here or anywhere, and a fallback leaves the
 * slot to the device that runs it for the grace period, then runs it late.
 */
export function due(
  schedule: Schedule,
  activeSince: number,
  now: number,
  alreadyRan: (key: string) => boolean,
  role: Role,
  zone: Zone,
): Due | null {
  const slot = latestAtOrBefore(schedule, now, zone);
  if (slot === null || slot < activeSince || alreadyRan(slotKey(slot))) return null;
  const waited = now - slot;
  if (role === "fallback" && waited < ASSIGNMENTS.clock.fallbackGraceMinutes * MINUTE) return null;
  return {
    slot,
    late: role === "fallback" || waited > ASSIGNMENTS.clock.lateAfterMinutes * MINUTE,
  };
}
