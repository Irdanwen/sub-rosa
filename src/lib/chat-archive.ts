/**
 * Archiving a chat (ADR-0080). An archived chat is one filed in the shared
 * folder named "Archive", the folder the phone already archives into, so an
 * archive made on one device shows on the other: folders and chat folder
 * memberships both synchronise, and the store answers a membership under the
 * desktop's Hermes session id as well as the conversation id the phone uses.
 *
 * Two devices can each create an "Archive" before they meet, so every folder
 * of that name counts; a new archive goes into the first one.
 */

import type { FolderDto, SessionFolderDto } from "./tauri";

export const ARCHIVE_FOLDER_NAME = "Archive";

/** The ids of every live folder named "Archive", case-insensitively. */
export function archiveFolderIds(folders: readonly Pick<FolderDto, "id" | "name">[]): string[] {
  return folders
    .filter((folder) => folder.name.trim().toLowerCase() === ARCHIVE_FOLDER_NAME.toLowerCase())
    .map((folder) => folder.id);
}

/** sessionId -> the folder ids it is filed under, from the store's rows. */
export function sessionFolderMap(rows: readonly SessionFolderDto[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    const folders = map[row.sessionId] ?? [];
    if (!folders.includes(row.folderId)) folders.push(row.folderId);
    map[row.sessionId] = folders;
  }
  return map;
}

export function isArchivedSession(
  sessionId: string,
  sessionFolders: Readonly<Record<string, readonly string[]>>,
  archiveIds: readonly string[],
): boolean {
  return (sessionFolders[sessionId] ?? []).some((folderId) => archiveIds.includes(folderId));
}

/** The chats the list shows, and the ones the "Archived chats" view shows. */
export function partitionArchivedSessions<T extends { id: string }>(
  sessions: readonly T[],
  sessionFolders: Readonly<Record<string, readonly string[]>>,
  archiveIds: readonly string[],
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const session of sessions) {
    (isArchivedSession(session.id, sessionFolders, archiveIds) ? archived : active).push(session);
  }
  return { active, archived };
}

/** The memberships that are projects: the archive is a state, not a project,
 * so it never names a chat's project and a move between projects keeps it. */
export function projectFolderMap(
  sessionFolders: Readonly<Record<string, readonly string[]>>,
  archiveIds: readonly string[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [sessionId, folderIds] of Object.entries(sessionFolders)) {
    const projects = folderIds.filter((folderId) => !archiveIds.includes(folderId));
    if (projects.length) map[sessionId] = projects;
  }
  return map;
}
