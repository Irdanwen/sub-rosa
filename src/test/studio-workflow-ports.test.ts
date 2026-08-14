// A node's input ports follow the model chosen in it (ADR-0022, extended to
// the canvas): a port whose capacity is zero is *closed* — not drawn, not
// connectable, and an error when an edge is left on it.
//
// The cases worth pinning are the ones that cost money when they are wrong: a
// reference photo wired onto an image-to-video model is dropped at submit
// after the prompt was written around it, and a frame wired onto a
// reference-to-video model renders a clip that ignored it and still bills.

import { describe, expect, it } from "vitest";
import { videoDirection, videoDirectionFromId } from "../lib/studio/catalog";
import type { MediaModel } from "../lib/studio/types";
import {
  effectiveParamValue,
  modelParamPatch,
  paramApplies,
  paramOptions,
} from "../lib/studio/workflow/models";
import { strandedEdges } from "../lib/studio/workflow/ordering";
import { templateWorkflows } from "../lib/studio/workflow/templates";
import {
  closedInputPort,
  defaultParams,
  nodeSchema,
  openInputPorts,
  resolveInputPort,
  type ParamSchema,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";

function node(
  id: string,
  type: WorkflowNodeType,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  };
}

function workflow(nodes: WorkflowNode[], edges: Workflow["edges"]): Workflow {
  return { id: "wf", name: "Test", nodes, edges, createdAt: 0, updatedAt: 0 };
}

const portIds = (params: Record<string, unknown>) =>
  openInputPorts(nodeSchema("video"), { ...defaultParams("video"), ...params }).map(
    (port) => port.id,
  );

describe("openInputPorts on a video node", () => {
  it("carries every port while no model is chosen", () => {
    expect(portIds({})).toEqual([
      "prompt",
      "openingFrame",
      "endFrame",
      "references",
      "referenceClips",
    ]);
  });

  it("closes the references on an image-to-video model", () => {
    expect(portIds({ model: "kling-2.5-turbo-pro-image-to-video" })).toEqual([
      "prompt",
      "openingFrame",
      "endFrame",
    ]);
  });

  it("closes the frames on a reference-to-video model", () => {
    // The full tier keeps its clips; the public one publishes no video input.
    expect(portIds({ model: "seedance-2-0-reference-to-video" })).toEqual([
      "prompt",
      "references",
      "referenceClips",
    ]);
    expect(portIds({ model: "seedance-2-5-reference-to-video-basic" })).toEqual([
      "prompt",
      "references",
    ]);
  });

  it("leaves a text-to-video model with its prompt alone", () => {
    expect(portIds({ model: "kling-2.5-turbo-pro-text-to-video" })).toEqual(["prompt"]);
  });

  it("keeps every port open for an id that names no direction", () => {
    // Nine of the operator's video models carry no direction in their id, five
    // of them image-to-video. Guessing "text to video" from silence would take
    // the frames away from `pixverse-c1-transition`, whose point is the frames.
    expect(portIds({ model: "runway-gen4-turbo" })).toContain("openingFrame");
    expect(portIds({ model: "pixverse-c1-transition" })).toContain("endFrame");
  });

  it("believes the direction the picker recorded over the silent id", () => {
    // What the catalog said when the model was picked, carried in the params
    // so the validator and the engine reach the same answer without one.
    expect(portIds({ model: "runway-gen4-turbo", modelDirection: "image" })).toEqual([
      "prompt",
      "openingFrame",
      "endFrame",
    ]);
    expect(portIds({ model: "runway-gen4-5-text", modelDirection: "text" })).toEqual(["prompt"]);
  });
});

describe("videoDirection", () => {
  const model = (id: string, mediaType: MediaModel["mediaType"], name = ""): MediaModel => ({
    id,
    name: name || id,
    mediaType,
    offline: false,
  });

  it("reads the catalog type ahead of the id", () => {
    expect(videoDirection(model("runway-gen4-turbo", "imageToVideo"))).toBe("image");
    expect(videoDirection(model("flux-3-first-last-frame-to-video", "imageToVideo"))).toBe("image");
    expect(videoDirection(model("kling-v3-pro-motion-control", "video"))).toBe("text");
  });

  it("still reads the id for the reference variants the operator types imageToVideo", () => {
    expect(videoDirection(model("grok-imagine-reference-to-video-private", "imageToVideo"))).toBe(
      "reference",
    );
  });

  it("tells an upscaler and a restyle apart from a text render", () => {
    expect(videoDirection(model("topaz-video-upscale", "video"))).toBe("video");
  });

  it("returns undefined from an id that vouches for no direction", () => {
    expect(videoDirectionFromId("runway-gen4-turbo")).toBeUndefined();
    expect(videoDirectionFromId("seedance-2-0-reference-to-video")).toBe("reference");
    expect(videoDirectionFromId("kling-2.5-turbo-pro-image-to-video")).toBe("image");
  });
});

