// The webview's half of `run_python` (ADR-0086). Rust asks for a run with an
// event and waits, with a timeout, for this side's answer through
// `agent_lite_python_reply`. Python only runs while the app is on screen: a
// hidden page refuses at once, and a page that goes hidden mid-run stops the
// worker and says so, so the turn moves on instead of waiting on a frozen
// webview. The run belongs to the turn, which is already the durable row
// (ADR-0018): a turn interrupted here is re-asked when it resumes.

import { mountedFiles } from "./files";
import {
  messageOf,
  type PythonReply,
  type PythonRunEvent,
  type WorkerDone,
  type WorkerRun,
} from "./protocol";

export type WorkerLike = {
  postMessage(message: WorkerRun): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerDone>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type PythonBridgeDeps = {
  onRun(handler: (event: PythonRunEvent) => void): Promise<() => void>;
  onCancel(handler: (requestId: string) => void): Promise<() => void>;
  reply(requestId: string, reply: PythonReply): Promise<unknown>;
  createWorker(): WorkerLike;
  visible(): boolean;
  onVisibilityChange(handler: () => void): () => void;
};

/** Starts listening; the returned function stops and frees the worker. */
export function startPythonBridge(deps: PythonBridgeDeps): () => void {
  let worker: WorkerLike | null = null;
  const pending = new Set<string>();
  const send = (requestId: string, reply: PythonReply) => {
    void deps.reply(requestId, reply).catch(() => undefined);
  };

  // Ends every run in flight with one reply, and the worker with them: wasm
  // cannot be interrupted, only discarded.
  const abandon = (reply: PythonReply) => {
    worker?.terminate();
    worker = null;
    for (const requestId of pending) send(requestId, reply);
    pending.clear();
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const created = deps.createWorker();
    created.onmessage = (event) => {
      const done = event.data;
      if (done?.type !== "done" || !pending.delete(done.id)) return;
      const { type: _type, id: _id, ...outcome } = done;
      send(done.id, { kind: "done", ...outcome });
    };
    created.onerror = (event) => {
      abandon({ kind: "refused", reason: "unavailable", detail: event.message || undefined });
    };
    worker = created;
    return created;
  };

  const run = (event: PythonRunEvent) => {
    if (!deps.visible()) {
      send(event.requestId, { kind: "refused", reason: "background" });
      return;
    }
    let target: WorkerLike;
    try {
      target = ensureWorker();
    } catch (error) {
      send(event.requestId, {
        kind: "refused",
        reason: "unavailable",
        detail: messageOf(error),
      });
      return;
    }
    pending.add(event.requestId);
    send(event.requestId, { kind: "started" });
    target.postMessage({
      type: "run",
      id: event.requestId,
      session: event.session,
      code: event.code,
      files: mountedFiles(event.files),
    });
  };

  const stops: (() => void)[] = [];
  let stopped = false;
  void deps.onRun(run).then((stop) => (stopped ? stop() : stops.push(stop)));
  void deps
    .onCancel((requestId) => {
      if (pending.has(requestId))
        abandon({ kind: "refused", reason: "unavailable", detail: "timeout" });
    })
    .then((stop) => (stopped ? stop() : stops.push(stop)));
  stops.push(
    deps.onVisibilityChange(() => {
      if (!deps.visible() && pending.size > 0) abandon({ kind: "refused", reason: "background" });
    }),
  );
  return () => {
    stopped = true;
    for (const stop of stops) stop();
    abandon({ kind: "refused", reason: "unavailable", detail: "closed" });
  };
}
