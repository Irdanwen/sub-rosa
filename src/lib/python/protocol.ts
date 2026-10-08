// The messages between the app and its Python worker, and between the app
// and Rust (ADR-0086). Kept free of DOM and Tauri imports so both the worker
// and the tests read the same shapes.

/** Rust → webview: run this code for a turn. */
export const PYTHON_RUN_EVENT = "agent-lite://python-run";
/** Rust → webview: the run outlived its timeout, stop it. */
export const PYTHON_CANCEL_EVENT = "agent-lite://python-cancel";

export type PythonInputFile = { name: string; text: string };

export type PythonRunEvent = {
  requestId: string;
  /** The conversation, so its variables survive from one run to the next. */
  session: string;
  code: string;
  files: PythonInputFile[];
};

export type PythonBlock = { kind: "chart" | "table"; json: string };

export type PythonOutcome = {
  stdout: string;
  result: string | null;
  blocks: PythonBlock[];
  error: string | null;
  /** Where the attached files were mounted, as the code should open them. */
  files: string[];
};

/** Webview → Rust, through `agent_lite_python_reply`. */
export type PythonReply =
  | { kind: "started" }
  | ({ kind: "done" } & PythonOutcome)
  | { kind: "refused"; reason: "background" | "unavailable"; detail?: string };

/** App → worker. */
export type WorkerRun = {
  type: "run";
  id: string;
  session: string;
  code: string;
  files: { path: string; text: string }[];
};

/** Worker → app. `unavailable` when Pyodide itself could not start (a
 * WebKit older than it supports, say): not the code's fault, so the bridge
 * tells Rust Python is unavailable rather than handing the model an error. */
export type WorkerDone = { type: "done"; id: string; unavailable?: boolean } & PythonOutcome;

/** Also for a rejection that is not an Error (a plain object from wasm glue),
 * which `String()` would turn into "[object Object]". */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}
