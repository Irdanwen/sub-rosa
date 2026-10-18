// The templates the library offers: each one valid as shipped (only the
// pictures a person must pick are missing), sorted into a category, priced
// before it is used, and pinned to models the live catalog offers.

import { describe, expect, it } from "vitest";
import type { MediaCatalog } from "../lib/studio/types";
import { validateWorkflow } from "../lib/studio/workflow";
import { workflowMakes } from "../lib/studio/workflow/library";
import { expandLists } from "../lib/studio/workflow/lists";
import { resolveTemplateModels } from "../lib/studio/workflow/template-models";
import { templateEstimate, templatePriceLabel } from "../lib/studio/workflow/template-price";
import {
  TEMPLATE_CATEGORIES,
  templateCategory,
  templateWorkflows,
} from "../lib/studio/workflow/templates";

/** The covers shipped with the app, made once per template. */
const COVERS = import.meta.glob("../assets/workflow-covers/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const template = (id: string) => {
  const found = templateWorkflows().find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the shipped templates", () => {
  it("each have a unique id, a category and a cover", () => {
    const templates = templateWorkflows();
    expect(new Set(templates.map((entry) => entry.id)).size).toBe(templates.length);
    for (const entry of templates) {
      expect(entry.id).toMatch(/^template-[a-z0-9-]+$/);
      expect(TEMPLATE_CATEGORIES).toContain(templateCategory(entry.id));
      expect([entry.id, Boolean(COVERS[`../assets/workflow-covers/${entry.id}.webp`])]).toEqual([
        entry.id,
        true,
      ]);
    }
  });

  it("make every app a form over steps the template has", () => {
    for (const entry of templateWorkflows().filter((workflow) => workflow.app)) {
      const app = entry.app as NonNullable<typeof entry.app>;
      const ids = new Set(entry.nodes.map((node) => node.id));
      expect([entry.id, app.fields.length > 0, app.outputs.length > 0]).toEqual([
        entry.id,
        true,
        true,
      ]);
      for (const field of app.fields)
        expect([entry.id, ids.has(field.nodeId)]).toEqual([entry.id, true]);
      for (const output of app.outputs)
        expect([entry.id, ids.has(output)]).toEqual([entry.id, true]);
      expect((app.intro ?? "").trim()).not.toBe("");
    }
  });

  it("say what one run makes, every item of a list and every kind of picture", () => {
    expect(workflowMakes(template("template-reformat-for-every-format"))).toBe("3 images");
    expect(workflowMakes(template("template-covers-from-list"))).toBe("3 images");
    expect(workflowMakes(template("template-character-sheet"))).toBe("1 image");
    expect(workflowMakes(template("template-story-in-three-shots"))).toBe("3 videos");
  });

  it("run a clip from a given first picture to a given last one", () => {
    for (const id of ["template-exploded-view", "template-animated-logo"]) {
      const entry = template(id);
      const clip = entry.nodes.find((node) => node.type === "video");
      const into = (port: string) =>
        entry.edges.filter((wire) => wire.target === clip?.id && wire.targetPort === port);
      expect([id, into("openingFrame").length, into("endFrame").length]).toEqual([id, 1, 1]);
    }
  });

  it("keep the person or the product first, the picture an edit keeps", () => {
    for (const [id, first] of [
      ["template-product-in-hand", "person"],
      ["template-ad-in-the-style-of", "product"],
      ["template-product-placement", "product"],
    ] as const) {
      const entry = template(id);
      const edit = entry.nodes.find((node) => node.type === "imageEdit");
      const images = entry.edges.filter(
        (wire) => wire.target === edit?.id && wire.targetPort === "images",
      );
      expect([id, images[0]?.source]).toEqual([id, first]);
    }
  });

  it("gather every item of a list where one step takes them all", () => {
    const into = (id: string, base: string, port: string) => {
      const expanded = expandLists(template(id));
      return expanded.edges.filter(
        (wire) => wire.target.split("#")[0] === base && wire.targetPort === port,
      ).length;
    };
    // The gate chooses among the four takes; the film is steered by the six panels.
    expect(into("template-pick-the-best-of-four", "pick", "in")).toBe(4);
    expect(into("template-storyboard-to-video", "film", "references")).toBe(6);
  });

  it("give each line of a dialogue to its speaker, in order", () => {
    const entry = template("template-two-voice-dialogue");
    const voices = entry.edges
      .filter((wire) => wire.target === "mix" && wire.targetPort === "dialogue")
      .map((wire) => entry.nodes.find((node) => node.id === wire.source)?.params.voice);
    expect(voices).toEqual(["af_heart", "am_michael", "af_heart", "am_michael"]);
  });

  it("sing the lyrics the story was turned into", () => {
    const entry = template("template-song-from-a-story");
    const song = entry.nodes.find((node) => node.id === "song");
    expect(song?.params.fedParams).toEqual(["lyrics"]);
    expect(
      entry.edges.some((wire) => wire.target === "song" && wire.targetPort === "param:lyrics"),
    ).toBe(true);
  });

  it("hand a clip to change, and a line to say, to the steps that take them", () => {
    const port = (id: string, source: string) =>
      template(id).edges.find((wire) => wire.source === source)?.targetPort;
    expect(port("template-talking-photo", "voice")).toBe("speech");
    expect(port("template-restyle-a-clip", "clip")).toBe("sourceClip");
    expect(port("template-recast-a-clip", "clip")).toBe("sourceClip");
    expect(port("template-recast-a-clip", "character")).toBe("openingFrame");
  });

  it("chain each camera move from where the last one ended", () => {
    const entry = template("template-editorial-to-motion");
    const frame = (clip: string, port: string) =>
      entry.edges.find((wire) => wire.target === clip && wire.targetPort === port)?.source;
    expect(frame("move-2", "openingFrame")).toBe(frame("move-1", "endFrame"));
    expect(frame("move-3", "openingFrame")).toBe(frame("move-2", "endFrame"));
  });

  it("validate as shipped, but for the pictures a person picks", () => {
    for (const entry of templateWorkflows()) {
      const issues = validateWorkflow(expandLists(entry)).errors.filter(
        (issue) => entry.nodes.find((node) => node.id === issue.nodeId)?.type !== "asset",
      );
      expect([entry.name, issues]).toEqual([entry.name, []]);
    }
  });
});

