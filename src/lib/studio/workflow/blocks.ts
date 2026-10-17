// Blocks (ComfyUI's subgraphs): several steps that run as one step. A block
// is defined once in the workflow (`Workflow.blocks`) and each block step is
// an instance of it (`params.blockId`), so editing the block edits every
// instance. Its inputs and outputs are inner steps' own; the settings it
// promotes show on every instance, which may set them for itself. A run
// never sees a block: `flatten.ts` puts its steps in its place (ADR-0116).
//
// Here: what a block takes and gives, and making one from a selection or
// putting its steps back.

import { nodeTypeLabel, portLabel } from "./labels";
import {
  type BlockInput,
  type BlockOutput,
  type BlockSetting,
  type InputPort,
  type IOKind,
  maybeNodeSchema,
  nodeLabel,
  openInputPorts,
  outputKindOf,
  resolveInputPort,
  type WorkflowBlock,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

/** How deep blocks may sit inside blocks. */
export const MAX_BLOCK_DEPTH = 4;

export type BlockGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[]; blocks?: WorkflowBlock[] };

/** The instance settings key for one promoted setting. */
export function settingKey(setting: Pick<BlockSetting, "nodeId" | "param">): string {
  return `${setting.nodeId}:${setting.param}`;
}

/** The block a block step is an instance of. */
export function blockOf(
  node: Pick<WorkflowNode, "type" | "params">,
  blocks: readonly WorkflowBlock[] | undefined,
): WorkflowBlock | undefined {
  if (node.type !== "block") return undefined;
  return blocks?.find((block) => block.id === node.params.blockId);
}

export interface BlockOutputPort {
  id: string;
  label: string;
  kind: IOKind;
}

export interface BlockPorts {
  inputs: InputPort[];
  outputs: BlockOutputPort[];
}

/** What a block takes and gives, each typed as the inner step's own port. */
export function blockPorts(
  block: WorkflowBlock,
  blocks: readonly WorkflowBlock[] | undefined,
  depth = 0,
): BlockPorts {
  const byId = new Map(block.nodes.map((node) => [node.id, node]));
  const inner = (node: WorkflowNode | undefined) =>
    node && depth < MAX_BLOCK_DEPTH ? blockOf(node, blocks) : undefined;
  const inputs = block.inputs.map((input): InputPort => {
    const node = byId.get(input.nodeId);
    const nested = inner(node);
    const schema = node ? maybeNodeSchema(node.type) : undefined;
    const port = nested
      ? blockPorts(nested, blocks, depth + 1).inputs.find((entry) => entry.id === input.port)
      : schema && node
        ? openInputPorts(schema, node.params).find((entry) => entry.id === input.port)
        : undefined;
    return {
      id: input.id,
      label: input.label,
      // An input whose step has gone takes nothing: the validator of the
      // flattened graph names it.
      kind: port?.kind ?? "any",
      ...(port?.multi ? { multi: true } : {}),
      ...(port?.max !== undefined ? { max: port.max } : {}),
    };
  });
  const context = { nodeById: byId, edges: block.edges };
  const outputs = block.outputs.map((output): BlockOutputPort => {
    const node = byId.get(output.nodeId);
    const nested = inner(node);
    const kind = nested
      ? (blockPorts(nested, blocks, depth + 1).outputs.find(
          (entry) => entry.id === (output.port ?? nested.outputs[0]?.id),
        )?.kind ?? "none")
      : node
        ? outputKindOf(node, context)
        : "none";
    return { id: output.id, label: output.label, kind };
  });
  return { inputs, outputs };
}

/** What an edge carries: a block's chosen output, or the step's own. */
export function edgeSourceKind(
  edge: Pick<WorkflowEdge, "source" | "sourcePort">,
  graph: BlockGraph,
): IOKind {
  const source = graph.nodes.find((node) => node.id === edge.source);
  if (!source) return "none";
  const block = blockOf(source, graph.blocks);
  if (block) {
    const outputs = blockPorts(block, graph.blocks).outputs;
    return (outputs.find((port) => port.id === edge.sourcePort) ?? outputs[0])?.kind ?? "none";
  }
  if (source.type === "block") return "none";
  return outputKindOf(source, {
    nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
    edges: graph.edges,
  });
}

/** The settings a new block shows by default: the words of each step whose
 * words are not fed from inside the block (a prompt, a text). */
