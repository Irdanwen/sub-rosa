// Blocks (ADR-0116): made from a selection and put back, run as their steps
// (flattened, wired where the block was), with their promoted settings, set
// aside as a whole, nested, and refused when they cannot be put in place.
// A step keeps its signature when it goes into a block, so the step cache
// still answers for it.

import { describe, expect, it } from "vitest";
import {
  blockFromSelection,
  blockPorts,
  edgeSourceKind,
  ungroupBlock,
} from "../lib/studio/workflow/blocks";
import { flattenBlocks, writtenGraph } from "../lib/studio/workflow/flatten";
import type { Workflow, WorkflowNode } from "../lib/studio/workflow/schema";
import { staticKeys } from "../lib/studio/workflow/signature";
import { validateWorkflow } from "../lib/studio/workflow/validator";

const node = (
  id: string,
  type: WorkflowNode["type"],
  params: Record<string, unknown> = {},
  x = 0,
): WorkflowNode => ({ id, type, label: "", position: { x, y: 0 }, params });

function ids(prefix = "id") {
  let next = 0;
  return () => `${prefix}${++next}`;
}

/** Brief → shot → output, the shot to go in a block. */
const workflow: Workflow = {
  id: "w",
  name: "W",
  nodes: [
    node("brief", "textInput", { text: "a red kite" }, 0),
    node("shot", "image", { model: "seedream-v4", prompt: "{{input}}, dawn" }, 300),
    node("out", "output", {}, 600),
  ],
  edges: [
    { id: "e1", source: "brief", target: "shot", targetPort: "prompt" },
    { id: "e2", source: "shot", target: "out" },
  ],
  createdAt: 0,
  updatedAt: 0,
};

function grouped() {
  const made = blockFromSelection(workflow, new Set(["shot"]), "Shot", ids());
  if (!made) throw new Error("no block");
  return { ...made, workflow: { ...workflow, ...made.graph } as Workflow };
}

