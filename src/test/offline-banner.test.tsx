import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_PROBE_INTERVAL_MS,
  OfflineBanner,
  offlineSentence,
  useOfflineState,
} from "../components/notes-list/OfflineBanner";
import type { NoteListItemDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  listNotesFailedInTransit: vi.fn(),
  carpeDiemProbeUpstream: vi.fn(),
  retryProcessing: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  listNotesFailedInTransit: mocks.listNotesFailedInTransit,
  carpeDiemProbeUpstream: mocks.carpeDiemProbeUpstream,
  retryProcessing: mocks.retryProcessing,
}));

function note(id: string, processingStatus: NoteListItemDto["processingStatus"]): NoteListItemDto {
  return {
    id,
    title: id,
    preview: "",
    processingStatus,
    folderIds: [],
    createdAt: "2026-09-03T08:00:00Z",
    updatedAt: "2026-09-03T08:00:00Z",
    durationMs: undefined,
  };
}

function Harness({ notes }: { notes: NoteListItemDto[] }) {
  const offline = useOfflineState(notes);
  return (
    <OfflineBanner
      waiting={offline.waiting.length}
      reachable={offline.reachable}
      retrying={offline.retrying}
      onRetryAll={() => void offline.retryAll()}
    />
  );
}

describe("offlineSentence", () => {
  it("says what it knows, and no more", () => {
    expect(offlineSentence(1, false)).toBe("You are offline. 1 note is waiting to be processed.");
    expect(offlineSentence(3, true)).toBe(
      "The connection is back. 3 notes are waiting to be processed.",
    );
    expect(offlineSentence(2, null)).toBe(
      "2 notes are waiting to be processed; checking the connection…",
    );
  });
});

describe("the offline banner", () => {
  beforeEach(() => {
    mocks.listNotesFailedInTransit.mockReset().mockResolvedValue(["n1", "n2"]);
    mocks.carpeDiemProbeUpstream.mockReset().mockResolvedValue({ reachable: false, message: "x" });
    mocks.retryProcessing.mockReset().mockResolvedValue({});
  });

  it("stays hidden while no note has failed", () => {
    render(<Harness notes={[note("a", "ready")]} />);
    expect(screen.queryByRole("status", { name: "Connection" })).toBeNull();
    expect(mocks.listNotesFailedInTransit).not.toHaveBeenCalled();
  });

  it("names the waiting notes, says offline, and keeps Retry all off until the endpoint answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Harness notes={[note("n1", "failed"), note("n2", "failed"), note("ok", "ready")]} />);
      expect(await screen.findByText(/You are offline\. 2 notes are waiting/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry all" })).toBeDisabled();

      // The endpoint comes back on the next probe; nothing retries on its own.
      mocks.carpeDiemProbeUpstream.mockResolvedValue({ reachable: true, message: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_INTERVAL_MS + 10);
      });
      expect(
        await screen.findByText(/The connection is back\. 2 notes are waiting/),
      ).toBeInTheDocument();
      expect(mocks.retryProcessing).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Retry all" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries every waiting note on one click, then clears", async () => {
    mocks.carpeDiemProbeUpstream.mockResolvedValue({ reachable: true, message: null });
    const user = userEvent.setup();
    render(<Harness notes={[note("n1", "failed"), note("n2", "failed")]} />);
    await screen.findByText(/The connection is back/);
    await user.click(screen.getByRole("button", { name: "Retry all" }));
    await waitFor(() => expect(mocks.retryProcessing).toHaveBeenCalledTimes(2));
    expect(mocks.retryProcessing).toHaveBeenCalledWith("n1");
    expect(mocks.retryProcessing).toHaveBeenCalledWith("n2");
    await waitFor(() => expect(screen.queryByRole("status", { name: "Connection" })).toBeNull());
  });
});
