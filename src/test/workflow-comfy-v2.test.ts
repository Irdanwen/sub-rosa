// ComfyUI import, second pass: a subgraph becomes a block, a reroute a
// relay, a widget fed by a shared value a setting taken from a connection,
// and partner nodes are read from a frozen table of ComfyUI's own
// (partner-nodes.json) rather than guessed from their names.

import { describe, expect, it } from "vitest";
import type { MediaCatalog } from "../lib/studio/types";
import { translateComfy } from "../lib/studio/workflow/comfy/translate";
import { flattenBlocks } from "../lib/studio/workflow/flatten";
import type { Workflow } from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    {
      id: "kling-2.5-turbo-pro-image-to-video",
      mediaType: "imageToVideo",
      name: "Kling 2.5 Turbo Pro (image)",
      offline: false,
      costCredits: 35,
    },
    { id: "seedream-v4", mediaType: "image", name: "Seedream v4", offline: false, costCredits: 4 },
    { id: "qwen3-next-80b", mediaType: "text", name: "Qwen3 Next 80B", offline: false },
    { id: "tts-elevenlabs-v3", mediaType: "tts", name: "ElevenLabs v3", offline: false },
  ],
};

/** A UI-format file around nodes and links, with subgraphs if given. */
function file(nodes: unknown[], links: unknown[], subgraphs: unknown[] = []) {
  return {
    nodes,
    links,
    ...(subgraphs.length > 0 ? { definitions: { subgraphs } } : {}),
  };
}

/** A subgraph: a picture in, a Kling clip from it out. */
const ANIMATE = {
  id: "5c2b0f3e-1d2e-4c1b-9a7f-3e2d1c0b9a8f",
  name: "Animate",
  inputs: [{ id: "i1", name: "picture", type: "IMAGE", linkIds: [10] }],
  outputs: [{ id: "o1", name: "clip", type: "VIDEO", linkIds: [11] }],
  nodes: [
    {
      id: 1,
      type: "KlingImage2VideoNode",
      mode: 0,
      inputs: [{ name: "start_frame", link: 10, type: "IMAGE" }],
      widgets_values: ["Slow push in, the scene comes alive"],
      pos: [0, 0],
    },
  ],
  links: [
    [10, -10, 0, 1, 0, "IMAGE"],
    [11, 1, 0, -20, 0, "VIDEO"],
  ],
};

function parentWith(instances: number) {
  const nodes: unknown[] = [
    { id: 1, type: "LoadImage", mode: 0, inputs: [], widgets_values: ["hero.png", "image"] },
  ];
  const links: unknown[] = [];
  for (let at = 0; at < instances; at += 1) {
    const block = 10 + at;
    const save = 20 + at;
    nodes.push(
      {
        id: block,
        type: ANIMATE.id,
        mode: 0,
        inputs: [{ name: "picture", link: 100 + at, type: "IMAGE" }],
        widgets_values: [],
      },
      {
        id: save,
        type: "SaveVideo",
        mode: 0,
        inputs: [{ name: "video", link: 200 + at, type: "VIDEO" }],
        widgets_values: [],
      },
    );
    links.push([100 + at, 1, 0, block, 0, "IMAGE"], [200 + at, block, 0, save, 0, "VIDEO"]);
  }
  return file(nodes, links, [ANIMATE]);
}

function runnable(workflow: Omit<Workflow, "id" | "createdAt" | "updatedAt">): Workflow {
  return { ...workflow, id: "w", createdAt: 0, updatedAt: 0 };
}

