import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetSessionWorkingDir,
  pushRecentWorkingDir,
  recentWorkingDirs,
  rememberSessionWorkingDir,
  removeRecentWorkingDir,
  sessionWorkingDir,
  workingDirDisplayName,
} from "../lib/agent-session-working-dir";

const SESSIONS_KEY = "june.agent.sessionWorkingDirs";
const RECENTS_KEY = "june.agent.recentWorkingDirs";

beforeEach(() => {
  window.localStorage.removeItem(SESSIONS_KEY);
  window.localStorage.removeItem(RECENTS_KEY);
});

describe("per-session working-folder record", () => {
  it("defaults to the app workspace: no record means undefined", () => {
    // Sessions from before this record existed must fall back to the safe
    // default, exactly like the mode record's absence means sandboxed.
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
    expect(sessionWorkingDir(undefined)).toBeUndefined();
  });

  it("remembers, overwrites, and forgets a session's folder", () => {
    rememberSessionWorkingDir("sess-1", "/Users/me/Projects/demo");
    expect(sessionWorkingDir("sess-1")).toBe("/Users/me/Projects/demo");

    rememberSessionWorkingDir("sess-1", "/Users/me/Projects/other");
    expect(sessionWorkingDir("sess-1")).toBe("/Users/me/Projects/other");

    forgetSessionWorkingDir("sess-1");
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
    // A fully-empty map removes the key instead of storing "{}" forever.
    expect(window.localStorage.getItem(SESSIONS_KEY)).toBeNull();
  });

  it("remembering null clears instead of storing a null", () => {
    rememberSessionWorkingDir("sess-1", "/Users/me/Projects/demo");
    rememberSessionWorkingDir("sess-1", null);
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
  });

  it("survives corrupt storage by treating it as empty", () => {
    window.localStorage.setItem(SESSIONS_KEY, "not json");
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(["array"]));
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
    // Non-string values are dropped rather than returned.
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify({ "sess-1": 42 }));
    expect(sessionWorkingDir("sess-1")).toBeUndefined();
  });
});

describe("recent working folders", () => {
  it("keeps most-recent-first, dedupes, and caps the list", () => {
    for (const dir of ["/a", "/b", "/c", "/d", "/e", "/f"]) {
      pushRecentWorkingDir(dir);
    }
    // Capped at 5, newest first.
    expect(recentWorkingDirs()).toEqual(["/f", "/e", "/d", "/c", "/b"]);
    // Re-picking an existing folder moves it to the front without duplicating.
    pushRecentWorkingDir("/d");
    expect(recentWorkingDirs()).toEqual(["/d", "/f", "/e", "/c", "/b"]);
  });

  it("removes a folder that turned invalid", () => {
    pushRecentWorkingDir("/a");
    pushRecentWorkingDir("/b");
    removeRecentWorkingDir("/a");
    expect(recentWorkingDirs()).toEqual(["/b"]);
    removeRecentWorkingDir("/b");
    expect(recentWorkingDirs()).toEqual([]);
    expect(window.localStorage.getItem(RECENTS_KEY)).toBeNull();
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem(RECENTS_KEY, "not json");
    expect(recentWorkingDirs()).toEqual([]);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify({ nope: true }));
    expect(recentWorkingDirs()).toEqual([]);
  });
});

describe("workingDirDisplayName", () => {
  it("returns the folder's own name across separators", () => {
    expect(workingDirDisplayName("/Users/me/Projects/demo")).toBe("demo");
    expect(workingDirDisplayName("/Users/me/Projects/demo/")).toBe("demo");
    expect(workingDirDisplayName("C:\\Users\\me\\Projects\\demo")).toBe("demo");
    // A name with spaces and accents survives untouched.
    expect(workingDirDisplayName("/Users/me/Un projet — démo")).toBe("Un projet — démo");
  });

  it("falls back to the input when there is no useful name", () => {
    expect(workingDirDisplayName("/")).toBe("/");
  });
});
