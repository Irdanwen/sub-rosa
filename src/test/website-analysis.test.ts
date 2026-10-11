import type { WorkerLike } from "@subrosa/chat-core/python/bridge";
import type { WorkerDone, WorkerRun } from "@subrosa/chat-core/python/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisFeature } from "../../website/src/client/analysis";
import { ANALYSIS } from "../../website/src/client/analysis/exported";
import {
  createPythonEngine,
  describe as describeOutcome,
} from "../../website/src/client/analysis/python";

type Answer = (run: WorkerRun) => Partial<WorkerDone> | "silent" | "crash";

function fakeWorkers(answer: Answer) {
  const created: (WorkerLike & { runs: WorkerRun[]; terminated: boolean })[] = [];
  const createWorker = () => {
    const worker = {
      runs: [] as WorkerRun[],
      terminated: false,
      onmessage: null as ((event: MessageEvent<WorkerDone>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(run: WorkerRun) {
        worker.runs.push(run);
        const reply = answer(run);
        if (reply === "silent") return;
        queueMicrotask(() => {
          if (reply === "crash") {
            worker.onerror?.({ message: "wasm failed" } as ErrorEvent);
            return;
          }
          worker.onmessage?.({
            data: {
              type: "done",
              id: run.id,
              stdout: "",
              result: null,
              blocks: [],
              error: null,
              files: [],
              ...reply,
            },
          } as MessageEvent<WorkerDone>);
        });
      },
      terminate() {
        worker.terminated = true;
      },
    };
    created.push(worker);
    return worker;
  };
  return { created, createWorker };
}

function engine(answer: Answer, visible = () => true) {
  const workers = fakeWorkers(answer);
  let onHidden: () => void = () => undefined;
  const python = createPythonEngine(
    {
      createWorker: workers.createWorker,
      visible,
      onVisibilityChange: (handler) => {
        onHidden = handler;
        return () => undefined;
      },
    },
    { firstAnswerMs: 50, runLimitMs: 200 },
  );
  return { python, workers, hide: () => onHidden() };
}

afterEach(() => vi.useRealTimers());

describe("Python in the web client", () => {
  it("runs the code in the conversation's session and hands the cards back verbatim", async () => {
    const { python, workers } = engine(() => ({
      stdout: "computed\n",
      result: "42",
      blocks: [
        { kind: "chart", json: '{"v":1,"type":"bar"}' },
        // A kind the parser never names, as a hostile worker could send.
        { kind: "script" as "chart", json: "{}" },
      ],
    }));
    const answer = await python.run("6 * 7", "chat-1");
    expect(workers.created[0].runs[0]).toMatchObject({
      session: "chat-1",
      code: "6 * 7",
      files: [],
    });
    expect(answer).toContain("Output:\ncomputed");
    expect(answer).toContain("Result:\n42");
    expect(answer).toContain(
      `${ANALYSIS.messages.cards}\n\`\`\`subrosa:chart\n{"v":1,"type":"bar"}\n\`\`\``,
    );
    expect(answer).not.toContain("subrosa:script");
    python.dispose();
  });

  it("refuses at once when the tab is hidden, and stops a run the tab leaves", async () => {
    const hidden = engine(
      () => ({ result: "1" }),
      () => false,
    );
    expect(await hidden.python.run("1", "c")).toBe(ANALYSIS.messages.needsPageOpen);

    let shown = true;
    const leaving = engine(
      () => "silent",
      () => shown,
    );
    const pending = leaving.python.run("while True: pass", "c");
    await Promise.resolve();
    shown = false;
    leaving.hide();
    expect(await pending).toBe(ANALYSIS.messages.needsPageOpen);
    expect(leaving.workers.created[0].terminated).toBe(true);
  });

  it("discards a run that outlives its clock", async () => {
    const slow = engine(() => "silent");
    expect(await slow.python.run("while True: pass", "c")).toBe(ANALYSIS.messages.timedOut);
    expect(slow.workers.created[0].terminated).toBe(true);
  });

  it("says Python is unavailable when Pyodide cannot start, and stops on request", async () => {
    const broken = engine(() => "crash");
    expect(await broken.python.run("1", "c")).toBe(
      ANALYSIS.messages.unavailable.replace("{detail}", " (wasm failed)"),
    );
    const stopping = engine(() => "silent");
    const controller = new AbortController();
    const run = stopping.python.run("1", "c", controller.signal);
    controller.abort();
    expect(await run).toBe(ANALYSIS.messages.stopped);
  });

  it("refuses empty and oversized code before anything starts", async () => {
    const { python, workers } = engine(() => ({ result: "1" }));
    expect(await python.run("  ", "c")).toBe(ANALYSIS.messages.noCode);
    expect(await python.run("x".repeat(ANALYSIS.limits.maxCodeChars + 1), "c")).toBe(
      ANALYSIS.messages.tooLong,
    );
    expect(workers.created).toHaveLength(0);
  });

  it("describes a silent run and an error the way the phone does", () => {
    const done = { stdout: "", result: null, blocks: [], error: null, files: [] };
    expect(describeOutcome({ kind: "done", outcome: done })).toBe(ANALYSIS.messages.printedNothing);
    expect(describeOutcome({ kind: "done", outcome: { ...done, error: "NameError: x" } })).toBe(
      "Error:\nNameError: x",
    );
    expect(describeOutcome({ kind: "unavailable" })).toBe(
      ANALYSIS.messages.unavailable.replace("{detail}", ""),
    );
  });

  it("offers run_python with the card prompt, in the browser's own words", async () => {
    const addition = await analysisFeature.turn?.({} as never, {
      chatId: "c",
      temporary: false,
      question: "q",
    });
    expect(addition?.tools.map((tool) => tool.function.name)).toEqual(["run_python"]);
    expect(addition?.tools[0].function.description).toContain("browser");
    expect(addition?.tools[0].function.description).not.toContain("phone");
    expect(JSON.stringify(addition?.tools[0].function.parameters)).not.toContain("files");
    expect(addition?.prompt).toContain("subrosa:chart");
    expect(
      await addition?.run?.("web_search", {}, { chatId: "c", temporary: false, question: "" }),
    ).toBeUndefined();
  });
});
