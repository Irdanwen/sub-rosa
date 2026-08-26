import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptToFilm } from "../components/studio/ScriptToFilm";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const hoisted = vi.hoisted(() => ({ invoke: vi.fn(), generateImages: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("../lib/studio/generate-image", () => ({ generateImages: hoisted.generateImages }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  saveArtifactFromBase64: vi.fn(async () => ({ id: "drawn.png", fileName: "drawn.png" })),
}));

function model(id: string, mediaType: string, over: Partial<MediaModel> = {}): MediaModel {
  return {
    id,
    name: id,
    mediaType: mediaType as MediaModel["mediaType"],
    offline: false,
    costCredits: 10,
    constraints: { durations: ["3s", "5s", "8s"], aspect_ratios: ["16:9"] },
    ...over,
  } as MediaModel;
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("kling-text", "video"),
    model("kling-image", "imageToVideo"),
    model("draws", "image", { constraints: undefined }),
  ],
};

const NOTE = { id: "n1", title: "Neon alley", updatedAt: "", createdAt: "" };

const SHOTS = [
  {
    scene: "The alley",
    action: "Nera turns towards the sound",
    camera: "Slow push in",
    characters: ["Nera"],
    location: "",
    dialogue: "Get in.",
    speaker: "Nera",
    motion: "low",
    continues: false,
  },
  {
    scene: "The alley",
    action: "She runs",
    camera: "Handheld",
    characters: ["Nera"],
    location: "",
    dialogue: "",
    speaker: "",
    motion: "high",
    continues: true,
  },
];

function respond(overrides: Record<string, unknown> = {}) {
  hoisted.invoke.mockImplementation(async (command: string) => {
    if (command === "list_notes") return { items: [NOTE] };
    if (command === "list_bible_entries") return [];
    if (command === "shot_list_plan")
      return {
        noteId: "n1",
        scriptChars: 900,
        chunkCount: 1,
        modelCalls: 1,
        breakable: true,
        reason: null,
      };
    if (command === "shot_list" || command === "build_shot_list")
      return {
        noteId: "n1",
        status: "ready",
        shotsJson: JSON.stringify(SHOTS),
        partsJson: null,
        chunkCount: 1,
        scriptChars: 900,
        model: "opus",
        promptVersion: "shotlist-v1",
        lastError: null,
        createdAt: "",
        updatedAt: "",
        ...overrides,
      };
    return null;
  });
}

async function pickTheNote() {
  fireEvent.click(await screen.findByRole("button", { name: /Neon alley/ }));
}

beforeEach(() => {
  hoisted.invoke.mockReset();
  hoisted.generateImages.mockReset().mockResolvedValue(["AAAA"]);
  respond();
});

describe("from a script to a film", () => {
  it("shows the shots, then hands a runnable graph to the canvas", async () => {
    const onCompiled = vi.fn();
    render(<ScriptToFilm catalog={catalog} onCompiled={onCompiled} onClose={vi.fn()} />);
    await pickTheNote();

    expect(await screen.findByText("Nera turns towards the sound")).toBeInTheDocument();
    expect(screen.getByText(/2 shots\. 1 spoken\./)).toBeInTheDocument();
    // The second shot carries on from the first: that is what makes the seam
    // invisible, and it is worth showing before anything is paid for.
    expect(screen.getByText(/high · continues/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Put it on the canvas" }));
    await waitFor(() => expect(onCompiled).toHaveBeenCalledTimes(1));
    const workflow = onCompiled.mock.calls[0][0];
    expect(workflow.nodes.filter((entry: { type: string }) => entry.type === "video")).toHaveLength(
      2,
    );
    // The chain, and the cut it ends on.
    expect(workflow.nodes.some((entry: { type: string }) => entry.type === "lastFrame")).toBe(true);
    expect(workflow.nodes.some((entry: { type: string }) => entry.type === "assemble")).toBe(true);
  });

  it("says which names the bible recognised, and which it never heard of", async () => {
    // A script calling her "Nera" and a bible entry called "Nera" hold the
    // same face. A script calling her "Nera Vex" holds nothing, renders every
    // shot from scratch, and used to say nothing about it - which is only
    // visible once the shots are paid for.
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [NOTE] };
      if (command === "list_bible_entries")
        return [
          {
            id: "e1",
            kind: "character",
            name: "Nera",
            traits: "green coat",
            note: "",
            refs: [],
            createdAt: "",
            updatedAt: "",
          },
        ];
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      if (command === "shot_list")
        return {
          noteId: "n1",
          status: "ready",
          shotsJson: JSON.stringify([{ ...SHOTS[0], characters: ["Nera"], location: "The alley" }]),
          chunkCount: 1,
          scriptChars: 900,
          model: "opus",
          promptVersion: "shotlist-v1",
          createdAt: "",
          updatedAt: "",
        };
      return null;
    });
    render(<ScriptToFilm catalog={catalog} onCompiled={vi.fn()} onClose={vi.fn()} />);
    await pickTheNote();

    expect(await screen.findByText(/From your bible: Nera\./)).toBeInTheDocument();
    // And the one it never heard of is not a warning to act on elsewhere: it
    // is offered a face, right here, where the user is already looking.
    // "The alley" is also the scene name on every shot, so the button is what
    // proves it was offered a look rather than merely mentioned.
    expect(screen.getByText(/will not look the same twice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give it a look" })).toBeEnabled();
  });

  it("gives a name from the script a face in one gesture", async () => {
    // The cold start, closed where it actually bites: the alternative was to
    // go and invent three prompts in another tab and come back.
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [NOTE] };
      if (command === "list_bible_entries") return [];
      if (command === "save_bible_entry") return "new-entry";
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      if (command === "shot_list")
        return {
          noteId: "n1",
          status: "ready",
          shotsJson: JSON.stringify([{ ...SHOTS[0], characters: ["Nera"], location: "" }]),
          chunkCount: 1,
          scriptChars: 900,
          model: "opus",
          promptVersion: "shotlist-v1",
          createdAt: "",
          updatedAt: "",
        };
      return null;
    });
    render(<ScriptToFilm catalog={catalog} onCompiled={vi.fn()} onClose={vi.fn()} />);
    await pickTheNote();

    fireEvent.click(await screen.findByRole("button", { name: "Give them a face" }));
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith(
        "save_bible_entry",
        expect.objectContaining({
          request: expect.objectContaining({ name: "Nera", kind: "character" }),
        }),
      ),
    );
    // The picture is drawn and attached: an ordinary gallery image on an
    // ordinary bible row, which the Bible tab shows in detail.
    await waitFor(() => expect(hoisted.generateImages).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith("add_bible_ref", expect.anything()),
    );
  });

  it("refuses to compile over the ceiling, and hands nothing over", async () => {
    // The confirmation handshake is for deciding. It is not for catching a
    // production that was never affordable.
    const onCompiled = vi.fn();
    render(<ScriptToFilm catalog={catalog} onCompiled={onCompiled} onClose={vi.fn()} />);
    await pickTheNote();
    await screen.findByText("Nera turns towards the sound");

    fireEvent.change(screen.getByLabelText("Spend ceiling"), { target: { value: "5" } });
    expect(await screen.findByText(/past the 5.00 agreed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Put it on the canvas" })).toBeDisabled();
    expect(onCompiled).not.toHaveBeenCalled();
  });

  it("says what a reading would take before it starts one", async () => {
    // No row yet: the note has never been read.
    respond();
    const base = hoisted.invoke.getMockImplementation();
    hoisted.invoke.mockImplementation(async (command: string, args?: unknown) =>
      command === "shot_list" ? null : base?.(command, args),
    );
    render(<ScriptToFilm catalog={catalog} onCompiled={vi.fn()} onClose={vi.fn()} />);
    await pickTheNote();
    expect(await screen.findByText(/1 pass over 900 characters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Break it into shots" }));
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith("build_shot_list", { noteId: "n1" }),
    );
  });

  it("will not start a reading it already knows cannot work", async () => {
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [NOTE] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list_plan")
        return {
          noteId: "n1",
          scriptChars: 20,
          chunkCount: 1,
          modelCalls: 1,
          breakable: false,
          reason: "There is not enough here to break into shots yet.",
        };
      return null;
    });
    render(<ScriptToFilm catalog={catalog} onCompiled={vi.fn()} onClose={vi.fn()} />);
    await pickTheNote();
    expect(await screen.findByText(/not enough here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Break it into shots" })).toBeDisabled();
  });

  it("shows why a reading failed instead of an empty panel", async () => {
    respond({ status: "failed", shotsJson: null, lastError: "The rail said no." });
    render(<ScriptToFilm catalog={catalog} onCompiled={vi.fn()} onClose={vi.fn()} />);
    await pickTheNote();
    expect(await screen.findByText("The rail said no.")).toBeInTheDocument();
  });
});
