// Versions of a workflow (⌘S): kept as the stored graph, read back exactly
// as a workflow is, and compared with the graph as it is now, step by step.

import { beforeEach, describe, expect, it, vi } from "vitest";

const table = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "workflow_version_save") {
      const request = args.request as Record<string, unknown>;
      table.rows.set(String(request.id), request);
      return null;
    }
    if (command === "workflow_version_get") return table.rows.get(String(args.id)) ?? null;
    return null;
  }),
}));

import type { Workflow } from "../lib/studio/workflow/schema";
import { diffSummary, graphDiff, saveVersion, versionGraph } from "../lib/studio/workflow/versions";

const step = (id: string, params: Record<string, unknown> = {}, label = "") => ({
  id,
  type: "textInput" as const,
  label,
  position: { x: 0, y: 0 },
  params,
});
const workflow: Workflow = {
  id: "w",
  name: "Cover",
  nodes: [step("a", { text: "kite" }, "Idea"), step("b", { text: "boat" })],
  edges: [{ id: "e", source: "a", target: "b" }],
  frames: [{ id: "f", label: "Opening", x: 0, y: 0, width: 200, height: 200 }],
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => table.rows.clear());

describe("a version", () => {
  it("reads back as the workflow it was, frames included", async () => {
    const kept = await saveVersion(workflow, "Before the client call");
    const back = await versionGraph(kept.id, { ...workflow, nodes: [], edges: [], frames: [] });
    expect(back).toMatchObject({
      id: "w",
      name: "Cover",
      nodes: workflow.nodes,
      edges: workflow.edges,
      frames: workflow.frames,
    });
    expect(table.rows.get(kept.id)).toMatchObject({
      label: "Before the client call",
      workflowId: "w",
    });
  });
});

describe("comparing two graphs", () => {
  it("names what was added, removed and changed, and counts wires, ignoring moves", () => {
    const after: Workflow = {
      ...workflow,
      nodes: [
        { ...step("a", { text: "kite at dawn" }, "Idea"), position: { x: 500, y: 0 } },
        step("c", {}, "Mood"),
      ],
      edges: [{ id: "e2", source: "a", target: "c" }],
    };
    const diff = graphDiff(workflow, after);
    expect(diff).toEqual({
      added: ["Mood"],
      removed: ["Text input"],
      changed: ["Idea"],
      rewired: 2,
    });
    expect(diffSummary(diff)).toBe("1 step added, 1 step removed, 1 step changed, 2 wires");
    const moved = {
      ...workflow,
      nodes: workflow.nodes.map((node) => ({ ...node, position: { x: 9, y: 9 } })),
    };
    expect(diffSummary(graphDiff(workflow, moved))).toBe("The same as now");
  });
});
