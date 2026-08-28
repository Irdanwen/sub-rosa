import { describe, expect, it } from "vitest";
import type { BibleEntry } from "../lib/studio/bible";
import {
  compileShotList,
  DIALOGUE_LEAD_IN_SECONDS,
  familyOf,
  familyStem,
  MAX_COMPILED_SHOTS,
  nearestOption,
  pickMusicModel,
  pickTtsModel,
  planShots,
  retargetShotModel,
  routeModels,
  videoFamilies,
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
  it("keeps a film on one family across all three directions", () => {
    // The moment a chained shot comes from a different engine than the one
    // before it, the grade and the motion change mid-cut and it stops reading
    // as one film. The directions are matched by stem, not by a table.
    expect(familyStem("seedance-2-0-fast-reference-to-video-basic")).toBe(
      familyStem("seedance-2-0-fast-text-to-video-basic"),
    );
    expect(familyStem("kling-v3-standard-text-to-video")).toBe("kling-v3-standard");
    expect(familyStem("flux-3-first-last-frame-to-video")).toBe("flux-3");

    const wide: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("cheap-text-to-video", "video", { costCredits: 1 }),
        model("kling-v3-text-to-video", "video", { costCredits: 40 }),
        model("kling-v3-image-to-video", "imageToVideo", { costCredits: 40 }),
        model("other-image-to-video", "imageToVideo", { costCredits: 2 }),
      ],
    };
    const routed = routeModels(wide, "kling-v3-text-to-video");
    expect(routed.text?.id).toBe("kling-v3-text-to-video");
    expect(routed.fromImage?.id).toBe("kling-v3-image-to-video");
  });

  it("stays in the family even when it has no image-to-video arm", () => {
    // Losing the opening frame is a smaller break than changing engine.
    const wide: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("lonely-text-to-video", "video", { costCredits: 40 }),
        model("someone-else-image-to-video", "imageToVideo", { costCredits: 1 }),
      ],
    };
    expect(routeModels(wide, "lonely-text-to-video").fromImage?.id).toBe("lonely-text-to-video");
  });

  it("picks the cheapest when nobody chose", () => {
    // Sorting by name was picking whichever family happened to sort first,
    // which on a real catalogue is a premium model nobody asked for.
    const wide: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("aaa-premium-text-to-video", "video", { costCredits: 90 }),
        model("zzz-cheap-text-to-video", "video", { costCredits: 3 }),
      ],
    };
    expect(routeModels(wide).text?.id).toBe("zzz-cheap-text-to-video");
  });

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

