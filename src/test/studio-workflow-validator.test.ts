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

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}-${target}`, source, target };
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
