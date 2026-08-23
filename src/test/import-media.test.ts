import { beforeEach, describe, expect, it, vi } from "vitest";

const stageImportedFile = vi.fn();
const discardStagedImport = vi.fn();
const importAudioNote = vi.fn();

vi.mock("../lib/tauri", () => ({
  stageImportedFile: (...args: unknown[]) => stageImportedFile(...args),
  discardStagedImport: (...args: unknown[]) => discardStagedImport(...args),
  importAudioNote: (...args: unknown[]) => importAudioNote(...args),
}));

import {
  extensionOf,
  importMediaFile,
  isImportableMediaFile,
  stageMediaFile,
} from "../lib/import-media";

/** A `File` big enough to be sliced, without allocating anything real. */
function fakeFile(name: string, bytes: number): File {
  const payload = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) payload[index] = index % 251;
  return new File([payload], name);
}

beforeEach(() => {
  stageImportedFile.mockReset();
  discardStagedImport.mockReset();
  importAudioNote.mockReset();
  // Staging answers with a path only on the final slice, like Rust does.
  stageImportedFile.mockImplementation(async ({ done }: { done: boolean }) =>
    done ? "/tmp/subrosa-staging-abc.mp3" : null,
  );
  importAudioNote.mockResolvedValue({ id: "note-1" });
});

describe("recognising importable media", () => {
  it("reads the extension case-insensitively", () => {
    expect(extensionOf("Talk.MP4")).toBe("mp4");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("accepts video containers, because a video is an audio track we read", () => {
    expect(isImportableMediaFile("keynote.mp4")).toBe(true);
    expect(isImportableMediaFile("interview.mov")).toBe(true);
    expect(isImportableMediaFile("episode.mp3")).toBe(true);
    expect(isImportableMediaFile("slides.pdf")).toBe(false);
  });
});

describe("staging a file", () => {
  it("hands the file over in slices and reports progress as it goes", async () => {
    // 20 MB against an 8 MB slice: three calls, the last one flagged done.
    const file = fakeFile("long-talk.mp3", 20 * 1024 * 1024);
    const progress: number[] = [];

    const staged = await stageMediaFile(file, ({ transferred, total }) =>
      progress.push(transferred / total),
    );

    expect(staged).toBe("/tmp/subrosa-staging-abc.mp3");
    expect(stageImportedFile).toHaveBeenCalledTimes(3);
    const calls = stageImportedFile.mock.calls.map(([request]) => request as { done: boolean });
    expect(calls.map((call) => call.done)).toEqual([false, false, true]);
    expect(progress.at(-1)).toBe(1);
    // Every slice carries the same upload id, or Rust would stage three files.
    const ids = new Set(
      stageImportedFile.mock.calls.map(([request]) => (request as { uploadId: string }).uploadId),
    );
    expect(ids.size).toBe(1);
  });

  it("still makes one call for an empty file, so `done` can come back", async () => {
    await stageMediaFile(fakeFile("empty.wav", 0));
    expect(stageImportedFile).toHaveBeenCalledTimes(1);
    expect(stageImportedFile.mock.calls[0][0]).toMatchObject({ done: true });
  });

  it("drops the half-written staging file when a slice fails", async () => {
    stageImportedFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(stageMediaFile(fakeFile("talk.mp3", 1024))).rejects.toThrow("disk full");

    expect(discardStagedImport).toHaveBeenCalledTimes(1);
  });
});

describe("importing a staged file", () => {
  it("imports by staged path, never by inlining the bytes", async () => {
    await importMediaFile(fakeFile("lecture.m4a", 1024), { folderId: "folder-7" });

    expect(importAudioNote).toHaveBeenCalledWith({
      stagedPath: "/tmp/subrosa-staging-abc.mp3",
      fileName: "lecture.m4a",
      folderId: "folder-7",
    });
    // The whole point of staging: no base64 payload crosses the boundary.
    expect(importAudioNote.mock.calls[0][0]).not.toHaveProperty("base64");
  });
});
