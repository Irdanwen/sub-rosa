// A composition is paid work, so every image of it is a durable row before it
// is anything else (ADR-0018), exactly as a retouch is. The webview queues one
// job per shot (or one per sheet) with what the result needs to know riding
// in its client context; whichever observer is awake when Rust has saved the
// file names it, cuts a sheet, and files the images in the composition's
// gallery folder. Foreground and cold launch take the same path.

import { invoke } from "@tauri-apps/api/core";
import { errorCode } from "../../errors";
import { t } from "../../i18n";
import {
  readArtifactBase64,
  registerDownloadedArtifactDurably,
  saveArtifactFromBase64,
} from "../artifacts";
import type { MediaJob } from "../async-job";
import { cutSheetCells } from "../bible/sheet";
import { markArtifacts } from "../library";
import { saveArtifactMetadata } from "../projects";
import type { StudioArtifact } from "../types";
import type { EditRequest } from "../retouch/request";
import { SHEET_CELLS } from "./packs";

export const COMPOSE_SOURCE = "compose:";
/** Images of a composition were filed. Detail: {@link ComposeResultDetail}. */
export const COMPOSE_RESULT_EVENT = "subrosa:compose-result";
/** A composition job failed; the failure is in {@link readComposeFailures}. */
export const COMPOSE_FAILED_EVENT = "subrosa:compose-failed";

const FAILURE_KEY = "os-june:compose-failures";
const CUT_KEY = "os-june:compose-cut";
const MAX_FAILURES = 20;

/** What travels with the job and comes back with its result. */
export interface ComposeJobContext {
  v: 1;
  /** One id per composition, shared by its jobs. */
  group: string;
  /** The source image's artifact id. */
  sourceId: string;
  pack: string;
  mode: "separate" | "sheet";
  /** The gallery folder the results are filed in, when one was made. */
  collectionId?: string;
  /** Separate: this job's shot. Sheet: the nine, in reading order. */
  labels: string[];
  index: number;
  of: number;
}

export interface ComposeResultDetail {
  group: string;
  jobId: string;
  artifactIds: string[];
}

export interface ComposeFailure {
  jobId: string;
  group: string;
  label: string;
  message: string;
}

export function composeSource(group: string): string {
  return `${COMPOSE_SOURCE}${group}`;
}

export function composeGroupOf(source: string | undefined): string | undefined {
  if (!source?.startsWith(COMPOSE_SOURCE)) return undefined;
  return source.slice(COMPOSE_SOURCE.length) || undefined;
}

export function composeContextOf(
  job: Pick<MediaJob, "clientContext">,
): ComposeJobContext | undefined {
  const context = job.clientContext as Partial<ComposeJobContext> | undefined;
  if (context?.v !== 1 || typeof context.group !== "string") return undefined;
  if (context.mode !== "separate" && context.mode !== "sheet") return undefined;
  if (!Array.isArray(context.labels) || typeof context.sourceId !== "string") return undefined;
  return context as ComposeJobContext;
}

export interface ComposeSubmission {
  request: EditRequest;
  context: ComposeJobContext;
  costCredits?: number;
}

/** Queue one image (or one sheet) of a composition. Resolves once the row
 * exists and the operator accepted the job; the result arrives through
 * recovery. */
export async function submitCompose({
  request,
  context,
  costCredits,
}: ComposeSubmission): Promise<MediaJob> {
  const jobId = crypto.randomUUID();
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
        source: composeSource(context.group),
        costCredits,
        clientContext: context,
      },
    });
  } catch (error) {
    if (errorCode(error) === "media_job_queue_failed")
      await invoke("media_job_dismiss", { id: jobId }).catch(() => undefined);
    throw error;
  }
}

/** Composition jobs still rendering. */
export async function inFlightCompositions(): Promise<MediaJob[]> {
  const jobs = (await invoke<MediaJob[] | null>("media_job_list").catch(() => null)) ?? [];
  return jobs.filter(
    (job) =>
      composeGroupOf(job.source) !== undefined &&
      (job.status === "queued" || job.status === "processing"),
  );
}

const settling = new Set<string>();

/** File a finished composition job, or record its failure. Returns whether
 * the job belonged to a composition. */