describe("a ComfyUI subgraph", () => {
  it("becomes a block, its input the inner step's opening frame, its output the clip", () => {
    const { workflow, report, usable } = translateComfy(parentWith(1), catalog);
    expect(usable).toBe(true);
    expect(workflow.blocks).toHaveLength(1);
    const block = workflow.blocks?.[0];
    const inner = block?.nodes[0];
    expect(inner?.type).toBe("video");
    expect(inner?.params.model).toBe("kling-2.5-turbo-pro-image-to-video");
    expect(block?.inputs).toEqual([
      { id: "in-0", label: "picture", nodeId: inner?.id, port: "openingFrame" },
    ]);
    expect(block?.outputs).toEqual([{ id: "out-0", label: "clip", nodeId: inner?.id }]);
    const instance = workflow.nodes.find((node) => node.type === "block");
    expect(instance?.params.blockId).toBe(block?.id);
    expect(instance?.label).toBe("Animate");
    expect(workflow.edges.find((edge) => edge.target === instance?.id)?.targetPort).toBe("in-0");
    expect(workflow.edges.find((edge) => edge.source === instance?.id)?.sourcePort).toBe("out-0");
    expect(report.translated).toContainEqual({ comfyType: "Animate", as: "Block" });
    // Put in place, it is the graph it stands for, and a valid one but for
    // the picture to pick.
    const flat = flattenBlocks(runnable(workflow)).workflow;
    const errors = validateWorkflow(flat).errors.filter(
      (issue) => flat.nodes.find((node) => node.id === issue.nodeId)?.type !== "asset",
    );
    expect(errors).toEqual([]);
  });

  it("is defined once however many times the file uses it", () => {
    const { workflow } = translateComfy(parentWith(2), catalog);
    expect(workflow.blocks).toHaveLength(1);
    expect(workflow.nodes.filter((node) => node.type === "block")).toHaveLength(2);
  });

  it("feeds one input to several inner steps through a relay", () => {
    const twice = {
      ...ANIMATE,
      nodes: [
        ...ANIMATE.nodes,
        {
          id: 2,
          type: "KlingImage2VideoNode",
          mode: 0,
          inputs: [{ name: "start_frame", link: 12, type: "IMAGE" }],
          widgets_values: [],
          pos: [0, 300],
        },
      ],
      links: [...ANIMATE.links, [12, -10, 0, 2, 0, "IMAGE"]],
    };
    const { workflow } = translateComfy(
      file([{ id: 10, type: ANIMATE.id, mode: 0, inputs: [], widgets_values: [] }], [], [twice]),
      catalog,
    );
    const block = workflow.blocks?.[0];
    const relay = block?.nodes.find((node) => node.type === "relay");
    expect(block?.inputs).toEqual([
      { id: "in-0", label: "picture", nodeId: relay?.id, port: "in" },
    ]);
    expect(block?.edges.filter((edge) => edge.source === relay?.id)).toHaveLength(2);
  });

  it("leaves out a nesting deeper than a block can hold", () => {
    const depth = 6;
    const subgraphs = Array.from({ length: depth }, (_, at) => ({
      id: `00000000-0000-4000-8000-00000000000${at}`,
      name: `Level ${at}`,
      inputs: [],
      outputs: [],
      nodes:
        at + 1 < depth
          ? [{ id: 1, type: `00000000-0000-4000-8000-00000000000${at + 1}`, mode: 0, inputs: [] }]
          : [],
      links: [],
    }));
    const { report } = translateComfy(
      file([{ id: 1, type: subgraphs[0].id, mode: 0, inputs: [] }], [], subgraphs),
      catalog,
    );
    expect(report.dropped.map((entry) => entry.reason)).toContain(
      "is a group of nodes nested too deep to open",
    );
  });
});

