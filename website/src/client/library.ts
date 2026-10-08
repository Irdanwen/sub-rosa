/**
 * The account's chats, notes and memories, read and written as the app's own
 * rows (`agent_tasks`, `agent_messages`, `notes`, `memories`, `folders`,
 * `account_session_folders`), so what a browser writes is an ordinary chat on
 * every device.
 */
import { type Row, timestamp } from "./codec";
import type { SyncClient, SyncObject } from "./sync";

export interface Chat {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** A custom assistant's conversation: read here, continued in the app. */
  assistant: boolean;
}
export interface Message {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface Memory {
  id: string;
  text: string;
  importance: number;
  createdAt: string;
}

/** The folder the phone and the desktop archive a chat into (ADR-0080). */
export const ARCHIVE_FOLDER_NAME = "Archive";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The app's `title_from_prompt`: the first 64 characters, on one line. */
export function titleFromPrompt(prompt: string): string {
  const title = Array.from(prompt.split(/\s+/).filter(Boolean).join(" ")).slice(0, 64).join("");
  return title.trim() ? title : "New task";
}

function archiveFolderIds(sync: SyncClient): string[] {
  return sync
    .rows("folders")
    .filter(
      (folder) =>
        !folder.row.deleted_at &&
        text(folder.row.name).trim().toLowerCase() === ARCHIVE_FOLDER_NAME.toLowerCase(),
    )
    .map((folder) => folder.id)
    .sort();
}

function archiveMemberships(sync: SyncClient, chatId: string): SyncObject[] {
  const folders = archiveFolderIds(sync);
  return sync
    .rows("account_session_folders")
    .filter((row) => row.row.session_id === chatId && folders.includes(text(row.row.folder_id)));
}

export function listChats(sync: SyncClient): Chat[] {
  const archived = new Set(
    sync
      .rows("account_session_folders")
      .filter(
        (row) =>
          Number(row.row.deleted ?? 0) === 0 &&
          archiveFolderIds(sync).includes(text(row.row.folder_id)),
      )
      .map((row) => text(row.row.session_id)),
  );
  return sync
    .rows("agent_tasks")
    .map((task) => ({
      id: task.id,
      title: text(task.row.title),
      model: text(task.row.model) || null,
      createdAt: text(task.row.created_at),
      updatedAt: text(task.row.updated_at),
      archived: archived.has(task.id),
      assistant: task.bodyTable === "assistant_conversations",
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function messagesOf(sync: SyncClient, taskId: string): Message[] {
  return sync
    .rows("agent_messages")
    .filter(
      (message) =>
        message.row.task_id === taskId &&
        (message.row.role === "user" || message.row.role === "assistant"),
    )
    .map((message) => ({
      id: message.id,
      taskId,
      role: message.row.role as "user" | "assistant",
      content: text(message.row.content),
      createdAt: text(message.row.created_at),
    }))
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
}

/** Chats whose title or messages contain every word of `query`. */
export function searchChats(sync: SyncClient, query: string): Chat[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const chats = listChats(sync);
  if (!words.length) return chats;
  return chats.filter((chat) => {
    const haystack = [chat.title, ...messagesOf(sync, chat.id).map((m) => m.content)]
      .join("\n")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// ── Writing a chat ──────────────────────────────────────────────────────────

export async function createChat(
  sync: SyncClient,
  prompt: string,
  model: string | null,
  title?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = timestamp();
  await sync.write("agent_tasks", {
    id,
    title: title?.trim() || titleFromPrompt(prompt),
    prompt: prompt.trim(),
    // A chat on the service is history: every device reads it as completed.
    status: "completed",
    safety_profile: "autonomous_private",
    progress_summary: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
    model,
  });
  return id;
}

async function touch(sync: SyncClient, taskId: string, model?: string | null) {
  const task = sync.objects.get(taskId);
  if (!task || task.deleted) return;
  const now = timestamp();
  await sync.write("agent_tasks", {
    ...task.row,
    status: "completed",
    updated_at: now,
    completed_at: now,
    ...(model !== undefined ? { model } : {}),
  });
}

export async function addMessage(
  sync: SyncClient,
  taskId: string,
  role: "user" | "assistant",
  content: string,
  model?: string | null,
): Promise<Message> {
  // Strictly after the chat's last message, even when two land in the same
  // millisecond: the app orders by `created_at`, then id.
  const last = messagesOf(sync, taskId).at(-1)?.createdAt ?? "";
  let now = timestamp();
  if (now <= last) now = timestamp(new Date(Date.parse(last) + 1));
  const message: Row = {
    id: crypto.randomUUID(),
    task_id: taskId,
    role,
    content,
    created_at: now,
    external_id: null,
  };
  await sync.write("agent_messages", message);
  await touch(sync, taskId, model);
  return { id: String(message.id), taskId, role, content, createdAt: now };
}

async function removeMessage(sync: SyncClient, id: string) {
  const message = sync.objects.get(id);
  if (message && !message.deleted)
    await sync.write("agent_messages", message.row, { deleted: true });
}

function lastQuestionIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index].role === "user") return index;
  return -1;
}

/** Regenerate: the replies after the last question go, the question stays. */
export async function rewindToLastQuestion(sync: SyncClient, taskId: string): Promise<boolean> {
  const messages = messagesOf(sync, taskId);
  const last = lastQuestionIndex(messages);
  if (last < 0) return false;
  for (const message of messages.slice(last + 1)) await removeMessage(sync, message.id);
  return true;
}

/** Edit the last question in place and drop what answered it. */
export async function rewriteLastQuestion(
  sync: SyncClient,
  taskId: string,
  messageId: string,
  content: string,
): Promise<boolean> {
  const messages = messagesOf(sync, taskId);
  const last = messages[lastQuestionIndex(messages)];
  if (!last || last.id !== messageId) return false;
  const object = sync.objects.get(messageId);
  if (!object) return false;
  await sync.write("agent_messages", { ...object.row, content: content.trim() });
  for (const message of messages.slice(messages.indexOf(last) + 1))
    await removeMessage(sync, message.id);
  await touch(sync, taskId);
  return true;
}

/**
 * A new chat holding the conversation up to a point (ADR-0079): through
 * `throughId` for Branch, or everything before `beforeId` ending on an edited
 * question for an edit of an earlier one. Nothing the person already read
 * disappears from the original.
 */
export async function branchChat(
  sync: SyncClient,
  taskId: string,
  cut: { throughId: string } | { beforeId: string; edited: string },
): Promise<string> {
  const source = sync.objects.get(taskId);
  const messages = messagesOf(sync, taskId);
  const index =
    "throughId" in cut
      ? messages.findIndex((message) => message.id === cut.throughId) + 1
      : messages.findIndex((message) => message.id === cut.beforeId);
  const kept = messages.slice(0, Math.max(0, index));
  const first = kept.find((message) => message.role === "user")?.content ?? "";
  const branch = await createChat(
    sync,
    "edited" in cut && !first ? cut.edited : first || "…",
    text(source?.row.model) || null,
    text(source?.row.title),
  );
  for (const message of kept) await addMessage(sync, branch, message.role, message.content);
  if ("edited" in cut) await addMessage(sync, branch, "user", cut.edited.trim());
  return branch;
}

// ── Archive (shared "Archive" folder) ───────────────────────────────────────

export async function archiveChat(sync: SyncClient, taskId: string): Promise<void> {
  let folderId = archiveFolderIds(sync)[0];
  const now = timestamp();
  if (!folderId) {
    folderId = crypto.randomUUID();
    await sync.write("folders", {
      id: folderId,
      name: ARCHIVE_FOLDER_NAME,
      description: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
  }
  const existing = archiveMemberships(sync, taskId).find((row) => row.row.folder_id === folderId);
  await sync.write("account_session_folders", {
    id: existing?.id ?? crypto.randomUUID(),
    session_id: taskId,
    folder_id: folderId,
    assigned_at: now,
    deleted: 0,
  });
}

/** Out of every archive folder, under every row that filed it there, the way
 * the app's trigger clears them. */
export async function restoreChat(sync: SyncClient, taskId: string): Promise<void> {
  for (const membership of archiveMemberships(sync, taskId))
    if (Number(membership.row.deleted ?? 0) === 0)
      await sync.write("account_session_folders", { ...membership.row, deleted: 1 });
}

// ── Notes ───────────────────────────────────────────────────────────────────

export function listNotes(sync: SyncClient): Note[] {
  return sync
    .rows("notes")
    .map((note) => ({
      id: note.id,
      title: text(note.row.title),
      body: text(note.row.edited_content) || text(note.row.generated_content),
      createdAt: text(note.row.created_at),
      updatedAt: text(note.row.updated_at),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 200_000;

/** `agent_notes::create`: an ordinary note, titled, body in `edited_content`. */
export async function createNote(sync: SyncClient, title: string, content: string): Promise<Note> {
  const body = content.trim().slice(0, MAX_BODY_CHARS);
  if (!body) throw new Error("A note needs some text.");
  const line = title.split("\n")[0]?.trim().slice(0, MAX_TITLE_CHARS) || "Untitled note";
  const now = timestamp();
  const id = crypto.randomUUID();
  await sync.write("notes", {
    id,
    title: line,
    generated_content: null,
    edited_content: body,
    active_tab: "notes",
    processing_status: "draft",
    created_at: now,
    updated_at: now,
    calendar_event_id: null,
    scheduled_start: null,
    attendees_json: null,
  });
  return { id, title: line, body, createdAt: now, updatedAt: now };
}

/** `append_to_note_content`: below what the person sees, a blank line apart. */
export async function appendToNote(sync: SyncClient, noteId: string, content: string) {
  const note = sync.objects.get(noteId);
  if (!note || note.deleted || note.table !== "notes") return null;
  const addition = content.trim().slice(0, MAX_BODY_CHARS);
  if (!addition) throw new Error("There is nothing to add.");
  const current = text(note.row.edited_content) || text(note.row.generated_content);
  const next = current.trim() ? `${current.trimEnd()}\n\n${addition}` : addition;
  await sync.write("notes", { ...note.row, edited_content: next, updated_at: timestamp() });
  return next;
}

// ── Memories ────────────────────────────────────────────────────────────────

/** The person's own memories (no project scope), most important first: lower
 * importance is more important, as in the app. */
export function listMemories(sync: SyncClient): Memory[] {
  return sync
    .rows("memories")
    .filter((memory) => Number(memory.row.disabled ?? 0) === 0 && !memory.row.scope)
    .map((memory) => ({
      id: memory.id,
      text: text(memory.row.text),
      importance: Number(memory.row.importance ?? 5),
      createdAt: text(memory.row.created_at),
    }))
    .sort((a, b) =>
      a.importance === b.importance
        ? b.createdAt.localeCompare(a.createdAt)
        : a.importance - b.importance,
    );
}

/** The `remember` tool: a manual memory of importance 3, once. */
export async function remember(sync: SyncClient, fact: string): Promise<"stored" | "known"> {
  const clean = fact.trim();
  if (listMemories(sync).some((memory) => memory.text.toLowerCase() === clean.toLowerCase()))
    return "known";
  const now = timestamp();
  await sync.write("memories", {
    id: crypto.randomUUID(),
    text: clean,
    source: "manual",
    importance: 3,
    disabled: 0,
    created_at: now,
    updated_at: now,
  });
  return "stored";
}