describe("modelParamPatch", () => {
  const videoParam: ParamSchema = {
    name: "model",
    type: "model",
    label: "Model",
    mediaType: "video",
    mediaTypes: ["video", "imageToVideo", "referenceToVideo"],
  };
  const imageParam: ParamSchema = {
    name: "model",
    type: "model",
    label: "Model",
    mediaType: "image",
  };

  const videoSchema = nodeSchema("video");
  const imageSchema = nodeSchema("image");

  it("records the direction beside the id for a video model", () => {
    const patch = modelParamPatch(videoSchema, defaultParams("video"), videoParam, {
      id: "runway-gen4-turbo",
      name: "Runway Gen4 Turbo",
      mediaType: "imageToVideo",
      offline: false,
    });
    expect(patch.model).toBe("runway-gen4-turbo");
    expect(patch.modelDirection).toBe("image");
  });

  it("records nothing extra for a model that decides no ports", () => {
    expect(
      modelParamPatch(imageSchema, defaultParams("image"), imageParam, {
        id: "flux-dev",
        name: "Flux",
        mediaType: "image",
        offline: false,
      }),
    ).toEqual({ model: "flux-dev" });
  });

  it("clears the direction when the model is unset", () => {
    const patch = modelParamPatch(videoSchema, defaultParams("video"), videoParam, undefined);
    expect(patch.model).toBe("");
    expect(patch.modelDirection).toBeUndefined();
  });

  it("re-settles a duration the new model does not offer", () => {
    // seedance 2.0 reaches 15s; 2.5 goes to 30s but drops 1080p and 4k. A
    // resolution left on screen that the submit would silently replace is the
    // failure this closes.
    const before = { ...defaultParams("video"), duration: "12s", resolution: "4k" };
    const patch = modelParamPatch(videoSchema, before, videoParam, {
      id: "seedance-2-5-reference-to-video-basic",
      name: "Seedance 2.5 R2V",
      mediaType: "referenceToVideo",
      offline: false,
    });
    // 12s is still on offer and survives; 4k is not, so the value falls to the
    // model's first option - which is what the request builder would have sent
    // anyway, only now it is on screen before the spend.
    expect(patch.duration).toBe("12s");
    expect(patch.resolution).toBe("480p");
    expect(patch.aspectRatio).toBe("21:9");
  });
});

describe("paramOptions", () => {
  const catalog = { backend: "carpe-diem" as const, models: [] };
  const durationParam: ParamSchema = {
    name: "duration",
    type: "string",
    label: "Duration",
    modelOptions: "durations",
  };
  const resolutionParam: ParamSchema = {
    name: "resolution",
    type: "string",
    label: "Resolution",
    modelOptions: "resolutions",
  };

  it("offers what the model publishes, even for an id the catalog omits", () => {
    // The operator forwards models it does not list, and the probed table is
    // keyed by id, so an unlisted passthrough still has options.
    expect(paramOptions(durationParam, { model: "seedance-2-5-fast" }, catalog)).toContain("30s");
    expect(paramOptions(resolutionParam, { model: "seedance-2-5-fast" }, catalog)).toEqual([
      "480p",
      "720p",
    ]);
  });

  it("stays free text for a model nobody knows anything about", () => {
    // An unrecognised key is rejected as hard as a missing required one, so
    // inventing a menu here would be worse than leaving the field open.
    expect(paramOptions(durationParam, { model: "some-unknown-video-model" }, catalog)).toEqual([]);
    expect(paramOptions(durationParam, {}, catalog)).toEqual([]);
  });

  it("hands a plain enum param its own values", () => {
    expect(
      paramOptions(
        { name: "position", type: "enum", label: "Frame", enumValues: ["handoff", "end"] },
        {},
        catalog,
      ),
    ).toEqual(["handoff", "end"]);
  });
});

describe("paramApplies", () => {
  const ratioParam: ParamSchema = {
    name: "aspectRatio",
    type: "string",
    label: "Aspect ratio",
    modelOptions: "aspectRatios",
  };
  const durationParam: ParamSchema = {
    name: "duration",
    type: "string",
    label: "Duration",
    modelOptions: "durations",
  };
  const catalogWith = (model: MediaModel) => ({ backend: "carpe-diem" as const, models: [model] });

  it("hides a setting an image-to-video model does not have", () => {
    // Its validator answers "This model does not support aspect_ratio"; a free
    // text box for one could only fail the render.
    const catalog = catalogWith({
      id: "wan-2-7-image-to-video",
      name: "Wan 2.7",
      mediaType: "imageToVideo",
      offline: false,
    });
    expect(paramApplies(ratioParam, { model: "wan-2-7-image-to-video" }, catalog)).toBe(false);
    expect(paramApplies(durationParam, { model: "wan-2-7-image-to-video" }, catalog)).toBe(true);
  });

  it("hides a setting the catalog publishes as an empty list", () => {
    // An empty list is a statement; an absent one is only silence.
    const declared = catalogWith({
      id: "some-model",
      name: "Some model",
      mediaType: "video",
      offline: false,
      constraints: { resolutions: [] },
    });
    const silent = catalogWith({
      id: "some-model",
      name: "Some model",
      mediaType: "video",
      offline: false,
    });
    const resolution: ParamSchema = {
      name: "resolution",
      type: "string",
      label: "Resolution",
      modelOptions: "resolutions",
    };
    expect(paramApplies(resolution, { model: "some-model" }, declared)).toBe(false);
    expect(paramApplies(resolution, { model: "some-model" }, silent)).toBe(true);
  });

  it("keeps every setting while no model is chosen", () => {
    expect(paramApplies(ratioParam, {}, { backend: "carpe-diem", models: [] })).toBe(true);
  });
});

