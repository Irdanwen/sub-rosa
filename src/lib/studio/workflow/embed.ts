// The workflow a gallery file carries out when the person saves a copy "with
// its workflow": the graph its run froze, which is exactly what made it, or
// the workflow as it now stands when that run has been pruned. Written into
// the copy by Rust (workflow_embed.rs) and read back by the importer
// (comfy/embedded.ts), so the copy dropped on the library opens the graph.

import { t } from "../../i18n";
import type { WorkflowOrigin } from "../types";
import { frozenWorkflow } from "../workflow-run";
import { workflowFileText } from "./comfy/file";
import { writtenGraph } from "./flatten";
import { listWorkflows, loadWorkflowLibrary } from "./store";

/** The workflow file to write into a copy of what `origin` made, or nothing
 * when neither its run nor its workflow is still here. */
export async function workflowFileFor(origin: WorkflowOrigin): Promise<string | undefined> {
  await loadWorkflowLibrary();
  const stored = listWorkflows().find((entry) => entry.id === origin.workflowId);
  const frozen = origin.runId
    ? await frozenWorkflow(origin.runId).catch(() => undefined)
    : undefined;
  // A run with blocks froze the flat graph it ran and the one written with
  // its blocks (flatten.ts); the copy carries the written one.
  const written = frozen ? writtenGraph(frozen) : undefined;
  const { written: _flat, ...extra } = frozen?.extra ?? {};
  const workflow = frozen
    ? {
        ...frozen,
        ...(written ? { nodes: written.nodes, edges: written.edges, blocks: written.blocks } : {}),
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        name: stored?.name ?? frozen.name ?? t("Workflow"),
        // Frames are layout, never frozen with a run: the workflow's own.
        ...(stored?.frames ? { frames: stored.frames } : {}),
      }
    : stored;
  return workflow ? workflowFileText(workflow, { compact: true }) : undefined;
}
