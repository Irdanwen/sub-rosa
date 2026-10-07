/**
 * Personalization and memory sources (ADR-0081), the Tauri side.
 *
 * Kept out of `tauri.ts` (at its size ceiling): the commands live in
 * `src-tauri/src/personalization/` and `src-tauri/src/memory/sources.rs`, and
 * both shells call them through here.
 */

import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import type { MemoryDto, MemorySettings } from "./tauri";

/** Mirrors `MAX_FIELD_CHARS` in personalization/mod.rs. */
export const PERSONALIZATION_MAX_CHARS = 1500;

export type Personality =
  | "default"
  | "professional"
  | "friendly"
  | "candid"
  | "efficient"
  | "nerdy";

export type PersonalizationSettings = {
  enabled: boolean;
  aboutYou: string;
  responseStyle: string;
  personality: Personality;
};

export const PERSONALITIES: { id: Personality; label: string; detail: string }[] = [
  { id: "default", label: t("Default"), detail: t("Balanced and clear") },
  { id: "professional", label: t("Professional"), detail: t("Polished and precise") },
  { id: "friendly", label: t("Friendly"), detail: t("Warm and conversational") },
  { id: "candid", label: t("Candid"), detail: t("Direct, says what it thinks") },
  { id: "efficient", label: t("Efficient"), detail: t("Brief and to the point") },
  { id: "nerdy", label: t("Nerdy"), detail: t("Curious, explains the why") },
];

export function personalityLabel(id: Personality): string {
  return PERSONALITIES.find((item) => item.id === id)?.label ?? t("Default");
}

export function personalizationGetSettings() {
  return invoke<PersonalizationSettings>("personalization_get_settings");
}

export function personalizationSetSettings(request: PersonalizationSettings) {
  return invoke<PersonalizationSettings>("personalization_set_settings", { request });
}

/** Memory settings with the past-chats switch. Absent from a save, the stored
 * value is kept, so screens that do not show the switch leave it alone. */
export type MemorySettingsWithHistory = MemorySettings & { referenceChatHistory?: boolean };

/** The memories one phone reply was given, keyed by the user message that
 * opened its turn. */
export type TurnMemorySources = { turnId: string; memories: MemoryDto[] };

export function memorySourcesForTask(taskId: string) {
  return invoke<TurnMemorySources[]>("memory_sources_for_task", { request: { taskId } });
}

export type SessionMemorySources = { recorded: boolean; memories: MemoryDto[] };

export function memorySourcesForSession(sessionId: string, startedAtMs?: number) {
  return invoke<SessionMemorySources>("memory_sources_for_session", {
    request: { sessionId, startedAtMs },
  });
}

/** A Hermes session's start as epoch milliseconds: the runtime reports a
 * float of seconds, sometimes as a string, sometimes an ISO date. */
export function sessionStartMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return sessionStartMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** The reply's turn: the user message right before it. */
export function turnIdForReply(
  messages: { id: string; role: string }[],
  replyId: string,
): string | undefined {
  const index = messages.findIndex((message) => message.id === replyId);
  for (let at = index - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "user") return message.id;
    if (message?.role === "assistant") return undefined;
  }
  return undefined;
}
