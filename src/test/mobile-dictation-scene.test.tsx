import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationScreen } from "../components/mobile/screens/DictationScreen";

/**
 * The dictation screen was the one place in the app where waiting had no shape:
 * a recording stopped, the word "Transcribing…" appeared, and nothing else
 * happened until text arrived. And with no history, the screen simply had
 * nothing on it below the microphone.
 *
 * Both are asserted here rather than left to a screenshot, because both are the
 * kind of thing a later refactor removes without noticing.
 */

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  writeText: vi.fn(),
  ensureNotificationPermission: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  mobileDictationStart: mocks.start,
  mobileDictationStop: mocks.stop,
  mobileDictationCancel: mocks.cancel,
  mobileDictationStatus: mocks.status,
  mobileListDictationHistory: mocks.list,
  mobileDeleteDictationHistoryItem: mocks.remove,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
vi.mock("../lib/notifications", () => ({
  ensureNotificationPermission: mocks.ensureNotificationPermission,
}));
vi.mock("../lib/haptics", () => ({ hapticImpact: vi.fn(), hapticNotify: vi.fn() }));

describe("the mobile dictation screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ items: [] });
    mocks.status.mockResolvedValue({ elapsedMs: 0, peak: 0 });
    mocks.ensureNotificationPermission.mockResolvedValue(true);
  });

  it("says what the screen is for when there is nothing on it yet", async () => {
    render(<DictationScreen />);

    // Before this, an empty history rendered nothing at all: the screen ended
    // under the microphone with no explanation of what it was waiting for.
    expect(await screen.findByText("Your voice journal starts here")).toBeInTheDocument();
  });

  it("stands down once there is history to show", async () => {
    mocks.list.mockResolvedValue({
      items: [{ id: "d1", text: "Buy milk", createdAt: new Date().toISOString() }],
    });

    render(<DictationScreen />);

    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(screen.queryByText("Your voice journal starts here")).toBeNull();
  });

  it("names the wait and counts it while a recording is transcribed", async () => {
    // Never resolves: the screen is held in the state the test is about.
    mocks.start.mockResolvedValue(undefined);
    mocks.stop.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<DictationScreen />);

      const mic = await screen.findByRole("button", { name: "Start dictation" });
      await act(async () => {
        mic.click();
        await Promise.resolve();
      });
      const stop = await screen.findByRole("button", { name: "Stop dictation" });
      await act(async () => {
        stop.click();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText("Transcribing your recording")).toBeVisible());
      // The bare word with an ellipsis, and no other information, is what this
      // replaced.
      expect(screen.queryByText("Transcribing…")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.getByText("3s")).toBeInTheDocument();

      // Past ten seconds the wait is explained rather than only counted -- and
      // still never estimated, because nothing here can estimate it.
      await act(async () => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.getByText("A long recording takes a moment.")).toBeInTheDocument();
      expect(screen.queryByText(/about \d+ ?s/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
