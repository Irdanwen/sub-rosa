/** The web client's data analysis: Pyodide in a worker of the tab (ADR-0086). */
import type { WebFeature } from "../feature";
import { ANALYSIS } from "./exported";
import { createPythonEngine, type PythonEngine } from "./python";
import { pythonWorkerUrl } from "./worker-url";

let engine: PythonEngine | null = null;

/** One engine for the page: one worker, the conversations' variables in it. */
function pageEngine(): PythonEngine {
  engine ??= createPythonEngine({
    createWorker: () =>
      new Worker(pythonWorkerUrl() as unknown as string, { type: "module", name: "python" }),
    visible: () => document.visibilityState === "visible",
    onVisibilityChange: (handler) => {
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
  });
  return engine;
}

export const analysisFeature: WebFeature = {
  id: "analysis",
  turn: () => ({
    tools: [ANALYSIS.tool],
    prompt: ANALYSIS.prompt,
    async run(name, args, turn) {
      if (name !== ANALYSIS.tool.function.name) return undefined;
      turn.onStatus?.("analysing-data");
      const code = typeof args.code === "string" ? args.code : "";
      return pageEngine().run(code, turn.chatId ?? "temporary", turn.signal);
    },
  }),
};
