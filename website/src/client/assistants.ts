/**
 * Custom assistants in the browser (ADR-0058): the synchronised definitions
 * (`assistants`, `assistant_references`), created and edited here with the
 * app's rules, and their conversations, which carry an immutable snapshot of
 * the definition and its references (`assistant_conversations`), so a later
 * edit never changes what an existing conversation was told.
 *
 * A turn with an assistant is agent-lite's loop with the assistant's own
 * prompt (Rust's words, `agent-lite.json` `assistant`), never the person's
 * personalization or past chats, and only the tools its permissions allow
 * that a browser can run: its references always, reading notes when allowed,
 * memory when allowed and switched on, the web when allowed.
 */
import { AGENT_LITE, ASSISTANT_CONVERSATIONS, timestamp, type ToolDefinition } from "./codec";
import { addMessage } from "./library";
import type { SyncClient, SyncObject } from "./sync";

export interface AssistantDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  opening_message: string;
  tools: string[];
  allow_notes: boolean;
  allow_memory: boolean;
  avatar_ref: string | null;
  cover_ref: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface AssistantReference {
  id: string;
  assistant_id: string;
  name: string;
  format: string;
  text: string;
  status: string;
  error: string | null;
  note_id: string | null;
  file_name: string | null;
  created_at: string;
  updated_at: string;
}
export interface AssistantSnapshot {
  definition: AssistantDefinition;
  references: AssistantReference[];
}

/** The permission keys an assistant may hold (`is_permission_key`). */
export const PERMISSIONS = ["web", "image", "video", "music", "speech", "documents"] as const;
const LIMITS = { name: 200, description: 4000, instructions: 64_000, opening: 8000, model: 200 };
const MAX_SNAPSHOT_BYTES = 500_000;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (value: string, max: number) => Array.from(value).slice(0, max).join("");

function parseTools(value: unknown): string[] {
  try {
    const parsed = JSON.parse(text(value) || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tool): tool is string => typeof tool === "string")
      : [];
  } catch {
    return [];
  }
}

function definitionOf(row: SyncObject): AssistantDefinition {
  return {
    id: row.id,
    name: text(row.row.name),
    description: text(row.row.description),
    instructions: text(row.row.instructions),
    model: text(row.row.model),
    opening_message: text(row.row.opening_message),
    tools: parseTools(row.row.tools_json),
    allow_notes: Number(row.row.allow_notes ?? 0) !== 0,
    allow_memory: Number(row.row.allow_memory ?? 0) !== 0,
    avatar_ref: text(row.row.avatar_ref) || null,
    cover_ref: text(row.row.cover_ref) || null,
    revision: Number(row.row.revision ?? 1),
    created_at: text(row.row.created_at),
    updated_at: text(row.row.updated_at),
  };
}

