// A workflow as an app (ADR-0119): the few settings a person fills in and
// the few results they get, in an order, over the same graph. The app is a
// view, never a second workflow: its fields are the steps' own settings, so
// filling one in edits the graph, and running it is running the workflow.

import type { MediaCatalog } from "../types";
import { paramApplies } from "./models";
import {
  fedParams,
  maybeNodeSchema,
  type ParamSchema,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./schema";

export interface AppField {
  nodeId: string;
  param: string;
  /** What the app calls it, when not the step's own label. */
  label?: string;
}

export interface WorkflowApp {
  /** What a person fills in, in the order they meet it. */
  fields: AppField[];
  /** The steps whose results the app shows, in order. */
  outputs: string[];
  /** A sentence above the form saying what the app is for. */
  intro?: string;
}

/** Settings an app never shows: plumbing the canvas keeps for itself. */
const HIDDEN_TYPES = new Set<ParamSchema["type"]>(["note", "zone"]);

/** Steps whose result is worth showing in an app. */
const RESULT_TYPES = new Set<WorkflowNodeType>([
  "output",
  "image",
  "imageEdit",
  "zoneEdit",
  "sheet",
  "upscale",
  "cutout",
  "video",
  "tts",
  "music",
  "soundMix",
  "assemble",
  "chat",
  "compare",
]);

/** An app read back from storage, keeping only what makes sense. */
export function cleanApp(raw: unknown): WorkflowApp | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const fields = Array.isArray(record.fields)
    ? record.fields.flatMap((entry): AppField[] => {
        if (!entry || typeof entry !== "object") return [];
        const { nodeId, param, label } = entry as Record<string, unknown>;
        if (typeof nodeId !== "string" || typeof param !== "string") return [];
        return [{ nodeId, param, ...(typeof label === "string" && label.trim() ? { label } : {}) }];
      })
    : [];
  const outputs = Array.isArray(record.outputs)
    ? record.outputs.filter((id): id is string => typeof id === "string")
    : [];
  const intro = typeof record.intro === "string" && record.intro.trim() ? record.intro : undefined;
  if (fields.length === 0 && outputs.length === 0) return undefined;
  return { fields, outputs, ...(intro ? { intro } : {}) };
}

/** The settings of a step an app may show: those the chosen model has, not
 * taken from a connection, and not the canvas's own plumbing. */
export function exposableParams(node: WorkflowNode, catalog: MediaCatalog): ParamSchema[] {
  const schema = maybeNodeSchema(node.type);
  if (!schema || node.type === "block" || node.type === "note") return [];
  const fed = new Set(fedParams(node.params));
  return schema.params.filter(
    (param) =>
      !HIDDEN_TYPES.has(param.type) &&
      !fed.has(param.name) &&
      paramApplies(param, node.params, catalog),
  );
}

/** Steps whose results an app may show. */
export function resultSteps(workflow: Pick<Workflow, "nodes">): WorkflowNode[] {
  return workflow.nodes.filter((node) => RESULT_TYPES.has(node.type));
}

/** A field as the form draws it, or none when its step or setting is gone. */
export interface ShownField {
  field: AppField;
  node: WorkflowNode;
  param: ParamSchema;
}

export function shownFields(
  app: WorkflowApp | undefined,
  workflow: Pick<Workflow, "nodes">,
  catalog: MediaCatalog,
): ShownField[] {
  if (!app) return [];
  return app.fields.flatMap((field) => {
    const node = workflow.nodes.find((entry) => entry.id === field.nodeId);
    const param = node
      ? exposableParams(node, catalog).find((entry) => entry.name === field.param)
      : undefined;
    return node && param ? [{ field, node, param }] : [];
  });
}

/** Whether a workflow opens as an app: it has something to fill in. */
export function isApp(workflow: Pick<Workflow, "app">): boolean {
  return (workflow.app?.fields.length ?? 0) > 0;
}

/** A first app for a workflow that has none: its words and its pictures to
 * fill in, and what reaches its outputs (or its last steps) to get. The
 * builder starts from it; nothing is kept until the person keeps it. */
export function suggestApp(workflow: Pick<Workflow, "nodes" | "edges">): WorkflowApp {
  const fields: AppField[] = [];
  for (const node of workflow.nodes) {
    if (node.type === "textInput") fields.push({ nodeId: node.id, param: "text" });
    if (node.type === "textList") fields.push({ nodeId: node.id, param: "items" });
    if (node.type === "asset") fields.push({ nodeId: node.id, param: "artifactId" });
    if (node.type === "imageList") fields.push({ nodeId: node.id, param: "artifactIds" });
  }
  const outputs = workflow.nodes.filter((node) => node.type === "output").map((node) => node.id);
  const fed = new Set(workflow.edges.map((edge) => edge.source));
  const last = resultSteps(workflow)
    .filter((node) => !fed.has(node.id))
    .map((node) => node.id);
  return { fields, outputs: outputs.length > 0 ? outputs : last };
}

/** The app with a field moved one place up or down. */
export function moveField(app: WorkflowApp, index: number, by: -1 | 1): WorkflowApp {
  const to = index + by;
  if (to < 0 || to >= app.fields.length) return app;
  const fields = [...app.fields];
  [fields[index], fields[to]] = [fields[to], fields[index]];
  return { ...app, fields };
}

/** The app with a setting shown or hidden. */
export function toggleField(app: WorkflowApp, nodeId: string, param: string): WorkflowApp {
  const has = app.fields.some((field) => field.nodeId === nodeId && field.param === param);
  return {
    ...app,
    fields: has
      ? app.fields.filter((field) => !(field.nodeId === nodeId && field.param === param))
      : [...app.fields, { nodeId, param }],
  };
}

/** The app with a result shown or hidden. */
export function toggleOutput(app: WorkflowApp, nodeId: string): WorkflowApp {
  return {
    ...app,
    outputs: app.outputs.includes(nodeId)
      ? app.outputs.filter((id) => id !== nodeId)
      : [...app.outputs, nodeId],
  };
}

/** The app of a graph whose steps were given new ids (a copied template, an
 * imported file); fields and results whose step is gone are let go. */
export function appWithIds(
  app: WorkflowApp | undefined,
  ids: ReadonlyMap<string, string>,
): WorkflowApp | undefined {
  if (!app) return undefined;
  return cleanApp({
    ...app,
    fields: app.fields.flatMap((field) => {
      const nodeId = ids.get(field.nodeId);
      return nodeId ? [{ ...field, nodeId }] : [];
    }),
    outputs: app.outputs.flatMap((id) => {
      const nodeId = ids.get(id);
      return nodeId ? [nodeId] : [];
    }),
  });
}
