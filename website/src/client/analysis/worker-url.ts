// Where the web's Python worker starts (ADR-0104 addendum of 2026-10-10): not
// in the page, but in a frame of the site's `/python-sandbox.html` framed
// with `sandbox="allow-scripts"`. The frame and its worker have an opaque
// origin, so nothing Python reaches can open the account origin's IndexedDB
// (the browser device's key, sealed connector tokens) or post anywhere the
// frame's own policy does not name, which is `/pyodide/` alone. The worker
// also closes its own ways out (`hardenScope`), so the frame is the second
// wall, not the only one. The Excel pane (ADR-0102) starts it the same way.
//
// To the bridge the frame is a worker: runs go in and answers come out on a
// MessagePort the page hands the frame once it says it is ready, and
// terminating it removes the frame, which ends the worker with it.

import type { WorkerLike } from "@subrosa/chat-core/python/bridge";
import type { WorkerDone, WorkerRun } from "@subrosa/chat-core/python/protocol";

/** The frame's three messages, as `sandbox-frame.ts` names them. Repeated
 * rather than imported, so the frame's chunk shares nothing with the page's
 * (a test holds the two equal). */
export const SANDBOX_READY = "subrosa-python-sandbox-ready";
export const SANDBOX_PORT = "subrosa-python-sandbox-port";
export const SANDBOX_FAILED = "subrosa-python-sandbox-failed";

/** The frame loads a page and a script; Pyodide itself loads after. */
const READY_WITHIN_MS = 15_000;

export type SandboxOptions = {
  document?: Document;
  /** The sandbox page; the site's own, under its base path. */
  url?: string;
  readyWithinMs?: number;
  /** Off only on the development server, which answers no CORS request from
   * an opaque origin; every build frames it sandboxed. */
  sandboxed?: boolean;
};

/** A Python worker in its own opaque-origin frame. */
export function createSandboxedWorker(options: SandboxOptions = {}): WorkerLike {
  const doc = options.document ?? document;
  const win = doc.defaultView;
  if (!win) throw new Error("no window to frame Python in");
  const frame = doc.createElement("iframe");
  if (options.sandboxed ?? !import.meta.env.DEV) frame.setAttribute("sandbox", "allow-scripts");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.src =
    options.url ??
    new URL(`${import.meta.env.BASE_URL}python-sandbox.html`, win.location.href).href;

  let port: MessagePort | null = null;
  let closed = false;
  const queue: WorkerRun[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      if (closed) return;
      if (port) port.postMessage(message);
      else queue.push(message);
    },
    terminate: () => close(),
  };

  const close = () => {
    closed = true;
    clearTimeout(timer);
    win.removeEventListener("message", onReady);
    port?.close();
    port = null;
    frame.remove();
  };
  const fail = (message: string) => {
    if (closed) return;
    close();
    worker.onerror?.({ message } as ErrorEvent);
  };

  function onReady(event: MessageEvent) {
    if (port || event.source !== frame.contentWindow || event.data?.type !== SANDBOX_READY) return;
    const target = frame.contentWindow;
    if (!target) return;
    clearTimeout(timer);
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (answer: MessageEvent) => {
      const data = answer.data as WorkerDone | { type: typeof SANDBOX_FAILED; message?: unknown };
      if (data?.type === SANDBOX_FAILED) {
        const reason = (data as { message?: unknown }).message;
        fail(typeof reason === "string" ? reason : "the Python sandbox stopped");
        return;
      }
      worker.onmessage?.({ data } as MessageEvent<WorkerDone>);
    };
    // An opaque origin can only be addressed as "*"; the port goes to this
    // frame's window and nowhere else.
    target.postMessage({ type: SANDBOX_PORT }, "*", [channel.port2]);
    for (const message of queue.splice(0)) port.postMessage(message);
  }

  const timer = setTimeout(
    () => fail("the Python sandbox did not start"),
    options.readyWithinMs ?? READY_WITHIN_MS,
  );
  win.addEventListener("message", onReady);
  doc.body.append(frame);
  return worker;
}
