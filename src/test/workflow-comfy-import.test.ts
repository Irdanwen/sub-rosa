/**
 * A ComfyUI workflow is translated, never executed (ADR-0075): what a hosted
 * model can do becomes native nodes, a local diffusion chain is rebuilt as one
 * hosted image, and everything else lands in the report with its reason.
 */

import { describe, expect, it } from "vitest";
import { readWorkflowFile, workflowFileText } from "../lib/studio/workflow/comfy/file";
import { detectWorkflowFile, translateComfy } from "../lib/studio/workflow/comfy/translate";
import { validateWorkflow } from "../lib/studio/workflow/validator";
import type { Workflow } from "../lib/studio/workflow/schema";
import type { MediaCatalog } from "../lib/studio/types";
import geminiOmni from "./fixtures/comfy/gemini-omni-image-to-video.json";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    {
      id: "gemini-omni-flash-1-1-image-to-video",
      mediaType: "imageToVideo",
      name: "Gemini Omni Flash 1.1",
      offline: false,
      constraints: { resolutions: ["720p", "1080p"], durations: ["5s"] },
    },
    {
      id: "gemini-omni-flash-1-1-text-to-video",
      mediaType: "video",
      name: "Gemini Omni Flash 1.1",
      offline: false,
      constraints: { resolutions: ["720p"], aspectRatios: ["16:9", "9:16"], durations: ["5s"] },
    },
    {
      id: "kling-v3-text-to-video",
      mediaType: "video",
      name: "Kling 3",
      offline: false,
    },
    { id: "gpt-image-2", mediaType: "image", name: "GPT Image 2", offline: false },
  ],
};

describe("reading a workflow file", () => {
  it("tells the three formats apart", () => {
    expect(detectWorkflowFile(geminiOmni)).toBe("comfy-ui");
    expect(detectWorkflowFile({ "3": { class_type: "KSampler", inputs: {} } })).toBe("comfy-api");
    expect(detectWorkflowFile({ format: "subrosa-workflow" })).toBe("subrosa");
    expect(detectWorkflowFile([1, 2])).toBe("unknown");
  });

  it("refuses what is not a workflow, saying why", () => {
    expect(() => readWorkflowFile("{", catalog)).toThrow("This file is not valid JSON.");
    expect(() => readWorkflowFile("{}", catalog)).toThrow(/neither a Sub Rosa nor a ComfyUI/);
  });
});

describe("the Gemini Omni image-to-video template", () => {
  const { workflow, report, usable } = translateComfy(geminiOmni, catalog);
  const byType = (type: string) => workflow.nodes.filter((node) => node.type === type);

  it("becomes a picture to provide, a video node and an output, wired as in Comfy", () => {
    expect(usable).toBe(true);
    expect(workflow.nodes.map((node) => node.type).sort()).toEqual(["asset", "output", "video"]);
    const [asset] = byType("asset");
    const [video] = byType("video");
    const [output] = byType("output");
    expect(asset.params).toMatchObject({ assetKind: "image", artifactId: "" });
    expect(asset.label).toBe("blue_studio_car.png");
    expect(video.params.model).toBe("gemini-omni-flash-1-1-image-to-video");
    expect(video.params.modelDirection).toBe("image");
    expect(String(video.params.prompt)).toMatch(/^Use @Image1 as the first frame/);
    expect(video.params.resolution).toBe("720p");
    expect(workflow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: asset.id, target: video.id, targetPort: "openingFrame" }),
        expect.objectContaining({ source: video.id, target: output.id, targetPort: "in" }),
      ]),
    );
  });

  it("keeps the note, names the missing picture and the dropped seed", () => {
    expect(workflow.description).toMatch(/## Input Asset/);
    expect(report.missing).toEqual(["blue_studio_car.png"]);
    expect(report.adjusted.join("\n")).toMatch(/seed is not kept/);
    expect(report.dropped).toEqual([]);
  });

  it("asks for the picture before it can run, and for nothing else", () => {
    const result = validateWorkflow(workflow as Workflow);
    expect(result.errors.map((issue) => issue.message)).toEqual(["Asset: pick a gallery item."]);
  });
});

