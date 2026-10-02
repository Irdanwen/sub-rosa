// A retouch is a paid job, so it is a durable row before it is anything else
// (ADR-0018). The webview queues it with its version lineage attached; Rust
// polls, merges a zone back into its source, and saves the file; whichever
// observer is awake then files the version. Foreground and cold launch take
// the same path, so a version that lands while the app is closed joins its
// session exactly like one the person watched arrive.

import { invoke } from "@tauri-apps/api/core";
import { errorCode } from "../../errors";
import { t } from "../../i18n";
import { registerDownloadedArtifactDurably } from "../artifacts";
import type { MediaJob } from "../async-job";
import type { RetouchLineage } from "../types";
import type { EditRequest } from "./request";

export const RETOUCH_SOURCE = "retouch:";
/** A version was filed. Detail: {@link RetouchVersionDetail}. */
export const RETOUCH_VERSION_EVENT = "subrosa:retouch-version";
/** A retouch failed; the failure is in {@link readRetouchFailures}. */
export const RETOUCH_FAILED_EVENT = "subrosa:retouch-failed";

const FAILURE_KEY = "os-june:retouch-failures";
const MAX_FAILURES = 20;

/** What travels with the job and comes back with its result. */
export interface RetouchJobContext {
  v: 1;
  edit: Omit<RetouchLineage, "jobId" | "elapsedMs" | "unmerged">;
  /** Set by Rust when a zone could not be merged back. */
  compositeFailed?: boolean;
}

/** A zone retouch: the crop that was sent, and where to put it back. */
export interface CompositeSpec {
  parentFileName: string;
  crop: [number, number, number, number];
  maskPngBase64: string;
}

export interface RetouchVersionDetail {
  rootId: string;
  artifactId: string;
  parentId: string;
  jobId: string;
}

export interface RetouchFailure {
  jobId: string;
  rootId: string;
  parentId: string;
  prompt: string;
  message: string;
}

export function retouchSource(rootId: string): string {
  return `${RETOUCH_SOURCE}${rootId}`;
}

export function retouchRootOf(source: string | undefined): string | undefined {
  if (!source?.startsWith(RETOUCH_SOURCE)) return undefined;
  return source.slice(RETOUCH_SOURCE.length) || undefined;
}

/** The lineage a job carries, if it is a well-formed retouch. */
export function retouchContextOf(
  job: Pick<MediaJob, "clientContext">,
): RetouchJobContext | undefined {
  const context = job.clientContext as Partial<RetouchJobContext> | undefined;
  const edit = context?.edit;
  if (context?.v !== 1 || !edit) return undefined;
  if (typeof edit.of !== "string" || typeof edit.root !== "string") return undefined;
  if (typeof edit.n !== "number" || typeof edit.op !== "string") return undefined;
  return context as RetouchJobContext;
}

export interface RetouchSubmission {
  request: EditRequest;
  lineage: RetouchJobContext["edit"];
  costCredits?: number;
  composite?: CompositeSpec;
}

/** Queue one retouch. Resolves once the row exists and the operator accepted
 * the job; the version itself arrives later, through recovery. */
export async function submitRetouch(submission: RetouchSubmission): Promise<MediaJob> {
  const { request, lineage } = submission;
  const jobId = crypto.randomUUID();
  const clientContext: RetouchJobContext = { v: 1, edit: lineage };
  try {
    return await invoke<MediaJob>("media_job_queue", {
      request: {
        jobId,
        kind: "image",
        model: request.body.model,
        prompt: request.body.prompt,
        extension: "png",
        queuePath: `${request.base}/queue`,
        queueBody: request.body,
        retrievePath: `${request.base}/retrieve`,
        urlFields: ["image_url", "url"],
        source: retouchSource(lineage.root),
        costCredits: submission.costCredits,
        clientContext,
        composite: submission.composite,
      },
    });
  } catch (error) {
    // An explicit refusal left a failed row nobody else owns. An uncertain
    // one stays durable so the person can check their provider history.
    if (errorCode(error) === "media_job_queue_failed")
      await invoke("media_job_dismiss", { id: jobId }).catch(() => undefined);
    throw error;
  }
}

