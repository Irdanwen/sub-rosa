// Where the Python worker starts (ADR-0086). Not from its own URL: a worker
// script served by the app's scheme carries no CSP (Tauri sends the header
// with HTML pages only), so a worker started from it ran under no policy at
// all, and the model's code could `js.fetch` any host or `js.eval` anything,
// measured in the iOS simulator. A worker started from a blob URL inherits the
// page's policy instead, so it reaches only what the page may reach. The blob
// holds one line, an import of the bundled worker.

import workerScript from "./python.worker.ts?worker&url";

/** The blob's whole content: the bundled worker, by absolute URL, since a
 * blob URL is no base for a relative one. */
export function pythonWorkerSource(scriptUrl: string): string {
  return `import ${JSON.stringify(scriptUrl)};\n`;
}

let bootstrap: string | null = null;

/** One blob URL for every worker the app starts; it is never revoked, since a
 * worker loads it after `new Worker` returns. */
export function pythonWorkerUrl(): string {
  bootstrap ??= URL.createObjectURL(
    new Blob([pythonWorkerSource(new URL(workerScript, window.location.href).href)], {
      type: "text/javascript",
    }),
  );
  return bootstrap;
}
