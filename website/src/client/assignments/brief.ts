/**
 * The daily brief on the web (ADR-0091, `moments/daily.rs`): one card a day,
 * at the time the person chose, while this tab is open. Off until asked for,
 * and silent when there is nothing to say. What it says is read, never
 * written by a model: yesterday's notes and the follow-ups they wrote down,
 * results waiting for review, runs that failed, and what is new on the topics
 * the person follows, one web search each.
 *
 * The calendar lives in the apps (ADR-0025), so the agenda line comes from a
 * Google or Microsoft calendar an app reads for this tab, else from the card
 * one of the person's devices composed today, else the panel says which
 * device would add it (ADR-0107, `agenda.ts`).
 *
 * The settings and the followed topics stay in this browser (the app keeps
 * them per device too), sealed in the feature's store. Each day's card is
 * kept there and also filed on the account, as the app files its own.
 */
import { t } from "../../lib/i18n";
import { webSearch } from "../carpe-diem";
import type { FeatureHost } from "../feature";
import { listNotes } from "../library";
import { type Agenda, agendaFromCalendars, deviceCards, fileCard } from "./agenda";
import { resultSummary } from "./prompt";
import { listAssignments, listRuns, needsReview } from "./rows";
import { ASSIGNMENTS } from "./words";

const RULES = ASSIGNMENTS.dailyBrief;

export interface BriefSettings {
  enabled: boolean;
  /** Minutes after local midnight. */
  atMinute: number;
  /** Followed topics, at most five. */
  topics: string[];
}
export const DEFAULT_BRIEF: BriefSettings = {
  enabled: false,
  atMinute: RULES.defaultAtMinute,
  topics: [],
};

export interface CardNote {
  id: string;
  title: string;
  followUps: string[];
}
export interface CardItem {
  runId: string | null;
  assignmentId: string | null;
  title: string;
  detail: string;
}
export interface CardLink {
  title: string;
  url: string;
}
export interface CardTopic {
  topic: string;
  links: CardLink[];
}
export interface DailyCard {
  day: string;
  createdAt: string;
  /** Today's meetings, as one line, when a calendar was read. */
  agenda?: Agenda | null;
  /** Where the agenda came from when another device composed it. */
  agendaFrom?: string | null;
  notes: CardNote[];
  reviews: CardItem[];
  failures: CardItem[];
  topics: CardTopic[];
}
export type CardStatus = "delivered" | "quiet" | "silent";
export interface StoredCard {
  card: DailyCard;
  status: CardStatus;
}

/** `follow_ups`: the items under a heading that names them. */
export function followUps(content: string): string[] {
  let inside = false;
  const found: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || (line.startsWith("**") && line.endsWith("**"))) {
      const heading = line
        .replace(/^#+/, "")
        .replace(/^\*+|\*+$/g, "")
        .trim()
        .toLowerCase();
      inside = RULES.followUpHeadings.some((word) => heading.includes(word));
      continue;
    }
    if (!inside) continue;
    const item = line
      .replace(/^[-*•]+/, "")
      .trim()
      .replace(/^(\[ \])+/, "")
      .replace(/^(\[x\])+/, "")
      .trim()
      .replaceAll("**", "");
    if (item) found.push(item);
    if (found.length === RULES.maxFollowUps) break;
  }
  return found;
}

/** Nothing to say: the silence rule. */
export function isEmpty(card: DailyCard): boolean {
  return (
    !card.agenda &&
    !card.notes.length &&
    !card.reviews.length &&
    !card.failures.length &&
    card.topics.every((topic) => !topic.links.length)
  );
}

/** Today's card is owed: on, its time has passed, none written today. */
export function cardDue(settings: BriefSettings, nowMinute: number, writtenToday: boolean) {
  return settings.enabled && !writtenToday && nowMinute >= settings.atMinute;
}

/** A card written now may still announce itself rather than wait quietly. */
export function mayNotify(settings: BriefSettings, nowMinute: number) {
  return nowMinute - settings.atMinute <= RULES.notifyWindowMinutes;
}

