/** The web client's data analysis: Pyodide in a worker of the tab (ADR-0086),
 * inside an opaque-origin frame (ADR-0104 addendum of 2026-10-10). */
import type { PythonInputFile } from "@subrosa/chat-core/python/protocol";
import type { TurnAddition, WebFeature } from "../feature";
import { ANALYSIS } from "./exported";
import { createPythonEngine, type PythonEngine } from "./python";
import { createSandboxedWorker } from "./worker-url";

let engine: PythonEngine | null = null;

/** One engine for the page: one worker, the conversations' variables in it. */
function pageEngine(): PythonEngine {
  engine ??= createPythonEngine({
    createWorker: () => createSandboxedWorker(),
    visible: () => document.visibilityState === "visible",
    onVisibilityChange: (handler) => {
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
  });
  return engine;
}

/** `run_python` for one turn. `files` are mounted under /data for each run:
 * the web client attaches none, an Excel pane its selected range (ADR-0102). */
export function analysisTurn(
  files: PythonInputFile[] = [],
  engineOf: () => PythonEngine = pageEngine,
): TurnAddition {
  return {
    tools: [ANALYSIS.tool],
    prompt: ANALYSIS.prompt,
    async run(name, args, turn) {
      if (name !== ANALYSIS.tool.function.name) return undefined;
      turn.onStatus?.("analysing-data");
      const code = typeof args.code === "string" ? args.code : "";
      return engineOf().run(code, turn.chatId ?? "temporary", turn.signal, files);
    },
  };
}

export const analysisFeature: WebFeature = {
  id: "analysis",
  turn: () => analysisTurn(),
};
