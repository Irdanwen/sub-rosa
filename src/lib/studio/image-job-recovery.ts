/** Recover standalone image renders after a webview or process restart. Rust
 * owns the paid queue and the file; this observer files its metadata and, for
 * bible portraits, completes the reference attachment before acknowledging
 * the durable job. It reads on mount/resume and listens while awake. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n";
import { isQueuedImageJobClaimed, registerDownloadedArtifactDurably } from "./artifacts";
import { addBibleRef, listBibleEntries } from "./bible";
import { BIBLE_ROLES, type BibleRole } from "./bible/types";
import type { MediaJob } from "./async-job";

export const STUDIO_IMAGE_RECOVERED_EVENT = "subrosa:studio-image-recovered";
export const STUDIO_IMAGE_FAILED_EVENT = "subrosa:studio-image-failed";
const FAILURE_KEY = "os-june:studio-image-failures";
const MAX_FAILURES = 10;
export interface StudioImageFailure {
  id: string;
  message: string;
}

export function readStandaloneImageFailures(): StudioImageFailure[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FAILURE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StudioImageFailure =>
        item && typeof item.id === "string" && typeof item.message === "string",
    );
  } catch {
    return [];
  }
}

export function dismissStandaloneImageFailure(id: string): void {
  const remaining = readStandaloneImageFailures().filter((item) => item.id !== id);
  window.localStorage.setItem(FAILURE_KEY, JSON.stringify(remaining));
  window.dispatchEvent(new Event(STUDIO_IMAGE_FAILED_EVENT));
}

function rememberFailure(job: MediaJob): void {
  const failures = readStandaloneImageFailures().filter((item) => item.id !== job.id);
  const reason = job.error?.trim() || t("The generation failed.");
  failures.push({
    id: job.id,
    message: (reason ===
    "The submission was interrupted. Check your provider history before starting another generation."
      ? t(
          "The submission was interrupted. Check your provider history before starting another generation.",
        )
      : t(reason)
    ).slice(0, 500),
  });
  window.localStorage.setItem(FAILURE_KEY, JSON.stringify(failures.slice(-MAX_FAILURES)));
}
const BIBLE_SOURCE = "bible-ref:";
const settling = new Set<string>();

export function bibleImageJobSource(entryId: string, role: BibleRole): string {
  return `${BIBLE_SOURCE}${entryId}:${role}`;
}

function bibleTarget(source?: string): { entryId: string; role: BibleRole } | undefined {
  if (!source?.startsWith(BIBLE_SOURCE)) return undefined;
  const [entryId, role] = source.slice(BIBLE_SOURCE.length).split(":");
  return entryId && BIBLE_ROLES.includes(role as BibleRole)
    ? { entryId, role: role as BibleRole }
    : undefined;
}

export async function recoverStandaloneImageJob(job: MediaJob): Promise<void> {
  if (
    job.kind !== "image" ||
    (job.status !== "completed" && job.status !== "failed") ||
    (job.source !== "studio" && !job.source?.startsWith(BIBLE_SOURCE)) ||
    (job.status === "completed" && (!job.artifactPath || !job.artifactFileName)) ||
    isQueuedImageJobClaimed(job.id) ||
    settling.has(job.id)
  )
    return;
  settling.add(job.id);
  try {
    if (job.status === "failed") {
      // Store the notice before acknowledging the row: if storage fails, the
      // durable row remains available for a later foreground reconciliation.
      rememberFailure(job);
      await invoke("media_job_dismiss", { id: job.id });
      window.dispatchEvent(new Event(STUDIO_IMAGE_FAILED_EVENT));
      return;
    }
    if (!job.artifactPath || !job.artifactFileName) return;
    const artifact = await registerDownloadedArtifactDurably(
      {
        path: job.artifactPath,
        fileName: job.artifactFileName,
        bytes: job.artifactBytes ?? 0,
      },
      { kind: "image", model: job.model, prompt: job.prompt, costCredits: job.costCredits },
    );
    const target = bibleTarget(job.source);
    if (target) {
      const entry = (await listBibleEntries()).find((candidate) => candidate.id === target.entryId);
      if (
        entry &&
        !entry.refs.some((ref) => ref.artifactId === artifact.id && ref.role === target.role)
      )
        await addBibleRef({
          entryId: target.entryId,
          artifactId: artifact.id,
          role: target.role,
          label: target.role,
        });
    }
    await invoke("media_job_dismiss", { id: job.id });
    window.dispatchEvent(new Event(STUDIO_IMAGE_RECOVERED_EVENT));
  } finally {
    settling.delete(job.id);
  }
}

/** No webview poll: a snapshot on mount/foreground plus Rust's job events. */
export function observeStandaloneImageJobs(): () => void {
  let stopped = false;
  const ingest = (job: MediaJob) => {
    if (stopped) return;
    void recoverStandaloneImageJob(job).catch(() => undefined);
  };
  const snapshot = () => {
    void Promise.resolve()
      .then(() => invoke<MediaJob[] | null>("media_job_list"))
      .then((jobs) => jobs?.forEach(ingest))
      .catch(() => undefined);
  };
  const visible = () => {
    if (document.visibilityState === "visible") snapshot();
  };
  const unlisten = Promise.resolve()
    .then(() => listen<MediaJob>("june://media-job", (event) => ingest(event.payload)))
    .catch(() => () => undefined);
  // Subscribe first, then snapshot. A completion between those two steps is
  // still seen by one of them.
  void unlisten.then(() => {
    if (!stopped) snapshot();
  });
  document.addEventListener("visibilitychange", visible);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", visible);
    void unlisten.then((stop) => stop()).catch(() => undefined);
  };
}
