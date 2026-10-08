/**
 * Projects (ADR-0085), the Tauri side: a folder's instructions, files and
 * memory mode, the desktop's project context, and reading a document a person
 * attaches to a chat.
 *
 * Kept out of `tauri.ts` (at its size ceiling). The commands live in
 * `src-tauri/src/projects/` and `src-tauri/src/documents.rs`, and both shells
 * call them through here.
 */

import { invoke } from "@tauri-apps/api/core";
import { attachmentPromptPath } from "./agent-chat-transcript";
import { t } from "./i18n";
import { assignSessionToFolder } from "./tauri";

export type ProjectMemoryMode = "default" | "project";

export type ProjectSettings = {
  folderId: string;
  instructions: string;
  memoryMode: ProjectMemoryMode;
  updatedAt?: string;
};

export type ProjectFile = {
  id: string;
  folderId: string;
  name: string;
  format: string;
  /** `queued` until read, then `ready` or `failed`. */
  status: "queued" | "ready" | "failed";
  error?: string;
  chars: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDto = {
  settings: ProjectSettings;
  files: ProjectFile[];
};

/** Mirrors `MAX_INSTRUCTIONS_CHARS` in projects/mod.rs. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 8000;

/** What a project's files may be, for a file input's `accept`. */
export const PROJECT_FILE_ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.md,.txt,.csv,.png,.jpg,.jpeg,.webp,.gif,image/*";

export const PROJECT_MEMORY_MODES: { id: ProjectMemoryMode; label: string; detail: string }[] = [
  {
    id: "default",
    label: t("Default"),
    detail: t("Chats in this project use your memory and add to it."),
  },
  {
    id: "project",
    label: t("Project only"),
    detail: t(
      "Chats in this project remember only what was said in this project, and what they learn stays here.",
    ),
  },
];

export function projectGet(folderId: string) {
  return invoke<ProjectDto>("project_get", { folderId });
}

export function projectSave(input: {
  folderId: string;
  instructions: string;
  memoryMode: ProjectMemoryMode;
}) {
  return invoke<ProjectSettings>("project_save", { request: input });
}

export async function projectFileAdd(folderId: string, file: File) {
  const data = await fileToBase64(file);
  return invoke<ProjectFile>("project_file_add", {
    request: { folderId, name: file.name, data },
  });
}

export function projectFileDelete(id: string) {
  return invoke<void>("project_file_delete", { id });
}

/** A file's bytes as base64, without the `data:` prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(t("This file could not be read. Choose it again.")));
    reader.readAsDataURL(file);
  });
}

/** How far along a file is, in a few words. */
export function projectFileStatus(file: ProjectFile): string {
  if (file.status === "queued") return t("Reading…");
  // The stored reason is the backend's English sentence; the catalog has it.
  if (file.status === "failed") return file.error ? t(file.error) : t("Could not be read");
  if (file.chars === 0) return t("Image");
  return t("{count} characters read", { count: file.chars.toLocaleString() });
}

// --- Documents attached to a chat ------------------------------------------

export type DocumentText = {
  name: string;
  format: string;
  text: string;
  pages: number;
  sheets: number;
  slides: number;
  truncated: boolean;
};

const DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx"];

/** Whether a picked file is a document the device extracts natively. */
export function isExtractableDocument(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_EXTENSIONS.includes(extension);
}

export async function documentExtract(file: File) {
  const data = await fileToBase64(file);
  return invoke<DocumentText>("document_extract", { request: { name: file.name, data } });
}

/** The note an attached document gets in the desktop's attachment block: the
 * runtime reads bytes, so it is pointed at the text written beside the file. */
export function attachmentTextNote(attachment: { textPath?: string | null }): string {
  return attachment.textPath
    ? ` (its text, extracted: ${attachmentPromptPath(attachment.textPath)})`
    : "";
}

// --- The desktop's project context -----------------------------------------

export type DesktopProjectContext = {
  folderId: string;
  name: string;
  block: string;
  fingerprint: string;
};

const SENT_STORAGE_KEY = "subrosa:project-context-sent";
/** The marker Hermes itself puts before context it attaches to a message;
 * the transcript and memory extraction strip everything after it. */
const CONTEXT_MARKER = "--- Attached Context ---";

function sentContexts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SENT_STORAGE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The project context a desktop send should carry: the project of the chat,
 * or of the project a new chat is started from, unless this chat already
 * received this exact context. Hermes' SOUL is shared by every chat, so the
 * project rides with the chat's first message instead, and again when it
 * changes. Never throws: a chat must not fail for its project.
 */
export async function projectContextForSend(
  sessionId: string | undefined,
  originFolderId: string | undefined,
): Promise<DesktopProjectContext | null> {
  if (!sessionId && !originFolderId) return null;
  try {
    const context = await invoke<DesktopProjectContext | null>("project_context", {
      request: sessionId ? { sessionId } : { folderId: originFolderId },
    });
    if (!context) return null;
    if (sessionId && sentContexts()[sessionId] === context.fingerprint) return null;
    return context;
  } catch {
    return null;
  }
}

/** The message text with the project context after Hermes' context marker. */
export function withProjectContext(text: string, context: DesktopProjectContext | null): string {
  if (!context) return text;
  return `${text}\n\n${CONTEXT_MARKER}\n\n${context.block}`;
}

/** Records that a chat received a context, and files a new chat in the
 * project it was started from. Best effort. */
export function projectContextSent(
  sessionId: string,
  context: DesktopProjectContext | null,
  created: boolean,
): void {
  if (!context) return;
  try {
    const sent = sentContexts();
    sent[sessionId] = context.fingerprint;
    localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(sent));
  } catch {
    // A lost record only means the context is sent once more.
  }
  if (created) void fileChatInProject(sessionId, context.folderId);
}

const PENDING_FILINGS_KEY = "subrosa:pending-project-filings";

function pendingFilings(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_FILINGS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writePendingFilings(filings: Record<string, string>) {
  try {
    localStorage.setItem(PENDING_FILINGS_KEY, JSON.stringify(filings));
  } catch {
    // Without storage the filing is only retried within this run.
  }
}

/** Files a new desktop chat in the project it was started from. A failure is
 * retried twice, then remembered and retried at the next launch, so a chat
 * started in a project never silently ends up outside it. Resolves whether
 * the chat is filed now. */
export async function fileChatInProject(
  sessionId: string,
  folderId: string,
  delaysMs: number[] = [0, 500, 2000],
): Promise<boolean> {
  for (const delay of delaysMs) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await assignSessionToFolder(sessionId, folderId);
      const pending = pendingFilings();
      if (sessionId in pending) {
        delete pending[sessionId];
        writePendingFilings(pending);
      }
      return true;
    } catch {
      // Tried again below, then kept for the next launch.
    }
  }
  writePendingFilings({ ...pendingFilings(), [sessionId]: folderId });
  return false;
}

/** Retries the filings a previous run could not complete. */
export async function retryPendingProjectFilings(): Promise<void> {
  for (const [sessionId, folderId] of Object.entries(pendingFilings())) {
    await fileChatInProject(sessionId, folderId, [0]);
  }
}
