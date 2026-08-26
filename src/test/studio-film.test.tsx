import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ceilingFor, FilmStudio, isTight } from "../components/studio/FilmStudio";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(),
  generateImages: vi.fn(),
  runWorkflow: vi.fn(),
  resumeRun: vi.fn(),
  mediaJson: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("../lib/studio/generate-image", () => ({ generateImages: hoisted.generateImages }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  saveArtifactFromBase64: vi.fn(async () => ({ id: "drawn.png", fileName: "drawn.png" })),
}));
vi.mock("../lib/studio/workflow-run", () => ({
  runAndSaveWorkflow: hoisted.runWorkflow,
  resumeWorkflowRun: hoisted.resumeRun,
  listFinishedProductions: vi.fn(async () => []),
  productionCut: vi.fn(),
}));
vi.mock("../lib/studio/frames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/frames")>()),
  extractFrameAt: vi.fn(async () => ({ dataUrl: "data:image/jpeg;base64,AA", timeSeconds: 1 })),
}));
vi.mock("../lib/studio/client", () => ({ mediaJson: hoisted.mediaJson, mediaBinary: vi.fn() }));

function model(id: string, mediaType: string, over: Partial<MediaModel> = {}): MediaModel {
  return {
    id,
    name: id,
    mediaType: mediaType as MediaModel["mediaType"],
    offline: false,
    costCredits: 4,
    constraints: { durations: ["3s", "5s", "8s"], aspect_ratios: ["16:9"] },
    ...over,
  } as MediaModel;
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("kling-text-to-video", "video"),
    model("kling-image-to-video", "imageToVideo"),
    model("draws", "image", { constraints: undefined, costCredits: 2 }),
    model("sees", "text", { constraints: undefined, supportsVision: true }),
  ],
};

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
];

function reading(over: Record<string, unknown> = {}) {
  return {
    noteId: "n1",
    status: "ready",
    shotsJson: JSON.stringify({
      cast: [{ name: "Nera", kind: "character", traits: "green wool coat" }],
      shots: SHOTS,
    }),
    chunkCount: 1,
    scriptChars: 900,
    model: "opus",
    promptVersion: "shotlist-v2",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  hoisted.generateImages.mockReset().mockResolvedValue(["AAAA"]);
  hoisted.runWorkflow.mockReset().mockResolvedValue(new Map());
  hoisted.resumeRun.mockReset().mockResolvedValue(new Map());
  hoisted.mediaJson.mockReset();
  hoisted.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
    if (command === "list_bible_entries") return [];
    if (command === "create_note") return { id: "n1", title: "" };
    if (command === "update_note") return { id: "n1" };
    if (command === "build_shot_list") return reading();
    if (command === "shot_list") return null;
    if (command === "shot_list_plan")
      return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
    if (command === "save_bible_entry") return "e1";
    if (command === "add_bible_ref") return "r1";
    return null;
  });
});

