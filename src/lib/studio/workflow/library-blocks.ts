// Blocks kept in the library (ADR-0116): a block saved there is a library
// row of its own (`origin: "block"`), with its steps, the blocks inside it
// and its face, so the next workflow can use it from the step search. A
// block is copied into a workflow by value: changing the library copy never
// changes a workflow that already uses it, mid-run or not.

import { blocksUsed } from "./blocks";
import type { BlockInput, BlockOutput, BlockSetting, Workflow, WorkflowBlock } from "./schema";

interface Face {
  inputs: BlockInput[];
  outputs: BlockOutput[];
  promoted: BlockSetting[];
}

/** The library row a block is saved as. Saving one that came from the
 * library again updates that row. */
export function blockToLibrary(
  block: WorkflowBlock,
  blocks: readonly WorkflowBlock[],
  now: number = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): Workflow {
  const nested = blocksUsed(block.nodes, blocks);
  const face: Face = { inputs: block.inputs, outputs: block.outputs, promoted: block.promoted };
  return {
    id: block.source?.id ?? newId(),
    name: block.name,
    ...(block.description ? { description: block.description } : {}),
    nodes: block.nodes,
    edges: block.edges,
    ...(nested.length > 0 ? { blocks: nested } : {}),
    extra: { face },
    origin: "block",
    createdAt: now,
    updatedAt: now,
  };
}

function faceOf(row: Workflow): Face {
  const face = (row.extra?.face ?? {}) as Partial<Face>;
  return {
    inputs: Array.isArray(face.inputs) ? face.inputs : [],
    outputs: Array.isArray(face.outputs) ? face.outputs : [],
    promoted: Array.isArray(face.promoted) ? face.promoted : [],
  };
}

/** The blocks a workflow gains to use a library block, and the block its
 * new step is an instance of: the copy it already has when it is the same
 * saved version, else a new one. */
export function blocksForLibraryBlock(
  row: Workflow,
  blocks: readonly WorkflowBlock[],
  newId: () => string = () => crypto.randomUUID(),
): { blocks: WorkflowBlock[]; blockId: string } {
  const held = blocks.find(
    (block) => block.source?.id === row.id && block.source.updatedAt === row.updatedAt,
  );
  if (held) return { blocks: [...blocks], blockId: held.id };
  const block: WorkflowBlock = {
    id: newId(),
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    nodes: row.nodes,
    edges: row.edges,
    ...faceOf(row),
    source: { id: row.id, updatedAt: row.updatedAt },
  };
  const known = new Set(blocks.map((entry) => entry.id));
  const nested = (row.blocks ?? []).filter((entry) => !known.has(entry.id));
  return { blocks: [...blocks, ...nested, block], blockId: block.id };
}