/** Retouch jobs still rendering for one session. */
export async function inFlightRetouches(rootId: string): Promise<MediaJob[]> {
  const jobs = (await invoke<MediaJob[] | null>("media_job_list").catch(() => null)) ?? [];
  return jobs.filter(
    (job) =>
      retouchRootOf(job.source) === rootId &&
      (job.status === "queued" || job.status === "processing"),
  );
}

const settling = new Set<string>();

/** File a finished retouch as a version, or record its failure. Idempotent:
 * the artifact id is the file name, so filing the same job twice rewrites the
 * same entry. Returns whether the job was a retouch. */
export async function recoverRetouchJob(job: MediaJob): Promise<boolean> {
  const rootId = retouchRootOf(job.source);
  if (!rootId || job.kind !== "image") return false;
  if (job.status !== "completed" && job.status !== "failed") return true;
  if (settling.has(job.id)) return true;
  const context = retouchContextOf(job);
  settling.add(job.id);
  try {
    if (job.status === "failed" || !context) {
      rememberFailure({
        jobId: job.id,
        rootId,
        parentId: context?.edit.of ?? rootId,
        prompt: job.prompt,
        message: job.error?.trim()
          ? t(job.error.trim())
          : context
            ? t("The retouch failed.")
            : t("The retouch came back without its details."),
      });
      await invoke("media_job_dismiss", { id: job.id });
      window.dispatchEvent(new Event(RETOUCH_FAILED_EVENT));
      return true;
    }
    if (!job.artifactPath || !job.artifactFileName) return true;
    const edit: RetouchLineage = {
      ...context.edit,
      jobId: job.id,
      elapsedMs: elapsedOf(job),
      ...(context.compositeFailed ? { unmerged: true } : {}),
    };
    const artifact = await registerDownloadedArtifactDurably(
      { path: job.artifactPath, fileName: job.artifactFileName, bytes: job.artifactBytes ?? 0 },
      { kind: "image", model: job.model, prompt: job.prompt, costCredits: job.costCredits, edit },
    );
    await invoke("media_job_dismiss", { id: job.id });
    const detail: RetouchVersionDetail = {
      rootId,
      artifactId: artifact.id,
      parentId: edit.of,
      jobId: job.id,
    };
    window.dispatchEvent(new CustomEvent(RETOUCH_VERSION_EVENT, { detail }));
    return true;
  } finally {
    settling.delete(job.id);
  }
}

/** Submission to delivery, from the row's own timestamps: right even when the
 * result landed while the app was closed. */
function elapsedOf(job: MediaJob): number | undefined {
  const start = Date.parse(job.createdAt);
  const end = Date.parse(job.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

export function readRetouchFailures(rootId?: string): RetouchFailure[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FAILURE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RetouchFailure =>
        item &&
        typeof item.jobId === "string" &&
        typeof item.rootId === "string" &&
        typeof item.message === "string" &&
        (rootId === undefined || item.rootId === rootId),
    );
  } catch {
    return [];
  }
}

export function dismissRetouchFailure(jobId: string): void {
  writeFailures(readRetouchFailures().filter((item) => item.jobId !== jobId));
  window.dispatchEvent(new Event(RETOUCH_FAILED_EVENT));
}

function rememberFailure(failure: RetouchFailure): void {
  const failures = readRetouchFailures().filter((item) => item.jobId !== failure.jobId);
  failures.push({ ...failure, message: failure.message.slice(0, 500) });
  writeFailures(failures.slice(-MAX_FAILURES));
}

function writeFailures(failures: RetouchFailure[]): void {
  try {
    window.localStorage.setItem(FAILURE_KEY, JSON.stringify(failures));
  } catch {
    // A failure notice is a convenience; the row is already settled.
  }
}

/** Ask the Studio to open an image in the Retouch tab, from any surface that
 * shows one. Detail: the artifact id. */
export const OPEN_RETOUCH_EVENT = "subrosa:open-retouch";

export function requestRetouch(artifactId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_RETOUCH_EVENT, { detail: artifactId }));
}
