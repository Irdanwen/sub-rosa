// Which steps the next run will answer from the step cache (ADR-0115), known
// before anything runs: the static key of every cacheable step, looked up in
// the native table. What the canvas prices and badges from.

import { useEffect, useMemo, useState } from "react";
import { knownStepKeys } from "../../../lib/studio/workflow-run";
import { isPaidNode, type Workflow } from "../../../lib/studio/workflow/schema";
import { staticKeys } from "../../../lib/studio/workflow/signature";
import { stableJson } from "../../../lib/studio/workflow/stable-json";

/** How long the graph must sit still before the lookup runs. */
const SETTLE_MS = 400;

function cacheable(node: Workflow["nodes"][number]): boolean {
  if (node.params.freshEachRun === true) return false;
  return node.type === "assemble" || (node.type !== "gate" && isPaidNode(node));
}

/**
 * Keep only the hits whose paid ancestors are reused too. A step fed by one
 * that will make something new receives new inputs, so its cached result
 * will not match at run time and promising it free would be a lie.
 */
export function reusable(
  workflow: Pick<Workflow, "nodes" | "edges">,
  hits: Set<string>,
): Set<string> {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const verdict = new Map<string, boolean>();
  const holds = (id: string, seen: Set<string>): boolean => {
    const known = verdict.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return false;
    seen.add(id);
    const node = byId.get(id);
    const self = !node || !(node.type === "assemble" || isPaidNode(node)) || hits.has(id);
    const parents = workflow.edges.filter((edge) => edge.target === id).map((edge) => edge.source);
    const result = self && parents.every((parent) => holds(parent, seen));
    verdict.set(id, result);
    return result;
  };
  return new Set([...hits].filter((id) => holds(id, new Set())));
}

/** Node ids a run would reuse. Recomputed when what decides a step changes,
 * never while a node is only being dragged. `refreshKey` asks again (after a
 * run filed new results). */
export function useReusePrediction(
  workflow: Pick<Workflow, "nodes" | "edges"> | undefined,
  refreshKey: unknown,
): Set<string> {
  const [predicted, setPredicted] = useState<Set<string>>(() => new Set());
  const graphKey = useMemo(
    () =>
      workflow
        ? stableJson({
            nodes: workflow.nodes.map(({ position: _p, label: _l, ...rest }) => rest),
            edges: workflow.edges,
          })
        : "",
    [workflow],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: graphKey stands in for the graph, which re-identifies on every drag frame.
  useEffect(() => {
    if (!workflow) {
      setPredicted(new Set());
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const keys = await staticKeys(workflow);
        const wanted = workflow.nodes.filter(cacheable).flatMap((node) => {
          const key = keys.get(node.id);
          return key ? [[node.id, key] as const] : [];
        });
        const known = await knownStepKeys(wanted.map(([, key]) => key));
        if (cancelled) return;
        setPredicted(
          reusable(workflow, new Set(wanted.filter(([, key]) => known.has(key)).map(([id]) => id))),
        );
      })().catch(() => undefined);
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graphKey, refreshKey]);
  return predicted;
}