/** `fresh_links`: published in the last two days when the results say when,
 * else the first ones; web links only. */
export function freshLinks(
  results: { title: string; url: string; date?: string }[],
  now: number,
): CardLink[] {
  const dated = results.filter((result) => typeof result.date === "string");
  const chosen = dated.length
    ? dated.filter((result) => {
        const at = Date.parse(result.date as string);
        return !Number.isNaN(at) && now - at <= 2 * 86_400_000;
      })
    : results;
  return chosen
    .filter((result) => /^https?:\/\//.test(result.url))
    .map((result) => ({
      title: Array.from(result.title || result.url)
        .slice(0, 160)
        .join(""),
      url: result.url,
    }))
    .slice(0, RULES.linksPerTopic);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** The local day of an instant, `YYYY-MM-DD`. */
export function dayOf(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The headline a notification carries: what is in the card, counted. */
export function headline(card: DailyCard): string {
  const parts: string[] = [];
  const count = (n: number, one: [string, string], many: (n: number) => [string, string]) => {
    const [en, fr] = n === 1 ? one : many(n);
    parts.push(t(en, fr));
  };
  if (card.agenda)
    count(card.agenda.count, ["1 meeting", "1 réunion"], (n) => [`${n} meetings`, `${n} réunions`]);
  if (card.notes.length)
    count(card.notes.length, ["1 note from yesterday", "1 note d’hier"], (n) => [
      `${n} notes from yesterday`,
      `${n} notes d’hier`,
    ]);
  if (card.reviews.length)
    count(card.reviews.length, ["1 result to review", "1 résultat à examiner"], (n) => [
      `${n} results to review`,
      `${n} résultats à examiner`,
    ]);
  if (card.failures.length)
    count(card.failures.length, ["1 run that failed", "1 exécution en échec"], (n) => [
      `${n} runs that failed`,
      `${n} exécutions en échec`,
    ]);
  const news = card.topics.filter((topic) => topic.links.length).length;
  if (news)
    count(news, ["news on 1 followed topic", "du nouveau sur 1 sujet suivi"], (n) => [
      `news on ${n} followed topics`,
      `du nouveau sur ${n} sujets suivis`,
    ]);
  return parts.join(", ");
}

/** Composes today's card from what this browser holds. */
export async function compose(
  host: FeatureHost,
  settings: BriefSettings,
  now: Date,
  signal?: AbortSignal,
): Promise<DailyCard> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const notes = listNotes(host.sync)
    .filter((note) => {
      const at = Date.parse(note.createdAt);
      return at >= yesterday && at < midnight;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RULES.maxNotes)
    .map((note) => ({ id: note.id, title: note.title, followUps: followUps(note.body) }));
  const titles = new Map(listAssignments(host.sync).map((row) => [row.id, row.title]));
  const reviews = needsReview(host.sync)
    .filter((run) => titles.has(run.assignmentId))
    .slice(0, RULES.maxItems)
    .map((run) => ({
      runId: run.id,
      assignmentId: run.assignmentId,
      title: titles.get(run.assignmentId) ?? "",
      detail: run.result ? resultSummary(run.result) : "",
    }));
  const since = now.getTime() - 24 * 3600_000;
  const failures = listRuns(host.sync)
    .filter(
      (run) =>
        run.state === "failed" &&
        titles.has(run.assignmentId) &&
        Date.parse(run.updatedAt) >= since,
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RULES.maxItems)
    .map((run) => ({
      runId: run.id,
      assignmentId: run.assignmentId,
      title: titles.get(run.assignmentId) ?? "",
      detail: run.error ?? "",
    }));
  const topics: CardTopic[] = [];
  const key = settings.topics.length ? await host.openKey().catch(() => null) : null;
  for (const topic of settings.topics.slice(0, RULES.maxTopics)) {
    let links: CardLink[] = [];
    if (key)
      try {
        links = freshLinks(await webSearch(host.operator, key, topic, 5, signal), now.getTime());
      } catch {
        // A failed search says nothing rather than something wrong.
      }
    topics.push({ topic, links });
  }
  const day = dayOf(now);
  let agenda = await agendaFromCalendars(host, now, signal).catch(() => null);
  let agendaFrom: string | null = null;
  if (!agenda) {
    // The line one of the person's devices composed this morning.
    const shared = deviceCards<DailyCard>(host, day).find((entry) => entry.card.agenda);
    if (shared) {
      agenda = shared.card.agenda ?? null;
      agendaFrom = shared.deviceName;
    }
  }
  return {
    day,
    createdAt: now.toISOString(),
    agenda,
    agendaFrom,
    notes,
    reviews,
    failures,
    topics,
  };
}

export async function loadBrief(host: FeatureHost): Promise<BriefSettings> {
  return {
    ...DEFAULT_BRIEF,
    ...((await host.storeFor("assignments").get<BriefSettings>("brief:settings")) ?? {}),
  };
}

export function cleanTopics(topics: string[]): string[] {
  const out: string[] = [];
  for (const topic of topics) {
    const clean = Array.from(topic.trim().replace(/\s+/g, " "))
      .slice(0, RULES.maxTopicChars)
      .join("");
    if (clean && !out.some((item) => item.toLowerCase() === clean.toLowerCase())) out.push(clean);
    if (out.length === RULES.maxTopics) break;
  }
  return out;
}

export async function saveBrief(host: FeatureHost, settings: BriefSettings) {
  const next: BriefSettings = {
    enabled: settings.enabled,
    atMinute: Math.min(24 * 60 - 1, Math.max(0, Math.round(settings.atMinute))),
    topics: cleanTopics(settings.topics),
  };
  await host.storeFor("assignments").put("brief:settings", next);
  return next;
}

export function todaysCard(host: FeatureHost, now = new Date()) {
  return host.storeFor("assignments").get<StoredCard>(`brief:day:${dayOf(now)}`);
}

let writing = false;

/**
 * Writes today's card when it is owed, once: silent when there is nothing to
 * say, announced through the page when it is still close enough to its
 * time, else kept quietly for the panel.
 */
export async function briefTick(
  host: FeatureHost,
  now = new Date(),
  signal?: AbortSignal,
): Promise<StoredCard | null> {
  if (writing) return null;
  const settings = await loadBrief(host);
  const minute = now.getHours() * 60 + now.getMinutes();
  const written = (await todaysCard(host, now)) !== undefined;
  if (!cardDue(settings, minute, written)) return null;
  writing = true;
  try {
    return await writeCard(host, settings, now, mayNotify(settings, minute), signal);
  } finally {
    writing = false;
  }
}

async function writeCard(
  host: FeatureHost,
  settings: BriefSettings,
  now: Date,
  announce: boolean,
  signal?: AbortSignal,
): Promise<StoredCard | null> {
  const store = host.storeFor("assignments");
  const card = await compose(host, settings, now, signal);
  const key = `brief:day:${card.day}`;
  // The first writer wins: a second look that got this far says nothing.
  if ((await store.get(key)) !== undefined) return null;
  const stored: StoredCard = {
    card,
    status: isEmpty(card) ? "silent" : announce ? "delivered" : "quiet",
  };
  await store.put(key, stored);
  if (stored.status !== "silent")
    await fileCard(host, card, stored.status, ASSIGNMENTS.dailyBrief.keepDays, now).catch(
      () => undefined,
    );
  if (stored.status === "delivered")
    host.notify(t(`Your day: ${headline(card)}`, `Votre journée : ${headline(card)}`));
  host.refresh();
  return stored;
}

/** Writes today's card now, before its time, without announcing it: the
 * person is looking at it. */
export async function prepareBrief(host: FeatureHost, now = new Date()) {
  const existing = await todaysCard(host, now);
  if (existing) return existing;
  return writeCard(host, await loadBrief(host), now, false);
}
