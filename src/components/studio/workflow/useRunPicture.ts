// What the canvas knows about the next run before it starts: the graph as
// it will run (blocks put in place, steps set aside resolved away), what is
// wrong with it, which steps the cache will answer, and what each step
// costs. Everything is worked out on the flat graph the engine runs and
// lifted back onto the steps the person drew (lift.ts, ADR-0116).

import { useMemo } from "react";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  estimateWorkflowCost,
  isPaidNode,
  type ValidationIssue,
  validateWorkflow,
  type Workflow,
  withReusedSteps,
} from "../../../lib/studio/workflow";
import { flattenBlocks } from "../../../lib/studio/workflow/flatten";
import { liftIssues, liftPrices, liftReused, viewAt } from "../../../lib/studio/workflow/lift";
import { applyModes } from "../../../lib/studio/workflow/modes";
import { useLiveQuotes } from "./useLiveQuotes";
import { useReusePrediction } from "./useReusePrediction";

export function useRunPicture(
  serialized: Workflow | undefined,
  catalog: MediaCatalog,
  runEpoch: number,
  /** The block steps the canvas is inside (none: the workflow itself). */
  path: readonly string[] = [],
) {
  const flattened = useMemo(
    () => (serialized ? flattenBlocks(serialized) : undefined),
    [serialized],
  );
  /** The graph a run executes: blocks put in place, steps set aside
   * resolved away (modes.ts). */
  const effective = useMemo(
    () => (flattened ? applyModes(flattened.workflow) : undefined),
    [flattened],
  );
  /** The level the canvas shows, seen from the flat graph. */
  const stepView = useMemo(
    () => (flattened ? viewAt(flattened, path) : undefined),
    [flattened, path],
  );
  /** What is wrong, said on the steps as drawn. */
  const validation = useMemo(() => {
    if (!effective || !flattened || !stepView) return undefined;
    const checked = validateWorkflow(effective);
    const errors = liftIssues([...flattened.issues, ...checked.errors], stepView);
    return {
      ok: errors.length === 0,
      errors,
      warnings: liftIssues(checked.warnings, stepView),
    };
  }, [effective, flattened, stepView]);
  /** The flat steps the cache will answer (what a run's price reads). */
  const reused = useReusePrediction(effective, runEpoch);
  const liveQuotes = useLiveQuotes(effective, catalog);
  const estimate = useMemo(
    () =>
      effective
        ? withReusedSteps(estimateWorkflowCost(effective, catalog, liveQuotes), reused)
        : undefined,
    [effective, catalog, reused, liveQuotes],
  );
  /** The steps as drawn that the cache will answer, block steps included. */
  const reusedShown = useMemo(
    () =>
      stepView && effective
        ? liftReused(
            reused,
            stepView,
            new Set(effective.nodes.filter(isPaidNode).map((node) => node.id)),
          )
        : reused,
    [reused, stepView, effective],
  );
  const priceByNode = useMemo(
    () => (stepView ? liftPrices(estimate?.nodes ?? [], stepView) : new Map<string, never>()),
    [estimate, stepView],
  );
  /** Each step's own problems, so they show on the step itself. */
  const issuesByNode = useMemo(() => {
    const byNode = new Map<string, ValidationIssue[]>();
    for (const issue of [...(validation?.errors ?? []), ...(validation?.warnings ?? [])]) {
      if (!issue.nodeId) continue;
      byNode.set(issue.nodeId, [...(byNode.get(issue.nodeId) ?? []), issue]);
    }
    return byNode;
  }, [validation]);
  return {
    flattened,
    effective,
    validation,
    reused,
    reusedShown,
    liveQuotes,
    estimate,
    priceByNode,
    issuesByNode,
    stepView,
  };
}
