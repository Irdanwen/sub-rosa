// The workflow a gallery file carries out when the person saves a copy "with
// its workflow": the graph its run froze, which is exactly what made it, or
// the workflow as it now stands when that run has been pruned. Written into
// the copy by Rust (workflow_embed.rs) and read back by the importer
// (comfy/embedded.ts), so the copy dropped on the library opens the graph.

import { t } from "../../i18n";
import type { WorkflowOrigin } from "../types";
import { frozenWorkflow } from "../workflow-run";
import { workflowFileText } from "./comfy/file";
import { listWorkflows, loadWorkflowLibrary } from "./store";

/** The workflow file to write into a copy of what `origin` made, or nothing
 * when neither its run nor its workflow is still here. */
export async function workflowFileFor(origin: WorkflowOrigin): Promise<string | undefined> {
  await loadWorkflowLibrary();
  const stored = listWorkflows().find((entry) => entry.id === origin.workflowId);
  const frozen = origin.runId
    ? await frozenWorkflow(origin.runId).catch(() => undefined)
    : undefined;
  const workflow = frozen
    ? { ...frozen, name: stored?.name ?? frozen.name ?? t("Workflow") }
    : stored;
  return workflow ? workflowFileText(workflow, { compact: true }) : undefined;
}
