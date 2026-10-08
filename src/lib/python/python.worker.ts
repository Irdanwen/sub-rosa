// The phone's Python (ADR-0086): Pyodide in a worker, so a long computation
// never freezes the chat, and so stopping one is as blunt as terminating the
// worker. Pyodide is read from the app's own bundle (`/pyodide/`), the first
// time a run needs it; nothing here reaches the network. The worker's body
// is shared with the web client (`@subrosa/chat-core/python/worker`).

import { startPythonWorker, type WorkerScope } from "@subrosa/chat-core/python/worker";

// Relative to this module's own URL: the iPhone serves the app from a custom
// scheme whose origin reads "null", and the worker's location is the blob it
// was started from (worker-url.ts), which is no base for a path.
startPythonWorker(self as unknown as WorkerScope, new URL("/pyodide/", import.meta.url).href);
