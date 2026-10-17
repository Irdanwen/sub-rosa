// Which level of the workflow the canvas shows: the workflow itself, or the
// inside of a block step (ADR-0116), entered through one instance so its
// steps show that instance's results. Whatever the level, what is saved,
// validated, priced and run is always the whole workflow: the level's steps
// are written back into their block as they are edited.

import type { Edge as FlowEdge } from "@xyflow/react";
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from "react";
import type { BlockGraph } from "../../../lib/studio/workflow/blocks";
import type { Workflow, WorkflowFrame } from "../../../lib/studio/workflow/schema";
import { fromFlow, type StudioFlowNode } from "./flow";

export interface ScopeLevel {
  /** The block step entered (its id at the level above). */
  instanceId: string;
  blockId: string;
}

/** The workflow with the steps the canvas shows written in where they live. */
export function composeRoot(
  root: Workflow,
  scope: readonly ScopeLevel[],
  nodes: StudioFlowNode[],
  edges: FlowEdge[],
  frames: WorkflowFrame[],
): Workflow {
  const inside = scope.at(-1);
  if (!inside) return fromFlow(root, nodes, edges, frames);
  const level = fromFlow({ ...root, frames: [] }, nodes, edges, []);
  return {
    ...root,
    blocks: (root.blocks ?? []).map((block) =>
      block.id === inside.blockId ? { ...block, nodes: level.nodes, edges: level.edges } : block,
    ),
  };
}

/** The workflow with a level's graph (as an edit returned it) written back. */
export function withLevel(
  root: Workflow,
  scope: readonly ScopeLevel[],
  graph: BlockGraph,
): Workflow {
  const inside = scope.at(-1);
  if (!inside) {
    const { blocks: _previous, ...rest } = root;
    return {
      ...rest,
      nodes: graph.nodes,
      edges: graph.edges,
      ...(graph.blocks?.length ? { blocks: graph.blocks } : {}),
    };
  }
  return {
    ...root,
    blocks: (graph.blocks ?? root.blocks ?? []).map((block) =>
      block.id === inside.blockId ? { ...block, nodes: graph.nodes, edges: graph.edges } : block,
    ),
  };
}

export function useBlockScope(options: {
  currentRef: { current: Workflow | undefined };
  setCurrent: Dispatch<SetStateAction<Workflow | undefined>>;
  setFrames: (frames: WorkflowFrame[]) => void;
  /** Put a graph on the canvas (steps and wires). */
  draw: (workflow: Workflow) => void;
  fitView: () => void;
}) {
  const { currentRef, setCurrent, setFrames, draw, fitView } = options;
  const [scope, setScope] = useState<ScopeLevel[]>([]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const path = useMemo(() => scope.map((level) => level.instanceId), [scope]);

  /** Show `root` at the level `next` leads to (as deep as it still exists). */
  const show = useCallback(
    (root: Workflow, next: readonly ScopeLevel[]) => {
      const kept: ScopeLevel[] = [];
      for (const level of next) {
        if (!root.blocks?.some((block) => block.id === level.blockId)) break;
        kept.push(level);
      }
      const inside = kept.at(-1);
      const block = inside ? root.blocks?.find((entry) => entry.id === inside.blockId) : undefined;
      setScope(kept);
      draw(block ? { ...root, nodes: block.nodes, edges: block.edges } : root);
      setFrames(block ? [] : (root.frames ?? []));
    },
    [draw, setFrames],
  );

  /** Make `root` the workflow, staying at the level shown when it can. */
  const applyRoot = useCallback(
    (root: Workflow) => {
      currentRef.current = root;
      setCurrent(root);
      show(root, scopeRef.current);
    },
    [currentRef, setCurrent, show],
  );

  /** Go into a block step shown at the current level. */
  const enter = useCallback(
    (root: Workflow, instanceId: string, blockId: string) => {
      currentRef.current = root;
      setCurrent(root);
      show(root, [...scopeRef.current, { instanceId, blockId }]);
      window.setTimeout(fitView, 0);
    },
    [currentRef, setCurrent, show, fitView],
  );

  /** Come back up to `depth` levels deep (0: the workflow). */
  const leave = useCallback(
    (root: Workflow, depth: number) => {
      currentRef.current = root;
      setCurrent(root);
      show(root, scopeRef.current.slice(0, depth));
      window.setTimeout(fitView, 0);
    },
    [currentRef, setCurrent, show, fitView],
  );

  const reset = useCallback(() => setScope([]), []);

  return { scope, path, applyRoot, enter, leave, reset };
}
