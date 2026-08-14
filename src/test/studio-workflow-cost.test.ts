import { beforeEach, describe, expect, it, vi } from "vitest";

// The quote fetch goes through the media client; everything else is pure.
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
}));

import { mediaJson } from "../lib/studio/client";
import type { MediaCatalog } from "../lib/studio/types";
import {
  estimateNodeCost,
  estimateWorkflowCost,
  fetchVideoQuotes,
  needsRunConfirmation,
  nodeCostMap,
} from "../lib/studio/workflow/cost";
import {
  defaultParams,
  nodeLabel,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";

const CATALOG: MediaCatalog = {
  backend: "carpe-diem",
  priceMultiplier: 1.2,
  models: [
    { id: "chat-model", mediaType: "text", name: "Chat", offline: false },
    { id: "img-flat", mediaType: "image", name: "Image", offline: false, costCredits: 12 },
    { id: "img-unpriced", mediaType: "image", name: "Image 2", offline: false },
    { id: "vid-flat", mediaType: "video", name: "Video", offline: false, costCredits: 80 },
    { id: "ltx-fast", mediaType: "video", name: "LTX", offline: false, costCredits: 5 },
    {
      id: "music-brackets",
      mediaType: "music",
      name: "Music",
      offline: false,
      pricing: {
        durations: {
          short: { usd: 0.5, min_seconds: 1, max_seconds: 30 },
          long: { usd: 1, min_seconds: 31, max_seconds: 120 },
        },
      },
    },
  ],
};

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

describe("estimateNodeCost", () => {
  it("prices local and pass-through nodes as free", () => {
    for (const type of [
      "textInput",
      "asset",
      "document",
      "lastFrame",
      "assemble",
      "output",
    ] as const) {
      expect(estimateNodeCost(node("n", type), CATALOG).kind).toBe("free");
    }
  });

  it("reads a flat per-generation price off the catalog", () => {
    const estimate = estimateNodeCost(node("img", "image", { model: "img-flat" }), CATALOG);
    expect(estimate).toMatchObject({ kind: "flat", credits: 12 });
  });

  it("treats unpriced paying nodes as metered, chat included", () => {
    expect(estimateNodeCost(node("img", "image", { model: "img-unpriced" }), CATALOG).kind).toBe(
      "metered",
    );
    expect(estimateNodeCost(node("llm", "chat", { model: "chat-model" }), CATALOG).kind).toBe(
      "metered",
    );
  });

  it("prices music by duration bracket with the backend multiplier", () => {
    const estimate = estimateNodeCost(
      node("track", "music", { model: "music-brackets", durationSeconds: 90 }),
      CATALOG,
    );
    // 1 USD bracket -> 100 credits x 1.2 multiplier.
    expect(estimate).toMatchObject({ kind: "flat", credits: 120 });
  });

  it("marks video nodes quotable except the families whose quote endpoint rejects", () => {
    expect(estimateNodeCost(node("v", "video", { model: "vid-flat" }), CATALOG)).toMatchObject({
      kind: "flat",
      credits: 80,
      quotable: true,
    });
    expect(estimateNodeCost(node("v", "video", { model: "ltx-fast" }), CATALOG).quotable).toBe(
      false,
    );
  });

  it("names nodes by their own label so two shots stay tellable apart", () => {
    const shot = { ...node("v", "video", { model: "vid-flat" }), label: "First shot" };
    expect(estimateNodeCost(shot, CATALOG).label).toBe("First shot");
  });
});

describe("estimateWorkflowCost", () => {
  const nodes = [
    node("in", "textInput", { text: "t" }),
    node("img", "image", { model: "img-flat" }),
    node("clip", "video", { model: "vid-flat" }),
    node("llm", "chat", { model: "chat-model" }),
  ];

  it("sums the known figures and counts the open ones", () => {
    const estimate = estimateWorkflowCost({ nodes }, CATALOG);
    expect(estimate.credits).toBe(92);
    expect(estimate.metered).toBe(1);
    expect(estimate.quotable).toBe(1);
  });

  it("lets run-time quotes override static figures", () => {
    const estimate = estimateWorkflowCost({ nodes }, CATALOG, new Map([["clip", 55]]));
    expect(estimate.credits).toBe(67);
    expect(nodeCostMap(estimate)).toEqual({ img: 12, clip: 55 });
  });
});

describe("needsRunConfirmation", () => {
  it("skips the handshake for a lone cheap flat-priced image", () => {
    const estimate = estimateWorkflowCost(
      { nodes: [node("img", "image", { model: "img-flat" })] },
      CATALOG,
    );
    expect(needsRunConfirmation(estimate)).toBe(false);
  });

  it("confirms once the total reaches the threshold", () => {
    const estimate = estimateWorkflowCost(
      {
        nodes: [
          node("clip", "video", { model: "ltx-fast" }),
          node("img", "image", { model: "img-flat" }),
          node("img2", "image", { model: "img-flat" }),
        ],
      },
      CATALOG,
    );
    expect(estimate.credits).toBeGreaterThanOrEqual(20);
    expect(needsRunConfirmation(estimate)).toBe(true);
  });

  it("confirms for quotable videos and unpriced media, but not for chat alone", () => {
    const quotable = estimateWorkflowCost(
      { nodes: [node("clip", "video", { model: "vid-flat" })] },
      CATALOG,
    );
    expect(needsRunConfirmation(quotable)).toBe(true);

    const unpricedMedia = estimateWorkflowCost(
      { nodes: [node("img", "image", { model: "img-unpriced" })] },
      CATALOG,
    );
    expect(needsRunConfirmation(unpricedMedia)).toBe(true);

    const chatOnly = estimateWorkflowCost(
      { nodes: [node("llm", "chat", { model: "chat-model" })] },
      CATALOG,
    );
    expect(needsRunConfirmation(chatOnly)).toBe(false);
  });
});

describe("fetchVideoQuotes", () => {
  const mediaJsonMock = vi.mocked(mediaJson);

  beforeEach(() => {
    mediaJsonMock.mockReset();
  });

  it("quotes only quotable video nodes and converts USD to credits", async () => {
    mediaJsonMock.mockResolvedValue({ quote: 0.5 });
    const quotes = await fetchVideoQuotes(
      {
        nodes: [
          node("clip", "video", {
            model: "vid-flat",
            prompt: "a shot",
            duration: "5s",
            aspectRatio: "16:9",
          }),
          // Not quotable: its family rejects every quote probe.
          node("ltx", "video", { model: "ltx-fast", prompt: "b" }),
          node("img", "image", { model: "img-flat" }),
        ],
      },
      CATALOG,
    );

    expect(mediaJsonMock).toHaveBeenCalledTimes(1);
    expect(mediaJsonMock).toHaveBeenCalledWith("/video/quote", {
      model: "vid-flat",
      prompt: "a shot",
      duration: "5s",
      aspect_ratio: "16:9",
    });
    // 0.5 USD -> 50 credits x 1.2 multiplier.
    expect(quotes).toEqual(new Map([["clip", 60]]));
  });

  it("leaves the static estimate in place when the quote fails or is shapeless", async () => {
    mediaJsonMock
      .mockRejectedValueOnce(new Error("400"))
      .mockResolvedValueOnce({ unexpected: true });
    const failing = await fetchVideoQuotes(
      { nodes: [node("clip", "video", { model: "vid-flat", prompt: "a" })] },
      CATALOG,
    );
    expect(failing.size).toBe(0);

    const shapeless = await fetchVideoQuotes(
      { nodes: [node("clip", "video", { model: "vid-flat", prompt: "a" })] },
      CATALOG,
    );
    expect(shapeless.size).toBe(0);
  });
});

describe("nodeLabel", () => {
  // Nodes are created unnamed so "never named" stays tellable from "named
  // after its own type". Everything that reports on a node - the cost
  // breakdown, the connection lists, the assemble node's own artifact, the
  // quote's stand-in prompt - has to read the name through here, or an
  // unnamed node reports as an empty string.
  it("falls back to the node type's own label", () => {
    expect(nodeLabel({ type: "asset", label: "" })).toBe("Asset");
    expect(nodeLabel({ type: "video", label: "   " })).toBe("Video");
    expect(nodeLabel({ type: "asset", label: "Hero sheet" })).toBe("Hero sheet");
  });

  it("prices an unnamed node under its type, and a named one under its name", () => {
    const unnamed: WorkflowNode = {
      id: "a",
      type: "video",
      label: "",
      position: { x: 0, y: 0 },
      params: { ...defaultParams("video"), model: "vid-flat" },
    };
    expect(estimateWorkflowCost({ nodes: [unnamed] }, CATALOG).nodes[0].label).toBe("Video");
    expect(
      estimateWorkflowCost({ nodes: [{ ...unnamed, label: "Wide shot" }] }, CATALOG).nodes[0].label,
    ).toBe("Wide shot");
  });
});
