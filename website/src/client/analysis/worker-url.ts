// Where the web's Python worker starts. As in the app (`src/lib/python/
// worker-url.ts`), not from its own URL but from a one-line blob that imports
// the bundled worker: a blob worker inherits the page's Content-Security-
// Policy, so `connect-src` and the refusal of `eval` hold inside it too. The
// page requires Trusted Types for script URLs, so the blob URL goes through
// the one policy the site's CSP admits, `subrosa`, which lets through only
// blob URLs this module made.

import workerScript from "./python.worker.ts?worker&url";

type ScriptUrl = string | { toString(): string };
interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): ScriptUrl };
}

/** The one-line module the blob holds. */
export function workerSource(scriptUrl: string): string {
  return `import ${JSON.stringify(scriptUrl)};\n`;
}

const made = new Set<string>();
let policy: { createScriptURL(input: string): ScriptUrl } | null = null;

/** A script URL the page's Trusted Types accept, for a blob made here. */
export function trustedScriptUrl(url: string): ScriptUrl {
  const types = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (!types) return url;
  policy ??= types.createPolicy("subrosa", {
    createScriptURL(input) {
      if (!made.has(input)) throw new TypeError("Only the Python worker may start here.");
      return input;
    },
  });
  return policy.createScriptURL(url);
}

let bootstrap: string | null = null;

/** One blob for every worker the page starts; never revoked, since a worker
 * loads it after `new Worker` returns. */
export function pythonWorkerUrl(): ScriptUrl {
  if (!bootstrap) {
    bootstrap = URL.createObjectURL(
      new Blob([workerSource(new URL(workerScript, window.location.href).href)], {
        type: "text/javascript",
      }),
    );
    made.add(bootstrap);
  }
  return trustedScriptUrl(bootstrap);
}
