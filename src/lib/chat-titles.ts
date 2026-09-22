import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentTaskDto } from "./tauri";

/** A chat in the history list: the task, and the line under its title. */
export type ChatSessionItem = AgentTaskDto & {
  lastMessagePreview?: string;
  lastMessageRole?: string;
};

/** The emit name of `crate::chat_titles::CHAT_TITLE_EVENT`. */
export const CHAT_TITLE_EVENT = "june://chat-title";

export type ChatTitleEvent = { taskId: string; title: string; source: "ai" | "user" };

export async function listChatSessions(): Promise<ChatSessionItem[]> {
  const response = await invoke<{ items: ChatSessionItem[] }>("list_agent_tasks");
  return response.items;
}

/** Renames a chat. The person's name is final: a title still being
 * generated never replaces it. */
export async function renameAgentTask(taskId: string, title: string): Promise<AgentTaskDto> {
  return invoke<AgentTaskDto>("rename_agent_task", { request: { taskId, title } });
}

/** A chat was named, by the model after its first reply or by its owner. */
export function onChatTitle(handler: (event: ChatTitleEvent) => void): () => void {
  const pending = listen<ChatTitleEvent>(CHAT_TITLE_EVENT, (event) => handler(event.payload));
  return () => {
    void pending.then((stop) => stop()).catch(() => undefined);
  };
}

/** Which section of the history a date falls in. */
export type HistorySection = "today" | "yesterday" | "week" | "older";

export function historySection(iso: string, now = new Date()): HistorySection {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "older";
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}
