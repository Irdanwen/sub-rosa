/**
 * Per-session record of the background PROCESSES a session has running — the
 * `background=true` shell commands the agent parks long work in.
 *
 * Since v1.27.0 the soul note tells the agent to put anything long (big
 * batches, long builds, repeated API calls) into a background process with
 * `notify_on_complete`, report what is running, and END ITS TURN. The gateway's
 * notification poller then wakes it with the output. That is the right shape
 * for long work, but it left the app looking dead: a finished turn, an idle
 * composer, and nothing anywhere saying that a two-hour job is still going.
 * This store is what the UI reads to say so.
 *
 * Deliberately tolerant about frame shapes. The runtime is pinned but its
 * background payloads are not part of the contract June freezes, so every field
 * is looked up under several plausible names and a process is only tracked when
 * one of them actually identifies it. An unrecognized shape means no banner —
 * never a wrong one.
 */

import type { JuneHermesEvent } from "./hermes-control-plane";

export type BackgroundProcessStatus = "running" | "finished";

export type BackgroundProcess = {
  /** Stable id: the runtime's handle when it gives one, else the tool call id. */
  id: string;
  sessionId: string;
  /** Short human label — the command when the frame carries one. */
  label?: string;
  status: BackgroundProcessStatus;
  startedAt: string;
  finishedAt?: string;
};

export type HermesBackgroundProcessStore = {
  /** Folds one classified frame in, under the STORED session id the rest of the
   * UI keys by. The caller passes it rather than the store reading the frame's
   * own `sessionId`, which is the live RUNTIME id — the two differ, and reading
   * the wrong one files every process under a key nothing looks up. Total:
   * frames that say nothing about a background process are ignored. */
  record(event: JuneHermesEvent, context: { sessionId: string; receivedAt: string }): void;
  /** This session's processes, oldest first. */
  forSession(sessionId: string | undefined): BackgroundProcess[];
  /** Drops the finished rows of a session — called when its next turn starts,
   * so "finished, being picked back up" does not linger once it has been. */
  clearFinished(sessionId: string): void;
  /** Drops everything for a session (it was deleted). */
  clearSession(sessionId: string): void;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
};

/** Cap per session so a pathological run cannot grow the store unbounded. */
export const BACKGROUND_PROCESSES_PER_SESSION_CAP = 20;

type ProcessRecord = Record<string, unknown>;

function asRecord(value: unknown): ProcessRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ProcessRecord;
}

/** The payload plus the nested bags tool frames wrap their arguments in. */
function payloadRecords(payload: unknown): ProcessRecord[] {
  const root = asRecord(payload);
  if (!root) return [];
  const records = [root];
  for (const key of ["arguments", "args", "input", "parameters"]) {
    const child = asRecord(root[key]);
    if (child) records.push(child);
  }
  return records;
}

/** Key-major, not record-major: `keys` is a preference order, so the most
 * specific name must win wherever it lives. A launch frame carries both
 * `name: "terminal"` at the root and the actual command in its nested
 * arguments, and the command is the label worth showing. */
