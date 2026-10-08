/**
 * `run_python` in the browser (ADR-0086, on the web). Python is Pyodide in a
 * worker of this tab, the app's own worker logic (`@subrosa/chat-core/python`),
 * and the tool's two clocks are the phone's: a first answer within five
 * seconds, which is how an absent or frozen worker is noticed, then the run
 * within two minutes, after which the worker is discarded (wasm cannot be
 * interrupted). A hidden tab refuses at once and a tab hidden mid-run stops
 * it, so a turn never waits on a page the browser has throttled. What the
 * model reads in each outcome is Rust's (`analysis.rs`).
 *
 * The run belongs to the turn; nothing is kept. Variables persist per
 * conversation while the worker lives.
 */
import { startPythonBridge, type WorkerLike } from "@subrosa/chat-core/python/bridge";
import type {
  PythonOutcome,
  PythonReply,
  PythonRunEvent,
} from "@subrosa/chat-core/python/protocol";
import { ANALYSIS } from "./exported";

export interface EngineDeps {
  createWorker(): WorkerLike;
  visible(): boolean;
  onVisibilityChange(handler: () => void): () => void;
}

type Outcome =
  | { kind: "done"; outcome: PythonOutcome }
  | { kind: "needs-page" }
  | { kind: "unavailable"; detail?: string }
  | { kind: "timed-out" }
  | { kind: "stopped" };

const clip = (text: string, limit: number) => {
  const cs = Array.from(text);
  return cs.length <= limit ? text : `${cs.slice(0, limit).join("")}\n[truncated]`;
};

/** The tool result the model reads: `python.rs::describe`. */
export function describe(outcome: Outcome): string {
  const words = ANALYSIS.messages;
  if (outcome.kind === "needs-page") return words.needsPageOpen;
  if (outcome.kind === "unavailable")
    return words.unavailable.replace("{detail}", outcome.detail ? ` (${outcome.detail})` : "");
  if (outcome.kind === "timed-out") return words.timedOut;
  if (outcome.kind === "stopped") return words.stopped;
  const done = outcome.outcome;
  const parts: string[] = [];
  if (done.files.length) parts.push(`Files: ${done.files.join(", ")}`);
  if (done.stdout.trim())
    parts.push(`Output:\n${clip(done.stdout.trimEnd(), ANALYSIS.limits.maxStdoutChars)}`);
  if (done.result?.trim()) parts.push(`Result:\n${done.result}`);
  if (done.error) parts.push(`Error:\n${done.error}`);
  const blocks = done.blocks
    .filter(
      (block) =>
        (block.kind === "chart" || block.kind === "table") &&
        new TextEncoder().encode(block.json).length <= ANALYSIS.limits.maxBlockChars,
    )
    .slice(0, ANALYSIS.limits.maxBlocks)
    .map((block) => `\`\`\`subrosa:${block.kind}\n${block.json}\n\`\`\``);
  if (blocks.length) parts.push(`${words.cards}\n${blocks.join("\n")}`);
  return parts.length ? parts.join("\n\n") : words.printedNothing;
}

export interface PythonEngine {
  /** Runs `code` in the conversation `session`; the answer is for the model.
   * `files` are mounted under /data first (an Office range, ADR-0102). */
  run(
    code: string,
    session: string,
    signal?: AbortSignal,
    files?: PythonRunEvent["files"],
  ): Promise<string>;
  dispose(): void;
}

export function createPythonEngine(
  deps: EngineDeps,
  limits: { firstAnswerMs: number; runLimitMs: number } = ANALYSIS.limits,
): PythonEngine {
  let runHandler: ((event: PythonRunEvent) => void) | null = null;
  let cancelHandler: ((requestId: string) => void) | null = null;
  const waiting = new Map<string, (reply: PythonReply) => void>();
  const stop = startPythonBridge({
    onRun: async (handler) => {
      runHandler = handler;
      return () => {
        runHandler = null;
      };
    },
    onCancel: async (handler) => {
      cancelHandler = handler;
      return () => {
        cancelHandler = null;
      };
    },
    reply: async (requestId, reply) => waiting.get(requestId)?.(reply),
    ...deps,
  });

  const settle = (reply: PythonReply): Outcome =>
    reply.kind === "done"
      ? { kind: "done", outcome: reply }
      : reply.kind === "refused" && reply.reason !== "background"
        ? { kind: "unavailable", detail: reply.detail }
        : { kind: "needs-page" };

  const once = async (event: PythonRunEvent, signal?: AbortSignal): Promise<Outcome> => {
    const replies: PythonReply[] = [];
    let wake: (() => void) | null = null;
    waiting.set(event.requestId, (reply) => {
      replies.push(reply);
      wake?.();
    });
    const next = (ms: number) =>
      new Promise<PythonReply | "timeout" | "stopped">((resolve) => {
        const queued = replies.shift();
        if (queued) return resolve(queued);
        if (signal?.aborted) return resolve("stopped");
        const timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
        const abort = () => finish("stopped");
        signal?.addEventListener("abort", abort, { once: true });
        function finish(value: PythonReply | "timeout" | "stopped") {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          wake = null;
          resolve(value);
        }
        wake = () => {
          const reply = replies.shift();
          if (reply) finish(reply);
        };
      });
    try {
      if (!runHandler) return { kind: "unavailable", detail: "closed" };
      runHandler(event);
      const first = await next(limits.firstAnswerMs);
      if (first === "timeout" || first === "stopped") {
        cancelHandler?.(event.requestId);
        return first === "stopped" ? { kind: "stopped" } : { kind: "needs-page" };
      }
      if (first.kind !== "started") return settle(first);
      const deadline = Date.now() + limits.runLimitMs;
      for (;;) {
        const reply = await next(deadline - Date.now());
        if (reply === "timeout" || reply === "stopped") {
          cancelHandler?.(event.requestId);
          return reply === "stopped" ? { kind: "stopped" } : { kind: "timed-out" };
        }
        if (reply.kind === "started") continue;
        return settle(reply);
      }
    } finally {
      waiting.delete(event.requestId);
    }
  };

  return {
    async run(code, session, signal, files = []) {
      if (!code.trim()) return ANALYSIS.messages.noCode;
      if (Array.from(code).length > ANALYSIS.limits.maxCodeChars) return ANALYSIS.messages.tooLong;
      const event: PythonRunEvent = { requestId: crypto.randomUUID(), session, code, files };
      return describe(await once(event, signal));
    },
    dispose: stop,
  };
}
