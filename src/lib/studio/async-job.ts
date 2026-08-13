// Async media generations (video, music, sound effects, heavy image models):
// queue here, then hand the job to Rust.
//
// These renders take minutes. The poll used to live in this file, which meant
// it lived in the webview — and iOS freezes the webview the moment the app
// leaves the foreground, so locking the phone stalled a render the user had
// already paid for until they came back to the exact screen that started it.
// The poll, the download and the "it's ready" notification now belong to
// `carpe_diem::jobs` in Rust, which keeps running through the background
// window and picks up unfinished rows on the next launch.
//
// What is left here is the view layer: queue the job, hand it over, then
// observe. Observation has two halves, and both are needed — the event stream
// for while the webview is awake, and a reconcile through `media_job_list` on
// mount for everything that landed while it was not.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaError, mediaJson, mediaRaw } from "./client";
import { ensureNotificationPermission } from "../notifications";
import type { ArtifactFile } from "./types";

export const POLL_INTERVAL_MS = 3_000;
/** ~15 minutes at the default interval; video renders can take a while. */
export const MAX_POLL_ATTEMPTS = 300;

/** Rust emits this whenever a job changes state. */
const MEDIA_JOB_EVENT = "june://media-job";
/** Backstop for the window where the webview was frozen and missed events. */
const RECONCILE_INTERVAL_MS = 5_000;
/** Same backstop with nothing in flight, where it is only a safety net. */
const IDLE_RECONCILE_INTERVAL_MS = 30_000;

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

/** In-webview polling, kept as the workflow engine's *fallback*: a run whose
 * durable row could not be recorded (tests, browser previews) still executes,
 * it is just foreground-bound. Everything the user actually starts — durable
 * workflow runs (ADR-0021) and standalone generations — rides the Rust job
 * rows instead ({@link useMediaJobQueue}, the durable runner in
 * workflow-run.ts).
 *
 * Transient retrieve errors don't kill the poll — only a terminal status, an
 * abort, or the attempt budget do. */
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

// --- durable jobs -------------------------------------------------------------

export type MediaJobKind = "video" | "music" | "image" | "sfx";

