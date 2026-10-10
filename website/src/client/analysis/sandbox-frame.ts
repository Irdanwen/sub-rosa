// Inside /python-sandbox.html (ADR-0104 addendum of 2026-10-10). The page
// frames it with `sandbox="allow-scripts"` and nothing else, so the frame,
// and the worker it starts, have an opaque origin: none of the account
// origin's IndexedDB (the browser device's key, sealed connector tokens),
// storage or cookies is theirs to open, whatever Python finds in the worker.
// The frame's own policy lets it load the site's `/assets/` and `/pyodide/`
// and post to `/pyodide/` alone.
//
// The frame waits for the page to hand it a MessagePort, starts the worker
// from a one-line `data:` module (a worker from a local URL inherits the
// frame's policy; Chromium refuses a blob URL minted by an opaque origin as
// a worker script), and relays runs one way and answers the other. Kept free
// of anything the page imports, so the build gives it a chunk of its own
// (python-sandbox.ts).

/** Frame → page: ready for a port. Mirrored in worker-url.ts. */
export const SANDBOX_READY = "subrosa-python-sandbox-ready";
/** Page → frame: the port, the only channel from then on. */
export const SANDBOX_PORT = "subrosa-python-sandbox-port";
/** Frame → page, on the port: the worker could not start or crashed. */
export const SANDBOX_FAILED = "subrosa-python-sandbox-failed";

/** The one-line module the worker starts from: the bundled worker, by
 * absolute URL, since a `data:` URL is no base for a relative one. */
export function workerSource(scriptUrl: string): string {
  return `import ${JSON.stringify(scriptUrl)};\n`;
}

type ScriptUrl = string | { toString(): string };
interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): ScriptUrl };
}

/** The worker's URL, through the one Trusted Types policy the frame's CSP
 * admits, `subrosa-python`, which lets through only the URL made here. */
export function sandboxWorkerUrl(scriptUrl: string): ScriptUrl {
  const source = `data:text/javascript,${encodeURIComponent(workerSource(scriptUrl))}`;
  const types = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (!types) return source;
  return types
    .createPolicy("subrosa-python", {
      createScriptURL(input) {
        if (input !== source) throw new TypeError("Only the Python worker may start here.");
        return input;
      },
    })
    .createScriptURL(source);
}

type WorkerHandle = Pick<Worker, "postMessage"> & {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

type FrameWindow = Pick<Window, "addEventListener" | "parent">;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Waits for the page's port, then runs the worker behind it. */
export function serveSandbox(
  win: FrameWindow,
  workerScriptUrl: string,
  startWorker: (url: ScriptUrl) => WorkerHandle = (url) =>
    new Worker(url as string, { type: "module", name: "python" }),
) {
  let started = false;
  win.addEventListener("message", (event: MessageEvent) => {
    if (started || event.source !== win.parent || event.data?.type !== SANDBOX_PORT) return;
    const port = event.ports[0];
    if (!port) return;
    started = true;
    let worker: WorkerHandle;
    try {
      worker = startWorker(sandboxWorkerUrl(workerScriptUrl));
    } catch (error) {
      port.postMessage({ type: SANDBOX_FAILED, message: messageOf(error) });
      return;
    }
    worker.onmessage = (answer) => port.postMessage(answer.data);
    worker.onerror = (failure) =>
      port.postMessage({
        type: SANDBOX_FAILED,
        message: failure.message || "the Python worker stopped",
      });
    port.onmessage = (run) => worker.postMessage(run.data);
  });
  // The frame's origin is opaque, so the page is named by "*"; the message
  // carries nothing, and the page checks that it came from its own frame.
  win.parent.postMessage({ type: SANDBOX_READY }, "*");
}
