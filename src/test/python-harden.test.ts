import {
  hardenScope,
  pythonJsGlobals,
  STRIPPED_CRYPTO,
  STRIPPED_GLOBALS,
  STRIPPED_NAVIGATOR,
} from "@subrosa/chat-core/python/harden";
import type { WorkerDone, WorkerRun } from "@subrosa/chat-core/python/protocol";
import type { PyodideLike } from "@subrosa/chat-core/python/runner";
import { NO_NETWORK } from "@subrosa/chat-core/python/runner";
import {
  type PyodideModule,
  startPythonWorker,
  type WorkerScope,
} from "@subrosa/chat-core/python/worker";
import { describe, expect, it, vi } from "vitest";

const accessor = (value: unknown) => ({
  get: () => value,
  configurable: true,
  enumerable: true,
});

/** A worker global shaped like a browser's: interface objects on the
 * global itself, storage and sockets as accessors two prototypes up, and
 * `navigator`'s and `crypto`'s members on their own prototypes. */
function fakeScope() {
  const workerGlobalScope = Object.create(Object.prototype, {
    indexedDB: accessor({ open: () => "the device key" }),
    caches: accessor({}),
    importScripts: { value: () => undefined, writable: true, configurable: true },
  });
  const dedicated = Object.create(workerGlobalScope, {
    fetchLater: { value: () => undefined, writable: true, configurable: true },
  });
  const navigatorProto = Object.create(Object.prototype, {
    storage: accessor({}),
    locks: accessor({}),
    serviceWorker: accessor({}),
    userAgent: accessor("test"),
  });
  const cryptoProto = Object.create(Object.prototype, {
    subtle: accessor({ decrypt: () => "plaintext" }),
    getRandomValues: { value: (array: Uint8Array) => array, configurable: true },
  });
  const posted: unknown[] = [];
  const fetched: string[] = [];
  const scope = Object.create(dedicated) as WorkerScope & Record<string, unknown>;
  Object.assign(scope, {
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    BroadcastChannel: class {},
    Worker: class {},
    navigator: Object.create(navigatorProto),
    crypto: Object.create(cryptoProto),
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("ok");
    }),
    postMessage: (message: unknown) => posted.push(message),
    onmessage: null,
    setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as number),
    queueMicrotask: (callback: () => void) => queueMicrotask(callback),
  });
  return { scope, posted, fetched, workerGlobalScope };
}

const RUN: WorkerRun = { type: "run", id: "r1", session: "s", code: "1", files: [] };

function fakePyodide(): PyodideLike {
  return {
    FS: { mkdirTree: () => undefined, writeFile: () => undefined },
    setStdout: () => undefined,
    setStderr: () => undefined,
    loadPackage: async () => undefined,
    runPythonAsync: async () => JSON.stringify({ result: "2", blocks: [], error: null }),
    globals: { set: () => undefined },
  };
}

async function answerOf(scope: WorkerScope, posted: unknown[]): Promise<WorkerDone> {
  scope.onmessage?.({ data: RUN } as MessageEvent<WorkerRun>);
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  return posted[0] as WorkerDone;
}

