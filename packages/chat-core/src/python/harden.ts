// What the model's Python can reach of the browser (ADR-0086, addendum of
// 2026-10-10). Pyodide's `js` module is the worker's global by default, so
// code a hidden instruction in an attached file wrote could read the
// origin's IndexedDB (the browser device's key, sealed connector tokens),
// open a socket or a request the page's `fetch` guard never sees, or decrypt
// with the origin's keys. Before Pyodide loads, the worker removes every way
// out it does not need, along the whole prototype chain, and hands Pyodide a
// `js` module of three timers instead of its global. What cannot be removed
// is shadowed; what is still there afterwards stops Python from starting at
// all, rather than letting it start with a door open.

/** The worker global's names that reach storage, the network or another
 * context. Some exist only in one engine; an absent name costs nothing. */
export const STRIPPED_GLOBALS = [
  "indexedDB",
  "caches",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "importScripts",
  "fetchLater",
  "cookieStore",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "webkitRequestFileSystem",
  "webkitRequestFileSystemSync",
  "webkitResolveLocalFileSystemURL",
  "webkitResolveLocalFileSystemSyncURL",
] as const;

/** `navigator`'s: origin storage and its file system, cross-context locks,
 * service workers. */
export const STRIPPED_NAVIGATOR = ["storage", "locks", "serviceWorker"] as const;

/** `crypto`'s: the origin's non-extractable keys are used through it.
 * `getRandomValues`, which Python's `os.urandom` needs, stays. */
export const STRIPPED_CRYPTO = ["subtle"] as const;

export type HardenableScope = {
  fetch: typeof fetch;
  postMessage(message: unknown): void;
  navigator?: object;
  crypto?: object;
};

export type HardenedScope = {
  /** The worker's own `fetch`, bound before anything was removed. */
  fetch: typeof fetch;
  /** Its `postMessage`, likewise: the only way an answer leaves. */
  postMessage(message: unknown): void;
  /** Names still reachable after hardening; Python must not start if any. */
  remaining: string[];
};

/** Removes `names` from `target` and everything it inherits from. */
function strip(
  target: object | undefined,
  names: readonly string[],
  label: string,
  remaining: string[],
) {
  if (!target) return;
  for (const name of names) {
    let stuck = false;
    for (let level: object | null = target; level; level = Object.getPrototypeOf(level)) {
      if (!Object.getOwnPropertyDescriptor(level, name)) continue;
      if (!Reflect.deleteProperty(level, name)) stuck = true;
    }
    // A property the engine will not let go of is hidden behind one of the
    // target's own, which nothing can change back.
    if (stuck)
      try {
        Object.defineProperty(target, name, {
          value: undefined,
          writable: false,
          enumerable: false,
          configurable: false,
        });
      } catch {
        // Reported by the check below.
      }
    let present = true;
    try {
      present = typeof (target as Record<string, unknown>)[name] !== "undefined";
    } catch {
      // A getter that throws is still a getter someone could call.
    }
    if (present) remaining.push(`${label}${name}`);
  }
}

/** Closes the worker's ways out, keeping the two it needs. Run once, first,
 * before Pyodide or anything it imports is loaded. */
export function hardenScope(scope: HardenableScope): HardenedScope {
  const kept = { fetch: scope.fetch.bind(scope), postMessage: scope.postMessage.bind(scope) };
  const remaining: string[] = [];
  strip(scope, STRIPPED_GLOBALS, "", remaining);
  strip(scope.navigator, STRIPPED_NAVIGATOR, "navigator.", remaining);
  strip(scope.crypto, STRIPPED_CRYPTO, "crypto.", remaining);
  return { ...kept, remaining };
}

type TimerScope = {
  setTimeout(callback: () => void, delay?: number): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask(callback: () => void): void;
};

const callable = (callback: unknown, name: string) => {
  // A string would be compiled as code where no policy forbids it.
  if (typeof callback !== "function") throw new TypeError(`${name} takes a function`);
  return callback as () => void;
};

/** What Python's `js` module holds: three timers, and nothing that leads
 * back to the worker's global. Pyodide's own event loop schedules through
 * its internal API, not through these. */
export function pythonJsGlobals(scope: TimerScope): Readonly<Record<string, unknown>> {
  const later = scope.setTimeout.bind(scope);
  const cancel = scope.clearTimeout.bind(scope);
  const soon = scope.queueMicrotask.bind(scope);
  const globals = Object.create(null) as Record<string, unknown>;
  globals.setTimeout = (callback: unknown, delay?: number) =>
    later(callable(callback, "setTimeout"), Number(delay) || 0);
  globals.clearTimeout = (handle: unknown) => cancel(handle);
  globals.queueMicrotask = (callback: unknown) => soon(callable(callback, "queueMicrotask"));
  return Object.freeze(globals);
}