function defaultPromoted(nodes: WorkflowNode[], edges: WorkflowEdge[]): BlockSetting[] {
  const fed = new Set(edges.map((edge) => `${edge.target}:${edge.targetPort ?? ""}`));
  const several = nodes.length > 1;
  const promoted: BlockSetting[] = [];
  for (const node of nodes) {
    const schema = maybeNodeSchema(node.type);
    if (!schema) continue;
    for (const param of schema.params) {
      const words =
        (param.name === "prompt" && !fed.has(`${node.id}:prompt`)) ||
        (param.name === "text" && node.type === "textInput");
      if (!words) continue;
      promoted.push({
        nodeId: node.id,
        param: param.name,
        ...(several ? { label: nodeLabel(node) } : {}),
      });
    }
  }
  return promoted;
}

export interface MadeBlock {
  graph: BlockGraph;
  block: WorkflowBlock;
  instanceId: string;
}

/** The selected steps as one block step, wired where they were. Nothing
 * when the selection is empty. */
export function blockFromSelection(
  graph: BlockGraph,
  ids: ReadonlySet<string>,
  name: string,
  newId: () => string = () => crypto.randomUUID(),
): MadeBlock | undefined {
  const chosen = graph.nodes.filter((node) => ids.has(node.id));
  if (chosen.length === 0) return undefined;
  const left = Math.min(...chosen.map((node) => node.position.x));
  const top = Math.min(...chosen.map((node) => node.position.y));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const blockId = newId();
  const instanceId = newId();

  const inputs: BlockInput[] = [];
  const inputFor = new Map<string, string>();
  const outputs: BlockOutput[] = [];
  const outputFor = new Map<string, string>();
  const edges: WorkflowEdge[] = [];
  const innerEdges: WorkflowEdge[] = [];
  for (const edge of graph.edges) {
    const fromInside = ids.has(edge.source);
    const toInside = ids.has(edge.target);
    if (fromInside && toInside) {
      innerEdges.push(edge);
    } else if (toInside) {
      const target = byId.get(edge.target) as WorkflowNode;
      // A portless edge is pinned to the port it resolves to now, so the
      // block's input means the same thing as the wire did.
      const port =
        edge.targetPort ?? resolveInputPort(target, edge, edgeSourceKind(edge, graph))?.id ?? "";
      const key = `${target.id}:${port}`;
      let inputId = inputFor.get(key);
      if (!inputId) {
        inputId = `in-${inputs.length + 1}`;
        inputFor.set(key, inputId);
        const block = blockOf(target, graph.blocks);
        const portName = block
          ? (blockPorts(block, graph.blocks).inputs.find((entry) => entry.id === port)?.label ??
            port)
          : portLabel(target.type, { id: port, label: port });
        inputs.push({ id: inputId, label: portName, nodeId: target.id, port });
      }
      edges.push({ ...edge, target: instanceId, targetPort: inputId });
    } else if (fromInside) {
      const source = byId.get(edge.source) as WorkflowNode;
      const key = `${source.id}:${edge.sourcePort ?? ""}`;
      let outputId = outputFor.get(key);
      if (!outputId) {
        outputId = `out-${outputs.length + 1}`;
        outputFor.set(key, outputId);
        outputs.push({
          id: outputId,
          label: nodeLabel(source),
          nodeId: source.id,
          ...(edge.sourcePort ? { port: edge.sourcePort } : {}),
        });
      }
      edges.push({ ...edge, source: instanceId, sourcePort: outputId });
    } else {
      edges.push(edge);
    }
  }
  // Two inputs read the same ("Prompt", "Prompt"): say whose.
  for (const input of inputs) {
    if (inputs.filter((other) => other.label === input.label).length > 1) {
      const owner = byId.get(input.nodeId);
      if (owner) input.label = `${input.label} (${nodeLabel(owner)})`;
    }
  }
  const nodes = chosen.map((node) => ({
    ...node,
    position: { x: node.position.x - left, y: node.position.y - top },
  }));
  const block: WorkflowBlock = {
    id: blockId,
    name,
    nodes,
    edges: innerEdges,
    inputs,
    outputs,
    promoted: defaultPromoted(nodes, innerEdges),
  };
  const instance: WorkflowNode = {
    id: instanceId,
    type: "block",
    label: "",
    position: { x: left, y: top },
    params: { blockId },
  };
  return {
    graph: {
      nodes: [...graph.nodes.filter((node) => !ids.has(node.id)), instance],
      edges,
      blocks: [...(graph.blocks ?? []), block],
    },
    block,
    instanceId,
  };
}

