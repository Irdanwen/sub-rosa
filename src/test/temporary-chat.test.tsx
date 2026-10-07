// Temporary chats (ADR-0083), the webview side: the toggle and its banner,
// the history lists that leave them out, the memory trigger that skips them,
// the share item that is never offered for them, and the deletion when the
// person leaves one.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  memoryGetSettings: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  hermesBridgeSessionMessages: mocks.hermesBridgeSessionMessages,
  memoryGetSettings: mocks.memoryGetSettings,
}));

import { TemporaryChatBanner, TemporaryChatToggle } from "../components/agent/TemporaryChat";
import { AGENT_SESSIONS_CHANGED_EVENT, dispatchAgentSessionsChanged } from "../lib/agent-events";
import { noteAssistantTurnCompleted } from "../lib/memory";
import {
  holdTemporaryChat,
  markTemporaryChat,
  registerIfTemporary,
  resetTemporaryChats,
  setTemporaryDraft,
  temporaryChatTitle,
  temporaryDraft,
  withoutLeftTemporaryChats,
  withoutTemporaryChats,
} from "../lib/temporary-chat";

beforeEach(() => {
  resetTemporaryChats();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a temporary chat", () => {
  it("is a switch that says, unmistakably, what it means", async () => {
    render(<TemporaryChatToggle />);
    const toggle = screen.getByRole("button", { name: "Temporary chat" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status")).toBeNull();

    await userEvent.click(toggle);
    expect(temporaryDraft()).toBe(true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Temporary chat: not saved, not remembered",
    );
  });

  it("names the desktop session Temporary chat and registers it, only when new", async () => {
    expect(temporaryChatTitle(undefined)).toBeUndefined();
    await registerIfTemporary(undefined, "session-a");
    expect(mocks.invoke).not.toHaveBeenCalled();

    setTemporaryDraft(true);
    expect(temporaryChatTitle(undefined)).toBe("Temporary chat");
    expect(temporaryChatTitle("existing")).toBeUndefined();
    await registerIfTemporary("existing", "existing");
    expect(mocks.invoke).not.toHaveBeenCalled();
    await registerIfTemporary(undefined, "session-b");
    expect(mocks.invoke).toHaveBeenCalledWith("temporary_chat_register", {
      sessionId: "session-b",
    });
  });

  it("keeps the banner at the head of an open temporary chat only", () => {
    markTemporaryChat("temp");
    const { rerender } = render(<TemporaryChatBanner chatId="temp" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<TemporaryChatBanner chatId="ordinary" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a temporary chat stays out of the history", () => {
  it("is filtered from every list, except the open one from its own surface", () => {
    markTemporaryChat("temp-open");
    markTemporaryChat("temp-left");
    const release = holdTemporaryChat("temp-open", "session");
    const sessions = [{ id: "a" }, { id: "temp-open" }, { id: "temp-left" }];
    expect(withoutTemporaryChats(sessions)).toEqual([{ id: "a" }]);
    expect(withoutLeftTemporaryChats(sessions)).toEqual([{ id: "a" }, { id: "temp-open" }]);
    release();
  });

  it("is never announced to the sidebar or the menu bar", () => {
    markTemporaryChat("temp");
    const heard: string[][] = [];
    const listener = (event: Event) =>
      heard.push(
        (event as CustomEvent<{ sessions: { id: string }[] }>).detail.sessions.map((s) => s.id),
      );
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, listener);
    dispatchAgentSessionsChanged({
      sessions: [{ id: "a" }, { id: "temp" }] as never,
      workingSessionIds: [],
      waitingSessionIds: [],
    });
    window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, listener);
    expect(heard).toEqual([["a"]]);
  });

  it("never reaches memory extraction", async () => {
    markTemporaryChat("temp");
    mocks.memoryGetSettings.mockResolvedValue({ enabled: true, autoExtract: true });
    noteAssistantTurnCompleted("temp");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.memoryGetSettings).not.toHaveBeenCalled();
    expect(mocks.hermesBridgeSessionMessages).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("memory_extract", expect.anything());
  });
});

describe("leaving a temporary chat", () => {
  it("deletes it once nothing holds it, and not while a surface takes it back", () => {
    vi.useFakeTimers();
    markTemporaryChat("task-1");
    const first = holdTemporaryChat("task-1", "task");
    first();
    // A remount takes it back before the deletion runs.
    const second = holdTemporaryChat("task-1", "task");
    vi.advanceTimersByTime(1000);
    expect(mocks.invoke).not.toHaveBeenCalled();

    second();
    vi.advanceTimersByTime(1000);
    expect(mocks.invoke).toHaveBeenCalledWith("temporary_chat_discard", {
      request: { taskId: "task-1" },
    });
  });

  it("deletes a desktop session through its session id", () => {
    vi.useFakeTimers();
    markTemporaryChat("hermes-1");
    holdTemporaryChat("hermes-1", "session")();
    vi.advanceTimersByTime(1000);
    expect(mocks.invoke).toHaveBeenCalledWith("temporary_chat_discard", {
      request: { sessionId: "hermes-1" },
    });
  });
});
