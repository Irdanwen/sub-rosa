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
    expect(read).toEqual({
      kind: "subrosa",
      workflow: { name: "Album cover", description: "Two steps", nodes: original.nodes, edges: [] },
    });
  });

  it("refuses a file from a newer version rather than misreading it", () => {
    expect(() =>
      readWorkflowFile(JSON.stringify({ format: "subrosa-workflow", version: 99 }), catalog),
    ).toThrow(/newer version/);
  });
});