/** A block step's steps put back in its place, with this instance's own
 * settings and wiring; the block itself goes once nothing uses it. */
export function ungroupBlock(
  graph: BlockGraph,
  instanceId: string,
  newId: () => string = () => crypto.randomUUID(),
): BlockGraph | undefined {
  const instance = graph.nodes.find((node) => node.id === instanceId);
  const block = instance ? blockOf(instance, graph.blocks) : undefined;
  if (!instance || !block) return undefined;
  const ids = new Map(block.nodes.map((node) => [node.id, newId()]));
  const settings = settingsOf(instance);
  const nodes = block.nodes.map((node) => {
    const params = instanceParams(block, node, settings);
    return {
      ...node,
      id: ids.get(node.id) as string,
      position: {
        x: instance.position.x + node.position.x,
        y: instance.position.y + node.position.y,
      },
      params,
      ...(instance.mode && !node.mode ? { mode: instance.mode } : {}),
    };
  });
  const edges: WorkflowEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.target === instanceId) {
      const input = block.inputs.find((entry) => entry.id === edge.targetPort);
      const target = input ? ids.get(input.nodeId) : undefined;
      if (input && target) edges.push({ ...edge, target, targetPort: input.port });
    } else if (edge.source === instanceId) {
      const output =
        block.outputs.find((entry) => entry.id === edge.sourcePort) ?? block.outputs[0];
      const source = output ? ids.get(output.nodeId) : undefined;
      if (output && source) {
        const { sourcePort: _block, ...rest } = edge;
        edges.push({ ...rest, source, ...(output.port ? { sourcePort: output.port } : {}) });
      }
    } else {
      edges.push(edge);
    }
  }
  for (const edge of block.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) edges.push({ ...edge, id: newId(), source, target });
  }
  const rest = graph.nodes.filter((node) => node.id !== instanceId);
  const stillUsed = rest.some((node) => node.type === "block" && node.params.blockId === block.id);
  return {
    nodes: [...rest, ...nodes],
    edges,
    blocks: stillUsed
      ? graph.blocks
      : (graph.blocks ?? []).filter((entry) => entry.id !== block.id),
  };
}

/** What setting a promoted one brings with it: the model picker writes the
 * model's direction beside its id (ADR-0022). */
const COMPANIONS: Record<string, string[]> = { model: ["modelDirection"] };

/** An inner step's settings as one instance runs it: the block's, with the
 * instance's own values for what the block promotes. A value for anything
 * the block no longer promotes is left out. */
export function instanceParams(
  block: Pick<WorkflowBlock, "promoted">,
  node: Pick<WorkflowNode, "id" | "params">,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  let params = node.params;
  for (const setting of block.promoted) {
    if (setting.nodeId !== node.id) continue;
    for (const name of [setting.param, ...(COMPANIONS[setting.param] ?? [])]) {
      const key = settingKey({ nodeId: node.id, param: name });
      if (key in settings) params = { ...params, [name]: settings[key] };
    }
  }
  return params;
}

/** An instance's own values for its block's promoted settings. */
export function settingsOf(node: Pick<WorkflowNode, "params">): Record<string, unknown> {
  const settings = node.params.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

/** The name a block step goes by: its own, or its block's. */
export function blockStepLabel(
  node: Pick<WorkflowNode, "type" | "label" | "params">,
  blocks: readonly WorkflowBlock[] | undefined,
): string {
  return node.label.trim() || blockOf(node, blocks)?.name || nodeTypeLabel(node.type);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Blocks read from a stored graph or a file: a malformed one is left out
 * (its steps then say their block is missing), and so is anything in one
 * that is not a step, a wire or a port. */
export function cleanBlocks(raw: unknown): WorkflowBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: WorkflowBlock[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    if (!Array.isArray(entry.nodes) || !Array.isArray(entry.edges)) continue;
    const nodes = entry.nodes.filter(
      (node): node is WorkflowNode =>
        isRecord(node) &&
        typeof node.id === "string" &&
        maybeNodeSchema(String(node.type)) !== undefined &&
        isRecord(node.position) &&
        isRecord(node.params),
    );
    const edges = entry.edges.filter(
      (edge): edge is WorkflowEdge =>
        isRecord(edge) && typeof edge.source === "string" && typeof edge.target === "string",
    );
    const ports = <T>(list: unknown, keep: (port: Record<string, unknown>) => boolean): T[] =>
      Array.isArray(list) ? (list.filter((port) => isRecord(port) && keep(port)) as T[]) : [];
    blocks.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : "",
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      nodes,
      edges,
      inputs: ports<BlockInput>(
        entry.inputs,
        (port) =>
          typeof port.id === "string" &&
          typeof port.nodeId === "string" &&
          typeof port.port === "string",
      ),
      outputs: ports<BlockOutput>(
        entry.outputs,
        (port) => typeof port.id === "string" && typeof port.nodeId === "string",
      ),
      promoted: ports<BlockSetting>(
        entry.promoted,
        (port) => typeof port.nodeId === "string" && typeof port.param === "string",
      ),
      ...(isRecord(entry.source) && typeof entry.source.id === "string"
        ? { source: entry.source as WorkflowBlock["source"] }
        : {}),
    });
  }
  return blocks;
}