describe("the plumbing of a ComfyUI file", () => {
  it("keeps a reroute as a relay the wire runs through", () => {
    const { workflow, report } = translateComfy(
      file(
        [
          { id: 1, type: "LoadImage", mode: 0, inputs: [], widgets_values: ["a.png", "image"] },
          { id: 2, type: "Reroute", mode: 0, inputs: [{ name: "", link: 1, type: "*" }] },
          {
            id: 3,
            type: "SaveImage",
            mode: 0,
            inputs: [{ name: "images", link: 2, type: "IMAGE" }],
            widgets_values: [],
          },
        ],
        [
          [1, 1, 0, 2, 0, "IMAGE"],
          [2, 2, 0, 3, 0, "IMAGE"],
        ],
      ),
      catalog,
    );
    const relay = workflow.nodes.find((node) => node.type === "relay");
    expect(relay).toBeDefined();
    expect(
      workflow.edges.map((edge) => [edge.target === relay?.id, edge.targetPort]),
    ).toContainEqual([true, "in"]);
    expect(report.translated.map((entry) => entry.comfyType)).not.toContain("Reroute");
  });

  it("keeps a negative prompt shared by two renders as a setting both take from one text", () => {
    const render = (id: number, link: number) => ({
      id,
      type: "IdeogramV3",
      mode: 0,
      inputs: [
        { name: "negative_prompt", link, type: "STRING", widget: { name: "negative_prompt" } },
      ],
      widgets_values: ["a lighthouse at dusk"],
    });
    const { workflow } = translateComfy(
      file(
        [
          {
            id: 1,
            type: "PrimitiveStringMultiline",
            mode: 0,
            inputs: [],
            widgets_values: ["blurry, text"],
          },
          render(2, 1),
          render(3, 2),
        ],
        [
          [1, 1, 0, 2, 0, "STRING"],
          [2, 1, 0, 3, 0, "STRING"],
        ],
      ),
      catalog,
    );
    const shared = workflow.nodes.find((node) => node.type === "textInput");
    expect(shared?.params.text).toBe("blurry, text");
    const fed = workflow.edges.filter((edge) => edge.source === shared?.id);
    expect(fed.map((edge) => edge.targetPort)).toEqual([
      "param:negativePrompt",
      "param:negativePrompt",
    ]);
    for (const edge of fed)
      expect(workflow.nodes.find((node) => node.id === edge.target)?.params.fedParams).toEqual([
        "negativePrompt",
      ]);
  });
});

describe("ComfyUI's partner nodes, from their table", () => {
  const one = (type: string, values: Record<string, unknown> = {}, backend = catalog) =>
    translateComfy({ "1": { class_type: type, inputs: values } }, backend);

  it("makes an upscaler an upscale step and reads its factor", () => {
    const { workflow } = one("ClarityCrystalUpscaleNode", { upscale_factor: 4 });
    expect(workflow.nodes.map((node) => [node.type, node.params.scale])).toEqual([
      ["upscale", "4"],
    ]);
  });

  it("makes a voice a speech step, its words a text step that feeds it", () => {
    const { workflow } = one("ElevenLabsTextToSpeech", { text: "Welcome back." });
    const speech = workflow.nodes.find((node) => node.type === "tts");
    const words = workflow.nodes.find((node) => node.type === "textInput");
    expect(speech?.params.model).toBe("tts-elevenlabs-v3");
    expect(words?.params.text).toBe("Welcome back.");
    expect(workflow.edges).toEqual([
      expect.objectContaining({ source: words?.id, target: speech?.id, targetPort: "text" }),
    ]);
  });

  it("says why a 3D model, a vector drawing or a voice changer has no step", () => {
    const reasons = [
      "TripoTextToModelNode",
      "RecraftTextToVectorNode",
      "ElevenLabsSpeechToSpeech",
    ].map((type) => one(type).report.dropped[0]?.reason);
    expect(reasons).toEqual([
      "makes a 3D model, which Sub Rosa does not make",
      "makes a vector drawing, which Sub Rosa does not make",
      "changes the voice of a recording, which Sub Rosa does not do",
    ]);
  });

  it("cuts out only where the provider offers it", () => {
    expect(one("RecraftRemoveBackgroundNode").report.dropped[0]?.reason).toBe(
      "removes a background, which this provider does not offer",
    );
    const venice = { ...catalog, backend: "venice" as const };
    expect(one("RecraftRemoveBackgroundNode", {}, venice).workflow.nodes[0]?.type).toBe("cutout");
  });

  it("keeps a generation with an optional reference a generation when none is linked", () => {
    const { workflow } = one("KlingImageGenerationNode", { prompt: "a fox" });
    expect(workflow.nodes[0]?.type).toBe("image");
  });
});
