/**
 * The daily brief's agenda line on the web (ADR-0107).
 *
 * A browser reads no calendar: EventKit lives on the phone and the Mac
 * (ADR-0025). So the agenda reaches the web two ways, and when neither can,
 * the card says which device would add it.
 *
 * - **The card a device composed.** The app files each brief it writes
 *   (`daily_brief_cards`), agenda line included; the panel shows today's.
 * - **A connected calendar.** When the person connected Google or Microsoft
 *   in an app that runs connectors for the browser, the brief here asks that
 *   app for today's events (`calendar_list`, a relayed call) and computes the
 *   line the way the app does (`daily::agenda_of`, checked on Rust's vectors).
 */
import type { FeatureHost } from "../feature";
import {
  forget,
  offerFor,
  relayedConnectors,
  requestCall,
  waitForAnswer,
} from "../connectors/relay";
import { getConnector } from "../connectors/store";
import { uuidV5 } from "./runid";

export interface Agenda {
  count: number;
  firstTitle: string;
  firstAt: string;
}

export interface AgendaEvent {
  /** Epoch seconds. */
  start: number;
  allDay: boolean;
  title: string;
  /** `HH:MM`, local. */
  at: string;
}

/** `daily::agenda_of`: the meetings that are not all-day, counted, and the
 * next one still ahead at `now`, else the first. */
export function agendaOf(events: AgendaEvent[], now: number): Agenda | null {
  const timed = events.filter((event) => !event.allDay).sort((a, b) => a.start - b.start);
  const first = timed.find((event) => event.start >= now) ?? timed[0];
  if (!first) return null;
  return { count: timed.length, firstTitle: first.title, firstAt: first.at };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The entries of `day` (local) among a connector's calendar events, as
 * `builtin::events_from_google` and `events_from_graph` shape them. A date
 * without a time is an all-day entry; a time without an offset is UTC, as
 * Microsoft Graph answers. */
export function eventsOfDay(raw: unknown, now: Date): AgendaEvent[] {
  const list = (raw as { events?: unknown } | null)?.events;
  if (!Array.isArray(list)) return [];
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const out: AgendaEvent[] = [];
  for (const item of list) {
    const start = typeof item?.start === "string" ? item.start : "";
    const title = typeof item?.title === "string" ? item.title : "";
    if (!start) continue;
    const allDay = !start.includes("T");
    const at = allDay
      ? new Date(`${start}T00:00:00`).getTime()
      : Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(start) ? start : `${start}Z`);
    if (Number.isNaN(at) || at < midnight || at >= next) continue;
    const local = new Date(at);
    out.push({
      start: Math.floor(at / 1000),
      allDay,
      title: Array.from(title).slice(0, 160).join(""),
      at: allDay ? "" : `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    });
  }
  return out;
}

/** The calendar connectors an app runs for this tab: Google or Microsoft,
 * with a `calendar_list` its device offers. */
export function relayedCalendars(host: FeatureHost) {
  const out: { connectorId: string; name: string; deviceName: string }[] = [];
  for (const offer of relayedConnectors(host.sync, host.device.id)) {
    // The built-ins go by their provider's id (`connector_for`).
    if (!["google", "microsoft"].includes(offer.connectorId)) continue;
    if (getConnector(host.sync, offer.connectorId)?.enabled === false) continue;
    if (!offer.tools.some((item) => item.name === "calendar_list")) continue;
    out.push({
      connectorId: offer.connectorId,
      name: offer.connectorName,
      deviceName: offer.deviceName,
    });
  }
  return out;
}

/** Today's agenda from a connected calendar, or null when none answered. */
export async function agendaFromCalendars(
  host: FeatureHost,
  now: Date,
  signal?: AbortSignal,
  waitMs = 30_000,
): Promise<Agenda | null> {
  const events: AgendaEvent[] = [];
  let answered = false;
  for (const calendar of relayedCalendars(host)) {
    const offer = offerFor(host.sync, calendar.connectorId, host.device.id);
    if (!offer) continue;
    try {
      const id = await requestCall(host.sync, {
        offer,
        tool: "calendar_list",
        args: { days: 1 },
        approved: false,
        requestedBy: host.device.id ?? "browser",
      });
      const answer = await waitForAnswer(host.sync, id, { signal, waitMs });
      if (answer === "timeout") continue;
      await forget(host.sync, id).catch(() => undefined);
      if (answer.state !== "done") continue;
      answered = true;
      events.push(...eventsOfDay(answer.result.structured, now));
    } catch {
      // A calendar that could not be read says nothing rather than something wrong.
    }
  }
  return answered ? agendaOf(events, Math.floor(now.getTime() / 1000)) : null;
}

// ── Cards that travel ────────────────────────────────────────────────────────

/** `daily_cards::card_id`: one object per device and day. */
export function cardId(deviceId: string, day: string): Promise<string> {
  return uuidV5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", `subrosa:daily-brief:${deviceId}:${day}`);
}

export interface DeviceCard<Card> {
  id: string;
  deviceId: string;
  /** `computer`, `phone` or `browser`. */
  deviceName: string;
  status: string;
  card: Card;
}

/** The cards the person's devices filed for `day`, newest first, this
 * browser's own left out. */
export function deviceCards<Card>(host: FeatureHost, day: string): DeviceCard<Card>[] {
  const out: (DeviceCard<Card> & { at: string })[] = [];
  for (const object of host.sync.rows("daily_brief_cards")) {
    if (object.row.day !== day || object.row.device_id === host.device.id) continue;
    try {
      out.push({
        id: String(object.row.id),
        deviceId: String(object.row.device_id ?? ""),
        deviceName: String(object.row.device_name ?? ""),
        status: String(object.row.status ?? ""),
        card: JSON.parse(String(object.row.card)) as Card,
        at: String(object.row.created_at ?? ""),
      });
    } catch {
      // A card that does not read is not shown.
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _at, ...card }) => card);
}

/** Files this browser's card, as the app files its own, and drops this
 * browser's cards older than the window. Best effort. */
export async function fileCard(
  host: FeatureHost,
  card: { day: string; createdAt: string },
  status: string,
  keepDays: number,
  now = new Date(),
) {
  const device = host.device.id;
  if (!device) return;
  const id = await cardId(device, card.day);
  if (host.sync.object("daily_brief_cards", id)) return;
  const stamp = new Date().toISOString();
  await host.sync.write("daily_brief_cards", {
    id,
    day: card.day,
    device_id: device,
    device_name: "browser",
    card: JSON.stringify(card),
    status,
    created_at: card.createdAt,
    updated_at: stamp,
  });
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  const oldest = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
  for (const object of host.sync.rows("daily_brief_cards"))
    if (object.row.device_id === device && String(object.row.day) < oldest)
      await host.sync.write("daily_brief_cards", object.row, { deleted: true });
  await host.sync.flush().catch(() => undefined);
}
