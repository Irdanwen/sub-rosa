// The phone chat's turn commands (agent-lite): running a turn, stopping it,
// asking the last question again and editing a question. Kept out of
// `tauri.ts`, which is at its size ratchet; `tauri.ts` re-exports
// `agentLiteRun` so existing imports keep working.

import { invoke } from "@tauri-apps/api/core";
import type { ReasoningEffort } from "./reasoning-effort";
import type { AgentLiteAttachment, AgentTaskDto } from "./tauri";

/** Run one turn of the chat and wait for its answer. `reasoningEffort` is
 * sent only when given, and only for a model that honours it (see
 * reasoning-effort.ts). */
export async function agentLiteRun(
  taskId: string,
  model?: string,
  attachments?: AgentLiteAttachment[],
  reasoningEffort?: ReasoningEffort,
) {
  return invoke<AgentTaskDto>("agent_lite_run", {
    request: { taskId, model, attachments, reasoningEffort },
  });
}

/** Stop the chat's reply. The running turn keeps what it had shown as the
 * reply, marks the chat stopped and announces it on `agent-lite://done`; the
 * pending run then resolves with that chat. */
export async function agentLiteCancel(taskId: string) {
  return invoke<AgentTaskDto>("agent_lite_cancel", { request: { taskId } });
}

export type AgentLiteTurnOptions = {
  model?: string;
  attachments?: AgentLiteAttachment[];
  reasoningEffort?: ReasoningEffort;
};

/** Answer the last question again, dropping the replies it already had.
 * Waits for the new answer, like `agentLiteRun`. */
export async function agentLiteRegenerate(taskId: string, options: AgentLiteTurnOptions = {}) {
  return invoke<AgentTaskDto>("agent_lite_regenerate", { request: { taskId, ...options } });
}

export type AgentLiteEdit = AgentLiteTurnOptions & {
  taskId: string;
  /** The question being edited. */
  messageId: string;
  content: string;
};

/** Rewrite the last question in place, drop what followed and answer it
 * again. Waits for the answer. */
export async function agentLiteEditLast(edit: AgentLiteEdit) {
  return invoke<AgentTaskDto>("agent_lite_edit_last", { request: edit });
}

/** Edit an earlier question: resolves at once with a new chat holding
 * everything before it and ending on the edited question, which is answered
 * in the background. The original chat is left as it was. */
export async function agentLiteEditBranch(edit: AgentLiteEdit) {
  return invoke<AgentTaskDto>("agent_lite_edit_branch", { request: edit });
}
