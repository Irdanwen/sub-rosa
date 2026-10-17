// Asking the Studio to open a workflow from anywhere (the gallery viewer's
// "Open the workflow that made it"). Detail: the workflow id.

export const OPEN_WORKFLOW_EVENT = "subrosa:open-workflow";

export function requestOpenWorkflow(workflowId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKFLOW_EVENT, { detail: workflowId }));
}