describe("choosing the engines", () => {
  it("folds the catalogue into families, priced, saying which hold a face", () => {
    // A picker of a hundred model ids is a list, not a choice. Families are
    // what the user is actually choosing between, and the two facts that
    // change the film are what a shot costs and whether a face survives it.
    const wide: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("kling-v3-standard-text-to-video", "video", { costCredits: 40 }),
        model("kling-v3-standard-image-to-video", "imageToVideo", { costCredits: 40 }),
        model("seedance-2-0-text-to-video", "video", { costCredits: 12 }),
        model("seedance-2-0-reference-to-video", "referenceToVideo", { costCredits: 15 }),
      ],
    };
    const families = videoFamilies(wide);
    expect(families.map((entry) => entry.stem)).toEqual(["seedance-2-0", "kling-v3-standard"]);
    expect(families[0].holdsFaces).toBe(true);
    expect(families[1].holdsFaces).toBe(false);
    expect(families[1].continuesShots).toBe(true);
    // Cheapest first, and the price shown is the plain shot's, not the
    // reference arm's: it is what most of the film is made of.
    expect(families[0].costCredits).toBe(12);
    expect(familyOf(wide, "kling-v3-standard-image-to-video")?.stem).toBe("kling-v3-standard");
  });

  it("warns that a family which cannot hold a face will break the look", () => {
    // The bible is not lost - the router sends those shots to a family that
    // can hold the face. What is lost is the single look, and that is worth
    // saying before the user pays for it.
    const result = compileShotList({
      shots: [shot({ characters: ["Nera"], location: "" })],
      bible: [nera],
      catalog,
      name: "Look",
      videoModelId: "kling-v3-standard-text-to-video",
    });
    expect(result.warnings.join(" ")).toMatch(/cannot carry a face/);
    expect(result.warnings.join(" ")).toMatch(/change look/);
    // Still compiled: a warning is a cost, not a refusal.
    expect(result.workflow).toBeDefined();
  });

  it("says nothing when the chosen family holds faces itself", () => {
    const result = compileShotList({
      shots: [shot({ characters: ["Nera"] })],
      bible: [nera],
      catalog,
      name: "Look",
      videoModelId: "seedance-2-0-reference-to-video",
    });
    expect(result.warnings).toEqual([]);
  });

  it("picks the voice with the most voices, not the first alphabetically", () => {
    // Nothing in this catalogue publishes a price for speech, so "cheapest"
    // sorted nothing and quietly meant "first by name". The voice list is the
    // only signal there is.
    const voices: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("kling-v3-standard-text-to-video", "video"),
        model("aaa-tts", "tts", { constraints: undefined, voices: ["one"] }),
        model("zzz-tts", "tts", {
          constraints: undefined,
          voices: ["one", "two", "three"],
        }),
      ],
    };
    expect(pickTtsModel(voices)?.id).toBe("zzz-tts");
    // An explicit choice always wins over the default.
    expect(pickTtsModel(voices, "aaa-tts")?.id).toBe("aaa-tts");
    // An id this account cannot run falls back rather than failing.
    expect(pickTtsModel(voices, "gone")?.id).toBe("zzz-tts");
  });

  it("scores with the model that can write the longest piece", () => {
    // A film wants one piece over the whole cut. A model capped at thirty
    // seconds forces a loop, and a viewer hears a loop.
    const scores: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model("kling-v3-standard-text-to-video", "video"),
        model("aaa-music", "music", { constraints: { durations: ["30s"] } }),
        model("zzz-music", "music", { constraints: { durations: ["30s", "180s"] } }),
      ],
    };
    expect(pickMusicModel(scores)?.id).toBe("zzz-music");
    expect(pickMusicModel(scores, "aaa-music")?.id).toBe("aaa-music");
  });

  it("speaks the dialogue with the chosen voice model", () => {
    const voices: MediaCatalog = {
      backend: "carpe-diem",
      models: [...catalog.models, model("other-tts", "tts", { constraints: undefined })],
    };
    const result = compileShotList({
      shots: [shot({ dialogue: "It is time.", speaker: "Nera" })],
      bible: [nera],
      catalog: voices,
      name: "Voice",
      ttsModelId: "other-tts",
    });
    const spoken = result.workflow?.nodes.find((node) => node.type === "tts");
    expect(spoken?.params?.model).toBe("other-tts");
  });
});

describe("retaking a shot on another engine", () => {
  it("keeps the arm the shot needs and snaps the duration to the new engine", () => {
    // The user picks a family; which of its three arms the shot lands on is
    // not their problem. A shot that was holding a face still has to.
    const wide: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        ...catalog.models,
        model("wan-2-text-to-video", "video", {
          constraints: { durations: ["4s"], aspect_ratios: ["16:9"] },
        }),
        model("wan-2-reference-to-video", "referenceToVideo", {
          constraints: { durations: ["4s"], aspect_ratios: ["16:9"] },
        }),
      ],
    };
    const built = compileShotList({
      shots: [shot({ characters: ["Nera"] })],
      bible: [nera],
      catalog: wide,
      name: "Retake",
    });
    const workflow = built.workflow;
    expect(workflow).toBeDefined();
    if (!workflow) return;
    const video = workflow.nodes.find((node) => node.type === "video");
    expect(video).toBeDefined();
    if (!video) return;

    const patched = retargetShotModel(workflow, video.id, wide, "wan-2-text-to-video");
    const moved = patched?.nodes.find((node) => node.id === video.id);
    // It had references, so it lands on the new family's reference arm.
    expect(moved?.params?.model).toBe("wan-2-reference-to-video");
    // 5s is not on offer over there, so it is snapped rather than sent.
    expect(moved?.params?.duration).toBe("4s");
    // Nothing else in the film moved.
    expect(patched?.nodes.length).toBe(workflow.nodes.length);
  });

  it("refuses a node that is not a shot", () => {
    const built = compileShotList({
      shots: [shot()],
      catalog,
      name: "Retake",
    });
    const workflow = built.workflow;
    if (!workflow) throw new Error("no workflow");
    const assemble = workflow.nodes.find((node) => node.type !== "video");
    expect(assemble).toBeDefined();
    if (!assemble) return;
    expect(
      retargetShotModel(workflow, assemble.id, catalog, "kling-v3-standard-text-to-video"),
    ).toBeUndefined();
  });
});
