// The mobile editor's linear list becomes a graph through assembleWorkflow.
// The interesting rule: input-less steps (text, asset, document) accumulate
// and all feed the next step that accepts inputs — which is what lets a
// phone-built flow wire an asset image AND a scene text into one video step.

import { describe, expect, it } from "vitest";
import { assembleWorkflow } from "../components/mobile/screens/WorkflowEditor";
import {
  defaultParams,
  validateWorkflow,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow";

function step(
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

const BASE: Workflow = { id: "wf", name: "Flow", nodes: [], edges: [], createdAt: 0, updatedAt: 0 };

function edgePairs(workflow: Workflow): Array<[string, string]> {
  return workflow.edges.map((edge) => [edge.source, edge.target]);
}

describe("assembleWorkflow", () => {
  it("chains plain steps sequentially and appends an output collector", () => {
    const assembled = assembleWorkflow(BASE, "Flow", [
      step("in", "textInput", { text: "hello" }),
      step("llm", "chat", { model: "m" }),
    ]);
    expect(edgePairs(assembled)).toEqual([
      ["in", "llm"],
      ["llm", "wf-output"],
    ]);
    expect(validateWorkflow(assembled).ok).toBe(true);
  });

  it("feeds every pending input-less step into the next step that accepts inputs", () => {
    const assembled = assembleWorkflow(BASE, "Flow", [
      step("hero", "asset", { assetKind: "image", artifactId: "a1" }),
      step("scene", "textInput", { text: "she walks on" }),
      step("clip", "video", { model: "m" }),
    ]);
    // Both sources reach the video step; kind affinity will route the image
    // to its opening frame and the text to its prompt.
    expect(edgePairs(assembled)).toEqual([
      ["hero", "clip"],
      ["scene", "clip"],
      ["clip", "wf-output"],
    ]);
    expect(validateWorkflow(assembled).ok).toBe(true);
  });

  it("no longer breaks when an input-less step sits mid-list", () => {
    const assembled = assembleWorkflow(BASE, "Flow", [
      step("brief", "textInput", { text: "a fox" }),
      step("llm", "chat", { model: "m" }),
      step("hero", "asset", { assetKind: "image", artifactId: "a1" }),
      step("clip", "video", { model: "m" }),
    ]);
    // The asset gets no inbound edge (it cannot take one); the chat result
    // and the asset both feed the video step.
    expect(edgePairs(assembled)).toEqual([
      ["brief", "llm"],
      ["llm", "clip"],
      ["hero", "clip"],
      ["clip", "wf-output"],
    ]);
    expect(validateWorkflow(assembled).ok).toBe(true);
  });
});
