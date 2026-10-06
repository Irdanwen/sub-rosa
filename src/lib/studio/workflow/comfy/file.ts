// Reading and writing a workflow file: Sub Rosa's own export, and ComfyUI's
// two formats, which are translated (ADR-0075).

import { t } from "../../../i18n";
import type { MediaCatalog } from "../../types";
import { maybeNodeSchema, type Workflow, WORKFLOW_FILE_VERSION } from "../schema";
import { type ComfyImport, detectWorkflowFile, translateComfy } from "./translate";

/** The largest file worth reading: a real workflow is a few hundred KB. */
export const MAX_WORKFLOW_FILE_BYTES = 5 * 1024 * 1024;

export interface WorkflowFile {
  format: "subrosa-workflow";
  version: number;
  workflow: Pick<Workflow, "name" | "description" | "nodes" | "edges">;
}

export function workflowFileText(workflow: Workflow): string {
  const file: WorkflowFile = {
    format: "subrosa-workflow",
    version: WORKFLOW_FILE_VERSION,
    workflow: {
      name: workflow.name,
      ...(workflow.description ? { description: workflow.description } : {}),
      nodes: workflow.nodes,
      edges: workflow.edges,
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ReadWorkflow =
  | { kind: "subrosa"; workflow: WorkflowFile["workflow"] }
  | { kind: "comfy"; result: ComfyImport };

export class WorkflowFileError extends Error {}

/** A file's text, as a workflow ready to save, or the reason it is not one. */
export function readWorkflowFile(text: string, catalog: MediaCatalog, fileName = ""): ReadWorkflow {
  if (text.length > MAX_WORKFLOW_FILE_BYTES)
    throw new WorkflowFileError(t("This file is too large to be a workflow."));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorkflowFileError(t("This file is not valid JSON."));
  }
  const format = detectWorkflowFile(json);
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  if (format === "subrosa") {
    const file = json as Partial<WorkflowFile>;
    if (typeof file.version !== "number" || file.version > WORKFLOW_FILE_VERSION)
      throw new WorkflowFileError(t("This workflow was saved by a newer version of Sub Rosa."));
    const workflow = file.workflow;
    if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges))
      throw new WorkflowFileError(t("This workflow file is incomplete."));
    const unknown = workflow.nodes.find((node) => !maybeNodeSchema(node.type));
    if (unknown)
      throw new WorkflowFileError(
        t("This workflow uses a step this version does not know: {step}.", {
          step: String(unknown.type),
        }),
      );
    return {
      kind: "subrosa",
      workflow: { ...workflow, name: workflow.name || stem || t("Imported workflow") },
    };
  }
  if (format === "comfy-ui" || format === "comfy-api") {
    const result = translateComfy(json, catalog);
    result.workflow.name = stem || t("Imported workflow");
    return { kind: "comfy", result };
  }
  throw new WorkflowFileError(t("This file is neither a Sub Rosa nor a ComfyUI workflow."));
}