/** A generation Rust is tracking. Mirrors `MediaJobDto`. */
export interface MediaJob {
  id: string;
  kind: MediaJobKind;
  model: string;
  prompt: string;
  extension: string;
  status: JobPhase;
  error?: string;
  /** HTTP status the failure arrived with, when it came from the backend. The
   * messages alone do not separate the cases a user has to act on. */
  errorStatus?: number;
  artifactPath?: string;
  artifactFileName?: string;
  artifactBytes?: number;
  /** Gallery id of the clip this render continues, when it started from a
   * handoff frame. Lives on the durable row so a chain survives the app being
   * closed mid-render. */
  parentArtifactId?: string;
  /** Where in the parent the handoff frame was taken, in seconds. */
  parentHandoffSeconds?: number;
  /** What the render was quoted at, in credits. */
  costCredits?: number;
  /** Who queued the job: absent/"studio" for hand-run generations,
   * "workflow" for a durable run's renders. The Studio surfaces leave
   * workflow jobs alone — the run files and dismisses them itself. */
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartJobOptions {
  kind: MediaJobKind;
  model: string;
  prompt: string;
  extension: string;
  queuePath: string;
  queueBody: Record<string, unknown>;
  /** Retrieve request built from the queue id (video needs `{id, model}`). */
  retrieve: (queueId: string) => { path: string; body: Record<string, unknown> };
  /** Response fields Rust should read the finished file's URL from, in order. */
  urlFields: string[];
  /** Gallery id of the clip this render continues (shot continuity). */
  parentArtifactId?: string;
  /** Where in the parent the handoff frame was taken, in seconds. */
  parentHandoffSeconds?: number;
  /** The quote accepted for this render, in credits, for chain totals. */
  costCredits?: number;
}

function startedAtOf(job: MediaJob): number {
  const parsed = Date.parse(job.createdAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function artifactOf(job: MediaJob): ArtifactFile | undefined {
  if (!job.artifactPath || !job.artifactFileName) return undefined;
  return {
    path: job.artifactPath,
    fileName: job.artifactFileName,
    bytes: job.artifactBytes ?? 0,
  };
}

/** Queue a generation upstream, then hand the id to Rust. The queue call is
 * the one part that has to happen here: it is what turns a prompt into a job
 * id, and it is short enough to finish inside the background grace window. */
async function queueAndHandOff(options: StartJobOptions): Promise<MediaJob> {
  const queued = await mediaJson<Record<string, unknown>>(options.queuePath, options.queueBody);
  const queueId = queued.queue_id ?? queued.id;
  if (typeof queueId !== "string" || !queueId) {
    throw new MediaError("The backend did not return a job id.", { status: 200 });
  }
  const retrieve = options.retrieve(queueId);
  // Ask for notification permission in context: the user just started a
  // generation that can take minutes, so a "when it's done" prompt reads
  // naturally here — and the notification is now what tells them it landed
  // while they were in another app.
  void ensureNotificationPermission();
  return invoke<MediaJob>("media_job_start", {
    request: {
      queueId,
      kind: options.kind,
      model: options.model,
      prompt: options.prompt,
      extension: options.extension,
      retrievePath: retrieve.path,
      retrieveBody: retrieve.body,
      urlFields: options.urlFields,
      parentArtifactId: options.parentArtifactId,
      parentHandoffSeconds: options.parentHandoffSeconds,
      costCredits: options.costCredits,
    },
  });
}

/**
 * Watch the durable jobs of one kind.
 *
 * Rust owns the work; this owns the reconciliation. A job that completes while
 * the app is away is not "seen" until we index its artifact in the gallery, so
 * the reducer here calls `onCompleted` and only then dismisses the row. That
 * handshake is what makes a render that finished overnight show up.
 */
function useDurableJobs(
  kind: MediaJobKind,
  onCompleted: (artifact: ArtifactFile, job: MediaJob) => Promise<void> | void,
) {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  /** Jobs whose artifact is being filed, so a re-render cannot file it twice. */
  const settling = useRef(new Set<string>());

  const ingest = useCallback(
    (incoming: MediaJob[]) => {
      // Workflow-run renders are not this surface's to file or dismiss: the
      // durable runner is waiting on those rows (ADR-0021).
      const mine = incoming.filter((job) => job.kind === kind && job.source !== "workflow");
      setJobs((current) => {
        const byId = new Map(current.map((job) => [job.id, job]));
        for (const job of mine) byId.set(job.id, job);
        // Drop rows Rust no longer knows about, but only when we have the full
        // picture (a single-job event says nothing about the others).
        return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      for (const job of mine) {
        if (job.status !== "completed" || settling.current.has(job.id)) continue;
        const artifact = artifactOf(job);
        if (!artifact) continue;
        settling.current.add(job.id);
        void (async () => {
          try {
            await onCompletedRef.current(artifact, job);
          } finally {
            await invoke("media_job_dismiss", { id: job.id }).catch(() => {});
            settling.current.delete(job.id);
            setJobs((current) => current.filter((entry) => entry.id !== job.id));
          }
        })();
      }
    },
    [kind],
  );

  const reconcile = useCallback(async () => {
    try {
      const all = await invoke<MediaJob[]>("media_job_list");
      const mine = all.filter((job) => job.kind === kind && job.source !== "workflow");
      setJobs((current) => {
        const known = new Set(mine.map((job) => job.id));
        // Anything the list no longer carries is settled: keep only rows still
        // being filed by `ingest`.
        const kept = current.filter((job) => known.has(job.id) || settling.current.has(job.id));
        const byId = new Map(kept.map((job) => [job.id, job]));
        for (const job of mine) byId.set(job.id, job);
        return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      ingest(mine);
    } catch {
      // The command surface is unavailable (browser preview, early boot):
      // the next tick tries again.
    }
  }, [ingest, kind]);

  const watching = jobs.length > 0;
  useEffect(() => {
    void reconcile();
    const unlisten = listen<MediaJob>(MEDIA_JOB_EVENT, (event) => ingest([event.payload]));
    // Events do not queue up while iOS has the webview frozen, so poll the
    // durable list as well: this is what catches everything that landed while
    // the app was away. Fast while something is in flight, slow otherwise —
    // with no job of this kind there is nothing that can complete behind our
    // back, and the mount above already caught up.
    const tick = window.setInterval(
      () => void reconcile(),
      watching ? RECONCILE_INTERVAL_MS : IDLE_RECONCILE_INTERVAL_MS,
    );
    return () => {
      void unlisten.then((stop) => stop()).catch(() => {});
      window.clearInterval(tick);
    };
  }, [ingest, reconcile, watching]);

  // One shared clock for the elapsed counters.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, []);

  const start = useCallback(
    async (options: StartJobOptions) => {
      const job = await queueAndHandOff(options);
      ingest([job]);
      return job;
    },
    [ingest],
  );

  /** Stop watching one job. The backend keeps rendering (and has already
   * billed), so the row stays and Rust resumes it on the next sweep. */
  const stop = useCallback(async (id: string) => {
    await invoke("media_job_stop", { id }).catch(() => {});
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  /** Forget a job for good (a failure the user dismissed). */
  const dismiss = useCallback(async (id: string) => {
    await invoke("media_job_dismiss", { id }).catch(() => {});
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  return { jobs, now, start, stop, dismiss };
}

// --- single-slot hook ---------------------------------------------------------

export type MediaJobState =
  | { phase: "idle" }
  | { phase: "queueing" }
  | { phase: "queued" | "processing"; startedAt: number; elapsedMs: number }
  /** `status` is the HTTP code the failure came back with, when it came from
   * the backend at all: what the message says and what the user can do about
   * it are two different questions, and only the code answers the second. */
  | { phase: "failed"; message: string; status?: number };

/**
 * Drives one generation at a time for the simple views. Reports the newest
 * unfinished job of its kind — including one started in a previous session, so
 * reopening the app mid-render shows the render rather than an empty form.
 */
export function useMediaJob(
  kind: MediaJobKind,
  onCompleted: (artifact: ArtifactFile, job: MediaJob) => Promise<void> | void,
) {
  const { jobs, now, start, stop, dismiss } = useDurableJobs(kind, onCompleted);
  const [queueing, setQueueing] = useState(false);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  /** A queue call that never produced a job id, so there is no row to carry
   * the message. Cleared by the next attempt. */
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  /** What the last submit asked for, so "start it again" can mean the same
   * request rather than whatever the form happens to hold now. Deliberately
   * not persisted: after a restart the honest answer is that we no longer
   * know what was asked for, and silently re-spending on a guess is worse
   * than not offering the button. */
  const lastOptions = useRef<StartJobOptions | undefined>(undefined);

  const active = jobs.find((job) => job.status === "queued" || job.status === "processing");
  const failed = jobs.find((job) => job.status === "failed" && job.id !== dismissed);

  let state: MediaJobState = { phase: "idle" };
  if (active) {
    const startedAt = startedAtOf(active);
    // `active` is filtered to the two running phases just above.
    const phase = active.status as "queued" | "processing";
    state = { phase, startedAt, elapsedMs: Math.max(0, now - startedAt) };
  } else if (queueing) {
    state = { phase: "queueing" };
  } else if (submitError) {
    state = { phase: "failed", message: submitError };
  } else if (failed) {
    state = {
      phase: "failed",
      message: failed.error ?? "The generation failed.",
      status: failed.errorStatus,
    };
  }

  const startJob = useCallback(
    async (options: StartJobOptions) => {
      setQueueing(true);
      setSubmitError(undefined);
      setDismissed(undefined);
      lastOptions.current = options;
      try {
        await start(options);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Queueing the generation failed.");
      } finally {
        setQueueing(false);
      }
    },
    [start],
  );

  const cancel = useCallback(() => {
    if (active) void stop(active.id);
  }, [active, stop]);

  const reset = useCallback(() => {
    setSubmitError(undefined);
    if (failed) {
      setDismissed(failed.id);
      void dismiss(failed.id);
    }
  }, [dismiss, failed]);

  /** Queue the failed request again, unchanged. Clears the old row first so
   * the failure does not linger next to its own replacement. */
  const retry = useCallback(() => {
    const options = lastOptions.current;
    if (!options) return;
    reset();
    void startJob(options);
  }, [reset, startJob]);

  return {
    state,
    start: startJob,
    cancel,
    reset,
    retry,
    /** Whether there is a request to repeat at all. */
    canRetry: lastOptions.current !== undefined,
  };
}

// --- multi-job hook -----------------------------------------------------------

/** One entry in a view's live job list. Completed jobs leave the list (their
 * artifact lands in the gallery); failed ones stay until dismissed. */
export interface QueuedJobState {
  job: MediaJob;
  phase: "queued" | "processing" | "failed";
  elapsedMs: number;
  message?: string;
  /** HTTP status behind a failure, when the backend gave one. */
  status?: number;
  /** Whether this entry's request is still known well enough to repeat. */
  canRetry: boolean;
}

/**
 * Drives any number of concurrent generations for one view. Rust polls them
 * all in parallel whether or not this component is mounted, so the list is a
 * read of durable state rather than a set of in-flight promises.
 */
export function useMediaJobQueue(
  kind: MediaJobKind,
  onCompleted: (artifact: ArtifactFile, job: MediaJob) => Promise<void> | void,
) {
  const { jobs, now, start, stop, dismiss } = useDurableJobs(kind, onCompleted);
  /** Submits that never reached the backend: no queue id, so no durable row —
   * they live here until the user dismisses them. */
  const [rejected, setRejected] = useState<QueuedJobState[]>([]);
  /** What each submit asked for, so "start it again" repeats that request
   * rather than rebuilding one from a form the user may have changed since.
   * Not persisted on purpose: after a restart we genuinely do not know what
   * was asked for, and re-spending on a guess is worse than no button. */
  const attempts = useRef(new Map<string, StartJobOptions>());

  const entries: QueuedJobState[] = [
    ...rejected,
    ...jobs
      .filter((job) => job.status !== "completed")
      .map((job) => ({
        job,
        phase: job.status as "queued" | "processing" | "failed",
        elapsedMs: Math.max(0, now - startedAtOf(job)),
        message: job.error,
        status: job.errorStatus,
        canRetry: attempts.current.has(job.id),
      })),
  ];

  const startJob = useCallback(
    async (options: StartJobOptions) => {
      try {
        const job = await start(options);
        attempts.current.set(job.id, options);
      } catch (error) {
        const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        attempts.current.set(id, options);
        setRejected((current) => [
          {
            job: {
              id,
              kind: options.kind,
              model: options.model,
              prompt: options.prompt,
              extension: options.extension,
              status: "failed",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            phase: "failed",
            elapsedMs: 0,
            message: error instanceof Error ? error.message : "Queueing the generation failed.",
            // Carry the status here too, or a queue call refused for a bad
            // field reads the same as one that never left the machine - and
            // only one of those is worth sending again unchanged.
            status: error instanceof MediaError ? error.status : undefined,
            canRetry: true,
          },
          ...current,
        ]);
      }
    },
    [start],
  );

  const dismissEntry = useCallback(
    (id: string) => {
      attempts.current.delete(id);
      setRejected((current) => current.filter((entry) => entry.job.id !== id));
      void dismiss(id);
    },
    [dismiss],
  );

  /** Queue one failed entry's request again, unchanged, and drop the entry it
   * replaces. A re-queue gets a new job id, so this is a new row, not a
   * resurrection of the old one. */
  const retry = useCallback(
    async (id: string) => {
      const options = attempts.current.get(id);
      if (!options) return;
      dismissEntry(id);
      await startJob(options);
    },
    [dismissEntry, startJob],
  );

  return { jobs: entries, start: startJob, stop, dismiss: dismissEntry, retry };
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}
