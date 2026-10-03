/**
 * The renders in flight, as the Studio surfaces see them.
 *
 * An observer, not a poll (ADR-0018): the durable state is the `media_jobs`
 * rows Rust keeps, and this hook only listens to the event those rows already
 * emit, plus one snapshot on mount and whenever the app comes back to the
 * foreground - iOS freezes the webview and events do not queue up, so a row
 * that finished in the background is read again rather than waited for.
 * Nothing here calls upstream, and nothing here runs on a timer.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { MEDIA_JOB_EVENT, type MediaJob } from "./async-job";

function running(job: MediaJob): boolean {
  return job.status === "queued" || job.status === "processing";
}

/**
 * Whether a job is the Studio's own to show. Workflow runs, assistant turns,
 * retouch sessions and bible portraits queue through the same rows and file
 * their results themselves; the Studio panels show only what was queued by
 * hand.
 */
export function isStudioOwned(job: Pick<MediaJob, "source">): boolean {
  return !job.source || job.source === "studio";
}

/** Every row currently queued or processing, newest first. */
export function useRunningMediaJobs(): MediaJob[] {
  const [jobs, setJobs] = useState<Map<string, MediaJob>>(() => new Map());

  useEffect(() => {
    let disposed = false;
    const ingest = (job: MediaJob) => {
      setJobs((current) => {
        const has = current.has(job.id);
        if (running(job) ? has && current.get(job.id)?.status === job.status : !has) {
          return current;
        }
        const next = new Map(current);
        if (running(job)) next.set(job.id, job);
        else next.delete(job.id);
        return next;
      });
    };
    const unlisten = listen<MediaJob>(MEDIA_JOB_EVENT, (event) => ingest(event.payload));
    const snapshot = () => {
      invoke<MediaJob[]>("media_job_list")
        .then((rows) => {
          if (disposed) return;
          setJobs(new Map((rows ?? []).filter(running).map((job) => [job.id, job])));
        })
        .catch(() => {
          // No command surface (browser preview, early boot): the event
          // stream still carries anything started from now on.
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") snapshot();
    };
    snapshot();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