export function listAssistants(sync: SyncClient): AssistantDefinition[] {
  return sync
    .rows("assistants")
    .map(definitionOf)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAssistant(sync: SyncClient, id: string): AssistantDefinition | null {
  const row = sync.objects.get(id);
  return row && !row.deleted && row.table === "assistants" ? definitionOf(row) : null;
}

export function referencesOf(sync: SyncClient, assistantId: string): AssistantReference[] {
  return sync
    .rows("assistant_references")
    .filter((row) => row.row.assistant_id === assistantId)
    .map((row) => ({
      id: row.id,
      assistant_id: assistantId,
      name: text(row.row.name),
      format: text(row.row.format),
      text: text(row.row.text),
      status: text(row.row.status),
      error: text(row.row.error) || null,
      note_id: text(row.row.note_id) || null,
      file_name: text(row.row.file_name) || null,
      created_at: text(row.row.created_at),
      updated_at: text(row.row.updated_at),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface AssistantDraft {
  name: string;
  description: string;
  instructions: string;
  model: string;
  openingMessage: string;
  tools: string[];
  allowNotes: boolean;
  allowMemory: boolean;
}

/** `assistant_save`: a new assistant at revision 1, an edit one revision on.
 * Two devices editing at once become siblings the app reviews. */
export async function saveAssistant(
  sync: SyncClient,
  draft: AssistantDraft,
  id?: string,
): Promise<string> {
  const name = draft.name.trim();
  if (!name || new TextEncoder().encode(name).length > LIMITS.name)
    throw new Error("An assistant needs a name of at most 200 characters.");
  const existing = id ? getAssistant(sync, id) : null;
  const tools = [
    ...new Set(draft.tools.filter((tool) => (PERMISSIONS as readonly string[]).includes(tool))),
  ].sort();
  const now = timestamp();
  const assistantId = existing?.id ?? crypto.randomUUID();
  await sync.write("assistants", {
    id: assistantId,
    name,
    description: clip(draft.description.trim(), LIMITS.description),
    instructions: clip(draft.instructions.trim(), LIMITS.instructions),
    model: clip(draft.model.trim(), LIMITS.model),
    opening_message: clip(draft.openingMessage.trim(), LIMITS.opening),
    tools_json: JSON.stringify(tools),
    allow_notes: draft.allowNotes ? 1 : 0,
    allow_memory: draft.allowMemory ? 1 : 0,
    avatar_ref: existing?.avatar_ref ?? null,
    cover_ref: existing?.cover_ref ?? null,
    revision: (existing?.revision ?? 0) + 1,
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  return assistantId;
}

export async function deleteAssistant(sync: SyncClient, id: string) {
  for (const reference of referencesOf(sync, id)) {
    const row = sync.objects.get(reference.id);
    if (row) await sync.write("assistant_references", row.row, { deleted: true });
  }
  const row = sync.objects.get(id);
  if (row && !row.deleted && row.table === "assistants")
    await sync.write("assistants", row.row, { deleted: true });
}

/** A reference read in this browser (or pasted as text): ready at once. */
export async function addReference(
  sync: SyncClient,
  assistantId: string,
  reference: { name: string; format: string; text: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = timestamp();
  await sync.write("assistant_references", {
    id,
    assistant_id: assistantId,
    name: clip(reference.name.trim() || "Reference", 200),
    format: reference.format,
    text: reference.text,
    status: "ready",
    error: null,
    note_id: null,
    file_name: `${id}.${reference.format}`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function removeReference(sync: SyncClient, id: string) {
  const row = sync.objects.get(id);
  if (row && !row.deleted && row.table === "assistant_references")
    await sync.write("assistant_references", row.row, { deleted: true });
}

/** The snapshot a new conversation keeps: the definition and its ready
 * references, under the app's size ceiling. */
export function snapshotOf(sync: SyncClient, assistantId: string): AssistantSnapshot {
  const definition = getAssistant(sync, assistantId);
  if (!definition) throw new Error("This assistant is no longer available.");
  const snapshot = {
    definition,
    references: referencesOf(sync, assistantId).filter((reference) => reference.status === "ready"),
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_SNAPSHOT_BYTES)
    throw new Error("These references are too large for one assistant conversation.");
  return snapshot;
}

/** `assistant_chat_start`: the conversation, its snapshot and the first
 * question, as the app writes them. */
export async function startAssistantChat(
  sync: SyncClient,
  assistantId: string,
  question: string,
): Promise<string> {
  const snapshot = snapshotOf(sync, assistantId);
  const id = crypto.randomUUID();
  const now = timestamp();
  await sync.write(
    "agent_tasks",
    {
      id,
      title: snapshot.definition.name,
      prompt: question.trim(),
      status: "completed",
      safety_profile: "custom_assistant",
      progress_summary: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
      model: snapshot.definition.model || null,
    },
    { bodyTable: ASSISTANT_CONVERSATIONS, extra: { assistant_snapshot: snapshot } },
  );
  await addMessage(sync, id, "user", question.trim(), snapshot.definition.model || null);
  return id;
}

/** The snapshot a conversation carries, or null: a custom conversation
 * without one fails closed (it is read, never continued). */
export function conversationSnapshot(sync: SyncClient, chatId: string): AssistantSnapshot | null {
  const task = sync.objects.get(chatId);
  if (!task || task.bodyTable !== ASSISTANT_CONVERSATIONS) return null;
  const snapshot = task.extra.assistant_snapshot as AssistantSnapshot | undefined;
  if (!snapshot?.definition || !Array.isArray(snapshot.references)) return null;
  return snapshot;
}

/** `runtime::system_prompt`, from Rust's words. */
export function assistantPrompt(snapshot: AssistantSnapshot, memory: string | null): string {
  const fill = (template: string) =>
    template
      .split("{name}")
      .join(snapshot.definition.name)
      .split("{instructions}")
      .join(snapshot.definition.instructions);
  let prompt = fill(AGENT_LITE.assistant.systemPrompt);
  if (snapshot.definition.allow_memory && memory) prompt += `\n\n${memory}`;
  return prompt;
}

/** `runtime::allows_tool`, for the tools a browser has. */
export function assistantAllows(definition: AssistantDefinition, name: string, memoryOn: boolean) {
  switch (name) {
    case "search_references":
      return true;
    case "search_notes":
    case "read_note":
    case "list_recent_notes":
      return definition.allow_notes;
    case "remember":
    case "search_memories":
      return definition.allow_memory && memoryOn;
    case "web_search":
    case "fetch_page":
      return definition.tools.includes("web");
    default:
      return false;
  }
}

export function assistantTools(
  snapshot: AssistantSnapshot,
  offered: ToolDefinition[],
  memoryOn: boolean,
): ToolDefinition[] {
  return [
    ...offered.filter((tool) => assistantAllows(snapshot.definition, tool.function.name, memoryOn)),
    AGENT_LITE.assistant.searchReferences,
  ];
}

/** `reference_passages`: each reference cut into 1800-character passages,
 * each labelled with the page, slide or sheet it falls in. */
function referencePassages(name: string, body: string): string[] {
  const sections: [string, string][] = [];
  let location = "Document";
  let current = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (["[Page ", "[Slide ", "[Sheet "].some((prefix) => trimmed.startsWith(prefix))) {
      const end = trimmed.indexOf("]");
      if (end >= 0) {
        if (current) sections.push([location, current]);
        current = "";
        location = trimmed.slice(0, end + 1);
      }
    }
    current += `${line}\n`;
  }
  if (current) sections.push([location, current]);
  const passages: string[] = [];
  for (const [where, content] of sections) {
    const chars = Array.from(content);
    for (let at = 0; at < chars.length; at += 1800)
      passages.push(
        `[Reference: ${name}; ${where}; passage ${passages.length + 1}]\n${chars.slice(at, at + 1800).join("")}`,
      );
  }
  return passages;
}

/** `reference_context`: the five passages sharing most words with the query. */
export function searchReferences(snapshot: AssistantSnapshot, query: string): string {
  const words = query
    .split(/\s+/)
    .filter((word) => new TextEncoder().encode(word).length > 2)
    .slice(0, 12)
    .map((word) => word.toLowerCase());
  const hits: { score: number; passage: string }[] = [];
  for (const reference of snapshot.references) {
    if (!reference.text) continue;
    for (const passage of referencePassages(reference.name, reference.text)) {
      const lower = passage.toLowerCase();
      const score = words.filter((word) => lower.includes(word)).length;
      if (score > 0 || !words.length) hits.push({ score, passage });
    }
  }
  const passages = hits
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((hit) => hit.passage)
    .join("\n\n");
  const images = snapshot.references
    .filter((reference) => ["png", "jpg", "jpeg", "webp", "gif"].includes(reference.format))
    .map((reference) => ({ id: reference.id, name: reference.name, format: reference.format }));
  // Image references are read in the app, whose vision tool a browser does
  // not offer; naming them would invite a call that cannot run.
  return images.length
    ? `${passages}\nImage references (read them in the Sub Rosa app): ${JSON.stringify(images)}`
    : passages || "No passage of the references matches that.";
}
