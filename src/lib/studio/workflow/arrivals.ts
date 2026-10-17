// What the open canvas does when another device's change to its workflow
// arrives (ADR-0118). The canvas is never interrupted by a run: an arrival
// waits for the run to end. A change this device made since its last save is
// the newest thing anyone did, so it stays; otherwise the canvas shows what
// arrived, or, if the workflow was deleted there, the next one.

import { sameWorkflow } from "./library";
import type { Workflow } from "./schema";

/** Whether two copies say the same thing the editor would save. */
export function sameDefinition(a: Workflow, b: Workflow): boolean {
  return (
    sameWorkflow(a, b) &&
    (a.description ?? "") === (b.description ?? "") &&
    Boolean(a.readOnly) === Boolean(b.readOnly)
  );
}

export type Arrival =
  /** Nothing to redraw: the canvas already shows it, or holds a newer edit. */
  | { kind: "keep" }
  /** Redraw the canvas from the library's copy. */
  | { kind: "open"; workflow: Workflow }
  /** Gone on another device: open the next one. */
  | { kind: "gone" };

export function settleArrival(input: {
  /** The library's copy before the arrival, the last one the canvas agreed with. */
  base: Workflow | undefined;
  /** The library's copy now. */
  fresh: Workflow | undefined;
  /** The graph on the canvas, as it would be saved. */
  canvas: Workflow | undefined;
}): Arrival {
  const { base, fresh, canvas } = input;
  if (canvas && base && !sameDefinition(base, canvas)) return { kind: "keep" };
  if (!fresh) return base ? { kind: "gone" } : { kind: "keep" };
  if (canvas && sameDefinition(fresh, canvas)) return { kind: "keep" };
  return { kind: "open", workflow: fresh };
}
