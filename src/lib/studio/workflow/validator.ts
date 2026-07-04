// Structural validation for Studio workflows. Errors block execution;
// warnings surface in the UI but the run proceeds.

import {
  isIdealMatch,
  maybeNodeSchema,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function isParamMissing(node: WorkflowNode, name: string): boolean {
  const value = node.params[name];
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/** Three-color DFS: gray means "on the current path", hitting gray = cycle. */
function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);

  const color = new Map<string, "white" | "gray" | "black">();
  for (const node of nodes) color.set(node.id, "white");

  const visit = (id: string): boolean => {
    color.set(id, "gray");
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next);
      if (c === "gray") return true;
      if (c === "white" && visit(next)) return true;
    }
    color.set(id, "black");
    return false;
  };

  for (const node of nodes) {
    if (color.get(node.id) === "white" && visit(node.id)) return true;
  }
  return false;
}

export function validateWorkflow(workflow: Pick<Workflow, "nodes" | "edges">): ValidationResult {
  const { nodes, edges } = workflow;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));

  if (nodes.length === 0) {
    warnings.push({ severity: "warning", message: "The workflow is empty." });
  }

  for (const node of nodes) {
    const schema = maybeNodeSchema(node.type);
    if (!schema) {
      errors.push({
        severity: "error",
        nodeId: node.id,
        message: `Unknown node type: ${String(node.type)}.`,
      });
      continue;
    }
    const incoming = edges.filter((edge) => edge.target === node.id);

    for (const param of schema.params) {
      if (!param.required || !isParamMissing(node, param.name)) continue;
      // A missing prompt/text is fine when an inbound edge can feed it.
      const feedable =
        (param.name === "prompt" || param.name === "text") &&
        schema.input !== "none" &&
        incoming.length > 0;
      if (!feedable) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: `${schema.label}: missing required "${param.name}".`,
        });
      }
    }

    if (schema.input === "none") {
      for (const edge of incoming) {
        errors.push({
          severity: "error",
          edgeId: edge.id,
          message: `${schema.label} does not accept inputs.`,
        });
      }
    } else if (incoming.length === 0) {
      // An unconnected input is only worth flagging when the node also has no
      // prompt of its own to run from.
      const hasOwnPrompt =
        schema.params.some((param) => param.name === "prompt") && !isParamMissing(node, "prompt");
      if (!hasOwnPrompt) {
        warnings.push({
          severity: "warning",
          nodeId: node.id,
          message: `${schema.label}: no upstream input connected.`,
        });
      }
    }

    if (schema.output === "none") {
      for (const edge of edges.filter((candidate) => candidate.source === node.id)) {
        errors.push({
          severity: "error",
          edgeId: edge.id,
          message: `${schema.label} has no output and cannot feed another node.`,
        });
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: `Edge source "${edge.source}" does not exist.`,
      });
      continue;
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: `Edge target "${edge.target}" does not exist.`,
      });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: "Self loops are not allowed.",
      });
      continue;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourceSchema = source ? maybeNodeSchema(source.type) : undefined;
    const targetSchema = target ? maybeNodeSchema(target.type) : undefined;
    if (!sourceSchema || !targetSchema) continue;
    // "none" ports are already reported as errors by the per-node checks.
    if (sourceSchema.output === "none" || targetSchema.input === "none") continue;
    if (!isIdealMatch(sourceSchema.output, targetSchema.input)) {
      warnings.push({
        severity: "warning",
        edgeId: edge.id,
        message: `${sourceSchema.label} outputs ${sourceSchema.output} but ${targetSchema.label} expects ${targetSchema.input}. The media will chain as a text description.`,
      });
    }
  }

  if (hasCycle(nodes, edges)) {
    errors.push({ severity: "error", message: "The workflow contains a cycle." });
  }

  return { ok: errors.length === 0, errors, warnings };
}
