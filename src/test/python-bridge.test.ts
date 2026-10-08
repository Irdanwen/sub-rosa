import { describe, expect, it, vi } from "vitest";
import { startPythonBridge, type WorkerLike } from "../lib/python/bridge";
import { mountedFiles, safeFileName, sheetListingToCsv } from "../lib/python/files";
import { PYTHON_PRELUDE } from "../lib/python/prelude";
import type { PythonReply, PythonRunEvent, WorkerDone, WorkerRun } from "../lib/python/protocol";
import {
  createRunner,
  guardFetch,
  NO_NETWORK,
  packagesFor,
  type PyodideLike,
} from "../lib/python/runner";
import { pythonWorkerSource, pythonWorkerUrl } from "../lib/python/worker-url";

function fakePyodide(answer: (code: string) => unknown = () => "{}") {
  const files = new Map<string, string>();
  let stdout: (text: string) => void = () => undefined;
  const globals = new Map<string, unknown>();
  const pyodide = {
    files,
    globals: { set: (name: string, value: unknown) => globals.set(name, value) },
    request: () => JSON.parse(String(globals.get("_subrosa_request"))),
    FS: {
      mkdirTree: vi.fn(),
      writeFile: (path: string, data: string) => files.set(path, data),
    },
    setStdout: (options: { batched: (text: string) => void }) => {
      stdout = options.batched;
    },
    setStderr: vi.fn(),
    print: (text: string) => stdout(text),
    loadPackage: vi.fn(async (_names: string[]) => undefined),
    runPythonAsync: vi.fn(async (code: string) => answer(code)),
  };
  return pyodide;
}

const RUN: WorkerRun = {
  type: "run",
  id: "r1",
  session: "task-1",
  code: "import pandas as pd\nprint(1)",
  files: [{ path: "/data/a.csv", text: "a\n1\n" }],
};

