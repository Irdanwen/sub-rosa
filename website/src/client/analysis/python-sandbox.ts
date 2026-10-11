// The entry of /python-sandbox.html: the frame that holds the web client's
// Python worker (sandbox-frame.ts). It imports nothing the page imports, so
// the build keeps it in its own `python-sandbox` chunk, the only scripts the
// frame's policy and the server's CORS headers admit.

import workerScript from "./python-sandbox.worker.ts?worker&url";
import { serveSandbox } from "./sandbox-frame";

serveSandbox(window, new URL(workerScript, window.location.href).href);
