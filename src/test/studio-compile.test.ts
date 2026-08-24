import { describe, expect, it } from "vitest";
import type { BibleEntry } from "../lib/studio/bible";
import {
  compileShotList,
  DIALOGUE_LEAD_IN_SECONDS,
  MAX_COMPILED_SHOTS,
  nearestOption,
  planShots,
  routeModels,
  type Shot,
} from "../lib/studio/workflow/compile";
import { validateWorkflow } from "../lib/studio/workflow/validator";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

function model(id: string, mediaType: string, over: Partial<MediaModel> = {}): MediaModel {
  return {
    id,
    name: id,
    mediaType: mediaType as MediaModel["mediaType"],
    offline: false,
    costCredits: 10,
    constraints: { durations: ["3s", "5s", "8s"], aspect_ratios: ["16:9", "9:16"] },
    ...over,
  } as MediaModel;
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("kling-v3-standard-text-to-video", "video"),
    model("kling-v3-standard-image-to-video", "imageToVideo"),
    model("seedance-2-0-reference-to-video", "referenceToVideo"),
    model("tts-kokoro", "tts", { constraints: undefined, voices: ["ash"] }),
    model("ace-step", "music", { constraints: undefined }),
  ],
};

function shot(over: Partial<Shot> = {}): Shot {
  return {
    scene: "The alley",
    action: "Nera turns towards the sound",
    camera: "Slow push in",
    characters: [],
    location: "",
    dialogue: "",
    speaker: "",
    motion: "medium",
    continues: false,
    ...over,
  };
}

const nera: BibleEntry = {
  id: "e1",
  kind: "character",
  name: "Nera",
  traits: "green coat",
  note: "",
  refs: [
    { id: "r1", entryId: "e1", artifactId: "nera.png", role: "portrait", label: "", ordinal: 0 },
    { id: "r2", entryId: "e1", artifactId: "nera.mp3", role: "voice", label: "ash", ordinal: 1 },
  ],
  createdAt: "",
  updatedAt: "",
};

describe("routing", () => {
  it("recognises families by what they take, never by their name", () => {
    // Ids change under us: the catalogue renamed every seedance variant
    // between two releases, and a hardcoded id is a film that stops rendering.
    const routing = routeModels(catalog);
    expect(routing.text?.mediaType).toBe("video");
    expect(routing.fromImage?.mediaType).toBe("imageToVideo");
    expect(routing.reference?.mediaType).toBe("referenceToVideo");
  });

  it("falls back to text-to-video when the account has nothing else", () => {
    const thin: MediaCatalog = { backend: "carpe-diem", models: [model("only", "video")] };
    expect(routeModels(thin).fromImage?.id).toBe("only");
    expect(routeModels(thin).reference).toBeUndefined();
  });
});

describe("what the app decides, and the model never does", () => {
  it("picks a duration from how much moves, clamped to what the model publishes", () => {
    const { planned } = planShots(
      [shot({ motion: "low" }), shot({ motion: "high" })],
      [],
      catalog,
      "16:9",
    );
    // A face listening does not need eight seconds; a chase does not read in
    // three. Both land on a value the model actually offers.
    expect(planned[0].duration).toBe("3s");
    expect(planned[1].duration).toBe("8s");
  });

  it("falls back to a ratio the model offers, and says so", () => {
    const { planned, notes } = planShots([shot()], [], catalog, "21:9");
    expect(planned[0].aspectRatio).toBe("16:9");
    expect(notes[0]).toContain("does not offer 21:9");
  });

  it("sends a shot with a known face to the reference family", () => {
    const { planned } = planShots([shot({ characters: ["Nera"] })], [nera], catalog, "16:9");
    expect(planned[0].model.mediaType).toBe("referenceToVideo");
    expect(planned[0].references).toEqual(["nera.png"]);
    // The traits ride on the prompt, because nothing carries between renders.
    expect(planned[0].prompt).toContain("Nera: green coat.");
  });

  it("prefers continuing from a frame over holding a face", () => {
    // A shot that carries straight on has a frame to start from, and starting
    // from it is what makes the seam invisible.
    const { planned } = planShots(
      [shot({ characters: ["Nera"] }), shot({ characters: ["Nera"], continues: true })],
      [nera],
      catalog,
      "16:9",
    );
    expect(planned[1].model.mediaType).toBe("imageToVideo");
    expect(planned[1].references).toEqual([]);
  });

  it("does not chain the very first shot, whatever it claims", () => {
    const { planned } = planShots([shot({ continues: true })], [], catalog, "16:9");
    expect(planned[0].chained).toBe(false);
  });
});

describe("nearestOption", () => {
  it("takes the closest published value rather than refusing", () => {
    expect(nearestOption(["3s", "5s", "8s"], 6)).toBe("5s");
    expect(nearestOption(["3s", "5s", "8s"], 100)).toBe("8s");
    expect(nearestOption([], 5)).toBe("");
    expect(nearestOption(undefined, 5)).toBe("");
    // Nothing numeric to compare: the first is as good an answer as any.
    expect(nearestOption(["auto"], 5)).toBe("auto");
  });
});

