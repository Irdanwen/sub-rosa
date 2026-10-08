import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

/**
 * The daily brief (ADR-0091, an addendum to the moments): one card a
 * morning, written by Rust at the time the person chose, read here. Off
 * until asked for, and silent on a morning with nothing to say.
 */
export type DailyBriefSettings = { enabled: boolean; atMinute: number };

export type DailyAgenda = { count: number; firstTitle: string; firstAt: string };
export type DailyNote = { id: string; title: string; followUps: string[] };
export type DailyItem = {
  runId: string | null;
  assignmentId: string | null;
  title: string;
  detail: string;
};
export type DailyLink = { title: string; url: string };
export type DailyTopic = { topic: string; links: DailyLink[] };

export type DailyCard = {
  day: string;
  createdAt: string;
  agenda: DailyAgenda | null;
  notes: DailyNote[];
  reviews: DailyItem[];
  failures: DailyItem[];
  topics: DailyTopic[];
};

export type Today = {
  settings: DailyBriefSettings;
  card: DailyCard | null;
  /** `delivered`, `quiet`, or `silent` when there was nothing to say. */
  status: "delivered" | "quiet" | "silent" | null;
};

export type FollowedTopic = { id: string; topic: string; createdAt: string };

export const dailyBriefToday = () => invoke<Today>("daily_brief_today");
export const dailyBriefPrepare = () => invoke<Today>("daily_brief_prepare");
export const dailyBriefSetSettings = (request: DailyBriefSettings) =>
  invoke<DailyBriefSettings>("daily_brief_set_settings", { request });

const asTopics = (value: unknown): FollowedTopic[] =>
  Array.isArray(value) ? (value as FollowedTopic[]) : [];
export const followList = () => invoke<FollowedTopic[]>("follow_list").then(asTopics);
export const followAdd = (topic: string) =>
  invoke<FollowedTopic[]>("follow_add", { topic }).then(asTopics);
export const followRemove = (id: string) =>
  invoke<FollowedTopic[]>("follow_remove", { id }).then(asTopics);

/** The day's agenda as one sentence. The calendar stays context, never a
 * list to open (ADR-0025). */
export function agendaSentence(agenda: DailyAgenda): string {
  const name = agenda.firstTitle.trim() || t("Untitled");
  if (agenda.count === 1) {
    return t("One meeting today, at {time}: {title}", { time: agenda.firstAt, title: name });
  }
  return t("{count} meetings today. Next at {time}: {title}", {
    count: agenda.count,
    time: agenda.firstAt,
    title: name,
  });
}

/** Whether a card has anything in it; the Rust side never writes an empty
 * one as delivered, but an old row may be read. */
export function cardHasContent(card: DailyCard): boolean {
  return Boolean(
    card.agenda ||
      card.notes.length ||
      card.reviews.length ||
      card.failures.length ||
      card.topics.some((topic) => topic.links.length),
  );
}
