// Assignments, scheduled tasks and the daily brief (ADR-0091): what a
// cadence and a run say, the inbox's Approve / Reject with feedback, the form
// on each shell, and Today drawing the rows the Rust side keeps.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { AssignmentEditor } from "../components/assignments/AssignmentEditor";
import { RunReview } from "../components/assignments/RunReview";
import { TodaySurface } from "../components/assignments/TodaySurface";
import {
  type Assignment,
  type AssignmentRun,
  blankAssignment,
  cadenceLabel,
  minuteFromTime,
  resultSummary,
  runErrorLabel,
  timeFromMinute,
  toolChoices,
} from "../lib/assignments";
import { agendaSentence, cardHasContent, type DailyCard } from "../lib/daily-brief";

function run(patch: Partial<AssignmentRun> = {}): AssignmentRun {
  return {
    id: "run-1",
    assignmentId: "a1",
    slot: "2026-10-08T07:00:00Z",
    late: false,
    deviceId: "desk",
    deviceName: "computer",
    handle: "job-1",
    state: "needs_review",
    result: "I looked at three sites.\n\n## Result\nTwo new tenders, one due Friday.",
    error: null,
    feedback: null,
    reviewedAt: null,
    startedAt: "2026-10-08T07:00:00Z",
    finishedAt: "2026-10-08T07:03:00Z",
    updatedAt: "2026-10-08T07:03:00Z",
    ...patch,
  };
}

