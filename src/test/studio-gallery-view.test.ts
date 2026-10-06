/**
 * What the gallery shows, on both shells: a file filed in a folder leaves the
 * kind views, as a filed note leaves the notes list, and a search still finds
 * it (ADR-0073 marks).
 */

import { describe, expect, it, vi } from "vitest";
import { visibleArtifacts } from "../lib/studio/gallery-view";
import type { StudioLibrary, StudioMark } from "../lib/studio/library";
import type { StudioArtifact } from "../lib/studio/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

const uuid = (n: number) => `0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c${String(n).padStart(2, "0")}`;
function item(n: number, kind: StudioArtifact["kind"], prompt: string): StudioArtifact {
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
  return {
    id: `${uuid(n)}.${ext}`,
    kind,
    path: `/gallery/${uuid(n)}.${ext}`,
    fileName: `${uuid(n)}.${ext}`,
    bytes: 10,
    model: "m",
    prompt,
    createdAt: n,
  };
}

const lighthouse = item(1, "image", "A lighthouse");
const tram = item(2, "video", "A tram");
const waltz = item(3, "music", "A waltz");
const ITEMS = [lighthouse, tram, waltz];

function library(marks: Partial<StudioMark>[]): StudioLibrary {
  return {
    collections: [{ id: "board", name: "Board", createdAt: "", updatedAt: "" }],
    marks: new Map(
      marks.map((mark) => [
        mark.fileId as string,
        {
          id: `mark-${mark.fileId}`,
          fileId: mark.fileId as string,
          collectionId: mark.collectionId ?? null,
          favorite: mark.favorite ?? false,
          hidden: mark.hidden ?? false,
        },
      ]),
    ),
  };
}

const filedTram = library([{ fileId: uuid(2), collectionId: "board", favorite: true }]);

describe("the gallery views", () => {
  it("leave a filed file out of every kind view", () => {
    expect(visibleArtifacts(ITEMS, filedTram, { view: "all" })).toEqual([lighthouse, waltz]);
    expect(visibleArtifacts(ITEMS, filedTram, { view: "video" })).toEqual([]);
  });

  it("show it in its folder and under favourites", () => {
    expect(
      visibleArtifacts(ITEMS, filedTram, { view: "collections", collectionId: "board" }),
    ).toEqual([tram]);
    expect(visibleArtifacts(ITEMS, filedTram, { view: "favorites" })).toEqual([tram]);
  });

  it("still find it by search", () => {
    expect(visibleArtifacts(ITEMS, filedTram, { view: "all", query: "tram" })).toEqual([tram]);
  });

  it("keep a hidden file out until the hidden view asks for it", () => {
    const hidden = library([{ fileId: uuid(1), hidden: true }]);
    expect(visibleArtifacts(ITEMS, hidden, { view: "all", query: "lighthouse" })).toEqual([]);
    expect(visibleArtifacts(ITEMS, hidden, { view: "hidden" })).toEqual([lighthouse]);
  });

  it("show a file whose folder was deleted elsewhere in the kind views", () => {
    const orphan = library([{ fileId: uuid(2), collectionId: "gone" }]);
    expect(visibleArtifacts(ITEMS, orphan, { view: "all" })).toEqual(ITEMS);
  });
});