function firstString(records: ProcessRecord[], keys: string[]): string | undefined {
  for (const key of keys) {
    for (const record of records) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return undefined;
}

/** True only for an explicit affirmative — an absent flag is not a background
 * process, and neither is `background: false` or an empty string. */
function backgroundFlag(records: ProcessRecord[]): boolean {
  for (const record of records) {
    for (const key of ["background", "is_background", "run_in_background", "detach"]) {
      const value = record[key];
      if (value === true) return true;
      if (typeof value === "string" && ["true", "yes", "1"].includes(value.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

const HANDLE_KEYS = [
  "handle",
  "background_id",
  "backgroundId",
  "process_id",
  "processId",
  "job_id",
  "jobId",
  "pid",
];

const LABEL_KEYS = ["command", "cmd", "script", "shell_command", "label", "name", "goal"];

/** A short, single-line label: the first line of the command, capped. */
function shortLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split("\n")[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/** Lifecycle statuses that mean the process is over. `background.complete` is
 * the common one; a status field is honoured when the frame carries one. */
function isFinishedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("finish") ||
    normalized.includes("exit") ||
    normalized.includes("done") ||
    normalized.includes("error") ||
    normalized.includes("fail") ||
    normalized.includes("cancel")
  );
}

export function createHermesBackgroundProcessStore(): HermesBackgroundProcessStore {
  const bySession = new Map<string, BackgroundProcess[]>();
  const listeners = new Set<() => void>();
  let version = 0;

  function emit() {
    version += 1;
    for (const listener of listeners) listener();
  }

  function upsert(next: BackgroundProcess) {
    const rows = bySession.get(next.sessionId) ?? [];
    const index = rows.findIndex((row) => row.id === next.id);
    if (index >= 0) {
      const previous = rows[index];
      if (!previous) return;
      // A start frame must never resurrect a finished process, and a repeated
      // start must not reset the elapsed clock the banner shows.
      rows[index] = {
        ...previous,
        ...next,
        startedAt: previous.startedAt,
        label: next.label ?? previous.label,
        status: next.status === "running" ? previous.status : next.status,
      };
    } else {
      rows.push(next);
      while (rows.length > BACKGROUND_PROCESSES_PER_SESSION_CAP) rows.shift();
    }
    bySession.set(next.sessionId, rows);
    emit();
  }

  function record(event: JuneHermesEvent, context: { sessionId: string; receivedAt: string }) {
    const { sessionId, receivedAt } = context;
    if (!sessionId) return;

    if (event.kind === "tool") {
      const records = payloadRecords(event.payload);
      if (!backgroundFlag(records)) return;
      const id = firstString(records, HANDLE_KEYS) ?? event.toolCallId;
      if (!id) return;
      upsert({
        id,
        sessionId,
        label: shortLabel(firstString(records, LABEL_KEYS)) ?? event.name,
        // A tool frame only ever announces the launch; a background process
        // outlives the call that started it, so `tool.complete` here means "the
        // launch returned", not "the process ended". Only a lifecycle frame
        // ends one.
        status: "running",
        startedAt: receivedAt,
      });
      return;
    }

    // `background.*` lifecycle frames. Matched on the raw type, not on
    // `status`: a frame carrying its own status field shadows the type there
    // ("exited" tells you nothing about which lifecycle it belongs to).
    if (event.kind !== "lifecycle" || !event.rawType?.startsWith("background.")) return;
    const records = payloadRecords(event.payload);
    const id = firstString(records, HANDLE_KEYS);
    if (!id) return;
    // Read the end from the type OR the status: `background.complete` with no
    // status, and `background.update` with `status: "exited"`, both mean over.
    const finished = isFinishedStatus(event.rawType) || isFinishedStatus(event.status);
    upsert({
      id,
      sessionId,
      label: shortLabel(firstString(records, LABEL_KEYS)),
      status: finished ? "finished" : "running",
      startedAt: receivedAt,
      ...(finished ? { finishedAt: receivedAt } : {}),
    });
  }

  function forSession(sessionId: string | undefined): BackgroundProcess[] {
    if (!sessionId) return [];
    return (bySession.get(sessionId) ?? []).map((row) => ({ ...row }));
  }

  function clearFinished(sessionId: string) {
    const rows = bySession.get(sessionId);
    if (!rows?.some((row) => row.status === "finished")) return;
    const next = rows.filter((row) => row.status !== "finished");
    if (next.length) {
      bySession.set(sessionId, next);
    } else {
      bySession.delete(sessionId);
    }
    emit();
  }

  function clearSession(sessionId: string) {
    if (!bySession.delete(sessionId)) return;
    emit();
  }

  return {
    record,
    forSession,
    clearFinished,
    clearSession,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
  };
}

/** The app-wide store. AgentWorkspace feeds it from the live gateway
 * subscription and the chat reads it, mirroring the other Hermes stores. */
export const hermesBackgroundProcessStore = createHermesBackgroundProcessStore();

/** True when a session has work running outside its turn — the reason a settled
 * turn is not necessarily an idle session. */
export function hasRunningBackgroundWork(processes: BackgroundProcess[]): boolean {
  return processes.some((process) => process.status === "running");
}