describe("worker runner, Pyodide mocked", () => {
  it("finds only the bundled packages a piece of code imports", () => {
    expect(packagesFor("import pandas as pd\nfrom numpy import arange\nimport json")).toEqual([
      "pandas",
      "numpy",
    ]);
    expect(packagesFor("import numpy as np, dateutil.parser")).toEqual([
      "numpy",
      "python-dateutil",
    ]);
    expect(packagesFor("import matplotlib\nx = 'import pandas'")).toEqual([]);
  });

  it("prepares once, mounts the files, loads what is imported and reports the outcome", async () => {
    const pyodide = fakePyodide((code) => {
      if (code === PYTHON_PRELUDE) return undefined;
      pyodide.print("1");
      return JSON.stringify({
        result: "3",
        blocks: [{ kind: "chart", json: '{"v":1}' }],
        error: null,
      });
    });
    const load = vi.fn(async () => pyodide as unknown as PyodideLike);
    const runner = createRunner(load);
    const first = await runner.run(RUN);
    const second = await runner.run({ ...RUN, id: "r2", code: "x = 1" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      pyodide.runPythonAsync.mock.calls.filter(([code]) => code === PYTHON_PRELUDE),
    ).toHaveLength(1);
    expect(pyodide.files.get("/data/a.csv")).toBe("a\n1\n");
    expect(pyodide.loadPackage).toHaveBeenCalledTimes(1);
    expect(pyodide.loadPackage).toHaveBeenCalledWith(["pandas"]);
    expect(pyodide.request()).toEqual({ session: "task-1", code: "x = 1" });
    expect(first).toEqual<WorkerDone>({
      type: "done",
      id: "r1",
      stdout: "1\n",
      result: "3",
      blocks: [{ kind: "chart", json: '{"v":1}' }],
      error: null,
      files: ["/data/a.csv"],
    });
    expect(second.id).toBe("r2");
  });

  it("reports a failed start to the model and starts over on the next run", async () => {
    const pyodide = fakePyodide(() => JSON.stringify({ result: null, blocks: [], error: null }));
    const load = vi
      .fn<() => Promise<PyodideLike>>()
      .mockRejectedValueOnce(new Error("wasm refused"))
      .mockResolvedValue(pyodide as unknown as PyodideLike);
    const runner = createRunner(load);
    const failed = await runner.run(RUN);
    expect(failed.error).toBe("Python could not start: wasm refused");
    expect(failed.unavailable).toBe(true);
    expect((await runner.run(RUN)).error).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("the worker's network", () => {
  it("reaches Pyodide's own files and refuses everything else at once", async () => {
    const original = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    const scope = { fetch: original as unknown as typeof fetch };
    guardFetch(scope, "tauri://localhost/pyodide/");
    await expect(scope.fetch("tauri://localhost/pyodide/numpy.whl")).resolves.toBeInstanceOf(
      Response,
    );
    for (const url of [
      "https://example.com/",
      "tauri://localhost/assets/index.js",
      "http://127.0.0.1:8080/v1/chat",
      "tauri://localhost/pyodide/../secrets",
    ]) {
      await expect(scope.fetch(url)).rejects.toThrow(NO_NETWORK);
    }
    expect(original).toHaveBeenCalledTimes(1);
  });
});

describe("attached files under /data", () => {
  it("turns the document reader's sheet listing back into one CSV per sheet", () => {
    const listing =
      "[Sheet 1]\nA1: Region\nB1: Sales\nA2: North, east\nB2: 1200\nC3: late\n[Sheet 2]\nA1: x\n";
    expect(sheetListingToCsv(listing)).toEqual([
      { sheet: 1, csv: 'Region,Sales,\n"North, east",1200,\n,,late\n' },
      { sheet: 2, csv: "x\n" },
    ]);
    expect(sheetListingToCsv("a,b\n1,2\n")).toBeNull();
  });

  it("names every mounted file safely and uniquely", () => {
    expect(safeFileName("../budget 2026 (final).csv")).toBe("budget_2026_final_.csv");
    const files = mountedFiles([
      { name: "Budget 2026.xlsx", text: "[Sheet 1]\nA1: a\n[Sheet 3]\nA1: b\n" },
      { name: "data.csv", text: "a\n" },
      { name: "data.csv", text: "b\n" },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "/data/Budget_2026.sheet1.csv",
      "/data/Budget_2026.sheet3.csv",
      "/data/data.csv",
      "/data/data-2.csv",
    ]);
  });
});

/** A worker the test answers by hand. */
function fakeWorker() {
  const posted: WorkerRun[] = [];
  const worker: WorkerLike & { posted: WorkerRun[]; terminated: number } = {
    posted,
    terminated: 0,
    onmessage: null,
    onerror: null,
    postMessage: (message) => posted.push(message),
    terminate: () => {
      worker.terminated += 1;
    },
  };
  return worker;
}

function harness(visible = true) {
  const replies: [string, PythonReply][] = [];
  const workers: ReturnType<typeof fakeWorker>[] = [];
  let run: (event: PythonRunEvent) => void = () => undefined;
  let cancel: (requestId: string) => void = () => undefined;
  let visibility: () => void = () => undefined;
  const state = { visible };
  const stop = startPythonBridge({
    onRun: async (handler) => {
      run = handler;
      return () => undefined;
    },
    onCancel: async (handler) => {
      cancel = handler;
      return () => undefined;
    },
    reply: async (requestId, reply) => replies.push([requestId, reply]),
    createWorker: () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker;
    },
    visible: () => state.visible,
    onVisibilityChange: (handler) => {
      visibility = handler;
      return () => undefined;
    },
  });
  const event: PythonRunEvent = {
    requestId: "q1",
    session: "task-1",
    code: "1 + 1",
    files: [{ name: "a.csv", text: "a\n" }],
  };
  return {
    replies,
    workers,
    stop,
    state,
    event,
    run: (overrides: Partial<PythonRunEvent> = {}) => run({ ...event, ...overrides }),
    cancel: (id: string) => cancel(id),
    hide: () => {
      state.visible = false;
      visibility();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the webview bridge", () => {
  it("refuses at once when the app is not on screen", async () => {
    const bridge = harness(false);
    await flush();
    bridge.run();
    expect(bridge.replies).toEqual([["q1", { kind: "refused", reason: "background" }]]);
    expect(bridge.workers).toHaveLength(0);
  });

  it("acknowledges, hands the worker its mounted files, and relays the outcome", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    expect(bridge.replies[0]).toEqual(["q1", { kind: "started" }]);
    const worker = bridge.workers[0];
    expect(worker.posted[0]).toEqual({
      type: "run",
      id: "q1",
      session: "task-1",
      code: "1 + 1",
      files: [{ path: "/data/a.csv", text: "a\n" }],
    });
    worker.onmessage?.({
      data: {
        type: "done",
        id: "q1",
        stdout: "",
        result: "2",
        blocks: [],
        error: null,
        files: ["/data/a.csv"],
      },
    } as unknown as MessageEvent<WorkerDone>);
    expect(bridge.replies[1]).toEqual([
      "q1",
      { kind: "done", stdout: "", result: "2", blocks: [], error: null, files: ["/data/a.csv"] },
    ]);
    // A second run reuses the warm worker.
    bridge.run({ requestId: "q2" });
    expect(bridge.workers).toHaveLength(1);
  });

  it("stops the worker when the app leaves the screen mid-run", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    bridge.hide();
    expect(bridge.workers[0].terminated).toBe(1);
    expect(bridge.replies.at(-1)).toEqual(["q1", { kind: "refused", reason: "background" }]);
    // The next run, back on screen, gets a fresh worker.
    bridge.state.visible = true;
    bridge.run({ requestId: "q2" });
    expect(bridge.workers).toHaveLength(2);
  });

  it("says Python is unavailable when Pyodide itself could not start", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    bridge.workers[0].onmessage?.({
      data: {
        type: "done",
        id: "q1",
        unavailable: true,
        stdout: "",
        result: null,
        blocks: [],
        error: "Python could not start: CompileError",
        files: [],
      },
    } as unknown as MessageEvent<WorkerDone>);
    expect(bridge.replies.at(-1)).toEqual([
      "q1",
      { kind: "refused", reason: "unavailable", detail: "Python could not start: CompileError" },
    ]);
  });

  it("lets an idle worker go when the app leaves the screen, and replies to nobody", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    bridge.workers[0].onmessage?.({
      data: { type: "done", id: "q1", stdout: "", result: "2", blocks: [], error: null, files: [] },
    } as unknown as MessageEvent<WorkerDone>);
    const count = bridge.replies.length;
    bridge.hide();
    expect(bridge.workers[0].terminated).toBe(1);
    expect(bridge.replies).toHaveLength(count);
    // Hiding again with no worker is a no-op.
    bridge.hide();
    expect(bridge.workers[0].terminated).toBe(1);
    bridge.state.visible = true;
    bridge.run({ requestId: "q2" });
    expect(bridge.workers).toHaveLength(2);
  });

  it("discards the worker when Rust cancels a run past its limit", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    bridge.cancel("other");
    expect(bridge.workers[0].terminated).toBe(0);
    bridge.cancel("q1");
    expect(bridge.workers[0].terminated).toBe(1);
    // A late answer from the discarded worker is not relayed twice.
    const count = bridge.replies.length;
    bridge.workers[0].onmessage?.({
      data: {
        type: "done",
        id: "q1",
        stdout: "",
        result: null,
        blocks: [],
        error: null,
        files: [],
      },
    } as unknown as MessageEvent<WorkerDone>);
    expect(bridge.replies).toHaveLength(count);
  });

  it("says Python is unavailable when the worker cannot start", async () => {
    const bridge = harness();
    await flush();
    bridge.run();
    bridge.workers[0].onerror?.({ message: "module script failed" } as ErrorEvent);
    expect(bridge.replies.at(-1)).toEqual([
      "q1",
      { kind: "refused", reason: "unavailable", detail: "module script failed" },
    ]);
  });
});

describe("where the worker starts", () => {
  it("is a blob that imports the bundled worker by absolute URL", () => {
    expect(pythonWorkerSource("tauri://localhost/assets/python.worker-a1.js")).toBe(
      'import "tauri://localhost/assets/python.worker-a1.js";\n',
    );
  });

  it("makes one blob URL and reuses it for every worker", () => {
    // jsdom has no object URLs.
    const original = URL.createObjectURL;
    const create = vi.fn((_blob: Blob) => "blob:tauri://localhost/b1");
    URL.createObjectURL = create;
    try {
      expect(pythonWorkerUrl()).toBe("blob:tauri://localhost/b1");
      expect(pythonWorkerUrl()).toBe("blob:tauri://localhost/b1");
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].type).toBe("text/javascript");
    } finally {
      URL.createObjectURL = original;
    }
  });
});