describe("the film tab", () => {
  it("asks one question, and will not read an empty answer", async () => {
    render(<FilmStudio catalog={catalog} />);
    expect(await screen.findByText("What's your film?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read it" })).toBeDisabled();
  });

  it("turns what was typed into a note, so a script is a note like any other", async () => {
    render(<FilmStudio catalog={catalog} />);
    fireEvent.change(await screen.findByLabelText("What happens"), {
      target: { value: "Nera waits under the rain. She turns. She runs." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Read it" }));

    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith("create_note", {
        request: { folderId: undefined },
      }),
    );
    // The first sentence becomes the title, so the film has a name nobody had
    // to invent.
    expect(hoisted.invoke).toHaveBeenCalledWith(
      "update_note",
      expect.objectContaining({
        request: expect.objectContaining({ title: "Nera waits under the rain" }),
      }),
    );
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith("build_shot_list", { noteId: "n1" }),
    );
  });

  it("shows the shots, the cast it can draw, and one figure - not five questions", async () => {
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));

    expect(await screen.findByText("Nera turns towards the sound")).toBeInTheDocument();
    expect(screen.getByText(/1 shot, 1 spoken/)).toBeInTheDocument();
    // The cast the script implies, with the description the reading gave it.
    expect(screen.getByText("green wool coat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draw" })).toBeEnabled();
    // One figure, and the five settings behind a disclosure.
    expect(screen.getByText(/credits, at least/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Spend ceiling")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByLabelText("Spend ceiling")).toBeInTheDocument();
  });

  it("runs the film as an ordinary saved workflow, never a private one", async () => {
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Make it" }));

    await waitFor(() => expect(hoisted.runWorkflow).toHaveBeenCalledTimes(1));
    const [workflow] = hoisted.runWorkflow.mock.calls[0] as [
      { nodes: Array<{ type: string }>; id: string },
    ];
    expect(workflow.nodes.some((node) => node.type === "video")).toBe(true);
    expect(workflow.nodes.some((node) => node.type === "assemble")).toBe(true);
    // Saved before it runs: a production started here is visible, resumable
    // and editable on the canvas like any other.
    expect(window.localStorage.getItem("os-june:studio-workflows")).toContain(workflow.id);
  });

  it("does not claim a film exists when the run came back without one", async () => {
    // A run that failed also returns. Telling somebody their film is ready
    // when a shot failed is the worst thing this screen can do.
    hoisted.runWorkflow.mockImplementation(async (_workflow, options) => {
      options.onRunRecorded?.("run-9");
      return new Map();
    });
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} onOpenProduction={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Make it" }));

    await waitFor(() => expect(hoisted.runWorkflow).toHaveBeenCalled());
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
    // Back where you can try again, rather than on a page claiming success.
    expect(await screen.findByRole("button", { name: "Make it" })).toBeInTheDocument();
  });

  it("plays the film it made, and hands it to where a cut gets finished", async () => {
    const onOpenProduction = vi.fn();
    hoisted.runWorkflow.mockImplementation(async (workflow, options) => {
      options.onRunRecorded?.("run-9");
      const assemble = workflow.nodes.find((node: { type: string }) => node.type === "assemble");
      options.onUpdate?.({
        nodeId: assemble.id,
        status: "done",
        output: { kind: "video", artifactId: "film.mp4", src: "asset:///film.mp4" },
      });
      return new Map();
    });
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} onOpenProduction={onOpenProduction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Make it" }));

    expect(await screen.findByText(/Neon alley is ready/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish it" }));
    expect(onOpenProduction).toHaveBeenCalledWith("run-9");
  });

  it("says why a reading cannot happen rather than failing silently", async () => {
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return null;
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
    render(<FilmStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    expect(await screen.findByText(/not enough here/)).toBeInTheDocument();
  });
});

describe("the spend ceiling", () => {
  it("is the balance, because a fixed default is wrong in both directions", () => {
    // Above the balance, the compile builds a film the run cannot pay for and
    // fails half way having spent the first half. Below it, it refuses a film
    // the user could easily afford.
    expect(ceilingFor(511.7)).toBe(511);
    expect(ceilingFor(12)).toBe(12);
    expect(ceilingFor(0)).toBe(0);
    expect(ceilingFor(-4)).toBe(0);
  });

  it("falls back rather than blocking a film on a number nobody asked about", () => {
    expect(ceilingFor(undefined)).toBe(200);
    expect(ceilingFor(Number.NaN)).toBe(200);
  });

  it("follows the balance until the user overrules it", async () => {
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "carpe_diem_get_credits") return { availableCredits: 37, escrowCredits: 0 };
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Options" }));

    const ceiling = (await screen.findByLabelText("Spend ceiling")) as HTMLInputElement;
    await waitFor(() => expect(ceiling.value).toBe("37"));
    expect(screen.getByText(/You have 37/)).toBeInTheDocument();
  });
});

describe("saying when a film is close to the edge", () => {
  it("warns above four fifths, because the figure is a minimum", () => {
    // Metered renders publish no price and count zero, so a film estimated at
    // most of the balance can still run out part way.
    expect(isTight(85, 100)).toBe(true);
    expect(isTight(50, 100)).toBe(false);
    expect(isTight(80, 100)).toBe(false);
  });

  it("says nothing when the balance is unknown, rather than guessing", () => {
    expect(isTight(1000, undefined)).toBe(false);
    expect(isTight(1000, Number.NaN)).toBe(false);
  });
});

describe("reacting to what you see", () => {
  /** Run a film through to the point where its shots exist. */
  async function makeAFilm() {
    hoisted.runWorkflow.mockImplementation(async (workflow, options) => {
      options.onRunRecorded?.("run-9");
      const shot = workflow.nodes.find((node: { type: string }) => node.type === "video");
      const assemble = workflow.nodes.find((node: { type: string }) => node.type === "assemble");
      options.onUpdate?.({
        nodeId: shot.id,
        status: "done",
        output: { kind: "video", artifactId: "s1.mp4", src: "asset:///s1.mp4" },
      });
      options.onUpdate?.({
        nodeId: assemble.id,
        status: "done",
        output: { kind: "video", artifactId: "film.mp4", src: "asset:///film.mp4" },
      });
      return new Map();
    });
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_notes") return { items: [{ id: "n1", title: "Neon alley" }] };
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} onOpenProduction={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a note I wrote" }));
    fireEvent.click(await screen.findByRole("button", { name: /Neon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Make it" }));
    await screen.findByText(/is ready/);
  }

  it("redoes one shot, and only what was built from it", async () => {
    await makeAFilm();
    // The figure is on the button: a retake spends, and nothing in this app
    // spends without saying what it costs.
    fireEvent.click(screen.getAllByRole("button", { name: /Do it again \(\d+ cr\)/ })[0]);

    await waitFor(() => expect(hoisted.resumeRun).toHaveBeenCalledTimes(1));
    const [runId, options] = hoisted.resumeRun.mock.calls[0] as [string, { redoNodeIds: string[] }];
    expect(runId).toBe("run-9");
    // The shot, not the film: everything else replays from cache.
    expect(options.redoNodeIds).toHaveLength(1);
    expect(options.redoNodeIds[0]).toMatch(/shot/);
  });

  it("points the retake at the shot the judge named", async () => {
    hoisted.mediaJson.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              // Numbered: several shots share a scene name, and a remark
              // matched back by scene would land on whichever came first.
              '{"score": 4, "summary": "The middle sags.", "weakest": [{"label": "Shot 1, The alley", "why": "the coat reads blue"}]}',
          },
        },
      ],
    });
    await makeAFilm();
    fireEvent.click(screen.getByRole("button", { name: "Review the cut" }));

    expect(await screen.findByText(/4\/10 The middle sags\./)).toBeInTheDocument();
    // The reason is on the shot it is about, next to the button that fixes it.
    expect(screen.getByText("the coat reads blue")).toBeInTheDocument();
  });

  it("says it has nothing to say rather than failing", async () => {
    hoisted.mediaJson.mockRejectedValue(new Error("502"));
    await makeAFilm();
    fireEvent.click(screen.getByRole("button", { name: "Review the cut" }));
    expect(await screen.findByText(/nothing to say/)).toBeInTheDocument();
  });
});

