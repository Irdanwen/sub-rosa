// What each open workflow's run is doing, kept apart per workflow so a run
// goes on while the canvas shows another tab. The canvas shows the session
// of the workflow it has open; the tabs show every session's status. A run's
// state is still durable rows (ADR-0021): a session is only what this window
// remembers of them while it is open.

import type { WorkflowCostEstimate } from "./cost";
import type { NodeRunResult } from "./run-types";
import type { Workflow } from "./schema";

export interface RunSession {
  running: boolean;
  /** What the steps show, newest first. A new map at every change. */
  results: Map<string, NodeRunResult>;
  /** The durable run this session started or resumed, for its gates. */
  runId?: string;
  abort?: AbortController;
  /** The graph that runs, flat: where a step's model and kind are read. */
  graph?: Workflow;
  /** The figures the run was started with, for a gate approved later. */
  estimate?: WorkflowCostEstimate;
  /** When each render of a run started here began; a resume is not timed. */
  renderStarts?: Map<string, number>;
  /** How the last run ended, until the person opens its tab. */
  outcome?: "done" | "failed";
  /** What stopped it, said again when its tab opens. */
  error?: string;
}

export type TabStatus = "running" | "held" | "failed" | "done";

const EMPTY: ReadonlyMap<string, NodeRunResult> = new Map();

export class RunSessions {
  private readonly sessions = new Map<string, RunSession>();

  get(id: string | undefined): RunSession | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  results(id: string | undefined): Map<string, NodeRunResult> {
    return (this.get(id)?.results ?? EMPTY) as Map<string, NodeRunResult>;
  }

  running(id: string | undefined): boolean {
    return this.get(id)?.running ?? false;
  }

  private ensure(id: string): RunSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { running: false, results: new Map() };
      this.sessions.set(id, session);
    }
    return session;
  }

  /** A run starts: the previous one of this workflow, if any, is stopped.
   * `keep` names the steps whose results stay (a partial run). */
  begin(
    id: string,
    start: {
      graph?: Workflow;
      estimate?: WorkflowCostEstimate;
      timed: boolean;
      keep?: (nodeId: string) => boolean;
      runId?: string;
    },
  ): AbortController {
    const session = this.ensure(id);
    session.abort?.abort();
    const controller = new AbortController();
    session.abort = controller;
    session.running = true;
    session.outcome = undefined;
    session.error = undefined;
    session.graph = start.graph ?? session.graph;
    session.estimate = start.estimate ?? session.estimate;
    session.renderStarts = start.timed ? new Map() : undefined;
    if (start.runId) session.runId = start.runId;
    const keep = start.keep;
    session.results = keep
      ? new Map([...session.results].filter(([nodeId]) => keep(nodeId)))
      : new Map();
    return controller;
  }

  /** A step's news. Returns the session, for what else reads it. */
  record(id: string, result: NodeRunResult): RunSession {
    const session = this.ensure(id);
    session.results = new Map(session.results).set(result.nodeId, result);
    return session;
  }

  /** Show results that did not come from a run here (history, a restore). */
  show(id: string, next: (live: Map<string, NodeRunResult>) => Map<string, NodeRunResult>): void {
    const session = this.ensure(id);
    session.results = next(session.results);
  }

  setRunId(id: string, runId: string): void {
    this.ensure(id).runId = runId;
  }

  /** The run is over. A cancelled run leaves no outcome to point at. */
  end(id: string, outcome: "done" | "failed" | "cancelled"): void {
    const session = this.ensure(id);
    session.running = false;
    session.abort = undefined;
    session.renderStarts = undefined;
    const failedStep = [...session.results.values()].some((result) => result.status === "error");
    session.outcome =
      outcome === "cancelled"
        ? undefined
        : outcome === "failed" || failedStep || session.error
          ? "failed"
          : "done";
  }

  /** What stopped the run, kept for when its tab opens. */
  fail(id: string, message: string): void {
    const session = this.ensure(id);
    session.error = message;
    session.outcome = "failed";
  }

  stop(id: string | undefined): void {
    this.get(id)?.abort?.abort();
  }

  /** The person opened the tab: what it ended with has been seen. */
  seen(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.outcome = undefined;
  }

  /** Forget a workflow that is gone. A live run of it is stopped. */
  forget(id: string): void {
    this.stop(id);
    this.sessions.delete(id);
  }

  status(id: string): TabStatus | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const held = [...session.results.values()].some((result) => result.status === "awaiting");
    if (session.running) return held ? "held" : "running";
    if (held) return "held";
    return session.outcome;
  }

  /** Workflows with a run going on, for the window to say before closing. */
  live(): string[] {
    return [...this.sessions].filter(([, session]) => session.running).map(([id]) => id);
  }
}
