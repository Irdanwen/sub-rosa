/**
 * The canvas seam: a stored workflow drawn as React Flow nodes and edges and
 * read back unchanged, and the pre-spend dialog every paid run passes through.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeOutputView } from "../components/studio/workflow/NodeOutputView";
import { RunCostDialog } from "../components/studio/workflow/RunCostDialog";
import { fromFlow, toFlowEdges, toFlowNodes } from "../components/studio/workflow/flow";
import type { WorkflowCostEstimate } from "../lib/studio/workflow";
import type { Workflow } from "../lib/studio/workflow/schema";
import type { MediaCatalog } from "../lib/studio/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

const catalog: MediaCatalog = { backend: "venice", models: [] };
const noop = () => {};
const artifacts: Parameters<typeof toFlowNodes>[2] = {
  byId: new Map(),
  loaded: true,
  remember: noop,
};

function sample(): Workflow {
  return {
    id: "w",
    name: "Sample",
    nodes: [
      {
        id: "t",
        type: "textInput",
        label: "Idea",
        position: { x: 0, y: 0 },
        params: { text: "A fox" },
      },
      {
        id: "i",
        type: "image",
        label: "",
        position: { x: 240, y: 40 },
        params: { prompt: "{{input}}" },
      },
      { id: "o", type: "output", label: "", position: { x: 480, y: 40 }, params: {} },
    ],
    // The first edge predates ports: the canvas must show it where the engine
    // will route it, and saving makes that explicit.
    edges: [
      { id: "e1", source: "t", target: "i" },
      { id: "e2", source: "i", target: "o", targetPort: "in" },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("the canvas seam", () => {
  it("draws a portless edge on the port it resolves to", () => {
    const edges = toFlowEdges(sample());
    expect(edges.map((edge) => [edge.id, edge.targetHandle])).toEqual([
      ["e1", "prompt"],
      ["e2", "in"],
    ]);
  });

  it("reads back what it drew, with moved positions and explicit ports", () => {
    const workflow = sample();
    const nodes = toFlowNodes(workflow, catalog, artifacts, new Map(), noop, noop, noop);
    nodes[1] = { ...nodes[1], position: { x: 300, y: 60 } };
    const back = fromFlow(workflow, nodes, toFlowEdges(workflow));
    expect(back.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 60 },
      { x: 480, y: 40 },
    ]);
    expect(back.nodes.map((node) => node.params)).toEqual(
      workflow.nodes.map((node) => node.params),
    );
    expect(back.edges).toEqual([
      { id: "e1", source: "t", target: "i", targetPort: "prompt" },
      { id: "e2", source: "i", target: "o", targetPort: "in" },
    ]);
  });

  it("lists every gate's candidates by name", () => {
    const workflow: Workflow = {
      ...sample(),
      nodes: [
        ...sample().nodes,
        { id: "g", type: "gate", label: "Pick one", position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: "e3", source: "i", target: "g", targetPort: "in" }],
    };
    const gate = toFlowNodes(workflow, catalog, artifacts, new Map(), noop, noop, noop).find(
      (node) => node.id === "g",
    );
    expect(gate?.data.gateSources).toEqual([{ id: "i", label: "Image" }]);
  });
});

describe("the pre-spend dialog", () => {
  const estimate: WorkflowCostEstimate = {
    credits: 12,
    metered: 1,
    quotable: 0,
    nodes: [
      { nodeId: "i", type: "image", label: "Poster", kind: "flat", credits: 12, quotable: false },
      { nodeId: "c", type: "chat", label: "Writer", kind: "metered", quotable: false },
      { nodeId: "t", type: "textInput", label: "Idea", kind: "free", quotable: false },
    ],
  };

  it("names each paying node, leaves the free ones out, and starts only on confirm", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<RunCostDialog estimate={estimate} onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByText("Poster")).toBeInTheDocument();
    expect(screen.getByText("Writer")).toBeInTheDocument();
    expect(screen.queryByText("Idea")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a node while it renders", () => {
  it("waits on the Studio's veil, in the node's own shape, with the clock running", () => {
    const { container } = render(
      <NodeOutputView
        node={{
          id: "v",
          type: "video",
          label: "",
          position: { x: 0, y: 0 },
          params: { model: "kling", prompt: "A fox", aspectRatio: "16:9" },
        }}
        result={{ nodeId: "v", status: "running" }}
      />,
    );
    const frame = container.querySelector(".stage-frame");
    expect(frame).not.toBeNull();
    // The shape the node will deliver (it read the wrong param name before
    // and always waited in a square).
    expect(frame?.getAttribute("style")).toContain("16 / 9");
    expect(screen.getByText("Rendering")).toBeInTheDocument();
  });

  it("shows nothing for a step that answers in seconds", () => {
    const { container } = render(
      <NodeOutputView
        node={{ id: "c", type: "chat", label: "", position: { x: 0, y: 0 }, params: {} }}
        result={{ nodeId: "c", status: "running" }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
