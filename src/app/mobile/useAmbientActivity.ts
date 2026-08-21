/**
 * Ambient work signals for the tab bar: is the assistant replying, is a
 * Studio render in flight? Purely an observer — per ADR-0018 the durable
 * state lives in Rust rows and this hook only listens to the events those
 * rows already emit, plus one snapshot on mount/resume. No polling loop.
 *
 * Staleness: iOS freezes the webview in the background and events do not
 * queue up, so a "busy" flag can outlive the work it described. On resume we
 * re-snapshot the media jobs and drop the chat flag — a genuinely running
 * turn re-asserts itself within a beat through its delta/status stream.
 */

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { MEDIA_JOB_EVENT, type MediaJob } from "../../lib/studio/async-job";
import {
  AGENT_LITE_DELTA_EVENT,
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteStatusDto,
  type AgentTaskDto,
} from "../../lib/tauri";

/** A turn quiet for this long is treated as gone (its done event was lost). */
const CHAT_STALE_MS = 3 * 60 * 1000;

function jobRunning(job: MediaJob) {
  return job.status === "queued" || job.status === "processing";
}

export function useAmbientActivity(): { chatBusy: boolean; studioBusy: boolean } {
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [runningJobIds, setRunningJobIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let staleTimer: number | undefined;

    const armStaleGuard = () => {
      window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => setBusyTaskId(null), CHAT_STALE_MS);
    };

    const markBusy = (taskId: string) => {
      setBusyTaskId(taskId);
      armStaleGuard();
    };

    const unlistenStatus = listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, (event) =>
      markBusy(event.payload.taskId),
    );
    const unlistenDelta = listen<{ taskId: string }>(AGENT_LITE_DELTA_EVENT, (event) =>
      markBusy(event.payload.taskId),
    );
    const unlistenDone = listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, (event) => {
      setBusyTaskId((current) => (current === event.payload.id ? null : current));
    });

    const ingestJob = (job: MediaJob) => {
      setRunningJobIds((current) => {
        if (jobRunning(job) === current.has(job.id)) return current;
        const next = new Set(current);
        if (jobRunning(job)) {
          next.add(job.id);
        } else {
          next.delete(job.id);
        }
        return next;
      });
    };
    const unlistenJobs = listen<MediaJob>(MEDIA_JOB_EVENT, (event) => ingestJob(event.payload));

    const snapshotJobs = () => {
      invoke<MediaJob[]>("media_job_list")
        .then((jobs) => setRunningJobIds(new Set(jobs.filter(jobRunning).map((job) => job.id))))
        .catch(() => {
          // Command surface unavailable (browser preview, early boot): the
          // event stream still lights the dot for anything started now.
        });
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      snapshotJobs();
      // A dead turn cannot clear itself; a live one re-lights this instantly.
      setBusyTaskId(null);
    };

    snapshotJobs();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(staleTimer);
      document.removeEventListener("visibilitychange", onVisible);
      for (const pending of [unlistenStatus, unlistenDelta, unlistenDone, unlistenJobs]) {
        void pending.then((stop) => stop()).catch(() => {});
      }
    };
  }, []);

  return { chatBusy: busyTaskId !== null, studioBusy: runningJobIds.size > 0 };
}
