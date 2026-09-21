import { parseChatBlock } from "./chat-blocks";
import { invoke } from "@tauri-apps/api/core";
import type { AgentTaskDto } from "./tauri";

export type AssistantTool = "web" | "image" | "video" | "music" | "speech";
export type AssistantDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  opening_message: string;
  tools: AssistantTool[];
  allow_notes: boolean;
  allow_memory: boolean;
  avatar_ref: string | null;
  cover_ref: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type AssistantReference = {
  id: string;
  assistant_id: string;
  name: string;
  format: string;
  text: string;
  status: "queued" | "ready" | "failed";
  error: string | null;
  note_id: string | null;
  file_name: string | null;
  created_at: string;
  updated_at: string;
};
export type AssistantAnswer = { question: string; answer: string };
export type AssistantDraft = {
  name: string;
  description: string;
  instructions: string;
  openingMessage: string;
  tools: AssistantTool[];
};

export const emptyAssistant = (): AssistantDefinition => ({
  id: "",
  name: "",
  description: "",
  instructions: "",
  model: "",
  opening_message: "",
  tools: [],
  allow_notes: false,
  allow_memory: false,
  avatar_ref: null,
  cover_ref: null,
  revision: 0,
  created_at: "",
  updated_at: "",
});
export const listAssistants = () => invoke<AssistantDefinition[]>("assistant_list");
export const saveAssistant = (definition: AssistantDefinition) =>
  invoke<AssistantDefinition>("assistant_save", { definition });
export const deleteAssistant = (definition: AssistantDefinition) =>
  invoke<void>("assistant_delete", { id: definition.id, revision: definition.revision });
export const duplicateAssistant = (id: string) =>
  invoke<AssistantDefinition>("assistant_duplicate", { id });
export const listAssistantReferences = (assistantId: string) =>
  invoke<AssistantReference[]>("assistant_reference_list", { assistantId });
export const importAssistantReference = (assistantId: string) =>
  invoke<AssistantReference | null>("assistant_reference_import", { assistantId });
export const addAssistantNote = (assistantId: string, noteId: string) =>
  invoke<AssistantReference>("assistant_reference_add_note", { assistantId, noteId });
export const deleteAssistantReference = (id: string) =>
  invoke<void>("assistant_reference_delete", { id });
export const readAssistantReference = (id: string) =>
  invoke<string>("assistant_reference_read", { id });
export const refreshAssistantNote = (id: string) =>
  invoke<AssistantReference>("assistant_reference_refresh_note", { id });
export const prepareAssistantDraft = (description: string, answers: AssistantAnswer[]) =>
  invoke<AssistantDraft>("assistant_draft", { request: { description, answers } });
export const startAssistantChat = (assistantId: string, content: string) =>
  invoke<AgentTaskDto>("assistant_chat_start", { request: { assistantId, content } });
export const sendAssistantChat = (taskId: string, content: string) =>
  invoke<AgentTaskDto>("assistant_chat_send", { request: { taskId, content } });
export const getAssistantChat = (taskId: string) =>
  invoke<AgentTaskDto>("assistant_chat_history", { request: { taskId } });
export const listAssistantChats = (assistantId: string) =>
  invoke<AgentTaskDto[]>("assistant_chat_list", { request: { assistantId } });

export const retryAssistantChat = (taskId: string) =>
  invoke<AgentTaskDto>("assistant_chat_retry", { request: { taskId } });
export const applyAssistantRevision = (taskId: string) =>
  invoke<AgentTaskDto>("assistant_chat_apply_revision", { request: { taskId } });

export const addAssistantArtifact = (assistantId: string, fileName: string) =>
  invoke<AssistantReference>("assistant_reference_from_artifact", { assistantId, fileName });

export type AssistantConversation = { task: AgentTaskDto; definition: AssistantDefinition };
export const listAssistantArchive = () =>
  invoke<AssistantConversation[]>("assistant_chat_archive_list");

/** Match the markdown renderer's completed fences so fallback proposals appear once. */
export function assistantMediaIds(messages: string[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const lines = message.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim().startsWith("```")) continue;
      const info = lines[index].trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) continue;
      const block = parseChatBlock(info, body.join("\n"));
      if (block?.kind === "media") ids.add(block.proposalId);
    }
  }
  return [...ids];
}
