import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { ProcessingProgressIndicator } from "../components/note-editor/ProcessingProgressIndicator";
import {
  type ProcessingProgressDto,
  mergeProcessingProgress,
  processingFraction,
} from "../lib/note-processing";

function progress(overrides: Partial<ProcessingProgressDto> = {}): ProcessingProgressDto {
  return {
    phase: "transcribing",
    done: 0,
    total: null,
    startedAt: "2026-09-22T09:00:00.000Z",
    phaseStartedAt: "2026-09-22T09:00:00.000Z",
    ...overrides,
  };
}

describe("folding a polled progress sample into what is on screen", () => {
  it("keeps the last sample when a snapshot carries none and the work goes on", () => {
    // An autosave or a folder move returns a plain row read with no live
    // fields on it. Blanking a working bar because the user typed would be a
    // lie in the other direction.
    const current = progress({ done: 7, total: 12 });
    expect(mergeProcessingProgress(current, undefined, true)).toBe(current);
  });

  it("drops the bar once the note is no longer being worked on", () => {
    expect(mergeProcessingProgress(progress({ done: 7, total: 12 }), undefined, false)).toBe(
      undefined,
    );
  });

  it("takes a new run whole rather than inheriting the old one's count", () => {
    const retried = progress({ done: 0, total: 40, startedAt: "2026-09-22T10:00:00.000Z" });
    expect(mergeProcessingProgress(progress({ done: 30, total: 30 }), retried, true)).toBe(retried);
  });

  it("never lets the count go backwards inside a run", () => {
    const merged = mergeProcessingProgress(
      progress({ done: 9, total: 12 }),
      progress({ done: 4, total: 12 }),
      true,
    );
    expect(merged?.done).toBe(9);
  });

  it("never lets the phase go backwards inside a run", () => {
    const merged = mergeProcessingProgress(
      progress({ phase: "composing" }),
      progress({ phase: "transcribing", done: 3, total: 3 }),
      true,
    );
    expect(merged?.phase).toBe("composing");
  });

  it("has no fraction to offer without a denominator", () => {
    expect(processingFraction(progress({ done: 4, total: null }))).toBe(undefined);
    expect(processingFraction(progress({ done: 3, total: 12 }))).toBe(0.25);
  });
});

describe("the processing indicator", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("stops the note it was shown for, and says so until the pipeline lands", async () => {
    render(
      <ProcessingProgressIndicator
        noteId="note-9"
        status="transcribing"
        progress={progress({ done: 4, total: 20 })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(mocks.invoke).toHaveBeenCalledWith("cancel_processing", {
      request: { noteId: "note-9" },
    });
    // The pipeline lets a paid request in flight land before it stops, which
    // can take a few seconds. Saying so is what prevents a second press.
    expect(screen.getByRole("status")).toHaveTextContent("Stopping");
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("offers no Stop without a note to stop", () => {
    render(<ProcessingProgressIndicator status="transcribing" />);
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("releases Stop when the command is refused", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("no bridge"));
    render(<ProcessingProgressIndicator noteId="note-9" status="generating" />);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).not.toBeDisabled());
  });

  it("names the step the pipeline is actually on, not the row's status", () => {
    // The row says `transcribing` for the whole of turn detection, which on a
    // long meeting is minutes under a word that means something else.
    render(
      <ProcessingProgressIndicator
        status="transcribing"
        progress={progress({ phase: "detectingTurns" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Finding who spoke when");
  });

  it("counts out loud once there is a denominator", () => {
    render(
      <ProcessingProgressIndicator
        status="transcribing"
        progress={progress({ done: 12, total: 31 })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing 12 of 31 parts");
  });

  it("fills the bar from the real count", () => {
    const { container } = render(
      <ProcessingProgressIndicator
        status="transcribing"
        progress={progress({ done: 3, total: 12 })}
      />,
    );
    const bar = container.querySelector(".note-processing-bar");
    expect(bar).not.toHaveAttribute("data-indeterminate");
    expect(container.querySelector(".note-processing-bar-fill")).toHaveStyle({
      transform: "scaleX(0.25)",
    });
  });

  it("sweeps rather than sitting at zero when nothing can be counted", () => {
    // A bar parked at zero reads as broken; a sweep reads as working.
    const { container } = render(
      <ProcessingProgressIndicator
        status="generating"
        progress={progress({ phase: "composing" })}
      />,
    );
    expect(container.querySelector(".note-processing-bar")).toHaveAttribute(
      "data-indeterminate",
      "true",
    );
  });

  it("keeps the clock out of the live region", () => {
    // A clock inside `aria-live` would re-announce the whole badge every
    // second, which makes the badge unreadable rather than informative.
    const { container } = render(
      <ProcessingProgressIndicator
        status="transcribing"
        progress={progress({ done: 1, total: 4 })}
      />,
    );
    const clock = container.querySelector(".note-processing-clock");
    expect(clock).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toContainElement(clock as HTMLElement);
  });

  it("still says something when the backend sends no progress at all", () => {
    // An older backend, or a note picked up by a shell that has not polled
    // yet: the status alone must still produce a sentence.
    render(<ProcessingProgressIndicator status="generating" />);
    expect(screen.getByRole("status")).toHaveTextContent("Writing your notes");
  });
});
