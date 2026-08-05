// "Start again" spends money, so what it repeats has to be exactly what
// failed, and it has to be absent whenever we cannot promise that.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobFailureNotice } from "../components/studio/JobFailureNotice";
import type { MediaJob, StartJobOptions } from "../lib/studio/async-job";
import { useMediaJobQueue } from "../lib/studio/async-job";
import { MediaError } from "../lib/studio/client";

const invoked = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const media = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invoked.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: invoked.listen }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: media.json,
}));
vi.mock("../lib/notifications", () => ({ ensureNotificationPermission: vi.fn() }));

const OPTIONS: StartJobOptions = {
  kind: "video",
  model: "seedance-2-0-reference-to-video",
  prompt: "A fox in the rain",
  extension: "mp4",
  queuePath: "/video/queue",
  queueBody: { model: "seedance-2-0-reference-to-video", duration: "10s" },
  retrieve: (queueId) => ({ path: "/video/retrieve", body: { queue_id: queueId } }),
  urlFields: ["video_url"],
};

function jobRow(id: string, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    kind: "video",
    model: OPTIONS.model,
    prompt: OPTIONS.prompt,
    extension: "mp4",
    status: "queued",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** A view over the queue hook, rendering the same notice the studios do. */
function Harness() {
  const queue = useMediaJobQueue("video", () => {});
  return (
    <div>
      <button type="button" onClick={() => void queue.start(OPTIONS)}>
        Generate
      </button>
      {queue.jobs.map((entry) => (
        <JobFailureNotice
          key={entry.job.id}
          message={entry.message}
          status={entry.status}
          onRetry={entry.canRetry ? () => void queue.retry(entry.job.id) : undefined}
        />
      ))}
    </div>
  );
}

describe("starting a failed generation again", () => {
  beforeEach(() => {
    invoked.invoke.mockReset();
    invoked.listen.mockReset();
    media.json.mockReset();
    invoked.listen.mockResolvedValue(() => {});
  });

  it("repeats the request that failed, and drops the row it replaces", async () => {
    // Rust's durable table, as far as this hook can tell: the reconcile pass
    // reads it and drops anything it no longer carries, so a mock that always
    // answers empty would erase the very row under test.
    const rows = new Map<string, MediaJob>();
    let queued = 0;
    media.json.mockImplementation(async () => ({ queue_id: `job-${(queued += 1)}` }));
    invoked.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "media_job_start") {
        const request = args.request as { queueId: string };
        const row = jobRow(request.queueId);
        rows.set(row.id, row);
        return row;
      }
      if (command === "media_job_list") return [...rows.values()];
      if (command === "media_job_dismiss") rows.delete(args.id as string);
      return undefined;
    });

    render(<Harness />);
    // The hook reconciles against that list on mount. Queueing before the
    // first pass returns lets it wipe the row we just ingested.
    await waitFor(() => expect(invoked.invoke).toHaveBeenCalledWith("media_job_list"));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(media.json).toHaveBeenCalledTimes(1));

    // The backend drops the job, as it did in production.
    await act(async () => {
      const failed = jobRow("job-1", {
        status: "failed",
        error: "Unknown or expired queue_id — re-queue the job",
        errorStatus: 404,
      });
      rows.set(failed.id, failed);
      const handler = invoked.listen.mock.calls[0][1] as (event: { payload: MediaJob }) => void;
      handler({ payload: failed });
    });

    const retry = await screen.findByRole("button", { name: "Start again" });
    await userEvent.click(retry);

    // Same payload, queued again: not a form rebuild, not a resurrection of
    // the dead job id.
    await waitFor(() => expect(media.json).toHaveBeenCalledTimes(2));
    expect(media.json.mock.calls[1][0]).toBe("/video/queue");
    expect(media.json.mock.calls[1][1]).toEqual(OPTIONS.queueBody);
    // The failed row is cleared, so the failure does not sit next to its own
    // replacement.
    expect(invoked.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start again" })).toBeNull());
  });

  it("offers the retry for a submit that never reached the backend", async () => {
    // No queue id means no durable row, but we still know exactly what was
    // asked for - this is the case where a retry is most obviously right.
    media.json.mockRejectedValueOnce(new MediaError("The network is down.", { status: 0 }));
    invoked.invoke.mockImplementation(async (command: string) =>
      command === "media_job_list" ? [] : undefined,
    );

    render(<Harness />);
    await waitFor(() => expect(invoked.invoke).toHaveBeenCalledWith("media_job_list"));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    // Status 0: it never left the machine, so nothing was queued or charged.
    expect(await screen.findByText(/never reached the backend/i)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Start again" }));
    await waitFor(() => expect(media.json).toHaveBeenCalledTimes(2));
    expect(media.json.mock.calls[1][1]).toEqual(OPTIONS.queueBody);
  });

  it("withholds the retry for a job this session never queued", async () => {
    // A row picked up from a previous run: the render outlived the session,
    // so what it asked for is genuinely unknown. Re-spending on a guess is
    // worse than not offering the button.
    invoked.invoke.mockImplementation(async (command: string) =>
      command === "media_job_list"
        ? [
            jobRow("job-from-yesterday", {
              status: "failed",
              error: "Unknown or expired queue_id — re-queue the job",
              errorStatus: 410,
            }),
          ]
        : undefined,
    );

    render(<Harness />);

    expect(await screen.findByText(/lost this job/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start again" })).toBeNull();
    expect(media.json).not.toHaveBeenCalled();
  });
});
