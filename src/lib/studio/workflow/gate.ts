// The gate node: hold the run for an approval, or let a judge speak first.

import { judge, type JudgeVerdict, verdictLine } from "../judge";
import type { WorkflowEdge, WorkflowNode } from "./schema";
import { type NodeOutput, type NodeRunResult, GateHold } from "./run-types";
import { stringParam } from "./execute-node";

/**
 * A gate either holds the run (no approval yet) or passes one upstream
 * candidate through untouched — parent links included, so an approved shot
 * still chains and trims like the shot it is.
 *
 * Three modes. `human` is what a gate has always been. `judged` asks a model
 * first and lets the work past on its own when the verdict clears the bar,
 * which is what makes a long production finish while nobody is watching.
 * `judged-then-human` always stops, but stops with an opinion attached.
 *
 * A judge never blocks: no model, a refusal, a timeout, an unreadable reply -
 * every one of them degrades to a plain human gate. An approval the user has
 * already given always wins, so re-running a judged gate after approving it
 * does not spend another judgement.
 */
export async function gateDecision(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
  approvedGates?: Map<string, string | undefined>,
  options?: {
    signal?: AbortSignal;
    /** The budget check, run just before the judge spends. */
    beforeJudge?: () => Promise<void>;
  },
): Promise<NodeOutput> {
  const inbound = edges.filter((edge) => edge.target === node.id);
  const candidates = inbound
    .map((edge) => ({ source: edge.source, output: results.get(edge.source)?.output }))
    .filter(
      (candidate): candidate is { source: string; output: NodeOutput } =>
        candidate.output !== undefined,
    );

  if (!approvedGates?.has(node.id)) {
    const verdict = await gateVerdict(node, candidates, options);
    const mode = stringParam(node.params, "mode") ?? "human";
    if (verdict && mode === "judged" && verdict.passes && candidates[0]) {
      return candidates[0].output;
    }
    throw new GateHold(verdict ? verdictLine(verdict) : undefined);
  }

  const choice = approvedGates.get(node.id);
  const picked = choice
    ? candidates.find((candidate) => candidate.source === choice)
    : candidates[0];
  if (!picked) {
    throw new Error("The approved candidate has no result to pass through.");
  }
  return picked.output;
}

/** What the judge says about a gate's candidates, or nothing at all. */
async function gateVerdict(
  node: WorkflowNode,
  candidates: ReadonlyArray<{ source: string; output: NodeOutput }>,
  options?: { signal?: AbortSignal; beforeJudge?: () => Promise<void> },
): Promise<JudgeVerdict | undefined> {
  const mode = stringParam(node.params, "mode") ?? "human";
  if (mode === "human") return undefined;
  const model = stringParam(node.params, "judgeModel") ?? "";
  if (!model) return undefined;
  const subjects = candidates
    .map((candidate, index) => ({
      label: `Candidate ${index + 1}`,
      imageDataUri:
        candidate.output.kind === "image"
          ? `data:${candidate.output.mimeType};base64,${candidate.output.base64}`
          : undefined,
    }))
    .filter((subject) => Boolean(subject.imageDataUri));
  if (subjects.length === 0) return undefined;
  // Unlike a judge that cannot answer, a refused budget is not something to
  // degrade past: it stops the run, the way it stops any paid node.
  await options?.beforeJudge?.();
  return judge(
    {
      subjects,
      brief: stringParam(node.params, "note") || undefined,
      lens: "continuity and composition",
    },
    model,
    options?.signal,
  );
}