function assignment(patch: Partial<Assignment> = {}): Assignment {
  return {
    id: "a1",
    kind: "assignment",
    title: "Tenders",
    goal: "Watch public tenders in Geneva",
    cadence: "daily",
    atMinute: 9 * 60,
    weekday: 1,
    everyHours: 4,
    autonomy: "ask",
    tools: ["web"],
    deviceId: "desk",
    deviceName: "",
    originDeviceId: "desk",
    paused: false,
    activeSince: "2026-10-01T07:00:00Z",
    createdAt: "2026-10-01T07:00:00Z",
    updatedAt: "2026-10-01T07:00:00Z",
    nextRunAt: "2026-10-09T07:00:00Z",
    runsHere: true,
    waitingForConsent: false,
    waiting: 1,
    lastRun: null,
    ...patch,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("what a cadence and a run say", () => {
  it("reads a cadence in one line", () => {
    expect(cadenceLabel({ cadence: "hourly", atMinute: 15, weekday: 1, everyHours: 4 })).toBe(
      "Every hour at :15",
    );
    expect(cadenceLabel({ cadence: "every", atMinute: 60, weekday: 1, everyHours: 6 })).toMatch(
      /^Every 6 hours from /,
    );
    expect(cadenceLabel({ cadence: "weekly", atMinute: 540, weekday: 1, everyHours: 4 })).toMatch(
      /^Every Monday at /,
    );
  });

  it("round-trips a time of day through the form's input", () => {
    expect(minuteFromTime("07:30")).toBe(450);
    expect(timeFromMinute(450)).toBe("07:30");
    expect(minuteFromTime("25:00")).toBeNull();
    expect(minuteFromTime("soon")).toBeNull();
  });

  it("finds the result a run was asked to end with, like the Rust side", () => {
    expect(resultSummary(run().result)).toBe("Two new tenders, one due Friday.");
    expect(resultSummary("# Digest\n- **Nothing** new today")).toBe("Nothing new today");
    expect(resultSummary(null)).toBe("");
  });

  it("offers the machine's tools on the desktop only, and marks what leaves the device", () => {
    expect(toolChoices("phone").map((choice) => choice.id)).toEqual(["web", "notes", "memory"]);
    const desktop = toolChoices("desktop");
    expect(desktop.filter((choice) => choice.acts).map((choice) => choice.id)).toEqual([
      "files",
      "terminal",
      "browser",
    ]);
    expect(runErrorLabel("The run did not start.")).toBe("The run did not start.");
    expect(runErrorLabel("upstream said no")).toBe("upstream said no");
  });

  it("says the agenda as a sentence and keeps an empty morning silent", () => {
    expect(agendaSentence({ count: 3, firstTitle: "Point produit", firstAt: "09:30" })).toBe(
      "3 meetings today. Next at 09:30: Point produit",
    );
    const empty: DailyCard = {
      day: "2026-10-08",
      createdAt: "2026-10-08T05:30:00Z",
      agenda: null,
      notes: [],
      reviews: [],
      failures: [],
      topics: [{ topic: "Energy prices", links: [] }],
    };
    expect(cardHasContent(empty)).toBe(false);
    expect(
      cardHasContent({
        ...empty,
        topics: [{ topic: "x", links: [{ title: "a", url: "https://a.ch" }] }],
      }),
    ).toBe(true);
  });
});

describe("the results inbox", () => {
  it("approves with feedback that the next run reads", async () => {
    mocks.invoke.mockResolvedValue(run({ state: "approved", feedback: "Only Geneva" }));
    const onReviewed = vi.fn();
    render(<RunReview run={run()} title="Tenders" onReviewed={onReviewed} />);
    expect(screen.getByText("Two new tenders, one due Friday.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Feedback for the next run"), {
      target: { value: "Only Geneva" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenCalledWith("assignment_review", {
      runId: "run-1",
      approve: true,
      feedback: "Only Geneva",
    });
  });

  it("rejects without feedback, and shows a late catch-up for what it is", async () => {
    mocks.invoke.mockResolvedValue(run({ state: "rejected" }));
    render(
      <RunReview run={run({ late: true, deviceName: "phone" })} onReviewed={() => undefined} />,
    );
    expect(screen.getByText(/On your phone · Ran late/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("assignment_review", {
        runId: "run-1",
        approve: false,
        feedback: undefined,
      }),
    );
  });
});

describe("the form", () => {
  it("saves an assignment, and keeps machine tools for after an approval under ask first", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "assignment_save" ? assignment() : [],
    );
    const onSaved = vi.fn();
    render(
      <AssignmentEditor
        initial={blankAssignment("assignment")}
        platform="desktop"
        onSaved={onSaved}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getAllByText("Only once you approve a proposal.")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("What should the assistant work on?"), {
      target: { value: "Watch public tenders in Geneva" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create the assignment" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saved = mocks.invoke.mock.calls.find(([command]) => command === "assignment_save");
    expect(saved?.[1].request).toMatchObject({
      kind: "assignment",
      goal: "Watch public tenders in Geneva",
      cadence: "daily",
      autonomy: "ask",
      tools: ["web", "notes"],
    });
  });
});

describe("Today", () => {
  it("draws the brief switch, the inbox and both lists on the phone", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "assignment_list":
          return [assignment(), assignment({ id: "t1", kind: "task", title: "News", waiting: 0 })];
        case "assignment_inbox":
          return [run()];
        case "daily_brief_today":
          return { settings: { enabled: false, atMinute: 450 }, card: null, status: null };
        default:
          return [];
      }
    });
    render(
      <TodaySurface
        platform="phone"
        backgroundNote="On Android, scheduled work runs while Sub Rosa is open."
        renderHeader={({ title }) => <h1>{title}</h1>}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Needs your review" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Daily brief" })).toBeTruthy();
    const tasks = screen.getByRole("region", { name: "Scheduled tasks" });
    expect(within(tasks).getByText("News")).toBeTruthy();
    expect(screen.getByText("1 to review")).toBeTruthy();
    expect(screen.getByText(/scheduled work runs while Sub Rosa is open/)).toBeTruthy();
    // Opening an assignment shows its detail, with its own inbox and history.
    fireEvent.click(screen.getByRole("button", { name: /Tenders/ }));
    expect(await screen.findByRole("heading", { name: "Tenders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  });

  it("turns the daily brief on with the time it comes", async () => {
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "daily_brief_today")
        return { settings: { enabled: false, atMinute: 450 }, card: null, status: null };
      if (command === "daily_brief_set_settings") return args?.request;
      return [];
    });
    render(<TodaySurface platform="desktop" renderHeader={({ title }) => <h1>{title}</h1>} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Daily brief" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("daily_brief_set_settings", {
        request: { enabled: true, atMinute: 450 },
      }),
    );
    // The desktop offers no scheduled-task list until there is one.
    expect(screen.queryByRole("region", { name: "Scheduled tasks" })).toBeNull();
  });
});
