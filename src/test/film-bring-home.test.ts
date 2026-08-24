import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BroughtHomeFilmDto } from "../lib/tauri";

const bringHomeMock = vi.fn();
const createNoteMock = vi.fn();
const updateNoteMock = vi.fn();
const registerMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  videomakerBringHome: (slug: string) => bringHomeMock(slug),
  createNote: () => createNoteMock(),
  updateNote: (input: unknown) => updateNoteMock(input),
}));

vi.mock("../lib/studio/artifacts", () => ({
  registerDownloadedArtifact: (file: unknown, metadata: unknown) => registerMock(file, metadata),
}));

import {
  BROUGHT_HOME_STORAGE_KEY,
  bringFilmHome,
  broughtHomeNoteId,
  composeFilmNote,
} from "../lib/films/bring-home";

function film(overrides: Partial<BroughtHomeFilmDto> = {}): BroughtHomeFilmDto {
  return {
    slug: "neon-alley",
    title: "Neon alley",
    brief: "Two strangers, one umbrella, forty seconds.",
    state: "produced",
    createdAt: "2026-07-01",
    spentDiem: 12.345,
    pieces: [
      { path: "/g/a.mp4", fileName: "a.mp4", bytes: 10, kind: "master" },
      {
        path: "/g/b.mp4",
        fileName: "b.mp4",
        bytes: 20,
        kind: "clip",
        sceneTitle: "The alley",
        shotId: "s1",
        prompt: "wide on the rain",
        durationSeconds: 4.26,
      },
      {
        path: "/g/c.png",
        fileName: "c.png",
        bytes: 5,
        kind: "frame",
        sceneTitle: "The alley",
        shotId: "s1",
      },
    ],
    transcript: [
      ["user", "Make it colder."],
      ["assistant", "Cooled the grade."],
    ],
    problems: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  bringHomeMock.mockReset();
  createNoteMock.mockReset();
  updateNoteMock.mockReset();
  registerMock.mockReset();
  createNoteMock.mockResolvedValue({ id: "note-1" });
  updateNoteMock.mockResolvedValue({ id: "note-1" });
});

describe("composeFilmNote", () => {
  it("writes a note that survives the feature it came from", () => {
    const { title, markdown } = composeFilmNote(film());
    expect(title).toBe("Neon alley");
    // Artifacts are referenced by file name (the gallery id), never by path:
    // a path outlives nothing, and this note has to outlive the studio.
    expect(markdown).toContain("`a.mp4`");
    expect(markdown).toContain("`b.mp4`");
    expect(markdown).not.toContain("/g/");
    expect(markdown).toContain("## Brief");
    expect(markdown).toContain("Two strangers, one umbrella, forty seconds.");
    expect(markdown).toContain("### The alley");
    expect(markdown).toContain("Shot s1");
    expect(markdown).toContain("Shot s1, storyboard frame");
    expect(markdown).toContain("(4.3 s)");
    expect(markdown).toContain("> wide on the rain");
    expect(markdown).toContain("**You:** Make it colder.");
    expect(markdown).toContain("**The studio:** Cooled the grade.");
    // Provenance lives in the note, not only in the localStorage index: the
    // index can be cleared, and this note has to keep saying what it is long
    // after the studio and its code are gone.
    expect(markdown).toContain("`neon-alley`");
  });

  it("names what did not come home rather than pretending it did", () => {
    const { markdown } = composeFilmNote(
      film({ problems: ["The final cut did not come home: 404."] }),
    );
    expect(markdown).toContain("## What did not come home");
    expect(markdown).toContain("404.");
  });

  it("omits sections a film never had", () => {
    const { markdown } = composeFilmNote(
      film({ brief: null, transcript: [], pieces: [], spentDiem: null, state: null }),
    );
    expect(markdown).not.toContain("## Brief");
    expect(markdown).not.toContain("## Direction");
    expect(markdown).not.toContain("## Shots");
    expect(markdown).not.toContain("## Final cut");
  });
});

describe("bringFilmHome", () => {
  it("indexes every downloaded file and writes one note", async () => {
    bringHomeMock.mockResolvedValue(film());
    const result = await bringFilmHome("neon-alley");

    expect(result).toMatchObject({ noteId: "note-1", alreadyHome: false, artifactCount: 3 });
    expect(registerMock).toHaveBeenCalledTimes(3);
    // A storyboard frame is an image in the gallery, a clip is a video.
    expect(registerMock.mock.calls[2]?.[1]).toMatchObject({ kind: "image" });
    expect(registerMock.mock.calls[1]?.[1]).toMatchObject({ kind: "video" });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
    expect(broughtHomeNoteId("neon-alley")).toBe("note-1");
  });

  it("does not download a film twice, and does not write a second note", async () => {
    bringHomeMock.mockResolvedValue(film());
    await bringFilmHome("neon-alley");
    bringHomeMock.mockClear();
    createNoteMock.mockClear();

    const second = await bringFilmHome("neon-alley");
    expect(second).toMatchObject({ noteId: "note-1", alreadyHome: true, artifactCount: 0 });
    expect(bringHomeMock).not.toHaveBeenCalled();
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("forced, fetches again and rewrites the same note", async () => {
    bringHomeMock.mockResolvedValue(film());
    await bringFilmHome("neon-alley");
    createNoteMock.mockClear();
    updateNoteMock.mockClear();

    // The retry is the whole point of `force`: the first pass lost a shot to an
    // expired URL, and the studio is still up to hand it over.
    bringHomeMock.mockResolvedValue(film({ problems: [] }));
    const retry = await bringFilmHome("neon-alley", { force: true });

    expect(retry).toMatchObject({ noteId: "note-1", alreadyHome: false });
    expect(createNoteMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });

  it("survives a corrupt rescue index rather than refusing to rescue", async () => {
    window.localStorage.setItem(BROUGHT_HOME_STORAGE_KEY, "{not json");
    bringHomeMock.mockResolvedValue(film());
    await expect(bringFilmHome("neon-alley")).resolves.toMatchObject({ alreadyHome: false });
  });
});
