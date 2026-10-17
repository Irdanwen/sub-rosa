// Waiting on a durable render, and handing renders to the queue (ADR-0114).
//
// A render is a `media_jobs` row Rust polls, downloads and files. The webview
// only has to learn when it settles. It listens for the event every row
// change already emits, reads the rows once when it starts listening (the job
// may have settled already), again when the app comes back to the foreground
// (iOS freezes the webview and events do not queue up), and on a slow safety
// timer in case one event was missed. A run with eight renders in flight used
// to read the whole table every three seconds per render.
//
// Submissions go through one module-wide gate, because several runs can be
// alive in one webview: a production of twelve shots used to fire twelve paid
// POSTs in the same instant, which is how a provider's rate limit is met.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../../i18n";
import { MEDIA_JOB_EVENT } from "../async-job";

/** The fields of a job row the wait reads. */
export interface SettledJobRow {
  id: string;
  status: string;
}

/** How often the rows are read again while nothing has been heard. */
export const SAFETY_READ_MS = 30_000;

function cancelled(): DOMException {
  return new DOMException("The workflow run was cancelled.", "AbortError");
}

function settled(status: string): boolean {
  return status === "completed" || status === "failed";
}

/** Resolves with the job's row once it has completed or failed. A cancelled
 * wait leaves the job alone: the render is paid for and will still land. */
export function waitForSettledJob<Row extends SettledJobRow>(
  jobId: string,
  signal?: AbortSignal,
): Promise<Row> {
  return new Promise<Row>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    let done = false;
    let stopListening: () => void = () => {};
    const cleanup = () => {
      done = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      signal?.removeEventListener("abort", onAbort);
      stopListening();
    };
    const finish = (row: Row) => {
      if (done) return;
      cleanup();
      resolve(row);
    };
    const fail = (error: unknown) => {
      if (done) return;
      cleanup();
      reject(error);
    };
    const read = () => {
      invoke<Row[] | null>("media_job_list")
        .then((rows) => {
          if (done) return;
          const row = (rows ?? []).find((entry) => entry.id === jobId);
          if (!row) {
            fail(
              new Error(
                t("The render's job row is gone. Run the workflow again to redo this node."),
              ),
            );
          } else if (settled(row.status)) {
            finish(row);
          }
        })
        .catch(() => {
          // A failed read is retried by the next one; the event may arrive
          // first anyway.
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    const onAbort = () => fail(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(read, SAFETY_READ_MS);
    // Listening starts before the first read, so a job that settles between
    // the two is heard by one or the other.
    listen<Row>(MEDIA_JOB_EVENT, (event) => {
      if (event.payload.id === jobId && settled(event.payload.status)) finish(event.payload);
    })
      .then((stop) => {
        if (done) stop();
        else stopListening = stop;
      })
      .catch(() => {
        // No event bridge (a test, a browser preview): the reads carry it.
      })
      .finally(read);
  });
}

/** How many paid submissions may be on the wire at once, across every run. */
export const SUBMISSION_SLOTS = 2;

let busy = 0;
const waiting: Array<() => void> = [];

/** Runs `submit` once a submission slot is free. Only the POST holds a slot:
 * renders themselves run in parallel as they always have. */
export async function withSubmissionSlot<T>(submit: () => Promise<T>): Promise<T> {
  // A released slot is handed straight to the next waiter, so a newcomer can
  // never slip in between and make it one too many.
  if (busy >= SUBMISSION_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve));
  else busy += 1;
  try {
    return await submit();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else busy -= 1;
  }
}

/** Tests only: forget slot bookkeeping between cases. */
export function resetSubmissionSlotsForTests(): void {
  busy = 0;
  waiting.length = 0;
}
