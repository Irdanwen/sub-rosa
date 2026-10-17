/**
 * Steps set aside without unwiring (ComfyUI's bypass and mute): a skipped
 * step passes its input of the kind it makes to every step it fed, a chain
 * of them resolves to the first step that runs, one with nothing to pass is
 * switched off, and a switched-off step takes down what only it fed.
 */

import { describe, expect, it } from "vitest";
import { applyModes } from "../lib/studio/workflow/modes";
import { defaultParams, type Workflow, type WorkflowNode } from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";

function node(id: string, type: WorkflowNode["type"], extra: Partial<WorkflowNode> = {}) {
  return {
    id,
    type,
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), model: "m", prompt: "p", text: "t" },
    ...extra,
  } satisfies WorkflowNode;
}

const edge = (source: string, target: string, targetPort: string) => ({
  id: `${source}-${target}`,
  source,
  target,
  targetPort,
});

function graph(nodes: WorkflowNode[], edges: Workflow["edges"]) {
  return { nodes, edges };
}

describe("steps set aside", () => {
  it("leaves a graph with nothing set aside untouched, as the same object", () => {
    const plain = graph([node("a", "textInput")], []);
    expect(applyModes(plain)).toBe(plain);
  });

  it("passes a skipped step's input straight on, through a chain of them", () => {
    const resolved = applyModes(
      graph(
        [
          node("idea", "textInput"),
          node("polish", "chat", { mode: "bypass" }),
          node("again", "chat", { mode: "bypass" }),
          node("pic", "image"),
        ],
        [
          edge("idea", "polish", "prompt"),
          edge("polish", "again", "prompt"),
          edge("again", "pic", "prompt"),
        ],
      ),
    );
    expect(resolved.nodes.map((entry) => entry.id)).toEqual(["idea", "pic"]);
    expect(resolved.edges).toEqual([
      { id: "again-pic", source: "idea", target: "pic", targetPort: "prompt" },
    ]);
    expect(validateWorkflow(resolved).ok).toBe(true);
  });

  it("switches off a skipped step with nothing of its kind to pass", () => {
    const resolved = applyModes(
      graph(
        [
          node("idea", "textInput"),
          node("pic", "image", { mode: "bypass" }),
          node("out", "output"),
        ],
        [edge("idea", "pic", "prompt"), edge("pic", "out", "in")],
      ),
    );
    // A text cannot stand in for the picture the step would have made.
    expect(resolved.nodes.map((entry) => entry.id)).toEqual(["idea"]);
  });

  it("takes down what only a switched-off step fed, and keeps what has another source", () => {
    const resolved = applyModes(
      graph(
        [
          node("a", "textInput"),
          node("b", "textInput"),
          node("off", "chat", { mode: "mute" }),
          node("onlyOff", "chat"),
          node("both", "chat"),
        ],
        [
          edge("a", "off", "prompt"),
          edge("off", "onlyOff", "prompt"),
          edge("off", "both", "prompt"),
          { id: "b-both", source: "b", target: "both", targetPort: "prompt" },
        ],
      ),
    );
    expect(resolved.nodes.map((entry) => entry.id).sort()).toEqual(["a", "b", "both"]);
    expect(resolved.edges.map((entry) => entry.id)).toEqual(["b-both"]);
  });
});