describe("a local diffusion workflow", () => {
  // The API format of ComfyUI's default text-to-image graph.
  const api = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a lighthouse at dusk", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
        seed: 1,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
  };

  it("is rebuilt as one hosted image with the same prompts, said in the report", () => {
    const { workflow, report, usable } = translateComfy(api, catalog);
    expect(usable).toBe(true);
    expect(workflow.nodes.map((node) => node.type).sort()).toEqual(["image", "output"]);
    const image = workflow.nodes.find((node) => node.type === "image");
    expect(image?.params).toMatchObject({
      model: "gpt-image-2",
      prompt: "a lighthouse at dusk",
      negativePrompt: "blurry",
    });
    expect(workflow.edges).toHaveLength(1);
    expect(report.adjusted.join("\n")).toMatch(/KSampler ran a model on a local graphics card/);
    expect(report.dropped.map((entry) => entry.comfyType).sort()).toEqual([
      "CheckpointLoaderSimple",
      "EmptyLatentImage",
      "VAEDecode",
    ]);
  });

  it("is not worth importing when nothing in it makes anything", () => {
    const { usable } = translateComfy(
      { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } },
      catalog,
    );
    expect(usable).toBe(false);
  });
});

describe("Sub Rosa's own file", () => {
  it("survives being written and read back", () => {
    const original: Workflow = {
      id: "w",
      name: "Album cover",
      description: "Two steps",
      nodes: [
        { id: "a", type: "textInput", label: "", position: { x: 0, y: 0 }, params: { text: "x" } },
      ],
      edges: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const read = readWorkflowFile(workflowFileText(original), catalog, "cover.json");
    if (read.kind !== "subrosa") throw new Error("not read as a Sub Rosa file");
    expect(read.workflow).toMatchObject({
      name: "Album cover",
      description: "Two steps",
      edges: [],
    });
    // Fresh ids, so an import never collides with a workflow already here.
    expect(read.workflow.nodes).toEqual([{ ...original.nodes[0], id: expect.any(String) }]);
    expect(read.workflow.nodes[0].id).not.toBe("a");
  });

  it("refuses a file from a newer version rather than misreading it", () => {
    expect(() =>
      readWorkflowFile(JSON.stringify({ format: "subrosa-workflow", version: 99 }), catalog),
    ).toThrow(/newer version/);
  });
});

describe("what the review found", () => {
  const withAnime: MediaCatalog = {
    ...catalog,
    models: [
      { id: "anime-xl", mediaType: "image", name: "Anime XL", offline: false },
      ...catalog.models,
      { id: "sora-2-image-to-video", mediaType: "imageToVideo", name: "Sora 2", offline: false },
      { id: "wan-2-5-image-to-video", mediaType: "imageToVideo", name: "Wan 2.5", offline: false },
    ],
  };
  const api = (nodes: Record<string, { class_type: string; inputs?: Record<string, unknown> }>) =>
    translateComfy(nodes, withAnime);

  it("never turns a local node into a paid one", () => {
    const { workflow, report } = api({
      "1": { class_type: "WanImageToVideo", inputs: { width: 832 } },
      "2": { class_type: "FluxGuidance", inputs: { guidance: 3.5 } },
      "3": { class_type: "WanVideoModelLoader", inputs: {} },
    });
    expect(workflow.nodes).toEqual([]);
    expect(report.dropped.map((entry) => entry.comfyType).sort()).toEqual([
      "FluxGuidance",
      "WanImageToVideo",
      "WanVideoModelLoader",
    ]);
  });

  it("translates the hosted Wan node, and refuses to swap a provider the catalog lacks", () => {
    const wan = api({ "1": { class_type: "WanImageToVideoApi", inputs: { prompt: "a fox" } } });
    expect(wan.workflow.nodes[0].params.model).toBe("wan-2-5-image-to-video");
    const minimax = api({
      "1": { class_type: "MinimaxHailuoImageToVideoNode", inputs: { prompt: "a fox" } },
    });
    expect(minimax.workflow.nodes[0].params.model).toBeFalsy();
    expect(minimax.report.adjusted.join("\n")).toMatch(/No hosted model matches/);
  });

  it("rebuilds a sampler with the app's default image model, not the catalog's first", () => {
    const { workflow } = api({
      "6": { class_type: "CLIPTextEncode", inputs: { text: "a lighthouse" } },
      "3": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    });
    expect(workflow.nodes[0].params.model).toBe("gpt-image-2");
  });

  it("leaves muted and bypassed nodes out, and wires through a bypassed one", () => {
    const ui = {
      nodes: [
        { id: 1, type: "LoadImage", mode: 0, inputs: [], widgets_values: ["car.png", "image"] },
        {
          id: 2,
          type: "ImageScaleBy",
          mode: 4,
          inputs: [{ name: "image", link: 1, type: "IMAGE" }],
        },
        {
          id: 3,
          type: "KlingImage2VideoNode",
          mode: 2,
          inputs: [{ name: "start_frame", link: 2, type: "IMAGE" }],
        },
        { id: 4, type: "SaveImage", mode: 0, inputs: [{ name: "images", link: 2, type: "IMAGE" }] },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 2, 0, 4, 0, "IMAGE"],
      ],
    };
    const { workflow, report } = translateComfy(ui, withAnime);
    expect(workflow.nodes.map((node) => node.type).sort()).toEqual(["asset", "output"]);
    expect(workflow.edges).toHaveLength(1);
    expect(report.dropped.map((entry) => entry.reason)).toEqual([
      "is bypassed in the file",
      "is muted in the file",
    ]);
  });

  it("reads an older file whose widget names do not line up, without misplacing the prompt", () => {
    const ui = {
      nodes: [
        {
          id: 7,
          type: "GeminiVideoOmniV2",
          mode: 0,
          // Only the converted widget is listed, as older files do.
          inputs: [
            { name: "model.aspect_ratio", link: null, widget: { name: "model.aspect_ratio" } },
          ],
          widgets_values: [
            "Omni Flash 1.1",
            "A long prompt about a blue car in a studio",
            "720p",
            "16:9",
          ],
        },
      ],
      links: [],
    };
    const { workflow } = translateComfy(ui, catalog);
    expect(workflow.nodes[0].params.prompt).toBe("A long prompt about a blue car in a studio");
  });

  it("lands only what a port takes: a number is not an opening frame", () => {
    const ui = {
      nodes: [
        { id: 1, type: "LoadImage", mode: 0, inputs: [], widgets_values: ["car.png", "image"] },
        {
          id: 2,
          type: "GeminiVideoOmniV2",
          mode: 0,
          inputs: [
            { name: "width", link: 1, type: "INT" },
            { name: "model.images.image_1", link: 2, type: "IMAGE" },
          ],
          widgets_values: [],
        },
      ],
      links: [
        [1, 1, 1, 2, 0, "INT"],
        [2, 1, 0, 2, 1, "IMAGE"],
      ],
    };
    const { workflow } = translateComfy(ui, catalog);
    expect(workflow.edges.map((edge) => edge.targetPort)).toEqual(["openingFrame"]);
  });

  it("makes a malformed Sub Rosa file safe to open", () => {
    const text = JSON.stringify({
      format: "subrosa-workflow",
      version: 1,
      workflow: {
        name: "Broken",
        nodes: [{ id: "a", type: "textInput" }, null],
        edges: [{ id: "e", source: "a", target: "missing" }],
      },
    });
    const read = readWorkflowFile(text, catalog);
    if (read.kind !== "subrosa") throw new Error("not read as a Sub Rosa file");
    expect(read.workflow.nodes).toEqual([
      {
        id: expect.any(String),
        type: "textInput",
        label: "",
        position: { x: 0, y: 0 },
        params: {},
      },
    ]);
    expect(read.workflow.edges).toEqual([]);
  });
});