/** A new id for a block's port, unused by its others. */
function nextPortId(prefix: string, taken: readonly { id: string }[]): string {
  let index = taken.length + 1;
  while (taken.some((port) => port.id === `${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

/** The block taking (or no longer taking) this inner step's input. */
export function toggleBlockInput(
  block: WorkflowBlock,
  nodeId: string,
  port: string,
  label: string,
): WorkflowBlock {
  const found = block.inputs.find((input) => input.nodeId === nodeId && input.port === port);
  if (found) return { ...block, inputs: block.inputs.filter((input) => input !== found) };
  return {
    ...block,
    inputs: [...block.inputs, { id: nextPortId("in", block.inputs), label, nodeId, port }],
  };
}

/** The block giving (or no longer giving) this inner step's result. */
export function toggleBlockOutput(
  block: WorkflowBlock,
  nodeId: string,
  label: string,
): WorkflowBlock {
  const found = block.outputs.find((output) => output.nodeId === nodeId && !output.port);
  if (found) return { ...block, outputs: block.outputs.filter((output) => output !== found) };
  return {
    ...block,
    outputs: [...block.outputs, { id: nextPortId("out", block.outputs), label, nodeId }],
  };
}

/** The block showing (or no longer showing) this inner setting. */
export function togglePromoted(block: WorkflowBlock, nodeId: string, param: string): WorkflowBlock {
  const found = block.promoted.find((entry) => entry.nodeId === nodeId && entry.param === param);
  return {
    ...block,
    promoted: found
      ? block.promoted.filter((entry) => entry !== found)
      : [...block.promoted, { nodeId, param }],
  };
}

/** The workflow with one block replaced, and every wire on a port the new
 * one no longer has taken off its instances, wherever they stand. */
export function replaceBlock<G extends BlockGraph>(graph: G, next: WorkflowBlock): G {
  const before = graph.blocks?.find((block) => block.id === next.id);
  if (!before) return graph;
  const inputs = new Set(next.inputs.map((input) => input.id));
  const outputs = new Set(next.outputs.map((output) => output.id));
  const usesIt = (nodes: WorkflowNode[]) =>
    new Set(
      nodes
        .filter((node) => node.type === "block" && node.params.blockId === next.id)
        .map((node) => node.id),
    );
  const keep = (nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
    const instances = usesIt(nodes);
    if (instances.size === 0) return edges;
    return edges.filter(
      (edge) =>
        !(instances.has(edge.target) && !inputs.has(edge.targetPort ?? "")) &&
        !(instances.has(edge.source) && edge.sourcePort && !outputs.has(edge.sourcePort)),
    );
  };
  return {
    ...graph,
    edges: keep(graph.nodes, graph.edges),
    blocks: (graph.blocks ?? []).map((block) => {
      const updated = block.id === next.id ? next : block;
      const edges = keep(updated.nodes, updated.edges);
      return edges === updated.edges ? updated : { ...updated, edges };
    }),
  };
}

/** The blocks these steps need, nested ones included. */
export function blocksUsed(
  nodes: WorkflowNode[],
  blocks: readonly WorkflowBlock[],
): WorkflowBlock[] {
  const used = new Map<string, WorkflowBlock>();
  const visit = (steps: WorkflowNode[]) => {
    for (const step of steps) {
      if (step.type !== "block") continue;
      const block = blocks.find((entry) => entry.id === step.params.blockId);
      if (!block || used.has(block.id)) continue;
      used.set(block.id, block);
      visit(block.nodes);
    }
  };
  visit(nodes);
  return [...used.values()];
}