describe("effectiveParamValue", () => {
  it("shows what the request builder will send", () => {
    expect(effectiveParamValue(["4s", "5s"], "5s")).toBe("5s");
    // Mirrors `pick` in video-request: an off-list value becomes the first.
    expect(effectiveParamValue(["4s", "5s"], "9s")).toBe("4s");
    expect(effectiveParamValue(["4s", "5s"], "")).toBe("4s");
    // No list means nobody knows: the typed value stands.
    expect(effectiveParamValue([], "whatever")).toBe("whatever");
  });
});

describe("closed ports and the edges left on them", () => {
  const still = node("still", "asset", { assetKind: "image", artifactId: "a" });

  it("refuses an explicit edge onto a port the model closed, and says which", () => {
    const result = validateWorkflow(
      workflow(
        [still, node("clip", "video", { model: "seedance-2-0-reference-to-video", prompt: "p" })],
        [{ id: "e", source: "still", target: "clip", targetPort: "openingFrame" }],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('no "Opening frame" input');
  });

  it("refuses a reference photo on an image-to-video model", () => {
    // Silently dropped at submit before: `videoRequestBody` fills
    // `reference_image_urls` for the reference direction and no other.
    const result = validateWorkflow(
      workflow(
        [still, node("clip", "video", { model: "wan-2-7-image-to-video", prompt: "p" })],
        [{ id: "e", source: "still", target: "clip", targetPort: "references" }],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('no "References" input');
  });

  it("does not degrade an image into the prompt when the image ports are closed", () => {
    // Closed is not absent: a text port accepts anything, so falling through
    // to it would chain the photo as "[generated image]" and render something
    // plausible that ignored it.
    const target = node("clip", "video", { model: "kling-2.5-turbo-pro-text-to-video" });
    expect(resolveInputPort(target, {}, "image")).toBeUndefined();
    // A node type that never had an image port still degrades, as before.
    expect(resolveInputPort(node("llm", "chat"), {}, "image")?.id).toBe("prompt");
  });

  it("reports what a saved workflow has landing on a port its model closed", () => {
    const graph = workflow(
      [
        still,
        node("clip", "video", { model: "seedance-2-5-reference-to-video-basic", prompt: "p" }),
      ],
      [
        { id: "opening", source: "still", target: "clip", targetPort: "openingFrame" },
        { id: "reference", source: "still", target: "clip", targetPort: "references" },
      ],
    );
    const stranded = strandedEdges(graph);
    expect(stranded).toHaveLength(1);
    expect(stranded[0].edge.id).toBe("opening");
    expect(stranded[0].port.label).toBe("Opening frame");
    expect(stranded[0].sourceId).toBe("still");
  });

  it("leaves an edge naming a port the node type never had for the validator", () => {
    // Stale data, not a closed port: repairing it out of sight would hide the
    // bug that wrote it.
    const graph = workflow(
      [still, node("clip", "video", { model: "kling-2.5-turbo-pro-image-to-video", prompt: "p" })],
      [{ id: "e", source: "still", target: "clip", targetPort: "nonsense" }],
    );
    expect(strandedEdges(graph)).toEqual([]);
    expect(validateWorkflow(graph).ok).toBe(false);
  });

  it("ships no template whose own wiring a model closes", () => {
    // A template that lost a connection the moment it was opened would be a
    // broken starting point, and the notice explaining it would read as a bug.
    for (const template of templateWorkflows()) {
      expect([template.name, strandedEdges(template)]).toEqual([template.name, []]);
    }
  });

  it("names a closed port apart from an unknown one", () => {
    const schema = nodeSchema("video");
    const referenceParams = { model: "seedance-2-0-reference-to-video" };
    expect(closedInputPort(schema, referenceParams, "openingFrame")?.label).toBe("Opening frame");
    expect(closedInputPort(schema, referenceParams, "references")).toBeUndefined();
    expect(closedInputPort(schema, referenceParams, "nonsense")).toBeUndefined();
  });
});
