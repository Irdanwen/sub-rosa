// A device file joining the gallery as an asset (import-asset.ts): a clip or
// a track is streamed into Rust's staging file and moved from there, a
// picture travels as one string, and a file of the wrong kind is refused
// before anything is read.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptFor,
  assetExtension,
  assetKindOf,
  importAssetFile,
} from "../lib/studio/import-asset";

const state = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: unknown }> }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    state.calls.push({ command, args });
    if (command === "stage_imported_file") {
      const request = (args as { request: { done: boolean; fileName: string } }).request;
      return request.done ? `/tmp/subrosa-staging-abc.${request.fileName.split(".").pop()}` : null;
    }
    if (command === "carpe_diem_media_import_staged") {
      const request = (args as { request: { extension: string } }).request;
      return {
        path: `/gallery/clip.${request.extension}`,
        fileName: `clip.${request.extension}`,
        bytes: 9,
      };
    }
    if (command === "carpe_diem_media_save_artifact")
      return { path: "/gallery/pic.png", fileName: "pic.png", bytes: 3 };
    if (command === "studio_artifact_save") return { id: "x" };
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));

beforeEach(() => {
  state.calls = [];
  window.localStorage.clear();
});

describe("what a device file is", () => {
  it("reads the extension off the name, else off the type the device reports", () => {
    expect(assetExtension({ name: "IMG_0001.MOV", type: "video/quicktime" })).toBe("mov");
    expect(assetExtension({ name: "clip", type: "video/quicktime" })).toBe("mov");
    expect(assetExtension({ name: "take 2", type: "audio/x-m4a" })).toBe("m4a");
    expect(assetExtension({ name: "mystery", type: "" })).toBeUndefined();
  });
  it("knows a picture, a clip and a track apart, by type then by name", () => {
    expect(assetKindOf({ name: "a.heic", type: "image/heic" })).toBe("image");
    expect(assetKindOf({ name: "a.mov", type: "" })).toBe("video");
    expect(assetKindOf({ name: "a.m4a", type: "" })).toBe("audio");
    expect(assetKindOf({ name: "a.pdf", type: "application/pdf" })).toBeUndefined();
  });
  it("tells a file input the types and the extensions, for the platforms that match on either", () => {
    expect(acceptFor("video")).toContain("video/*");
    expect(acceptFor("video")).toContain(".mov");
    expect(acceptFor("audio")).toContain(".m4a");
    expect(acceptFor("image")).toContain(".heic");
  });
});

describe("importing a device file", () => {
  it("streams a clip into the staging file, slice by slice, then moves it into the gallery", async () => {
    // Nine megabytes: two slices, so the staging call answers once with
    // nothing and once with the path.
    const bytes = new Uint8Array(9 * 1024 * 1024);
    const file = new File([bytes], "IMG_0001.MOV", { type: "video/quicktime" });
    const artifact = await importAssetFile(file, "video");
    const staged = state.calls.filter((call) => call.command === "stage_imported_file");
    expect(staged).toHaveLength(2);
    expect(
      staged.map((call) => (call.args as { request: { done: boolean } }).request.done),
    ).toEqual([false, true]);
    const moved = state.calls.find((call) => call.command === "carpe_diem_media_import_staged");
    expect(moved?.args).toEqual({
      request: { stagedPath: "/tmp/subrosa-staging-abc.MOV", extension: "mov" },
    });
    expect(artifact.kind).toBe("video");
    expect(artifact.fileName).toBe("clip.mov");
    // Nothing went through the one-string path.
    expect(state.calls.some((call) => call.command === "carpe_diem_media_save_artifact")).toBe(
      false,
    );
  });

  it("files a track in the music bucket", async () => {
    const file = new File([new Uint8Array(16)], "voice.m4a", { type: "audio/x-m4a" });
    const artifact = await importAssetFile(file, "audio");
    expect(artifact.kind).toBe("music");
  });

  it("saves a picture through the one-string path, as the retouch does", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
    const artifact = await importAssetFile(file, "image");
    expect(artifact.kind).toBe("image");
    expect(state.calls.some((call) => call.command === "carpe_diem_media_save_artifact")).toBe(
      true,
    );
    expect(state.calls.some((call) => call.command === "stage_imported_file")).toBe(false);
  });

  it("refuses a file of another kind before reading it", async () => {
    const file = new File([new Uint8Array(16)], "song.mp3", { type: "audio/mpeg" });
    await expect(importAssetFile(file, "video")).rejects.toThrow("This setting takes a clip");
    expect(state.calls).toEqual([]);
  });
});
