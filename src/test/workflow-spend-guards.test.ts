/**
 * Every paid step passes one budget check before it spends: the schema's
 * `paid` flag decides which steps, a gate's judge is checked only when it is
 * about to read, and the canvas lets a usage-priced step through only while
 * the account holds more than the run has already set aside.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ carpeDiemGetCredits: vi.fn() }));
vi.mock("../lib/studio/judge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/judge")>()),
  judge: vi.fn(async () => ({ score: 9, passes: true, summary: "Fine.", weakest: [] })),
}));

import { judge } from "../lib/studio/judge";
import { estimateRenderMs, renderEtaKey } from "../lib/studio/render-eta";
import { carpeDiemGetCredits } from "../lib/tauri";
import { estimateNodeCost, type WorkflowCostEstimate } from "../lib/studio/workflow/cost";
import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import { nodeEtaKey } from "../lib/studio/workflow/eta";
import { defaultParams, isPaidNode, type WorkflowNode } from "../lib/studio/workflow/schema";
import { spendGuard } from "../lib/studio/workflow/spend";

const balance = (availableCredits: number) =>
  ({ availableCredits }) as Awaited<ReturnType<typeof carpeDiemGetCredits>>;

function node(id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  } satisfies WorkflowNode;
}

function estimate(entries: Array<[string, number | undefined]>): WorkflowCostEstimate {
  return {
    credits: entries.reduce((sum, [, credits]) => sum + (credits ?? 0), 0),
    metered: entries.filter(([, credits]) => credits === undefined).length,
    quotable: 0,
    nodes: entries.map(([nodeId, credits]) =>
      credits === undefined
        ? { nodeId, type: "chat", label: nodeId, kind: "metered", quotable: false }
        : { nodeId, type: "image", label: nodeId, kind: "flat", credits, quotable: false },
    ),
  };
}

beforeEach(() => {
  vi.mocked(carpeDiemGetCredits).mockReset();
  vi.mocked(judge).mockClear();
});

describe("which steps are paid", () => {
  it("is every generator, and a gate only when a judge will read", () => {
    for (const type of ["chat", "image", "imageEdit", "tts", "music", "video"] as const) {
      expect(isPaidNode(node(type, type))).toBe(true);
    }
    for (const type of [
      "textInput",
      "asset",
      "document",
      "lastFrame",
      "assemble",
      "output",
    ] as const) {
      expect(isPaidNode(node(type, type))).toBe(false);
    }
    expect(isPaidNode(node("g", "gate"))).toBe(false);
    expect(isPaidNode(node("g", "gate", { mode: "judged" }))).toBe(false);
    expect(isPaidNode(node("g", "gate", { mode: "judged", judgeModel: "vision" }))).toBe(true);
    expect(isPaidNode(node("g", "gate", { mode: "judged-then-human", judgeModel: "v" }))).toBe(
      true,
    );
  });

  it("prices a judged gate by usage and an approval as free", () => {
    const catalog = { backend: "venice" as const, models: [] };
    expect(estimateNodeCost(node("g", "gate"), catalog).kind).toBe("free");
    expect(
      estimateNodeCost(node("g", "gate", { mode: "judged", judgeModel: "v" }), catalog).kind,
    ).toBe("metered");
  });
});

describe("the canvas spend guard", () => {
  it("lets a usage-priced step through while the account holds more than is reserved", async () => {
    vi.mocked(carpeDiemGetCredits).mockResolvedValue(balance(15));
    const guard = spendGuard(
      estimate([
        ["image", 10],
        ["chat", undefined],
      ]),
      { unpriced: "allow" },
    );
    await guard(node("image", "image"));
    await expect(guard(node("chat", "chat"))).resolves.toBeUndefined();
  });

  it("stops a usage-priced step once the reservations have used the account up", async () => {
    vi.mocked(carpeDiemGetCredits).mockResolvedValue(balance(10));
    const guard = spendGuard(
      estimate([
        ["image", 10],
        ["chat", undefined],
      ]),
      { unpriced: "allow" },
    );
    await guard(node("image", "image"));
    await expect(guard(node("chat", "chat"))).rejects.toThrow("enough credits");
  });

  it("refuses an unpriced step when the caller's ceiling is a promise", async () => {
    await expect(
      spendGuard(estimate([["chat", undefined]]), { unpriced: "refuse", ceiling: 100 })(
        node("chat", "chat"),
      ),
    ).rejects.toThrow("Price unavailable");
    expect(carpeDiemGetCredits).not.toHaveBeenCalled();
  });

  it("holds a ceiling when there is one, and none when there is not", async () => {
    vi.mocked(carpeDiemGetCredits).mockResolvedValue(balance(1000));
    const capped = spendGuard(
      estimate([
        ["a", 10],
        ["b", 10],
      ]),
      { unpriced: "allow", ceiling: 15 },
    );
    await capped(node("a", "image"));
    await expect(capped(node("b", "image"))).rejects.toThrow("spend ceiling");
    const open = spendGuard(
      estimate([
        ["a", 10],
        ["b", 10],
      ]),
      { unpriced: "allow" },
    );
    await open(node("a", "image"));
    await expect(open(node("b", "image"))).resolves.toBeUndefined();
  });
});

describe("the gate's judge", () => {
  const picture = { kind: "image" as const, base64: "AA", mimeType: "image/png" };
  const storage = {
    save: vi.fn(),
    loadNote: vi.fn(),
    readMedia: vi.fn(),
    loadAsset: vi.fn(async (artifactId: string) => ({
      kind: "image" as const,
      src: `blob:${artifactId}`,
      base64: picture.base64,
      mimeType: picture.mimeType,
      artifactId,
    })),
  } as unknown as WorkflowStorage;
  const graph = {
    id: "w",
    name: "w",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      node("a", "asset", { assetKind: "image", artifactId: "pic" }),
      node("g", "gate", { mode: "judged", judgeModel: "vision" }),
    ],
    edges: [{ id: "e", source: "a", target: "g", targetPort: "in" }],
  };

  it("is checked against the budget just before it reads", async () => {
    const beforeNode = vi.fn(async (_node: WorkflowNode) => {});
    await runWorkflow(graph, { storage, beforeNode });
    expect(beforeNode).toHaveBeenCalledTimes(1);
    expect(beforeNode.mock.calls[0][0]).toMatchObject({ id: "g" });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("spends nothing, and is not checked, once the gate is approved", async () => {
    const beforeNode = vi.fn(async (_node: WorkflowNode) => {});
    await runWorkflow(graph, { storage, beforeNode, approvedGates: new Map([["g", undefined]]) });
    expect(beforeNode).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it("stops the run when the budget refuses, rather than degrading to a human gate", async () => {
    const beforeNode = vi.fn(async () => {
      throw new Error("You do not have enough credits for this generation.");
    });
    await expect(runWorkflow(graph, { storage, beforeNode })).rejects.toThrow("enough credits");
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("render-time buckets", () => {
  it("shares the desks' buckets, and leaves quick steps untimed", () => {
    expect(nodeEtaKey(node("v", "video", { model: "kling" }))).toBe(renderEtaKey("video", "kling"));
    expect(nodeEtaKey(node("s", "tts", { model: "kokoro" }))).toBe(
      renderEtaKey("speech", "kokoro"),
    );
    expect(nodeEtaKey(node("c", "chat", { model: "m" }))).toBeUndefined();
    expect(nodeEtaKey(node("a", "asset"))).toBeUndefined();
    expect(estimateRenderMs(renderEtaKey("video", "never-rendered"))).toBeUndefined();
  });
});