describe("the Python worker's ways out", () => {
  it("removes every name, wherever on the prototype chain it lives", () => {
    const { scope, workerGlobalScope } = fakeScope();
    const hardened = hardenScope(scope);
    expect(hardened.remaining).toEqual([]);
    for (const name of STRIPPED_GLOBALS) expect(typeof scope[name], name).toBe("undefined");
    for (const name of STRIPPED_NAVIGATOR)
      expect(typeof (scope.navigator as Record<string, unknown>)[name], name).toBe("undefined");
    for (const name of STRIPPED_CRYPTO)
      expect(typeof (scope.crypto as Record<string, unknown>)[name], name).toBe("undefined");
    // Gone from the prototype too, not merely shadowed: no getter is left to
    // call with the global as its receiver.
    expect(Object.getOwnPropertyDescriptor(workerGlobalScope, "indexedDB")).toBeUndefined();
    // What Python needs stays.
    expect((scope.navigator as { userAgent: string }).userAgent).toBe("test");
    expect(typeof (scope.crypto as { getRandomValues: unknown }).getRandomValues).toBe("function");
  });

  it("keeps working copies of fetch and postMessage", async () => {
    const { scope, posted, fetched } = fakeScope();
    const hardened = hardenScope(scope);
    scope.fetch = (() => Promise.reject(new Error("replaced"))) as typeof fetch;
    scope.postMessage = () => undefined;
    await hardened.fetch("https://site.test/pyodide/a");
    hardened.postMessage("done");
    expect(fetched).toEqual(["https://site.test/pyodide/a"]);
    expect(posted).toEqual(["done"]);
  });

  it("hides what a prototype will not let go of behind a fixed undefined", () => {
    const { scope, workerGlobalScope } = fakeScope();
    Object.defineProperty(workerGlobalScope, "caches", { value: {}, configurable: false });
    const hardened = hardenScope(scope);
    expect(hardened.remaining).toEqual([]);
    expect(scope.caches).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(scope, "caches")).toMatchObject({
      value: undefined,
      writable: false,
      configurable: false,
    });
  });

  it("fails closed on a name it can neither remove nor hide", async () => {
    const { scope, posted } = fakeScope();
    Object.defineProperty(scope, "WebSocket", {
      get: () => class {},
      configurable: false,
    });
    expect(hardenScope(scope).remaining).toEqual(["WebSocket"]);
    const load = vi.fn(async () => ({ loadPyodide: async () => fakePyodide() }));
    startPythonWorker(scope, "https://site.test/pyodide/", undefined, load);
    const done = await answerOf(scope, posted);
    expect(load).not.toHaveBeenCalled();
    expect(done.unavailable).toBe(true);
    expect(done.error).toContain("WebSocket");
  });

  it("hands Pyodide a js module of three timers and nothing else", async () => {
    const { scope, posted } = fakeScope();
    let options: { indexURL: string; jsglobals?: object } | null = null;
    const load = vi.fn(
      async (_url: string): Promise<PyodideModule> => ({
        loadPyodide: async (given) => {
          options = given;
          return fakePyodide();
        },
      }),
    );
    startPythonWorker(scope, "https://site.test/pyodide/", undefined, load);
    const done = await answerOf(scope, posted);
    expect(done.result).toBe("2");
    expect(load).toHaveBeenCalledWith("https://site.test/pyodide/pyodide.mjs");
    const given = options as unknown as { indexURL: string; jsglobals: Record<string, unknown> };
    expect(given.indexURL).toBe("https://site.test/pyodide/");
    const jsglobals = given.jsglobals;
    expect(Reflect.ownKeys(jsglobals).sort()).toEqual([
      "clearTimeout",
      "queueMicrotask",
      "setTimeout",
    ]);
    expect(Object.getPrototypeOf(jsglobals)).toBeNull();
    expect(Object.isFrozen(jsglobals)).toBe(true);
    for (const name of [...STRIPPED_GLOBALS, "fetch", "postMessage", "self", "globalThis"])
      expect(name in jsglobals, name).toBe(false);
    // And the worker's own fetch is held to Pyodide's files.
    await expect(scope.fetch("https://evil.test/")).rejects.toThrow(NO_NETWORK);
  });

  it("runs only functions on the timers, never a string of code", async () => {
    const globals = pythonJsGlobals({
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as number),
      queueMicrotask: (callback) => queueMicrotask(callback),
    }) as {
      setTimeout(callback: unknown, delay?: number): unknown;
      queueMicrotask(callback: unknown): void;
    };
    expect(() => globals.setTimeout("fetch('/exfil')", 0)).toThrow(TypeError);
    expect(() => globals.queueMicrotask("fetch('/exfil')")).toThrow(TypeError);
    const ran = await new Promise((resolve) => globals.setTimeout(() => resolve("ran"), 1));
    expect(ran).toBe("ran");
  });
});
