// What a step was asked, as a digest: the key of the step cache (ADR-0115).
//
// Two digests, for two moments. The *static* one is taken from the graph
// alone, before anything runs: a step's type, schema version, settings, take
// counter and the static digests of what feeds each of its ports, in edge
// order (a Merkle tree over the graph, ComfyUI's input signature). It is what
// the canvas uses to say which steps a run will reuse and to price the rest.
// The *runtime* one is taken just before a step would spend, from what it
// actually receives: the text and files upstream produced, and the catalog's
// own entry for its model, so a default the operator changed is a new request
// and a step fed by a different take is a new request too.
//
// Neither digest holds a node id or a position: moving, renaming or
// duplicating a branch keeps its cache. The display name is left out too.

import { stableJson } from "./stable-json";
import type { NodeOutput } from "./run-types";
import { maybeNodeSchema, openInputPorts, resolveInputPort, outputKindOf } from "./schema";
import type { Workflow, WorkflowNode } from "./schema";

const HEX = "0123456789abcdef";

/** SHA-256 of a text, as hex. */
export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let hex = "";
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 15];
  return hex;
}

/** The settings that decide what a step makes. Hidden bookkeeping a person
 * never sets and that does not reach the request is left out. */
function decisiveParams(node: WorkflowNode): Record<string, unknown> {
  const { assetLabel: _label, noteTitle: _title, freshEachRun: _fresh, ...rest } = node.params;
  return rest;
}

function header(node: WorkflowNode) {
  return {
    type: node.type,
    v: node.v ?? 1,
    params: decisiveParams(node),
  };
}

/** One upstream output, as the digest input it is: a file by its gallery id,
 * a text or an inline frame by its own digest. */
export async function outputDigest(output: NodeOutput): Promise<string> {
  switch (output.kind) {
    case "text":
      return `text:${await sha256(output.text)}`;
    case "image":
      return output.artifactId
        ? `file:${output.artifactId}`
        : `bytes:${await sha256(output.base64)}`;
    case "audio":
    case "video":
      if (output.artifactId) return `file:${output.artifactId}`;
      if (output.url) return `url:${output.url}`;
      if (output.kind === "audio" && output.base64) return `bytes:${await sha256(output.base64)}`;
      return `src:${output.src ?? ""}`;
  }
}

/** The runtime key: what this step is about to ask, given what it received. */
export async function runtimeKey(
  node: WorkflowNode,
  ports: Map<string, NodeOutput[]>,
  model?: unknown,
): Promise<string> {
  const inputs: Array<[string, string[]]> = [];
  for (const [portId, outputs] of [...ports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    inputs.push([portId, await Promise.all(outputs.map(outputDigest))]);
  }
  return sha256(stableJson({ ...header(node), inputs, model: model ?? null }));
}

/** Static keys for every node, from the graph alone (see the module note). */
export async function staticKeys(workflow: Pick<Workflow, "nodes" | "edges">) {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById, edges: workflow.edges };
  const keys = new Map<string, string>();
  const visiting = new Set<string>();
  const keyOf = async (node: WorkflowNode): Promise<string> => {
    const known = keys.get(node.id);
    if (known) return known;
    // A cycle has no key; the validator refuses the graph anyway.
    if (visiting.has(node.id)) return "cycle";
    visiting.add(node.id);
    const schema = maybeNodeSchema(node.type);
    const open = new Set(schema ? openInputPorts(schema, node.params).map((port) => port.id) : []);
    const byPort = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      if (edge.target !== node.id) continue;
      const source = nodeById.get(edge.source);
      if (!source) continue;
      const port = resolveInputPort(node, edge, outputKindOf(source, kindContext));
      if (!port || !open.has(port.id)) continue;
      const list = byPort.get(port.id) ?? [];
      list.push(await keyOf(source));
      byPort.set(port.id, list);
    }
    const inputs = [...byPort.entries()].sort(([a], [b]) => a.localeCompare(b));
    const key = await sha256(stableJson({ ...header(node), inputs }));
    visiting.delete(node.id);
    keys.set(node.id, key);
    return key;
  };
  for (const node of workflow.nodes) await keyOf(node);
  return keys;
}
