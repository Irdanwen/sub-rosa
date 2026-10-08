import { describe, expect, it } from "vitest";
import {
  archiveFolderIds,
  isArchivedSession,
  partitionArchivedSessions,
  projectFolderMap,
  sessionFolderMap,
} from "../lib/chat-archive";

const folders = [
  { id: "work", name: "Work" },
  { id: "archive-mac", name: "Archive" },
  { id: "archive-phone", name: " archive " },
  { id: "archives", name: "Archives" },
];

describe("archiving a chat", () => {
  it("counts every folder named Archive, whichever device made it", () => {
    expect(archiveFolderIds(folders)).toEqual(["archive-mac", "archive-phone"]);
    expect(archiveFolderIds([{ id: "work", name: "Work" }])).toEqual([]);
  });

  it("groups the store's rows by chat, once per folder", () => {
    expect(
      sessionFolderMap([
        { sessionId: "h1", folderId: "work" },
        { sessionId: "h1", folderId: "archive-mac" },
        { sessionId: "h1", folderId: "work" },
        { sessionId: "task-2", folderId: "archive-phone" },
      ]),
    ).toEqual({ h1: ["work", "archive-mac"], "task-2": ["archive-phone"] });
  });

  it("hides archived chats from the list and shows them in the archived view", () => {
    const archiveIds = archiveFolderIds(folders);
    const sessionFolders = { h1: ["work"], h2: ["archive-phone"], h3: ["work", "archive-mac"] };
    const sessions = [{ id: "h1" }, { id: "h2" }, { id: "h3" }, { id: "h4" }];

    const { active, archived } = partitionArchivedSessions(sessions, sessionFolders, archiveIds);

    expect(active.map((s) => s.id)).toEqual(["h1", "h4"]);
    expect(archived.map((s) => s.id)).toEqual(["h2", "h3"]);
    expect(isArchivedSession("h4", sessionFolders, archiveIds)).toBe(false);
    // Without an Archive folder nothing is archived, whatever else is filed.
    expect(partitionArchivedSessions(sessions, sessionFolders, []).archived).toEqual([]);
  });

  it("never names the archive as a chat's project", () => {
    const archiveIds = archiveFolderIds(folders);
    expect(
      projectFolderMap({ h1: ["archive-mac", "work"], h2: ["archive-phone"] }, archiveIds),
    ).toEqual({ h1: ["work"] });
  });
});