export async function recoverComposeJob(job: MediaJob): Promise<boolean> {
  const group = composeGroupOf(job.source);
  if (!group || job.kind !== "image") return false;
  if (job.status !== "completed" && job.status !== "failed") return true;
  if (settling.has(job.id)) return true;
  const context = composeContextOf(job);
  settling.add(job.id);
  try {
    if (job.status === "failed" || !context) {
      rememberFailure({
        jobId: job.id,
        group,
        label: context?.labels[0] ?? "",
        message: job.error?.trim()
          ? t(job.error.trim())
          : t("This image of the composition could not be made."),
      });
      await invoke("media_job_dismiss", { id: job.id });
      window.dispatchEvent(new Event(COMPOSE_FAILED_EVENT));
      return true;
    }
    if (!job.artifactPath || !job.artifactFileName) return true;
    const made = await registerDownloadedArtifactDurably(
      { path: job.artifactPath, fileName: job.artifactFileName, bytes: job.artifactBytes ?? 0 },
      {
        kind: "image",
        model: job.model,
        prompt: job.prompt,
        costCredits: job.costCredits,
        sourceArtifactId: context.sourceId,
      },
    );
    const filed = context.mode === "sheet" ? await cutIntoImages(job.id, made, context) : [made];
    if (context.mode === "separate" && context.labels[0])
      await saveArtifactMetadata({ id: made.id, title: context.labels[0] }).catch(() => undefined);
    if (context.collectionId)
      await markArtifacts(filed, { collectionId: context.collectionId }).catch(() => undefined);
    await invoke("media_job_dismiss", { id: job.id });
    forgetCut(job.id);
    const detail: ComposeResultDetail = {
      group,
      jobId: job.id,
      artifactIds: filed.map((item) => item.id),
    };
    window.dispatchEvent(new CustomEvent(COMPOSE_RESULT_EVENT, { detail }));
    return true;
  } finally {
    settling.delete(job.id);
  }
}

/** A sheet becomes nine images; the sheet itself stays with them. The cut is
 * remembered by job until the row is dismissed, so a crash between the two
 * does not cut the same sheet twice. */
async function cutIntoImages(
  jobId: string,
  sheet: StudioArtifact,
  context: ComposeJobContext,
): Promise<StudioArtifact[]> {
  if (wasCut(jobId)) return [sheet];
  const base64 = await readArtifactBase64(sheet);
  const cells = await cutSheetCells(
    `data:image/png;base64,${base64}`,
    Array.from({ length: SHEET_CELLS }, (_, index) => index),
  );
  const images: StudioArtifact[] = [];
  for (const [index, cell] of cells.entries()) {
    if (!cell) continue;
    const label = context.labels[index] ?? "";
    const image = await saveArtifactFromBase64(cell, "png", {
      kind: "image",
      model: sheet.model,
      prompt: label,
      sourceArtifactId: context.sourceId,
    });
    if (label) await saveArtifactMetadata({ id: image.id, title: label }).catch(() => undefined);
    images.push(image);
  }
  rememberCut(jobId);
  await saveArtifactMetadata({ id: sheet.id, title: t("Sheet") }).catch(() => undefined);
  return [sheet, ...images];
}

export function readComposeFailures(group?: string): ComposeFailure[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FAILURE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ComposeFailure =>
        item &&
        typeof item.jobId === "string" &&
        typeof item.group === "string" &&
        typeof item.message === "string" &&
        (group === undefined || item.group === group),
    );
  } catch {
    return [];
  }
}

export function dismissComposeFailure(jobId: string): void {
  writeJson(
    FAILURE_KEY,
    readComposeFailures().filter((item) => item.jobId !== jobId),
  );
  window.dispatchEvent(new Event(COMPOSE_FAILED_EVENT));
}

function rememberFailure(failure: ComposeFailure): void {
  const failures = readComposeFailures().filter((item) => item.jobId !== failure.jobId);
  failures.push({ ...failure, message: failure.message.slice(0, 500) });
  writeJson(FAILURE_KEY, failures.slice(-MAX_FAILURES));
}

function readCuts(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CUT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function wasCut(jobId: string): boolean {
  return readCuts().includes(jobId);
}

function rememberCut(jobId: string): void {
  writeJson(CUT_KEY, [...readCuts().filter((id) => id !== jobId), jobId].slice(-50));
}

function forgetCut(jobId: string): void {
  writeJson(
    CUT_KEY,
    readCuts().filter((id) => id !== jobId),
  );
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A notice or a cut marker is a convenience; the row is the record.
  }
}

/** Ask the Studio to open the composer on an image, from any surface that
 * shows one. Detail: the artifact id. */
export const OPEN_COMPOSE_EVENT = "subrosa:open-compose";

export function requestCompose(artifactId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_COMPOSE_EVENT, { detail: artifactId }));
}
