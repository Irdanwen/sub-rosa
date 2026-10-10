// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import type { WorkerDone, WorkerRun } from "@subrosa/chat-core/python/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as frameSide from "../../website/src/client/analysis/sandbox-frame";
import { serveSandbox, workerSource } from "../../website/src/client/analysis/sandbox-frame";
import * as pageSide from "../../website/src/client/analysis/worker-url";
import { createSandboxedWorker } from "../../website/src/client/analysis/worker-url";

const RUN: WorkerRun = { type: "run", id: "r1", session: "s", code: "1", files: [] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The frame the page made, its window's posts captured. */
function framed(options: Parameters<typeof createSandboxedWorker>[0] = {}) {
  const worker = createSandboxedWorker({
    url: "https://site.test/python-sandbox.html",
    ...options,
  });
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  const target = frame.contentWindow as Window;
  const sent: { data: unknown; origin: string; ports: MessagePort[] }[] = [];
  vi.spyOn(target, "postMessage").mockImplementation(((
    data: unknown,
    origin: string,
    ports: MessagePort[],
  ) => {
    sent.push({ data, origin, ports });
  }) as typeof target.postMessage);
  const ready = (source: unknown = target) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: pageSide.SANDBOX_READY },
        source: source as Window,
      }),
    );
  return { worker, frame, sent, ready };
}

describe("the page's side of the Python sandbox", () => {
  it("frames the sandbox page with scripts and nothing else", () => {
    const { frame } = framed({ sandboxed: true });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.src).toBe("https://site.test/python-sandbox.html");
    expect(frame.hidden).toBe(true);
  });

  it("hands its port only to its own frame, then relays runs and answers", async () => {
    const { worker, sent, ready } = framed({ sandboxed: true });
    const answers: WorkerDone[] = [];
    worker.onmessage = (event) => answers.push(event.data);
    worker.postMessage(RUN);
    ready(window);
    expect(sent).toHaveLength(0);
    ready();
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toEqual({ type: pageSide.SANDBOX_PORT });
    const port = sent[0].ports[0];
    const runs: unknown[] = [];
    port.onmessage = (event) => runs.push(event.data);
    await vi.waitFor(() => expect(runs).toEqual([RUN]));
    const done = { type: "done", id: "r1" } as WorkerDone;
    port.postMessage(done);
    await vi.waitFor(() => expect(answers).toEqual([done]));
    port.close();
  });

  it("removes the frame when the worker is terminated", () => {
    const { worker, frame } = framed();
    worker.terminate();
    expect(frame.isConnected).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("reports a frame that never says it is ready, and drops it", () => {
    vi.useFakeTimers();
    const { worker, frame } = framed({ readyWithinMs: 1000 });
    const errors: string[] = [];
    worker.onerror = (event) => errors.push(event.message);
    vi.advanceTimersByTime(1000);
    expect(errors).toEqual(["the Python sandbox did not start"]);
    expect(frame.isConnected).toBe(false);
  });

  it("reports a worker the frame could not run", async () => {
    const { worker, sent, ready, frame } = framed();
    const errors: string[] = [];
    worker.onerror = (event) => errors.push(event.message);
    ready();
    sent[0].ports[0].postMessage({ type: pageSide.SANDBOX_FAILED, message: "wasm refused" });
    await vi.waitFor(() => expect(errors).toEqual(["wasm refused"]));
    expect(frame.isConnected).toBe(false);
  });

  it("names the frame's messages as the frame does", () => {
    expect(pageSide.SANDBOX_READY).toBe(frameSide.SANDBOX_READY);
    expect(pageSide.SANDBOX_PORT).toBe(frameSide.SANDBOX_PORT);
    expect(pageSide.SANDBOX_FAILED).toBe(frameSide.SANDBOX_FAILED);
  });
});

describe("the frame's side of the Python sandbox", () => {
  function frame() {
    const parent = { postMessage: vi.fn() };
    const target = new EventTarget();
    const win = {
      parent,
      addEventListener: target.addEventListener.bind(target),
    } as unknown as Window;
    const worker = {
      posted: [] as unknown[],
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: unknown) {
        worker.posted.push(message);
      },
    };
    const started: unknown[] = [];
    serveSandbox(win, "https://site.test/assets/python-sandbox.worker.js", (url) => {
      started.push(url);
      return worker;
    });
    const port = (source: unknown) => {
      const channel = new MessageChannel();
      target.dispatchEvent(
        new MessageEvent("message", {
          data: { type: frameSide.SANDBOX_PORT },
          source: source as Window,
          ports: [channel.port2],
        }),
      );
      return channel.port1;
    };
    return { parent, worker, started, port };
  }

  it("says it is ready, and starts the worker for its parent's port only", async () => {
    const { parent, worker, started, port } = frame();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: frameSide.SANDBOX_READY }, "*");
    port({}).close();
    expect(started).toEqual([]);
    const own = port(parent);
    expect(started).toEqual([
      `data:text/javascript,${encodeURIComponent(workerSource("https://site.test/assets/python-sandbox.worker.js"))}`,
    ]);
    const answers: unknown[] = [];
    own.onmessage = (event) => answers.push(event.data);
    own.postMessage(RUN);
    await vi.waitFor(() => expect(worker.posted).toEqual([RUN]));
    worker.onmessage?.({ data: { type: "done", id: "r1" } } as MessageEvent);
    worker.onerror?.({ message: "" } as ErrorEvent);
    await vi.waitFor(() =>
      expect(answers).toEqual([
        { type: "done", id: "r1" },
        { type: frameSide.SANDBOX_FAILED, message: "the Python worker stopped" },
      ]),
    );
    // A second port, even the parent's, starts nothing more.
    port(parent).close();
    expect(started).toHaveLength(1);
    own.close();
  });

  it("starts the worker from a data module only its own Trusted Types policy lets through", () => {
    expect(workerSource("https://site.test/assets/python-sandbox.worker.js")).toBe(
      'import "https://site.test/assets/python-sandbox.worker.js";\n',
    );
    const policies: string[] = [];
    let rules: { createScriptURL(input: string): string } | null = null;
    vi.stubGlobal("trustedTypes", {
      createPolicy(name: string, given: { createScriptURL(input: string): string }) {
        policies.push(name);
        rules = given;
        return { createScriptURL: (input: string) => `trusted:${given.createScriptURL(input)}` };
      },
    });
    expect(String(frameSide.sandboxWorkerUrl("https://site.test/w.js"))).toBe(
      `trusted:data:text/javascript,${encodeURIComponent('import "https://site.test/w.js";\n')}`,
    );
    expect(policies).toEqual(["subrosa-python"]);
    expect(() => rules?.createScriptURL("https://evil.test/x.js")).toThrow();
  });

  it("is a page whose only script is its own entry", () => {
    const html = readFileSync("website/python-sandbox.html", "utf8") as string;
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('src="/src/client/analysis/python-sandbox.ts"');
  });
});