describe("coming back to a film", () => {
  it("lists the films already started, because a reading is paid for", async () => {
    // Leaving this tab used to lose the way back to a reading, which meant
    // paying for it twice.
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_films")
        return [
          { noteId: "n1", title: "Neon alley", status: "ready", shotCount: 6, updatedAt: "" },
          { noteId: "n2", title: "Half read", status: "running", shotCount: 0, updatedAt: "" },
        ];
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return null;
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);

    expect(await screen.findByText("Films you started")).toBeInTheDocument();
    expect(screen.getByText("6 shots")).toBeInTheDocument();
    expect(screen.getByText("still reading")).toBeInTheDocument();
  });

  it("forgets a reading that went badly, without touching the note", async () => {
    // A script read badly should not sit in this list forever, and the note
    // itself is the user's own writing.
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_films")
        return [
          { noteId: "n1", title: "Neon alley", status: "failed", shotCount: 0, updatedAt: "" },
        ];
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return null;
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: /Forget the reading/ }));

    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith("forget_shot_list", { noteId: "n1" }),
    );
    // The note is not deleted, only its reading.
    expect(hoisted.invoke).not.toHaveBeenCalledWith("delete_note", expect.anything());
    await waitFor(() => expect(screen.queryByText("Neon alley")).not.toBeInTheDocument());
  });

  it("opens the film the shell asked for, once", async () => {
    // The note editor dispatches, the shell writes the key, this reads it and
    // clears it: coming back later must not silently reopen last week's film.
    window.localStorage.setItem("os-june:studio-film-note", "n1");
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "list_films") return [];
      if (command === "list_bible_entries") return [];
      if (command === "shot_list") return reading();
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    expect(await screen.findByText("Nera turns towards the sound")).toBeInTheDocument();
    expect(window.localStorage.getItem("os-june:studio-film-note")).toBeNull();
  });

  it("reopens one without paying to read it again", async () => {
    hoisted.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_films")
        return [
          { noteId: "n1", title: "Neon alley", status: "ready", shotCount: 1, updatedAt: "" },
        ];
      if (command === "list_bible_entries") return [];
      if (command === "shot_list")
        return (args as { noteId: string }).noteId === "n1" ? reading() : null;
      if (command === "shot_list_plan")
        return { noteId: "n1", scriptChars: 900, chunkCount: 1, modelCalls: 1, breakable: true };
      return null;
    });
    render(<FilmStudio catalog={catalog} />);
    // The row itself, not the button that forgets it.
    fireEvent.click(await screen.findByRole("button", { name: /Neon alley 1 shot/ }));

    // Straight back to its shots, with nothing re-read.
    expect(await screen.findByText("Nera turns towards the sound")).toBeInTheDocument();
    expect(hoisted.invoke).not.toHaveBeenCalledWith("build_shot_list", expect.anything());
  });
});
