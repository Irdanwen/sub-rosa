/**
 * The step cache (ADR-0115): a paid step asked the same thing twice is
 * answered by what it made the first time. The keys ignore ids, positions
 * and names; anything that changes the request changes the key; a run
 * reuses without spending or checking the budget; a step set to make a new
 * result every run never reuses; and the canvas only promises a step free
 * when everything paid above it is reused too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
}));

import { reusable } from "../components/studio/workflow/useReusePrediction";
import { mediaJson } from "../lib/studio/client";
import { estimateWorkflowCost, withReusedSteps } from "../lib/studio/workflow/cost";
import { runWorkflow, type StepCache } from "../lib/studio/workflow/engine";
import type { NodeOutput } from "../lib/studio/workflow/run-types";
import { defaultParams, type Workflow, type WorkflowNode } from "../lib/studio/workflow/schema";
import { runtimeKey, staticKeys } from "../lib/studio/workflow/signature";

const mediaJsonMock = vi.mocked(mediaJson);

function node(id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) {
  return {
    id,
    type,
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  } satisfies WorkflowNode;
}

function graph(): Workflow {
  return {
    id: "w",
    name: "w",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("idea", "textInput", { text: "A fox in the snow" }),
      node("write", "chat", { model: "writer", prompt: "Describe: {{input}}" }),
      node("pic", "chat", { model: "writer", prompt: "Title for: {{input}}" }),
    ],
    edges: [
      { id: "e1", source: "idea", target: "write", targetPort: "prompt" },
      { id: "e2", source: "write", target: "pic", targetPort: "prompt" },
    ],
  };
}

function memoryCache(): StepCache & { rows: Map<string, NodeOutput> } {
  const rows = new Map<string, NodeOutput>();
  return {
    rows,
    get: vi.fn(async (key: string) => rows.get(key)),
    put: vi.fn(async (key: string, _static: string, _node: WorkflowNode, output: NodeOutput) => {
      rows.set(key, output);
    }),
  };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  let calls = 0;
  mediaJsonMock.mockImplementation(async () => {
    calls += 1;
    return { choices: [{ message: { content: `answer ${calls}` } }] };
  });
});

describe("static keys", () => {
  it("ignore ids, positions and names", async () => {
    const original = graph();
    const moved: Workflow = {
      ...original,
      nodes: original.nodes.map((entry, index) => ({
        ...entry,
        id: `other-${entry.id}`,
        label: `Named ${index}`,
        position: { x: index * 300, y: 99 },
      })),
      edges: original.edges.map((edge) => ({
        ...edge,
        id: `x-${edge.id}`,
        source: `other-${edge.source}`,
        target: `other-${edge.target}`,
      })),
    };
    const a = await staticKeys(original);
    const b = await staticKeys(moved);
    for (const entry of original.nodes) expect(b.get(`other-${entry.id}`)).toBe(a.get(entry.id));
  });

  it("change for a step and everything it feeds when its settings or take change", async () => {
    const before = await staticKeys(graph());
    for (const change of [{ prompt: "Summarise: {{input}}" }, { take: 1 }, { model: "other" }]) {
      const edited = graph();
      edited.nodes[1] = { ...edited.nodes[1], params: { ...edited.nodes[1].params, ...change } };
      const after = await staticKeys(edited);
      expect(after.get("idea")).toBe(before.get("idea"));
      expect(after.get("write")).not.toBe(before.get("write"));
      expect(after.get("pic")).not.toBe(before.get("pic"));
    }
  });

  it("leave the switch that asks for a new result out of the key", async () => {
    const before = await staticKeys(graph());
    const edited = graph();
    edited.nodes[1] = {
      ...edited.nodes[1],
      params: { ...edited.nodes[1].params, freshEachRun: true },
    };
    expect((await staticKeys(edited)).get("write")).toBe(before.get("write"));
  });
});

describe("runtime keys", () => {
  it("follow what a step actually receives, and its model's catalog entry", async () => {
    const step = node("write", "chat", { model: "writer", prompt: "{{input}}" });
    const ports = (text: string) => new Map([["prompt", [{ kind: "text" as const, text }]]]);
    const a = await runtimeKey(step, ports("fox"));
    expect(await runtimeKey({ ...step, id: "elsewhere", label: "Named" }, ports("fox"))).toBe(a);
    expect(await runtimeKey(step, ports("wolf"))).not.toBe(a);
    expect(await runtimeKey(step, ports("fox"), { id: "writer", constraints: { x: 1 } })).not.toBe(
      a,
    );
    const file = new Map([
      [
        "images",
        [{ kind: "image" as const, base64: "AA", mimeType: "image/png", artifactId: "a.png" }],
      ],
    ]);
    const other = new Map([
      [
        "images",
        [{ kind: "image" as const, base64: "BB", mimeType: "image/png", artifactId: "a.png" }],
      ],
    ]);
    // A gallery file is its id, whatever bytes were read for it.
    expect(await runtimeKey(step, file)).toBe(await runtimeKey(step, other));
  });
});

describe("a run with the cache", () => {
  it("buys each step once: the second identical run spends nothing and checks no budget", async () => {
    const cache = memoryCache();
    const first = await runWorkflow(graph(), { cache });
    expect(mediaJsonMock).toHaveBeenCalledTimes(2);
    expect(first.get("pic")?.reused).toBeUndefined();
    expect(cache.rows.size).toBe(2);

    const beforeNode = vi.fn(async () => {});
    const second = await runWorkflow(graph(), { cache, beforeNode });
    expect(mediaJsonMock).toHaveBeenCalledTimes(2);
    expect(beforeNode).not.toHaveBeenCalled();
    expect(second.get("write")).toMatchObject({ status: "done", reused: true });
    expect(second.get("pic")?.output).toEqual(first.get("pic")?.output);
  });

  it("makes a new result for a step asked to, and for what it feeds", async () => {
    const cache = memoryCache();
    await runWorkflow(graph(), { cache });
    const fresh = graph();
    fresh.nodes[1] = {
      ...fresh.nodes[1],
      params: { ...fresh.nodes[1].params, freshEachRun: true },
    };
    const again = await runWorkflow(fresh, { cache });
    expect(again.get("write")?.reused).toBeUndefined();
    // Its new answer is a new input downstream, so that step runs too.
    expect(again.get("pic")?.reused).toBeUndefined();
    expect(mediaJsonMock).toHaveBeenCalledTimes(4);
  });

  it("never caches a free step, and runs as before without a cache", async () => {
    const cache = memoryCache();
    await runWorkflow(graph(), { cache });
    const putTypes = vi.mocked(cache.put).mock.calls.map((call) => call[2].type);
    expect(putTypes).not.toContain("textInput");
    mediaJsonMock.mockClear();
    await runWorkflow(graph());
    expect(mediaJsonMock).toHaveBeenCalledTimes(2);
  });

  it("runs the step when the cache cannot answer", async () => {
    const cache: StepCache = {
      get: vi.fn(async () => {
        throw new Error("table locked");
      }),
      put: vi.fn(async () => {
        throw new Error("table locked");
      }),
    };
    const results = await runWorkflow(graph(), { cache });
    expect(results.get("pic")?.status).toBe("done");
  });
});

describe("what the canvas promises", () => {
  it("only calls a step free when every paid step above it is reused too", () => {
    const workflow = graph();
    expect([...reusable(workflow, new Set(["write", "pic"]))].sort()).toEqual(["pic", "write"]);
    // The writer makes something new, so the titler receives a new input.
    expect([...reusable(workflow, new Set(["pic"]))]).toEqual([]);
  });

  it("takes reused steps out of the bill and asks no quote for them", () => {
    const catalog = {
      backend: "venice" as const,
      models: [
        { id: "img", name: "Img", mediaType: "image" as const, offline: false, costCredits: 8 },
      ],
    };
    const workflow = {
      nodes: [
        node("a", "image", { model: "img", prompt: "x" }),
        node("b", "image", { model: "img", prompt: "y" }),
      ],
    };
    const priced = withReusedSteps(estimateWorkflowCost(workflow, catalog), new Set(["a"]));
    expect(priced.credits).toBe(8);
    expect(priced.nodes.find((entry) => entry.nodeId === "a")).toMatchObject({
      reused: true,
      credits: 0,
      quotable: false,
    });
  });
});
