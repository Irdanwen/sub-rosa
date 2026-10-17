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
import { liftIssues, liftPrices, liftReused } from "../../../lib/studio/workflow/lift";
import { applyModes } from "../../../lib/studio/workflow/modes";
import { useLiveQuotes } from "./useLiveQuotes";
import { useReusePrediction } from "./useReusePrediction";

export function useRunPicture(
  serialized: Workflow | undefined,
  catalog: MediaCatalog,
  runEpoch: number,
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
  /** What is wrong, said on the steps as drawn. */
  const validation = useMemo(() => {
    if (!effective || !flattened) return undefined;
    const checked = validateWorkflow(effective);
    const errors = liftIssues([...flattened.issues, ...checked.errors], flattened);
    return {
      ok: errors.length === 0,
      errors,
      warnings: liftIssues(checked.warnings, flattened),
    };
  }, [effective, flattened]);
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
      flattened && effective
        ? liftReused(
            reused,
            flattened,
            new Set(effective.nodes.filter(isPaidNode).map((node) => node.id)),
          )
        : reused,
    [reused, flattened, effective],
  );
  const priceByNode = useMemo(
    () => (flattened ? liftPrices(estimate?.nodes ?? [], flattened) : new Map<string, never>()),
    [estimate, flattened],
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
  };
}
