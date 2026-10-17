// A workflow of 150 steps stays quick to judge, price, lay out and put in
// place: what the canvas computes on every change. ComfyUI graphs of this
// size are common; the canvas draws them compact from afar (arrange.ts,
// StudioNode), and these are the computations behind each redraw.

import { describe, expect, it } from "vitest";
import { estimateWorkflowCost, validateWorkflow } from "../lib/studio/workflow";
import { layered } from "../lib/studio/workflow/arrange";
import { flattenBlocks } from "../lib/studio/workflow/flatten";
import { expandLists } from "../lib/studio/workflow/lists";
import type { Workflow, WorkflowEdge, WorkflowNode } from "../lib/studio/workflow/schema";

function chain(count: number): Workflow {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  for (let at = 0; at < count / 3; at += 1) {
    const ids = [`t${at}`, `i${at}`, `o${at}`];
    nodes.push(
      {
        id: ids[0],
        type: "textInput",
        label: "",
        position: { x: 0, y: at * 200 },
        params: { text: `Shot ${at}` },
      },
      {
        id: ids[1],
        type: "image",
        label: "",
        position: { x: 300, y: at * 200 },
        params: { model: "seedream-v4", prompt: "{{input}}" },
      },
      { id: ids[2], type: "output", label: "", position: { x: 600, y: at * 200 }, params: {} },
    );
    edges.push(
      { id: `${ids[0]}>`, source: ids[0], target: ids[1], targetPort: "prompt" },
      { id: `${ids[1]}>`, source: ids[1], target: ids[2], targetPort: "in" },
    );
  }
  return { id: "w", name: "Big", nodes, edges, createdAt: 1, updatedAt: 1 };
}

describe("a workflow of 150 steps", () => {
  it("is judged, priced, put in place and laid out in well under a frame budget per change", () => {
    const workflow = chain(150);
    expect(workflow.nodes).toHaveLength(150);
    const catalog = {
      backend: "carpe-diem" as const,
      models: [
        {
          id: "seedream-v4",
          mediaType: "image" as const,
          name: "Seedream",
          offline: false,
          costCredits: 4,
        },
      ],
    };
    const started = performance.now();
    const effective = expandLists(flattenBlocks(workflow).workflow);
    const verdict = validateWorkflow(effective);
    const estimate = estimateWorkflowCost(effective, catalog);
    const positions = layered(
      workflow.nodes.map((node) => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        width: 280,
        height: 160,
      })),
      workflow.edges,
      48,
    );
    const elapsed = performance.now() - started;
    expect(verdict.ok).toBe(true);
    expect(estimate.credits).toBe(200);
    expect(positions.size).toBe(150);
    // Generous for a loaded CI machine; locally it is a few milliseconds.
    expect(elapsed).toBeLessThan(250);
  });
});
