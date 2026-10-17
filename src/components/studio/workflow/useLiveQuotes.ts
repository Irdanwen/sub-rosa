// Video prices while the graph is being edited: each quotable step is quoted
// once per set of pricing settings (model, duration, ratio, resolution,
// sound), one quote at a time, a moment after editing stops, with a single
// attempt (a rate limit costs a figure, never a wait). The static estimate
// stays wherever no quote has answered.

import { useEffect, useMemo, useState } from "react";
import { mediaJsonOnce } from "../../../lib/studio/client";
import { estimateWorkflowCost, quoteBody, quoteVideoNode } from "../../../lib/studio/workflow/cost";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import { stableJson } from "../../../lib/studio/workflow/stable-json";
import type { MediaCatalog } from "../../../lib/studio/types";

/** How long the graph must sit still before anything is quoted. */
const SETTLE_MS = 500;

/** Quotes already answered, by pricing settings, for the session. A miss is
 * remembered too (as undefined), so a family the quote refuses is not asked
 * again on every edit. */
const answered = new Map<string, number | undefined>();

/** Node id to quoted credits. */
export function useLiveQuotes(
  workflow: Pick<Workflow, "nodes"> | undefined,
  catalog: MediaCatalog,
): Map<string, number> {
  const multiplier = catalog.priceMultiplier ?? 1;
  const wanted = useMemo(() => {
    if (!workflow) return [];
    const quotable = new Set(
      estimateWorkflowCost(workflow, catalog)
        .nodes.filter((node) => node.quotable)
        .map((node) => node.nodeId),
    );
    return workflow.nodes
      .filter((node) => quotable.has(node.id))
      .map((node) => ({ node, key: `${multiplier}:${stableJson(quoteBody(node))}` }));
  }, [workflow, catalog, multiplier]);
  const wantedKey = wanted.map((entry) => `${entry.node.id}=${entry.key}`).join("|");
  const [quotes, setQuotes] = useState<Map<string, number>>(() => new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedKey stands in for the list, which re-identifies on every render.
  useEffect(() => {
    let cancelled = false;
    const collect = () =>
      new Map(
        wanted.flatMap(({ node, key }) => {
          const credits = answered.get(key);
          return credits === undefined ? [] : [[node.id, credits] as const];
        }),
      );
    setQuotes(collect());
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const { node, key } of wanted) {
          if (cancelled) return;
          if (answered.has(key)) continue;
          answered.set(key, await quoteVideoNode(node, multiplier, mediaJsonOnce));
          if (!cancelled) setQuotes(collect());
        }
      })();
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wantedKey, multiplier]);
  return quotes;
}

/** Tests only: forget what was quoted. */
export function resetLiveQuotesForTests(): void {
  answered.clear();
}