describe("compiling", () => {
  it("builds a graph the existing validator accepts", () => {
    // The whole bet of this file: no second runtime. If the canvas will not
    // run it, it is a bug here, not a run to attempt.
    const result = compileShotList({
      name: "Neon alley",
      shots: [shot({ characters: ["Nera"] }), shot({ continues: true })],
      bible: [nera],
      catalog,
      withScore: true,
    });
    expect(result.refusal).toBeUndefined();
    const workflow = result.workflow;
    expect(workflow).toBeDefined();
    if (!workflow) return;
    const validation = validateWorkflow(workflow);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("chains the second shot through a handoff frame", () => {
    const { workflow } = compileShotList({
      name: "F",
      shots: [shot(), shot({ continues: true })],
      catalog,
    });
    const frame = workflow?.nodes.find((entry) => entry.type === "lastFrame");
    expect(frame?.params.position).toBe("handoff");
    expect(workflow?.edges).toContainEqual(
      expect.objectContaining({ source: "shot-1", target: frame?.id, targetPort: "video" }),
    );
    expect(workflow?.edges).toContainEqual(
      expect.objectContaining({ source: frame?.id, target: "shot-2", targetPort: "openingFrame" }),
    );
  });

  it("declares one asset per reference however many shots use it", () => {
    const { workflow } = compileShotList({
      name: "F",
      shots: [shot({ characters: ["Nera"] }), shot({ characters: ["Nera"] })],
      bible: [nera],
      catalog,
    });
    expect(workflow?.nodes.filter((entry) => entry.type === "asset").length).toBe(1);
  });

  it("renders a spoken line in the speaker's own voice, and lets it reach the film", () => {
    const { workflow } = compileShotList({
      name: "F",
      shots: [shot({ characters: ["Nera"], dialogue: "Get in.", speaker: "Nera" })],
      bible: [nera],
      catalog,
    });
    const line = workflow?.nodes.find((entry) => entry.type === "tts");
    expect(line?.params.text).toBe("Get in.");
    // The voice donor's label is the voice that was auditioned and kept.
    expect(line?.params.voice).toBe("ash");
    // Without this edge the line renders, costs money, and is never heard.
    expect(workflow?.edges).toContainEqual(
      expect.objectContaining({ source: line?.id, target: "assemble", targetPort: "dialogue" }),
    );
  });

  it("places each line on the shot it belongs to, just inside the cut", () => {
    // Only the compiler knows which shot a line belongs to: the cut cannot
    // work it out from a graph. A line landing on the cut frame reads as a
    // mistake, so it starts a beat of picture later.
    const { workflow } = compileShotList({
      name: "F",
      shots: [
        shot({ motion: "low", dialogue: "First." }),
        shot({ motion: "high", dialogue: "Second." }),
      ],
      catalog,
    });
    const lines = workflow?.nodes.filter((entry) => entry.type === "tts") ?? [];
    // Three seconds for the low-motion shot, then the second line.
    expect(lines[0]?.params.startAt).toBe(`${DIALOGUE_LEAD_IN_SECONDS.toFixed(2)}`);
    expect(lines[1]?.params.startAt).toBe(`${(3 + DIALOGUE_LEAD_IN_SECONDS).toFixed(2)}`);
  });

  it("lays the score on the music lane, not on the legacy single track", () => {
    const { workflow } = compileShotList({
      name: "F",
      shots: [shot()],
      catalog,
      withScore: true,
    });
    const score = workflow?.nodes.find((entry) => entry.type === "music");
    expect(workflow?.edges).toContainEqual(
      expect.objectContaining({ source: score?.id, target: "assemble", targetPort: "music" }),
    );
  });

  it("refuses over the envelope instead of building something to confirm", () => {
    // The handshake is for deciding. It is not for catching a graph that was
    // never affordable in the first place.
    const result = compileShotList({
      name: "F",
      shots: [shot(), shot(), shot(), shot()],
      catalog,
      envelopeCredits: 15,
    });
    expect(result.workflow).toBeUndefined();
    expect(result.refusal).toContain("past the 15.00 agreed");
    expect(result.refusal).toMatch(/About \d+ shots? fits/);
  });

  it("builds when the estimate fits", () => {
    const result = compileShotList({
      name: "F",
      shots: [shot()],
      catalog,
      envelopeCredits: 1000,
    });
    expect(result.workflow).toBeDefined();
    expect(result.estimateCredits).toBeGreaterThan(0);
  });

  it("refuses a script too long to build blind", () => {
    const result = compileShotList({
      name: "F",
      shots: Array.from({ length: MAX_COMPILED_SHOTS + 1 }, () => shot()),
      catalog,
    });
    expect(result.refusal).toContain("Split the script");
  });

  it("refuses when the account cannot render video at all", () => {
    const result = compileShotList({
      name: "F",
      shots: [shot()],
      catalog: { backend: "carpe-diem", models: [] },
    });
    expect(result.refusal).toContain("no video model");
  });

  it("says the film has no score rather than pretending it has one", () => {
    const result = compileShotList({
      name: "F",
      shots: [shot()],
      catalog: { backend: "carpe-diem", models: [model("v", "video")] },
      withScore: true,
    });
    expect(result.notes.some((note) => note.includes("no score"))).toBe(true);
  });

  it("puts a gate in front of the cut when asked", () => {
    const { workflow } = compileShotList({
      name: "F",
      shots: [shot(), shot()],
      catalog,
      gateBeforeAssemble: true,
    });
    const gate = workflow?.nodes.find((entry) => entry.type === "gate");
    expect(gate).toBeDefined();
    // Everything reaches the cut through the gate, not around it.
    const toAssemble = workflow?.edges.filter((entry) => entry.target === "assemble") ?? [];
    expect(toAssemble.map((entry) => entry.source)).toEqual([gate?.id]);
  });
});
