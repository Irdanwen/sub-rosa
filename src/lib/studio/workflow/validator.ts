import { t } from "../../i18n";
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
import { kindLabel, nodeTypeLabel, paramLabel, portLabel } from "./labels";

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
function pickerRequirement(node: string, paramType: string): string | undefined {
  if (paramType === "artifact") return t("{node}: pick a gallery item.", { node });
  if (paramType === "note") return t("{node}: pick a note.", { node });
  return undefined;
}

export function validateWorkflow(workflow: Pick<Workflow, "nodes" | "edges">): ValidationResult {
  const { nodes, edges } = workflow;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  if (nodes.length === 0) {
    warnings.push({ severity: "warning", message: t("The workflow is empty.") });
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
        message: t("Unknown node type: {type}.", { type: String(node.type) }),
      });
      continue;
    }
    const incoming = edges.filter((edge) => edge.target === node.id);
    const name = nodeTypeLabel(node.type);
    // What this node carries, which its chosen model can narrow (ADR-0022).
    const inputs = openInputPorts(schema, node.params);

    for (const param of schema.params) {
      if (!param.required || !isParamMissing(node, param.name)) continue;
      const picker = pickerRequirement(name, param.type);
      if (picker) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: picker,
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
          message: t("{node}: fill in {setting}.", { node: name, setting: paramLabel(param) }),
        });
      }
    }

    if (node.type === "tts" || node.type === "music") {
      const inputName = node.type === "tts" ? "text" : "prompt";
      const ownText =
        typeof node.params[inputName] === "string" ? String(node.params[inputName]).trim() : "";
      const hasText = incoming.some((edge) => resolvedPorts.get(edge.id)?.id === inputName);
      if (!ownText && !hasText)
        errors.push({
          severity: "error",
          nodeId: node.id,
          message:
            node.type === "tts"
              ? t("Add dialogue before generating speech.")
              : t("Add a music prompt before generating the score."),
        });
    }

    if (schema.inputs.length === 0) {
      for (const edge of incoming) {
        errors.push({
          severity: "error",
          edgeId: edge.id,
          message: t("{node} does not accept inputs.", { node: name }),
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
          message: t("{node}: no upstream input connected.", { node: name }),
        });
      }
    }

    for (const port of inputs) {
      const landing = incoming.filter((edge) => resolvedPorts.get(edge.id)?.id === port.id);
      if (port.required && landing.length === 0) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message: t("{node}: connect the {input} input.", {
            node: name,
            input: portLabel(node.type, port),
          }),
        });
      }
      const capacity = portCapacity(port, node.params);
      if (capacity !== undefined && landing.length > capacity) {
        errors.push({
          severity: "error",
          nodeId: node.id,
          message:
            capacity === 1
              ? t("{node}: {input} takes one connection at most.", {
                  node: name,
                  input: portLabel(node.type, port),
                })
              : t("{node}: {input} takes at most {count} connections.", {
                  node: name,
                  input: portLabel(node.type, port),
                  count: capacity,
                }),
        });
      }
    }

    if (schema.output === "none") {
      for (const edge of edges.filter((candidate) => candidate.source === node.id)) {
        errors.push({
          severity: "error",
          edgeId: edge.id,
          message: t("{node} has no output and cannot feed another node.", { node: name }),
        });
      }
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: t("A connection starts from a node that no longer exists."),
      });
      continue;
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: t("A connection leads to a node that no longer exists."),
      });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: t("A node cannot feed itself."),
      });
      continue;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourceSchema = source ? maybeNodeSchema(source.type) : undefined;
    const targetSchema = target ? maybeNodeSchema(target.type) : undefined;
    if (!source || !target || !sourceSchema || !targetSchema) continue;
    const sourceName = nodeTypeLabel(source.type);
    const targetName = nodeTypeLabel(target.type);
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
          ? t("{node}: the chosen model has no {input} input. Remove this connection.", {
              node: targetName,
              input: portLabel(target.type, closed),
            })
          : edge.targetPort !== undefined
            ? t("{node} has no {input} input.", { node: targetName, input: edge.targetPort })
            : t("{node} has no input that accepts {kind}.", {
                node: targetName,
                kind: kindLabel(sourceKind),
              }),
      });
      continue;
    }
    if (!isInputCompatible(sourceKind, port.kind)) {
      errors.push({
        severity: "error",
        edgeId: edge.id,
        message: t("{node}: {input} expects {expected}, but {source} makes {made}.", {
          node: targetName,
          input: portLabel(target.type, port),
          expected: kindLabel(port.kind),
          source: sourceName,
          made: kindLabel(sourceKind),
        }),
      });
      continue;
    }
    if (!isIdealMatch(sourceKind, port.kind)) {
      warnings.push({
        severity: "warning",
        edgeId: edge.id,
        message: t(
          "{source} makes {made} but {input} expects {expected}. The media will chain as a text description.",
          {
            source: sourceName,
            made: kindLabel(sourceKind),
            input: portLabel(target.type, port),
            expected: kindLabel(port.kind),
          },
        ),
      });
    }
  }

  if (hasCycle(nodes, edges)) {
    errors.push({ severity: "error", message: t("The workflow contains a cycle.") });
  }

  return { ok: errors.length === 0, errors, warnings };
}
