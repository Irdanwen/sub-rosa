/**
 * Projects in the browser (ADR-0085): a project is a folder, its settings and
 * files sit beside it (`project_settings`, whose id is the folder's, and
 * `project_files`), and a chat is in the project whose folder it was filed in
 * last. The browser reads and writes those same rows, so a project made here
 * is an ordinary project on every device.
 *
 * What a chat in a project is told comes from Rust (`agent-lite.json`,
 * `project`): the section of `projects::context::agent_lite_section`, the
 * `search_project_files` tool, and the memory mode's two values.
 */
import { AGENT_LITE, timestamp } from "./codec";
import { ARCHIVE_FOLDER_NAME } from "./library";
import type { SyncClient, SyncObject } from "./sync";

export interface ProjectFile {
  id: string;
  folderId: string;
  name: string;
  format: string;
  text: string;
  status: string;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: string;
  files: ProjectFile[];
  updatedAt: string;
}

/** The app caps a project's instructions at this many characters. */
export const MAX_INSTRUCTIONS_CHARS = 8000;
/** A project file's text is searched in chunks of this many characters. */
const CHUNK_CHARS = 1600;
/** Passages one search returns, at most. */
const PASSAGES = 6;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const isArchive = (folder: SyncObject) =>
  text(folder.row.name).trim().toLowerCase() === ARCHIVE_FOLDER_NAME.toLowerCase();

function liveFolders(sync: SyncClient): SyncObject[] {
  return sync.rows("folders").filter((folder) => !folder.row.deleted_at && !isArchive(folder));
}

function normalizedMode(mode: unknown): string {
  return mode === AGENT_LITE.project.memoryProject
    ? AGENT_LITE.project.memoryProject
    : AGENT_LITE.project.memoryDefault;
}

