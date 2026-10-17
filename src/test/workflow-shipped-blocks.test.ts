// The blocks Sub Rosa ships with: each one, dropped into a workflow and fed
// what its inputs take, is a graph the validator accepts once flattened, and
// what it shows on the block are settings its steps really have.

import { describe, expect, it } from "vitest";
import { builtInBlocks } from "../lib/studio/workflow/block-templates";
import { blockPorts } from "../lib/studio/workflow/blocks";
import { flattenBlocks } from "../lib/studio/workflow/flatten";
import { blocksForLibraryBlock } from "../lib/studio/workflow/library-blocks";
import { applyModes } from "../lib/studio/workflow/modes";
import { searchNodeTypes } from "../lib/studio/workflow/node-search";
import {
  defaultParams,
  maybeNodeSchema,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";

const step = (id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  }) as WorkflowNode;

describe("the shipped blocks", () => {
  const blocks = builtInBlocks();

  it("are eight, with stable ids and their own names", () => {
    expect(blocks).toHaveLength(8);
    expect(new Set(blocks.map((entry) => entry.id)).size).toBe(8);
    for (const entry of blocks) {
      expect(entry.id.startsWith("builtin-block-")).toBe(true);
      expect(entry.name.trim()).not.toBe("");
    }
  });

  for (const row of builtInBlocks()) {
    it(`"${row.name}" runs once fed what it takes`, () => {
      const { blocks: defined, blockId } = blocksForLibraryBlock(row, [], () => "b");
      const block = defined.find((entry) => entry.id === blockId);
      if (!block) throw new Error("no block");
      const ports = blockPorts(block, defined);
      expect(ports.inputs.length).toBeGreaterThan(0);
      expect(ports.outputs.length).toBeGreaterThan(0);
      const nodes: WorkflowNode[] = [step("inst", "block", { blockId })];
      const edges: WorkflowEdge[] = [];
      for (const port of ports.inputs) {
        const id = `src-${port.id}`;
        nodes.push(
          port.kind === "image" || port.kind === "video" || port.kind === "audio"
            ? step(id, "asset", { assetKind: port.kind, artifactId: `${port.kind}-1` })
            : step(id, "textInput", { text: "A red kite over rooftops at dawn." }),
        );
        edges.push({ id: `e-${port.id}`, source: id, target: "inst", targetPort: port.id });
      }
      nodes.push(step("out", "output"));
      edges.push({ id: "e-out", source: "inst", target: "out", sourcePort: ports.outputs[0].id });
      const workflow: Workflow = {
        id: "w",
        name: "W",
        nodes,
        edges,
        blocks: defined,
        createdAt: 0,
        updatedAt: 0,
      };
      const flat = flattenBlocks(workflow);
      expect(flat.issues).toEqual([]);
      expect(validateWorkflow(applyModes(flat.workflow)).errors).toEqual([]);
      // What the block shows are settings its steps have.
      for (const setting of block.promoted) {
        const inner = block.nodes.find((entry) => entry.id === setting.nodeId);
        const params = inner ? maybeNodeSchema(inner.type)?.params : undefined;
        expect(params?.some((param) => param.name === setting.param)).toBe(true);
      }
    });
  }

  it("are offered by the step search", () => {
    const hits = searchNodeTypes("chained", undefined, builtInBlocks());
    expect(hits[0]).toMatchObject({ libraryId: "builtin-block-two-shots", category: "blocks" });
  });
});
