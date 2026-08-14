// Structural validation for Studio workflows. Errors block execution;
// warnings surface in the UI but the run proceeds.
//
// Ports made part of this binding: a media port only accepts its own kind
// (an error, where the pre-port validator only warned), text ports accept
// everything but degrade media to a description (still a warning), and a
// port that is required, over-filled, or unknown blocks the run.

import {
  closedInputPort,
  isIdealMatch,
  isInputCompatible,
  maybeNodeSchema,
  openInputPorts,
  outputKindOf,
  portCapacity,
  resolveInputPort,
  type InputPort,
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

/** User-legible requirement for picker params, instead of the generic
 * missing-param wording which would name an internal field. */
function pickerRequirement(paramType: string): string | undefined {
  if (paramType === "artifact") return "pick a gallery item";
  if (paramType === "note") return "pick a note";
  return undefined;
}

export function validateWorkflow(workflow: Pick<Workflow, "nodes" | "edges">): ValidationResult {
  const { nodes, edges } = workflow;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  if (nodes.length === 0) {
    warnings.push({ severity: "warning", message: "The workflow is empty." });
  }

  const kindContext = { nodeById, edges };
  /** The port each valid edge resolved to, for capacity + connection checks. */
  const resolvedPorts = new Map<string, InputPort | undefined>();
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const targetSchema = target ? maybeNodeSchema(target.type) : undefined;
    if (!source || !target || !targetSchema) continue;
    resolvedPorts.set(edge.id, resolveInputPort(target, edge, outputKindOf(source, kindContext)));
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
    // What this node carries, which its chosen model can narrow (ADR-0022).
    const inputs = openInputPorts(schema, node.params);

    for (const param of schema.params) {
      if (!param.required || !isParamMissing(node, param.name)) continue;
      const picker = pickerRequirement(param.type);
      if (picker) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: `${schema.label}: ${picker}.`,
        });
        continue;
      }
      // A missing prompt/text is fine when an inbound text edge can feed it.
      const textFed =
        (param.name === "prompt" || param.name === "text") &&
        incoming.some((edge) => {
          const port = resolvedPorts.get(edge.id);
          return port !== undefined && (port.kind === "text" || port.kind === "any");
        });
      if (!textFed) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: `${schema.label}: missing required "${param.name}".`,
        });
      }
    }

    if (schema.inputs.length === 0) {
      for (const edge of incoming) {
        errors.push({
          severity: "error",
          edgeId: edge.id,
          message: `${schema.label} does not accept inputs.`,
        });
      }
    } else if (incoming.length === 0) {
      // A node whose model closed every port is judged on its own params,
      // exactly like one that never had inputs.
      // An unconnected input is only worth flagging when the node also has no
      // prompt of its own to run from — and not when a required-port error
      // below already says the same thing louder.
      const hasOwnPrompt =
        schema.params.some((param) => param.name === "prompt") && !isParamMissing(node, "prompt");
      const hasRequiredPort = inputs.some((port) => port.required);
      if (!hasOwnPrompt && !hasRequiredPort) {
        warnings.push({
          severity: "warning",
          nodeId: node.id,
          message: `${schema.label}: no upstream input connected.`,
        });
      }
    }

    for (const port of inputs) {
      const landing = incoming.filter((edge) => resolvedPorts.get(edge.id)?.id === port.id);
      if (port.required && landing.length === 0) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: `${schema.label}: connect the "${port.label}" input.`,
        });
      }
      const capacity = portCapacity(port, node.params);
      if (capacity !== undefined && landing.length > capacity) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: `${schema.label}: "${port.label}" takes at most ${capacity} ${
            capacity === 1 ? "connection" : "connections"
          }.`,
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
    if (!source || !target || !sourceSchema || !targetSchema) continue;
    // Nodes without inputs already reported every inbound edge as an error.
    if (targetSchema.inputs.length === 0) continue;
    const sourceKind = outputKindOf(source, kindContext);
    // "none" outputs are already reported as errors by the per-node checks.
    if (sourceKind === "none") continue;
    const port = resolvedPorts.get(edge.id);
    if (!port) {
      // A port the node's own model closed is named for what it is, rather
      // than reported as an unknown input the user never typed.
      const closed =
        edge.targetPort !== undefined
          ? closedInputPort(targetSchema, target.params, edge.targetPort)
          : undefined;
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: closed
          ? `${targetSchema.label}: the chosen model has no "${closed.label}" input. Remove this connection.`
          : edge.targetPort !== undefined
            ? `${targetSchema.label} has no "${edge.targetPort}" input.`
            : `${targetSchema.label} has no input that accepts ${sourceKind}.`,
      });
      continue;
    }
    if (!isInputCompatible(sourceKind, port.kind)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: `${targetSchema.label}: "${port.label}" expects ${port.kind} but ${sourceSchema.label} outputs ${sourceKind}.`,
      });
      continue;
    }
    if (!isIdealMatch(sourceKind, port.kind)) {
      warnings.push({
        severity: "warning",
        edgeId: edge.id,
        message: `${sourceSchema.label} outputs ${sourceKind} but "${port.label}" expects ${port.kind}. The media will chain as a text description.`,
      });
    }
  }

  if (hasCycle(nodes, edges)) {
    errors.push({ severity: "error", message: "The workflow contains a cycle." });
  }

  return { ok: errors.length === 0, errors, warnings };
}
