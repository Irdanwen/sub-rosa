// Undo and redo for the workflow canvas (ComfyUI's change tracker): a stack
// of graph snapshots, fifty deep, where a snapshot equal to the last one is
// not a step.

import type { Workflow } from "./schema";
import { stableJson } from "./stable-json";

export type GraphSnapshot = Pick<Workflow, "nodes" | "edges" | "frames" | "blocks">;

const DEPTH = 50;

export class GraphHistory {
  private past: Array<{ graph: GraphSnapshot; key: string }> = [];
  private future: Array<{ graph: GraphSnapshot; key: string }> = [];

  /** Start over from a freshly opened graph. */
  reset(graph: GraphSnapshot): void {
    this.past = [{ graph, key: stableJson(graph) }];
    this.future = [];
  }

  /** Record the graph as it now is; a change makes redo impossible. */
  record(graph: GraphSnapshot): void {
    const key = stableJson(graph);
    if (this.past.at(-1)?.key === key) return;
    this.past.push({ graph, key });
    if (this.past.length > DEPTH + 1) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 1;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** The graph to show after undoing, or nothing to undo. */
  undo(): GraphSnapshot | undefined {
    if (!this.canUndo()) return undefined;
    const step = this.past.pop();
    if (step) this.future.push(step);
    return this.past.at(-1)?.graph;
  }

  redo(): GraphSnapshot | undefined {
    const step = this.future.pop();
    if (!step) return undefined;
    this.past.push(step);
    return step.graph;
  }
}
