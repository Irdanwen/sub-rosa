import { describe, expect, it } from "vitest";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
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

function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "Test", nodes, edges, createdAt: 0, updatedAt: 0 };
}

describe("validateWorkflow", () => {
  it("accepts a valid linear pipeline", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("llm", "chat", { model: "qwen3-next-80b", prompt: "Summarize: {{input}}" }),
          node("out", "output"),
        ],
        [edge("in", "llm"), edge("llm", "out")],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects cycles", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("a", "chat", { model: "m", prompt: "p" }),
          node("b", "chat", { model: "m", prompt: "p" }),
        ],
        [edge("a", "b"), edge("b", "a")],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.message.includes("cycle"))).toBe(true);
  });

  it("flags a missing required param", () => {
    const result = validateWorkflow(workflow([node("llm", "chat", { prompt: "Say hi" })], []));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((issue) => issue.nodeId === "llm" && issue.message.includes("model")),
    ).toBe(true);
  });

  it("accepts a missing prompt when an inbound edge can feed it", () => {
    const result = validateWorkflow(
      workflow(
        [node("in", "textInput", { text: "hello" }), node("llm", "chat", { model: "m" })],
        [edge("in", "llm")],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("still errors on a missing prompt with no inbound edge", () => {
    const result = validateWorkflow(workflow([node("llm", "chat", { model: "m" })], []));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((issue) => issue.nodeId === "llm" && issue.message.includes("prompt")),
    ).toBe(true);
  });

  it("rejects self loops", () => {
    const result = validateWorkflow(
      workflow([node("a", "chat", { model: "m", prompt: "p" })], [edge("a", "a")]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.edgeId === "a-a")).toBe(true);
  });

  it("rejects edges into a node without input and out of a node without output", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("llm", "chat", { model: "m", prompt: "p" }),
          node("in", "textInput", { text: "t" }),
          node("out", "output"),
        ],
        [edge("llm", "in"), edge("out", "llm")],
      ),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (issue) => issue.edgeId === "llm-in" && issue.message.includes("does not accept inputs"),
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (issue) => issue.edgeId === "out-llm" && issue.message.includes("has no output"),
      ),
    ).toBe(true);
  });

  it("rejects edges whose endpoints do not exist", () => {
    const result = validateWorkflow(
      workflow([node("llm", "chat", { model: "m", prompt: "p" })], [edge("ghost", "llm")]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.edgeId === "ghost-llm")).toBe(true);
  });

  it("warns on an empty workflow and on an unconnected input", () => {
    const empty = validateWorkflow(workflow([], []));
    expect(empty.ok).toBe(true);
    expect(empty.warnings.some((issue) => issue.message.includes("empty"))).toBe(true);

    const unconnected = validateWorkflow(
      workflow([node("speech", "tts", { model: "tts-kokoro" })], []),
    );
    expect(unconnected.ok).toBe(true);
    expect(
      unconnected.warnings.some(
        (issue) => issue.nodeId === "speech" && issue.message.includes("no upstream input"),
      ),
    ).toBe(true);
  });

  it("flags unknown node types", () => {
    const bogus = {
      ...node("x", "chat", { model: "m", prompt: "p" }),
      type: "hologram" as WorkflowNodeType,
    };
    const result = validateWorkflow(workflow([bogus], []));
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.message.includes("hologram"))).toBe(true);
  });
});

describe("validateWorkflow with named ports", () => {
  it("rejects a media port fed the wrong kind", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("clip", "video", { model: "m", prompt: "p" }),
        ],
        [edge("in", "clip", "openingFrame")],
      ),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (issue) => issue.edgeId === "in-clip-openingFrame" && issue.message.includes("expects"),
      ),
    ).toBe(true);
  });

  it("rejects an edge naming a port the node does not have", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("llm", "chat", { model: "m", prompt: "p" }),
        ],
        [edge("in", "llm", "ghostPort")],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.message.includes("ghostPort"))).toBe(true);
  });

  it("caps a single port at one connection and references at four", () => {
    const stills = ["s1", "s2"].map((id) =>
      node(id, "asset", { assetKind: "image", artifactId: id }),
    );
    const doubleOpening = validateWorkflow(
      workflow(
        [...stills, node("clip", "video", { model: "m", prompt: "p" })],
        [edge("s1", "clip", "openingFrame"), edge("s2", "clip", "openingFrame")],
      ),
    );
    expect(doubleOpening.ok).toBe(false);
    expect(
      doubleOpening.errors.some(
        (issue) => issue.nodeId === "clip" && issue.message.includes("at most 1"),
      ),
    ).toBe(true);

    const five = ["r1", "r2", "r3", "r4", "r5"].map((id) =>
      node(id, "asset", { assetKind: "image", artifactId: id }),
    );
    const tooManyRefs = validateWorkflow(
      workflow(
        [...five, node("clip", "video", { model: "m", prompt: "p" })],
        five.map((still) => edge(still.id, "clip", "references")),
      ),
    );
    expect(tooManyRefs.ok).toBe(false);
    expect(
      tooManyRefs.errors.some(
        (issue) => issue.nodeId === "clip" && issue.message.includes("at most 4"),
      ),
    ).toBe(true);
  });

  it("requires the ports a node cannot run without", () => {
    const frame = validateWorkflow(workflow([node("frame", "lastFrame")], []));
    expect(frame.ok).toBe(false);
    expect(
      frame.errors.some((issue) => issue.nodeId === "frame" && issue.message.includes('"Video"')),
    ).toBe(true);

    const film = validateWorkflow(workflow([node("film", "assemble")], []));
    expect(film.ok).toBe(false);
    expect(
      film.errors.some((issue) => issue.nodeId === "film" && issue.message.includes('"Clips"')),
    ).toBe(true);
  });

  it("asks for a gallery item and a note in picker words, not param names", () => {
    const result = validateWorkflow(
      workflow([node("ref", "asset", { artifactId: "" }), node("doc", "document")], []),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (issue) => issue.nodeId === "ref" && issue.message.includes("pick a gallery item"),
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (issue) => issue.nodeId === "doc" && issue.message.includes("pick a note"),
      ),
    ).toBe(true);
  });

  it("accepts a portless image edge into a video node without warnings", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("still", "asset", { assetKind: "image", artifactId: "a" }),
          node("clip", "video", { model: "m", prompt: "p" }),
        ],
        [edge("still", "clip")],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("resolves kinds through a gate: an approved image still lands on a media port", () => {
    const result = validateWorkflow(
      workflow(
        [
          node("still", "asset", { assetKind: "image", artifactId: "a" }),
          node("check", "gate"),
          node("clip", "video", { model: "m", prompt: "p" }),
        ],
        // Portless gate→video edge: affinity must see the image behind the
        // gate, not a generic text output.
        [edge("still", "check"), edge("check", "clip")],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