describe("making a block from a selection", () => {
  it("keeps the wiring: what came in is an input, what went out an output", () => {
    const { block, instanceId, graph } = grouped();
    expect(block.inputs).toEqual([{ id: "in-1", label: "Prompt", nodeId: "shot", port: "prompt" }]);
    expect(block.outputs).toEqual([{ id: "out-1", label: "Image", nodeId: "shot" }]);
    expect(block.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(graph.edges).toEqual([
      { id: "e1", source: "brief", target: instanceId, targetPort: "in-1" },
      { id: "e2", source: instanceId, target: "out", sourcePort: "out-1" },
    ]);
    expect(graph.nodes.map((entry) => entry.type)).toEqual(["textInput", "output", "block"]);
    // Its prompt shows on the block.
    expect(block.promoted).toEqual([{ nodeId: "shot", param: "prompt" }]);
  });

  it("takes and gives what its steps do", () => {
    const { block, workflow: withBlock, instanceId } = grouped();
    const ports = blockPorts(block, withBlock.blocks);
    expect(ports.inputs).toEqual([{ id: "in-1", label: "Prompt", kind: "text", multi: true }]);
    expect(ports.outputs).toEqual([{ id: "out-1", label: "Image", kind: "image" }]);
    expect(edgeSourceKind({ source: instanceId, sourcePort: "out-1" }, withBlock)).toBe("image");
  });

  it("puts its steps back where they were, wired as before", () => {
    const { workflow: withBlock, instanceId } = grouped();
    const back = ungroupBlock(withBlock, instanceId, ids());
    if (!back) throw new Error("not ungrouped");
    expect(back.blocks).toEqual([]);
    const shot = back.nodes.find((entry) => entry.type === "image");
    expect(shot?.position).toEqual({ x: 300, y: 0 });
    expect(back.edges).toEqual([
      { id: "e1", source: "brief", target: shot?.id, targetPort: "prompt" },
      { id: "e2", source: shot?.id, target: "out" },
    ]);
  });
});

describe("a block when it runs", () => {
  it("is its steps, wired where it was, and the same run as before", async () => {
    const { workflow: withBlock, instanceId } = grouped();
    const flat = flattenBlocks(withBlock);
    expect(flat.issues).toEqual([]);
    expect(flat.workflow.nodes.map((entry) => entry.id)).toEqual([
      "brief",
      "out",
      `${instanceId}/shot`,
    ]);
    expect(flat.workflow.edges).toEqual([
      { id: "e1", source: "brief", target: `${instanceId}/shot`, targetPort: "prompt" },
      { id: "e2", source: `${instanceId}/shot`, target: "out" },
    ]);
    expect(flat.workflow.blocks).toBeUndefined();
    expect(flat.display).toEqual(new Map([[`${instanceId}/shot`, instanceId]]));
    expect(validateWorkflow(flat.workflow).errors).toEqual([]);
    // The same signature inside the block as outside: the cache still answers.
    const before = await staticKeys(workflow);
    const after = await staticKeys(flat.workflow);
    expect(after.get(`${instanceId}/shot`)).toBe(before.get("shot"));
    // Reopening the run shows the block.
    expect(writtenGraph(flat.workflow)?.nodes.map((entry) => entry.type)).toContain("block");
  });

  it("leaves a graph without blocks as it was", () => {
    expect(flattenBlocks(workflow).workflow).toBe(workflow);
  });

  it("takes each instance's own settings, and is set aside as a whole", () => {
    const { workflow: withBlock, instanceId } = grouped();
    const instance = withBlock.nodes.find((entry) => entry.id === instanceId) as WorkflowNode;
    const second = {
      ...instance,
      id: "second",
      params: { ...instance.params, settings: { "shot:prompt": "{{input}}, dusk" } },
      mode: "mute" as const,
    };
    const flat = flattenBlocks({ ...withBlock, nodes: [...withBlock.nodes, second] });
    const first = flat.workflow.nodes.find((entry) => entry.id === `${instanceId}/shot`);
    const other = flat.workflow.nodes.find((entry) => entry.id === "second/shot");
    expect(first?.params.prompt).toBe("{{input}}, dawn");
    expect(other?.params.prompt).toBe("{{input}}, dusk");
    expect(other?.mode).toBe("mute");
    expect(first?.mode).toBeUndefined();
  });

  it("puts a block inside a block in place, under the outer step", () => {
    const { workflow: withBlock, instanceId } = grouped();
    const outer = blockFromSelection(
      withBlock,
      new Set([instanceId, "brief"]),
      "Scene",
      ids("outer"),
    );
    if (!outer) throw new Error("no outer block");
    const flat = flattenBlocks({ ...withBlock, ...outer.graph } as Workflow);
    expect(flat.issues).toEqual([]);
    const shot = `${outer.instanceId}/${instanceId}/shot`;
    expect(flat.workflow.nodes.map((entry) => entry.id).sort()).toEqual(
      [`${outer.instanceId}/brief`, shot, "out"].sort(),
    );
    expect(flat.workflow.edges).toContainEqual(
      expect.objectContaining({ source: shot, target: "out" }),
    );
    expect(flat.display.get(shot)).toBe(outer.instanceId);
  });

  it("says why when a block cannot be put in place", () => {
    const { workflow: withBlock, instanceId, block } = grouped();
    const missing = flattenBlocks({ ...withBlock, blocks: [] });
    // Said once: its wires go with it.
    expect(missing.issues.map((issue) => [issue.nodeId, issue.code])).toEqual([
      [instanceId, "blockMissing"],
    ]);
    expect(missing.workflow.edges).toEqual([]);
    // An input whose step inside has gone.
    const dangling = { ...block, inputs: [{ ...block.inputs[0], nodeId: "gone" }] };
    const lost = flattenBlocks({ ...withBlock, blocks: [dangling] });
    expect(lost.issues.map((issue) => [issue.nodeId, issue.code])).toEqual([
      [instanceId, "blockPort"],
    ]);
    // A block that holds itself.
    const looped = {
      ...block,
      nodes: [...block.nodes, node("self", "block", { blockId: block.id })],
    };
    const loop = flattenBlocks({ ...withBlock, blocks: [looped] });
    expect(loop.issues.map((issue) => issue.code)).toContain("blockLoop");
  });
});

describe("a level of the workflow, seen from the flat graph", () => {
  it("shows each step at the top, and a block's steps from inside it", async () => {
    const { viewAt, liftResults, liftPrices, flatTargets } = await import(
      "../lib/studio/workflow/lift"
    );
    const { workflow: withBlock, instanceId } = grouped();
    const outer = blockFromSelection(withBlock, new Set([instanceId]), "Scene", ids("outer"));
    if (!outer) throw new Error("no outer block");
    const flat = flattenBlocks({ ...withBlock, ...outer.graph } as Workflow);
    const shot = `${outer.instanceId}/${instanceId}/shot`;
    const done = new Map([
      [
        shot,
        { nodeId: shot, status: "done" as const, output: { kind: "text" as const, text: "x" } },
      ],
      ["brief", { nodeId: "brief", status: "done" as const }],
    ]);
    // The top: the outer block step shows its shot's result.
    const top = viewAt(flat);
    expect([...top.groups.keys()].sort()).toEqual(["brief", "out", outer.instanceId].sort());
    expect(liftResults(done, top).get(outer.instanceId)).toMatchObject({
      status: "done",
      output: { kind: "text", text: "x" },
    });
    // Inside the outer block: the inner block step stands for the shot.
    const inside = viewAt(flat, [outer.instanceId]);
    expect([...inside.groups.keys()]).toEqual([instanceId]);
    expect(liftResults(done, inside).get(instanceId)?.status).toBe("done");
    // Inside both: the shot itself, by its own id.
    const deepest = viewAt(flat, [outer.instanceId, instanceId]);
    expect(liftResults(done, deepest).get("shot")?.nodeId).toBe("shot");
    expect(flatTargets(["shot"], deepest)).toEqual([shot]);
    const prices = liftPrices(
      [{ nodeId: shot, type: "image", label: "", kind: "flat", credits: 4, quotable: false }],
      top,
    );
    expect(prices.get(outer.instanceId)).toMatchObject({ kind: "flat", credits: 4 });
  });
});

describe("the face a block shows", () => {
  it("takes, gives and shows what is chosen, and drops the wires on what it stops giving", async () => {
    const { toggleBlockInput, toggleBlockOutput, togglePromoted, replaceBlock } = await import(
      "../lib/studio/workflow/blocks"
    );
    const { workflow: withBlock, block } = grouped();
    const noInput = toggleBlockInput(block, "shot", "prompt", "Prompt");
    expect(noInput.inputs).toEqual([]);
    expect(toggleBlockInput(noInput, "shot", "prompt", "Prompt").inputs).toEqual([
      { id: "in-1", label: "Prompt", nodeId: "shot", port: "prompt" },
    ]);
    expect(togglePromoted(block, "shot", "prompt").promoted).toEqual([]);
    expect(togglePromoted(block, "shot", "model").promoted).toHaveLength(2);
    const silent = toggleBlockOutput(block, "shot", "Image");
    expect(silent.outputs).toEqual([]);
    const after = replaceBlock(withBlock, silent);
    // The wire that left the block's output is gone; the one into it stays.
    expect(after.edges.map((edge) => edge.id)).toEqual(["e1"]);
    const removedInput = replaceBlock(withBlock, noInput);
    expect(removedInput.edges.map((edge) => edge.id)).toEqual(["e2"]);
  });
});

describe("writing a level back into the workflow", () => {
  it("puts the steps edited inside a block into the block, and leaves the rest", async () => {
    const { withLevel } = await import("../components/studio/workflow/useBlockScope");
    const { workflow: withBlock, block, instanceId } = grouped();
    const edited = { ...block.nodes[0], params: { ...block.nodes[0].params, prompt: "dusk" } };
    const root = withLevel(withBlock, [{ instanceId, blockId: block.id }], {
      nodes: [edited],
      edges: [],
    });
    expect(root.nodes).toBe(withBlock.nodes);
    expect(root.blocks?.[0].nodes[0].params.prompt).toBe("dusk");
    const top = withLevel(withBlock, [], { nodes: [], edges: [] });
    expect(top.nodes).toEqual([]);
    expect(top.blocks).toBeUndefined();
  });
});

describe("a block kept in the library", () => {
  it("is saved with its steps, the blocks inside it and its face, and comes back as a copy", async () => {
    const { blockToLibrary, blocksForLibraryBlock } = await import(
      "../lib/studio/workflow/library-blocks"
    );
    const { workflow: withBlock, block } = grouped();
    const row = blockToLibrary(block, withBlock.blocks ?? [], 5, () => "row");
    expect(row).toMatchObject({ id: "row", origin: "block", name: "Shot", updatedAt: 5 });
    expect(row.extra?.face).toEqual({
      inputs: block.inputs,
      outputs: block.outputs,
      promoted: block.promoted,
    });
    // Into another workflow: a copy with a new id that remembers where it came from.
    const first = blocksForLibraryBlock(row, [], () => "copy");
    expect(first.blockId).toBe("copy");
    expect(first.blocks[0]).toMatchObject({
      id: "copy",
      name: "Shot",
      inputs: block.inputs,
      source: { id: "row", updatedAt: 5 },
    });
    // The same saved version again is the copy already there.
    expect(blocksForLibraryBlock(row, first.blocks, () => "other").blockId).toBe("copy");
    // A newer one is a new copy beside it.
    const newer = blocksForLibraryBlock({ ...row, updatedAt: 9 }, first.blocks, () => "newer");
    expect(newer.blocks.map((entry) => entry.id)).toEqual(["copy", "newer"]);
    // Saving a copy again updates the row it came from.
    expect(blockToLibrary(first.blocks[0], first.blocks, 7).id).toBe("row");
  });

  it("is offered by the step search, but not to finish a connection", async () => {
    const { searchNodeTypes } = await import("../lib/studio/workflow/node-search");
    const library = [{ id: "row", name: "Opening shot" }];
    const hits = searchNodeTypes("opening", undefined, library);
    expect(hits[0]).toMatchObject({ type: "block", label: "Opening shot", libraryId: "row" });
    expect(
      searchNodeTypes("opening", { from: "output", kind: "image" }, library).some(
        (hit) => hit.libraryId,
      ),
    ).toBe(false);
  });
});

describe("a workflow's card", () => {
  it("counts what its blocks make", async () => {
    const { workflowMakes } = await import("../lib/studio/workflow/library");
    const { workflow: withBlock } = grouped();
    expect(workflowMakes(withBlock)).toBe("1 image");
  });
});
