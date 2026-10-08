// The web client's Python (ADR-0086 on the web): the app's worker body, with
// Pyodide served from the site's own origin under its base path. Started from
// a blob (worker-url.ts), so it runs under the page's own policy.

import { startPythonWorker, type WorkerScope } from "@subrosa/chat-core/python/worker";
import { ANALYSIS } from "./exported";

startPythonWorker(
  self as unknown as WorkerScope,
  new URL(`${import.meta.env.BASE_URL}pyodide/`, import.meta.url).href,
  ANALYSIS.messages.noNetwork,
);
