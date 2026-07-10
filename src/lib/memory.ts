/**
 * Desktop trigger for automatic memory extraction.
 *
 * Desktop chat transcripts live inside Hermes (not in the app's SQLite), so
 * the Rust side has no post-turn hook of its own: this module watches
 * completed assistant turns from the workspace, and every 3rd assistant
 * reply per session sends the recent message window to the `memory_extract`
 * command (which prompts the extraction model and stores survivors). The
 * mobile agent-lite pipeline has the equivalent hook in Rust
 * (`memory::extract::maybe_extract_after_agent_lite_turn`).
 *
 * Everything here is best-effort: extraction failures are swallowed, never
 * surfaced into the chat UI.
 */

import { textFromHermesContent } from "./agent-chat-runtime";
import {
  type HermesSessionMessage,
  hermesBridgeSessionMessages,
  type MemoryConversationMessage,
  memoryExtract,
  memoryGetSettings,
} from "./tauri";

/** Keep in sync with EXTRACTION_CADENCE in src-tauri/src/memory/extract.rs. */
const EXTRACTION_CADENCE = 3;
/** Keep in sync with CONTEXT_MESSAGES_PER_ROLE in memory/extract.rs. */
const CONTEXT_MESSAGES_PER_ROLE = 5;

/** Assistant-turn count at the last extraction, per session: terminal gateway
 * events can replay across reconnects, and one turn must extract at most once. */
const extractedAtTurn = new Map<string, number>();

/** Called by the workspace when a session's turn completes. Fire-and-forget. */
export function noteAssistantTurnCompleted(sessionId: string): void {
  void extractIfDue(sessionId).catch(() => {
    // Memory is an enrichment; a failed extraction must never break chat.
  });
}

async function extractIfDue(sessionId: string): Promise<void> {
  const settings = await memoryGetSettings();
  if (!settings.enabled || !settings.autoExtract) return;

  const response = await hermesBridgeSessionMessages(sessionId);
  const raw = response.messages ?? response.items ?? response.data ?? [];
  const conversation = conversationFromHermesMessages(raw);
  const assistantTurns = conversation.filter((message) => message.role === "assistant").length;
  if (assistantTurns === 0 || assistantTurns % EXTRACTION_CADENCE !== 0) return;
  if (extractedAtTurn.get(sessionId) === assistantTurns) return;
  extractedAtTurn.set(sessionId, assistantTurns);

  await memoryExtract(windowedConversation(conversation));
}

/** Normalizes Hermes session messages to plain (role, content) pairs; tool
 * and system entries never reach the extractor. */
export function conversationFromHermesMessages(
  messages: HermesSessionMessage[],
): MemoryConversationMessage[] {
  const conversation: MemoryConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text =
      textFromHermesContent(message.content) ?? textFromHermesContent(message.text) ?? "";
    const content = stripAttachedContext(text);
    if (!content) continue;
    conversation.push({ role: message.role, content });
  }
  return conversation;
}

/** The last N user + N assistant messages in order — the Rust side windows
 * again, but trimming here keeps the IPC payload small for long sessions. */
export function windowedConversation(
  conversation: MemoryConversationMessage[],
): MemoryConversationMessage[] {
  const keep = new Set<MemoryConversationMessage>();
  for (const role of ["user", "assistant"] as const) {
    const recent = conversation
      .filter((message) => message.role === role)
      .slice(-CONTEXT_MESSAGES_PER_ROLE);
    for (const message of recent) {
      keep.add(message);
    }
  }
  return conversation.filter((message) => keep.has(message));
}

/** Same marker strip as agent-chat-runtime's private stripHermesContextMarkers:
 * attached-context dumps (files, warnings) are scaffolding, not user facts. */
function stripAttachedContext(value: string): string {
  const withoutWarnings = value.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  return (marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings).trim();
}