describe("a template in today's catalog", () => {
  const catalog: MediaCatalog = {
    backend: "carpe-diem",
    models: [
      { id: "qwen3-next-80b", mediaType: "text", name: "Qwen3 Next", offline: false },
      // The template's image model is gone; two others are offered.
      {
        id: "flux-2-pro",
        mediaType: "image",
        name: "Flux 2 Pro",
        offline: false,
        costCredits: 1.3,
      },
      {
        id: "z-image-turbo",
        mediaType: "image",
        name: "Z Image",
        offline: false,
        costCredits: 0.4,
      },
      // The text-to-video model is gone; one of its family remains, and an
      // image-to-video model that must not stand in for it.
      {
        id: "kling-v3-pro-text-to-video",
        mediaType: "video",
        name: "Kling V3 Pro",
        offline: false,
        costCredits: 30,
      },
      {
        id: "wan-2-7-image-to-video",
        mediaType: "imageToVideo",
        name: "Wan 2.7",
        offline: false,
        costCredits: 20,
      },
    ],
  };

  it("keeps a model still offered and moves a gone one to the cheapest of its kind", () => {
    const { workflow, missing } = resolveTemplateModels(template("template-album-cover"), catalog);
    expect(missing).toEqual([]);
    const model = (id: string) => workflow.nodes.find((node) => node.id === id)?.params.model;
    expect(model("direction")).toBe("qwen3-next-80b");
    expect(model("cover")).toBe("z-image-turbo");
  });

  it("moves a video to its own family and direction, never across directions", () => {
    const { workflow } = resolveTemplateModels(template("template-short-video-ad"), catalog);
    const clip = workflow.nodes.find((node) => node.id === "clip");
    expect(clip?.params.model).toBe("kling-v3-pro-text-to-video");
    expect(clip?.params.modelDirection).toBe("text");
  });

  it("never stands in a model that drops a wire the template needs", () => {
    // No motion control here, only a plain text-to-video of the same
    // family: it would close the clip the character is moved by.
    const recast = resolveTemplateModels(template("template-recast-a-clip"), catalog);
    expect(recast.missing).toEqual(["Recast"]);
    // A clip to restyle moves to another model that changes a clip.
    const restyle = resolveTemplateModels(template("template-restyle-a-clip"), {
      ...catalog,
      models: [
        ...catalog.models,
        {
          id: "wan-2-7-video-to-video",
          mediaType: "video",
          name: "Wan 2.7 V2V",
          offline: false,
        },
      ],
    });
    expect(restyle.missing).toEqual([]);
    expect(restyle.workflow.nodes.find((node) => node.id === "restyled")?.params.model).toBe(
      "wan-2-7-video-to-video",
    );
  });

  it("names the steps no offered model can make", () => {
    const { missing } = resolveTemplateModels(template("template-music-from-mood"), catalog);
    expect(missing).toEqual(["Track"]);
  });

  it("judges nothing before the catalog arrives", () => {
    const shipped = template("template-album-cover");
    expect(resolveTemplateModels(shipped, { backend: "carpe-diem", models: [] })).toEqual({
      workflow: shipped,
      missing: [],
    });
    expect(templateEstimate(shipped, { backend: "carpe-diem", models: [] })).toBeUndefined();
  });

  it("is priced like a run, its lists at their most", () => {
    const covers = resolveTemplateModels(template("template-covers-from-list"), catalog).workflow;
    const estimate = templateEstimate(covers, catalog);
    // Three titles, three pictures.
    expect(estimate?.credits).toBeCloseTo(1.2);
    expect(estimate && templatePriceLabel(estimate)).toBe("~1.2 credits");
  });
});
