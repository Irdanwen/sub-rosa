// "Run now" on an assignment (QA 1.89.1 row 4): the "running" line follows
// the run's row, so it goes when the result lands, and a run waiting for
// review is not described as a run that never happened.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    mocks.listeners.push(handler);
    return () => undefined;
  }),
}));

import { AssignmentDetail } from "../components/assignments/AssignmentDetail";
import type { Assignment, AssignmentRun } from "../lib/assignments";

function run(patch: Partial<AssignmentRun> = {}): AssignmentRun {
  return {
    id: "run-1",
    assignmentId: "a1",
    slot: "now:2026-10-10T19:00:00Z",
    late: false,
    deviceId: "desk",
    deviceName: "computer",
    handle: "job-1",
    state: "running",
    result: null,
    error: null,
    feedback: null,
    reviewedAt: null,
    startedAt: "2026-10-10T19:00:00Z",
    finishedAt: null,
    updatedAt: "2026-10-10T19:00:00Z",
    ...patch,
  };
}

const assignment: Assignment = {
  id: "a1",
  kind: "assignment",
  title: "QA mission",
  goal: "Say hello",
  cadence: "daily",
  atMinute: 9 * 60,
  weekday: 1,
  everyHours: 4,
  autonomy: "ask",
  tools: [],
  deviceId: "desk",
  deviceName: "",
  originDeviceId: "desk",
  paused: false,
  activeSince: "2026-10-01T07:00:00Z",
  createdAt: "2026-10-01T07:00:00Z",
  updatedAt: "2026-10-01T07:00:00Z",
  nextRunAt: null,
  runsHere: true,
  waitingForConsent: false,
  waiting: 0,
  lastRun: null,
};

const RUNNING_LINE = "Running now. The result lands here.";
const NOT_RUN = "This assignment has not run yet.";

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listeners.length = 0;
});

describe("run now on an assignment", () => {
  it("says running while the row runs, and stops once the result waits for review", async () => {
    let rows: AssignmentRun[] = [];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "assignment_run_now") {
        rows = [run()];
        return { outcome: "started", deviceName: "" };
      }
      if (command === "assignment_runs") return rows;
      return [];
    });
    render(
      <AssignmentDetail
        assignment={assignment}
        platform="desktop"
        onEdit={() => undefined}
        onDeleted={() => undefined}
        onChanged={() => undefined}
      />,
    );
    expect(await screen.findByText(NOT_RUN)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText(RUNNING_LINE)).toBeTruthy();

    // The runtime finishes: the row moves to review and the change event fires.
    rows = [run({ state: "needs_review", result: "Hello.", finishedAt: "2026-10-10T19:01:30Z" })];
    await act(async () => {
      for (const listener of mocks.listeners) listener();
    });
    await waitFor(() => expect(screen.queryByText(RUNNING_LINE)).toBeNull());
    expect(screen.getByRole("heading", { name: "To review" })).toBeTruthy();
    expect(screen.queryByText(NOT_RUN)).toBeNull();
  });

  it("keeps the sent notice for a run handed to another device", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "assignment_run_now") return { outcome: "sent", deviceName: "Mac mini" };
      return [];
    });
    render(
      <AssignmentDetail
        assignment={{ ...assignment, runsHere: false, deviceName: "Mac mini" }}
        platform="phone"
        onEdit={() => undefined}
        onDeleted={() => undefined}
        onChanged={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    expect(
      await screen.findByText("Sent to Mac mini. It runs there as soon as Sub Rosa is open."),
    ).toBeTruthy();
    expect(screen.queryByText(RUNNING_LINE)).toBeNull();
  });
});
