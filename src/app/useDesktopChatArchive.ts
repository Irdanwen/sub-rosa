import { type Dispatch, type SetStateAction, useCallback, useMemo } from "react";
import { useAccountSyncUpdated } from "../lib/account-sync-events";
import {
  ARCHIVE_FOLDER_NAME,
  archiveFolderIds,
  isArchivedSession,
  partitionArchivedSessions,
  projectFolderMap,
  sessionFolderMap,
} from "../lib/chat-archive";
import {
  assignSessionToFolder,
  type FolderDto,
  listSessionFolders,
  removeSessionFromFolder,
} from "../lib/tauri";

/**
 * Archive and restore for desktop chats, in the phone's terms (ADR-0080): a
 * chat is archived by filing it in the shared "Archive" folder, so the archive
 * travels with the folder memberships and shows on every device.
 */
export function useDesktopChatArchive({
  folders,
  sessionFolders,
  setSessionFolders,
  createFolder,
  onError,
}: {
  folders: readonly FolderDto[];
  sessionFolders: Record<string, string[]>;
  setSessionFolders: Dispatch<SetStateAction<Record<string, string[]>>>;
  createFolder: (name: string) => Promise<FolderDto | undefined>;
  onError: (err: unknown) => void;
}) {
  const archiveIds = useMemo(() => archiveFolderIds(folders), [folders]);

  // The store answers a membership under every id the chat is known by, so a
  // re-read is how one made on the phone, or under the other id, shows here.
  const refresh = useCallback(async () => {
    setSessionFolders(sessionFolderMap(await listSessionFolders()));
  }, [setSessionFolders]);
  useAccountSyncUpdated(refresh);

  const archivedIds = useMemo(
    () =>
      new Set(
        Object.keys(sessionFolders).filter((id) =>
          isArchivedSession(id, sessionFolders, archiveIds),
        ),
      ),
    [archiveIds, sessionFolders],
  );

  /** Memberships without the archive, for every surface that names projects. */
  const projectFolders = useMemo(
    () => projectFolderMap(sessionFolders, archiveIds),
    [archiveIds, sessionFolders],
  );

  async function archive(sessionId: string) {
    try {
      const folderId = archiveIds[0] ?? (await createFolder(ARCHIVE_FOLDER_NAME))?.id;
      if (!folderId) return;
      await assignSessionToFolder(sessionId, folderId);
      await refresh();
    } catch (err) {
      onError(err);
    }
  }

  async function restore(sessionId: string) {
    try {
      for (const folderId of sessionFolders[sessionId] ?? []) {
        if (archiveIds.includes(folderId)) await removeSessionFromFolder(sessionId, folderId);
      }
      await refresh();
    } catch (err) {
      onError(err);
    }
  }

  return {
    archiveIds,
    archivedIds,
    archive,
    restore,
    refresh,
    projectFolders,
    split: <T extends { id: string }>(sessions: readonly T[]) =>
      partitionArchivedSessions(sessions, sessionFolders, archiveIds),
  };
}