function filesOf(sync: SyncClient, folderId: string): ProjectFile[] {
  return sync
    .rows("project_files")
    .filter((file) => file.row.folder_id === folderId)
    .map((file) => ({
      id: file.id,
      folderId,
      name: text(file.row.name),
      format: text(file.row.format),
      text: text(file.row.text),
      status: text(file.row.status),
      createdAt: text(file.row.created_at),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function projectOf(sync: SyncClient, folder: SyncObject): Project {
  // The settings share their folder's object id (ADR-0085): one object, two
  // rows, each kept apart in the client (`SyncClient.object`).
  const settings = sync.object("project_settings", folder.id);
  const own = settings && !settings.deleted;
  return {
    id: folder.id,
    name: text(folder.row.name),
    description: text(folder.row.description),
    instructions: own ? text(settings.row.instructions) : "",
    memoryMode: normalizedMode(own ? settings.row.memory_mode : null),
    files: filesOf(sync, folder.id),
    updatedAt: text(folder.row.updated_at),
  };
}

/** Every project of the account, by name. */
export function listProjects(sync: SyncClient): Project[] {
  return liveFolders(sync)
    .map((folder) => projectOf(sync, folder))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(sync: SyncClient, id: string): Project | null {
  const folder = liveFolders(sync).find((item) => item.id === id);
  return folder ? projectOf(sync, folder) : null;
}

/** `folder_of_session`: the live, non-archive folder the chat was filed in
 * last (ties by folder id). */
export function projectIdOfChat(sync: SyncClient, chatId: string): string | null {
  const live = new Set(liveFolders(sync).map((folder) => folder.id));
  const filed = sync
    .rows("account_session_folders")
    .filter(
      (row) =>
        row.row.session_id === chatId &&
        Number(row.row.deleted ?? 0) === 0 &&
        live.has(text(row.row.folder_id)),
    )
    .sort(
      (a, b) =>
        text(b.row.assigned_at).localeCompare(text(a.row.assigned_at)) ||
        text(a.row.folder_id).localeCompare(text(b.row.folder_id)),
    );
  return filed.length ? text(filed[0].row.folder_id) : null;
}

/** The memory scope of a chat: its project's folder in "Project only", the
 * person's own (null) otherwise. */
export function memoryScopeOf(project: Project | null): string | null {
  return project && project.memoryMode === AGENT_LITE.project.memoryProject ? project.id : null;
}

/**
 * Which chats a chat in `scope` may quote as past chats (ADR-0081 with
 * ADR-0085): a "Project only" project reads its own chats only, and every
 * other chat reads none of a "Project only" project's.
 */
export function chatsInScope(sync: SyncClient, scope: string | null): (chatId: string) => boolean {
  const closed = new Set(
    listProjects(sync)
      .filter((project) => project.memoryMode === AGENT_LITE.project.memoryProject)
      .map((project) => project.id),
  );
  return (chatId) => {
    const folder = projectIdOfChat(sync, chatId);
    return scope ? folder === scope : !folder || !closed.has(folder);
  };
}

const fill = (template: string, name: string, value: string) =>
  template.split(`{${name}}`).join(value);

/** `agent_lite_section`, from the exported pieces. */
export function projectSection(project: Project): string {
  const words = AGENT_LITE.project;
  let section = fill(words.opening, "name", project.name.trim());
  if (project.instructions.trim())
    section += fill(words.instructions, "instructions", project.instructions.trim());
  if (project.files.length)
    section += fill(words.files, "files", project.files.map((file) => file.name).join(", "));
  if (project.memoryMode === words.memoryProject) section += words.ownMemory;
  return section;
}

/** `search_project_files` without the app's relevance screen: chunks scored
 * by the query words they contain, best first, as `select_reference_context`
 * picks them when no screen answers. */
export function searchProjectFiles(project: Project, query: string): string {
  const ready = project.files.filter((file) => file.status === "ready" && file.text);
  if (!ready.length) return "This project has no readable files yet.";
  const words = query
    .split(/\s+/)
    .filter((word) => new TextEncoder().encode(word).length > 2)
    .map((word) => word.toLowerCase());
  const scored: { score: number; passage: string }[] = [];
  for (const file of ready) {
    const chars = Array.from(file.text);
    for (let at = 0, index = 0; at < chars.length; at += CHUNK_CHARS, index++) {
      const chunk = chars.slice(at, at + CHUNK_CHARS).join("");
      const lower = chunk.toLowerCase();
      const score = words.filter((word) => lower.includes(word)).length;
      if (words.length && score === 0) continue;
      scored.push({
        score,
        passage: `[Reference: ${file.name}; passage ${index + 1}; id: ${file.id}]\n${chunk}`,
      });
    }
  }
  const kept = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PASSAGES)
    .map((entry) => entry.passage);
  return kept.length ? kept.join("\n\n") : "No passage of the project's files matches that.";
}

// ── Writing ────────────────────────────────────────────────────────────────

export async function createProject(
  sync: SyncClient,
  name: string,
  description = "",
): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error("A project needs a name.");
  const now = timestamp();
  const id = crypto.randomUUID();
  await sync.write("folders", {
    id,
    name: clean.slice(0, 200),
    description: description.trim() || null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  });
  return id;
}

export async function renameProject(
  sync: SyncClient,
  id: string,
  change: { name?: string; description?: string },
) {
  const folder = sync.objects.get(id);
  if (!folder || folder.deleted || folder.table !== "folders") return;
  const name = change.name?.trim();
  await sync.write("folders", {
    ...folder.row,
    ...(name ? { name: name.slice(0, 200) } : {}),
    ...(change.description !== undefined ? { description: change.description.trim() || null } : {}),
    updated_at: timestamp(),
  });
}

/** Deleting a project keeps its chats and its scoped memories (ADR-0085):
 * only the folder is marked deleted, as the app does. */
export async function deleteProject(sync: SyncClient, id: string) {
  const folder = sync.objects.get(id);
  if (!folder || folder.deleted || folder.table !== "folders") return;
  const now = timestamp();
  await sync.write("folders", { ...folder.row, deleted_at: now, updated_at: now });
}

export async function saveProjectSettings(
  sync: SyncClient,
  folderId: string,
  settings: { instructions: string; memoryMode: string },
) {
  await sync.write("project_settings", {
    id: folderId,
    folder_id: folderId,
    instructions: Array.from(settings.instructions.trim())
      .slice(0, MAX_INSTRUCTIONS_CHARS)
      .join(""),
    memory_mode: normalizedMode(settings.memoryMode),
    updated_at: timestamp(),
  });
}

/** A file read in this browser (`documents.ts`): its text travels, ready to
 * search on every device, as the app's extracted files do. The bytes stay
 * here, as they stay on the device that added a file in the app. */
export async function addProjectFile(
  sync: SyncClient,
  folderId: string,
  file: { name: string; format: string; text: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = timestamp();
  await sync.write("project_files", {
    id,
    folder_id: folderId,
    name: file.name.slice(0, 200),
    format: file.format,
    text: file.text,
    status: "ready",
    error: null,
    file_name: `${id}.${file.format}`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function removeProjectFile(sync: SyncClient, id: string) {
  const file = sync.objects.get(id);
  if (file && !file.deleted && file.table === "project_files")
    await sync.write("project_files", file.row, { deleted: true });
}

/** Files a chat into a project, or out of every project (null). The Archive
 * is not a project and is left alone. */
export async function moveChatToProject(sync: SyncClient, chatId: string, folderId: string | null) {
  const live = new Set(liveFolders(sync).map((folder) => folder.id));
  for (const row of sync.rows("account_session_folders"))
    if (
      row.row.session_id === chatId &&
      Number(row.row.deleted ?? 0) === 0 &&
      live.has(text(row.row.folder_id)) &&
      row.row.folder_id !== folderId
    )
      await sync.write("account_session_folders", { ...row.row, deleted: 1 });
  if (!folderId) return;
  const existing = sync
    .rows("account_session_folders")
    .find((row) => row.row.session_id === chatId && row.row.folder_id === folderId);
  await sync.write("account_session_folders", {
    id: existing?.id ?? crypto.randomUUID(),
    session_id: chatId,
    folder_id: folderId,
    assigned_at: timestamp(),
    deleted: 0,
  });
}
