// Generic queue → poll → retrieve machinery for the async media endpoints
// (video, music, heavy image models). One implementation serves them all —
// the endpoints share the same lifecycle, only paths and response fields vary.
//
// Jobs are persisted to localStorage the moment they are queued: a generation
// the user already paid for must survive an app restart, so views re-attach
// to pending jobs on mount instead of orphaning them.

import { useCallback, useEffect, useRef, useState } from "react";
import { MediaError, mediaJson, mediaRaw } from "./client";
import { ensureNotificationPermission, notifyMediaJobDone } from "./media-notifications";

export const POLL_INTERVAL_MS = 3_000;
/** ~15 minutes at the default interval; video renders can take a while. */
export const MAX_POLL_ATTEMPTS = 300;

const JOBS_STORAGE_KEY = "os-june:studio-jobs";
const MAX_PERSISTED_JOBS = 20;

export type JobPhase = "queued" | "processing" | "completed" | "failed";

/** Backends spell statuses differently (and in both cases): normalize. */
export function normalizeJobStatus(raw: unknown): JobPhase | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "queued":
    case "pending":
    case "waiting":
      return "queued";
    case "processing":
    case "running":
    case "in_progress":
    case "generating":
      return "processing";
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return undefined;
  }
}

export interface PollOptions<T> {
  retrievePath: string;
  retrieveBody: Record<string, unknown>;
  /** Extracts the finished payload once status is completed. */
  getResult: (response: Record<string, unknown>) => T | undefined;
  intervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onPhase?: (phase: JobPhase) => void;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The job was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls a retrieve endpoint until the job completes or fails. Transient
 * retrieve errors don't kill the poll — only a terminal status, an abort, or
 * the attempt budget do. */
export async function pollUntilDone<T>(options: PollOptions<T>): Promise<T> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? MAX_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException("The job was cancelled.", "AbortError");
    }
    let response: Record<string, unknown> | undefined;
    try {
      const raw = await mediaRaw(options.retrievePath, options.retrieveBody, options.signal);
      if (raw.json && typeof raw.json === "object") {
        response = raw.json as Record<string, unknown>;
      } else if (raw.bodyBase64) {
        // Some backends answer a finished job with the file itself instead of
        // a completed-status JSON, and drop the job server-side right after
        // (Carpe Diem music). This response IS the delivery: skipping it means
        // the next poll 404s and the paid result is lost.
        response = {
          status: "completed",
          body_base64: raw.bodyBase64,
          content_type: raw.contentType,
        };
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // A 4xx on retrieve is not transient: the job id is wrong or expired.
      if (error instanceof MediaError && error.status >= 400 && error.status < 500) {
        throw error;
      }
    }
    if (response) {
      const phase = normalizeJobStatus(response.status);
      if (phase === "completed") {
        const result = options.getResult(response);
        if (result !== undefined) return result;
        throw new MediaError("The job completed but returned no output.", { status: 200 });
      }
      if (phase === "failed") {
        const reason =
          typeof response.error === "string" && response.error.trim()
            ? response.error
            : "The generation failed.";
        throw new MediaError(reason, { status: 200 });
      }
      if (phase) options.onPhase?.(phase);
    }
    await sleep(interval, options.signal);
  }
  throw new MediaError(
    "The job is taking longer than expected. It may still finish - check again later.",
    { status: 0 },
  );
}

/** A finished job's file, whichever way the backend delivered it: a URL to
 * download, or the bytes themselves when the retrieve streamed the file. */
export type MediaFileResult = { url: string } | { base64: string };

/** Builds a `getResult` for file-producing jobs: reads the first non-empty
 * URL field from a JSON response, and falls back to the synthesized binary
 * body when the backend delivered the file directly. */
export function fileResultFrom(
  ...urlFields: string[]
): (response: Record<string, unknown>) => MediaFileResult | undefined {
  return (response) => {
    for (const field of urlFields) {
      const url = response[field];
      if (typeof url === "string" && url.trim()) return { url };
    }
    const base64 = response.body_base64;
    if (typeof base64 === "string" && base64) return { base64 };
    return undefined;
  };
}

// --- persisted pending jobs ---------------------------------------------------

export type PersistedJobKind = "video" | "music" | "image";

/** Everything needed to re-attach to a queued generation after a restart. */
export interface PersistedJob {
  id: string;
  kind: PersistedJobKind;
  model: string;
  prompt: string;
  queueId: string;
  retrievePath: string;
  retrieveBody: Record<string, unknown>;
  /** File extension for the eventual artifact download. */
  extension: string;
  createdAt: number;
}

