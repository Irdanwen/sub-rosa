/**
 * The `subrosa:file` chat block (ADR-0090): a Word, Excel or PowerPoint file
 * the assistant made with `make_document`, saved in the gallery's documents
 * folder. The payload names the file by its gallery name, never by a path:
 * a path goes stale on iOS across reinstalls, and the commands behind the
 * card's buttons resolve the name inside the documents folder only.
 */

import { invoke } from "@tauri-apps/api/core";

export type DocumentKind = "docx" | "xlsx" | "pptx";

export type FileChatBlock = {
  kind: "file";
  /** `<uuid>.<docx|xlsx|pptx>` */
  file: string;
  title: string;
  documentKind: DocumentKind;
  /** What it holds, in a few words ("5 slides"). */
  detail?: string;
};

const FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(docx|xlsx|pptx)$/;
const MAX_TITLE = 120;
const MAX_DETAIL = 60;

function capped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Parses a `subrosa:file` payload (already JSON-decoded, `v` checked). */
export function parseFilePayload(payload: Record<string, unknown>): FileChatBlock | null {
  const file = typeof payload.file === "string" ? payload.file.trim() : "";
  const match = FILE_NAME.exec(file);
  if (!match) return null;
  const documentKind = match[1] as DocumentKind;
  // The kind is the file's: a payload that disagrees is not one the tool wrote.
  if (payload.kind !== undefined && payload.kind !== documentKind) return null;
  const detail = capped(payload.detail, MAX_DETAIL);
  return {
    kind: "file",
    file,
    title: capped(payload.title, MAX_TITLE) ?? file,
    documentKind,
    ...(detail ? { detail } : {}),
  };
}

/** The block as plain text, for copying a reply. */
export function filePlainText(block: FileChatBlock): string[] {
  return [`${block.title}.${block.documentKind}`];
}

/** A file name to suggest when saving: the title, without what file systems refuse. */
export function suggestedFileName(block: FileChatBlock): string {
  const stem =
    block.title
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Document";
  return `${stem.slice(0, 80)}.${block.documentKind}`;
}

/** A document in the gallery's documents folder (`deliverable_list`), made
 * on this device or synchronised from another. */
export type DocumentEntry = {
  file: string;
  /** The title written in the file; absent when it has none. */
  title?: string | null;
  kind: DocumentKind;
  bytes: number;
  modifiedAt?: string | null;
};

/** Every document the assistant made, newest first, for the Library. */
export async function listDeliverables(): Promise<DocumentEntry[]> {
  const rows = await invoke<DocumentEntry[]>("deliverable_list");
  return Array.isArray(rows) ? rows : [];
}

/** A listed document as the card a chat shows for it, so the Library opens,
 * shares and saves it with the same buttons. */
export function documentBlock(entry: DocumentEntry, detail?: string): FileChatBlock {
  return {
    kind: "file",
    file: entry.file,
    title: entry.title?.trim() || entry.file,
    documentKind: entry.kind,
    ...(detail ? { detail } : {}),
  };
}

/** Opens the file: its default app on the computer, the share sheet on the phone. */
export function openDeliverable(file: string): Promise<void> {
  return invoke<void>("deliverable_open", { request: { file } });
}

/** Desktop: copies the file where the person picks in a save dialog (Rust opens it).
 * Resolves to the saved path, or null when the dialog was cancelled. */
export async function saveDeliverableCopy(block: FileChatBlock): Promise<string | null> {
  const path = await invoke<string>("deliverable_path", { request: { file: block.file } });
  return invoke<string | null>("carpe_diem_media_export_artifact", {
    request: { path, suggestedName: suggestedFileName(block) },
  });
}
