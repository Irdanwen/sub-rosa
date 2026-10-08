// The phone's Python (ADR-0086): Pyodide in a worker, so a long computation
// never freezes the chat, and so stopping one is as blunt as terminating the
// worker. Pyodide is read from the app's own bundle (`/pyodide/`), the first
// time a run needs it; nothing here reaches the network.

import type { WorkerRun } from "./protocol";
import { createRunner, guardFetch, type PyodideLike } from "./runner";

type WorkerScope = {
  fetch: typeof fetch;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<WorkerRun>) => void) | null;
};

const scope = self as unknown as WorkerScope;

// Relative to this module's own URL: the iPhone serves the app from a custom
// scheme whose origin reads "null", and the worker's location is the blob it
// was started from (worker-url.ts), which is no base for a path.
const indexURL = new URL("/pyodide/", import.meta.url).href;
guardFetch(scope, indexURL);

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
