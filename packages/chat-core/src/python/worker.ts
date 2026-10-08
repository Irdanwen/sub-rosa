// The body of the Python worker (ADR-0086), shared by the phone's webview and
// the web client's tab: Pyodide read from the surface's own origin under
// `indexURL`, the first time a run needs it, and every other fetch refused at
// once. Each surface keeps a one-line worker entry of its own, because where
// its Pyodide is served from is its own business.

import type { WorkerRun } from "./protocol";
import { createRunner, guardFetch, type PyodideLike } from "./runner";

export type WorkerScope = {
  fetch: typeof fetch;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<WorkerRun>) => void) | null;
};

/** Starts answering runs in `scope`, a dedicated worker's global. */
export function startPythonWorker(scope: WorkerScope, indexURL: string, refusal?: string) {
  guardFetch(scope, indexURL, refusal);
  const runner = createRunner(async () => {
    const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
      loadPyodide(options: { indexURL: string }): Promise<PyodideLike>;
    };
    return module.loadPyodide({ indexURL });
  });
  scope.onmessage = (event) => {
    if (event.data?.type !== "run") return;
    void runner.run(event.data).then((done) => scope.postMessage(done));
  };
}