function readJobs(): PersistedJob[] {
  try {
    const raw = window.localStorage.getItem(JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersistedJob[]) : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: PersistedJob[]) {
  try {
    window.localStorage.setItem(
      JOBS_STORAGE_KEY,
      JSON.stringify(jobs.slice(0, MAX_PERSISTED_JOBS)),
    );
  } catch {
    // Quota pressure: pending-job bookkeeping is best-effort.
  }
}

export function persistJob(job: PersistedJob) {
  writeJobs([job, ...readJobs().filter((existing) => existing.id !== job.id)]);
}

export function removePersistedJob(id: string) {
  writeJobs(readJobs().filter((job) => job.id !== id));
}

export function pendingJobs(kind: PersistedJobKind): PersistedJob[] {
  return readJobs().filter((job) => job.kind === kind);
}

// --- React hook ---------------------------------------------------------------

export type MediaJobState =
  | { phase: "idle" }
  | { phase: "queueing" }
  | { phase: "queued" | "processing"; startedAt: number; elapsedMs: number }
  | { phase: "failed"; message: string };

export interface StartJobOptions<T> {
  kind: PersistedJobKind;
  model: string;
  prompt: string;
  extension: string;
  queuePath: string;
  queueBody: Record<string, unknown>;
  /** Retrieve body from the queue id (video needs `{id, model}`). */
  retrieve: (queueId: string) => { path: string; body: Record<string, unknown> };
  getResult: (response: Record<string, unknown>) => T | undefined;
}

/** Drives one async generation at a time: queue, persist, poll, report.
 * `onCompleted` receives the extracted result plus the persisted job (for
 * downloading + gallery metadata); the hook clears the persisted entry. */
export function useMediaJob<T>(onCompleted: (result: T, job: PersistedJob) => Promise<void>) {
  const [state, setState] = useState<MediaJobState>({ phase: "idle" });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    const tick = window.setInterval(() => {
      setState((current) =>
        current.phase === "queued" || current.phase === "processing"
          ? { ...current, elapsedMs: Date.now() - current.startedAt }
          : current,
      );
    }, 1_000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const attach = useCallback(
    async (job: PersistedJob, getResult: (response: Record<string, unknown>) => T | undefined) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      const startedAt = job.createdAt;
      setState({ phase: "queued", startedAt, elapsedMs: Date.now() - startedAt });
      try {
        const result = await pollUntilDone<T>({
          retrievePath: job.retrievePath,
          retrieveBody: job.retrieveBody,
          getResult,
          signal: controller.signal,
          onPhase: (phase) =>
            setState((current) =>
              (phase === "queued" || phase === "processing") &&
              (current.phase === "queued" || current.phase === "processing")
                ? { phase, startedAt: current.startedAt, elapsedMs: current.elapsedMs }
                : current,
            ),
        });
        await onCompletedRef.current(result, job);
        removePersistedJob(job.id);
        // Best-effort local notification: long renders finish while the user is
        // elsewhere in (or just returning to) the app.
        void notifyMediaJobDone(job.kind, job.prompt);
        setState({ phase: "idle" });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setState({ phase: "idle" });
          return;
        }
        // Terminal failure: the backend won't finish this job, drop it.
        if (!(error instanceof MediaError && error.status === 0)) {
          removePersistedJob(job.id);
        }
        setState({
          phase: "failed",
          message: error instanceof Error ? error.message : "The generation failed.",
        });
      }
    },
    [],
  );

  const start = useCallback(
    async (options: StartJobOptions<T>) => {
      setState({ phase: "queueing" });
      let queueId: string;
      try {
        const queued = await mediaJson<Record<string, unknown>>(
          options.queuePath,
          options.queueBody,
        );
        const id = queued.queue_id ?? queued.id;
        if (typeof id !== "string" || !id) {
          throw new MediaError("The backend did not return a job id.", { status: 200 });
        }
        queueId = id;
      } catch (error) {
        setState({
          phase: "failed",
          message: error instanceof Error ? error.message : "Queueing the generation failed.",
        });
        return;
      }
      const retrieve = options.retrieve(queueId);
      const job: PersistedJob = {
        id: queueId,
        kind: options.kind,
        model: options.model,
        prompt: options.prompt,
        queueId,
        retrievePath: retrieve.path,
        retrieveBody: retrieve.body,
        extension: options.extension,
        createdAt: Date.now(),
      };
      persistJob(job);
      // Ask for notification permission in context: the user just started a
      // generation that can take minutes, so a "when it's done" prompt reads
      // naturally here.
      void ensureNotificationPermission();
      await attach(job, options.getResult);
    },
    [attach],
  );

  /** Re-attach to a job persisted before a restart. */
  const resume = useCallback(
    (job: PersistedJob, getResult: (response: Record<string, unknown>) => T | undefined) =>
      attach(job, getResult),
    [attach],
  );

  /** Stops polling. The backend keeps rendering (and billing) — the persisted
   * job stays so the user can re-attach later instead of losing the output. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: "idle" });
  }, []);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, start, resume, cancel, reset };
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}
