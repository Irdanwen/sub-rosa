// The body of the Python worker (ADR-0086), shared by the phone's webview and
// the web client: Pyodide read from the surface's own origin under
// `indexURL`, the first time a run needs it, and every other fetch refused at
// once. Each surface keeps a one-line worker entry of its own, because where
// its Pyodide is served from is its own business. Before anything else the
// worker closes its ways out (`hardenScope`), and Python's `js` module is a
// few timers, not the worker's global (ADR-0086 addendum of 2026-10-10).

import { type HardenableScope, hardenScope, pythonJsGlobals } from "./harden";
import type { WorkerRun } from "./protocol";
import { createRunner, guardFetch, type PyodideLike } from "./runner";

export type WorkerScope = HardenableScope & {
  onmessage: ((event: MessageEvent<WorkerRun>) => void) | null;
  setTimeout(callback: () => void, delay?: number): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask(callback: () => void): void;
};

/** The slice of Pyodide 0.29's loader the worker calls. */
export type PyodideModule = {
  loadPyodide(options: { indexURL: string; jsglobals?: object }): Promise<PyodideLike>;
};

/** Starts answering runs in `scope`, a dedicated worker's global. `load`
 * stands in for importing Pyodide, for the tests. */
export function startPythonWorker(
  scope: WorkerScope,
  indexURL: string,
  refusal?: string,
  load: (url: string) => Promise<PyodideModule> = (url) => import(/* @vite-ignore */ url),
) {
  const hardened = hardenScope(scope);
  guardFetch(scope, indexURL, refusal, hardened.fetch);
  const jsglobals = pythonJsGlobals(scope);
  const runner = createRunner(async () => {
    // Fail closed: a worker that could still reach one of these never runs
    // Python, and the tool says Python is unavailable.
    if (hardened.remaining.length > 0)
      throw new Error(`the sandbox could not close ${hardened.remaining.join(", ")}`);
    const module = await load(`${indexURL}pyodide.mjs`);
    return module.loadPyodide({ indexURL, jsglobals });
  });
  scope.onmessage = (event) => {
    if (event.data?.type !== "run") return;
    void runner.run(event.data).then((done) => hardened.postMessage(done));
  };
}
