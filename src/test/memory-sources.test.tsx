// Memory sources on a reply (ADR-0081): the phone shows "Used N memories"
// under the reply a turn produced, and the desktop shows which memories a
// chat started with. Both open a list where a memory can be forgotten.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryInChatIndicator } from "../components/agent/MemoryInChatIndicator";
import { MemorySourcesChip } from "../components/mobile/MemorySourcesChip";
import { sessionStartMs, turnIdForReply } from "../lib/personalization";
import type { MemoryDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  forTask: vi.fn(),
  forSession: vi.fn(),
  memoryDelete: vi.fn(),
  memoryUpdate: vi.fn(),
}));

vi.mock("../lib/personalization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/personalization")>()),
  memorySourcesForTask: mocks.forTask,
  memorySourcesForSession: mocks.forSession,
}));

vi.mock("../lib/tauri", () => ({
  memoryDelete: mocks.memoryDelete,
  memoryUpdate: mocks.memoryUpdate,
}));

vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

function memory(id: string, text: string): MemoryDto {
  return {
    id,
    text,
    source: "auto",
    importance: 2,
    disabled: false,
    hasEmbedding: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

const TASK = {
  id: "task-1",
  messages: [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forTask.mockResolvedValue([
    { turnId: "u1", memories: [memory("m1", "Lives in Lyon."), memory("m2", "Likes tea.")] },
  ]);
  mocks.memoryDelete.mockResolvedValue(undefined);
  mocks.memoryUpdate.mockImplementation(async ({ memoryId }: { memoryId: string }) => ({
    ...memory(memoryId, "Lives in Lyon."),
    disabled: true,
  }));
});

describe("turnIdForReply", () => {
  it("is the user message right before the reply", () => {
    expect(turnIdForReply(TASK.messages, "a1")).toBe("u1");
    expect(turnIdForReply(TASK.messages, "a2")).toBe("u2");
    expect(turnIdForReply(TASK.messages, "u1")).toBeUndefined();
    expect(
      turnIdForReply(
        [
          { id: "a0", role: "assistant" },
          { id: "a1", role: "assistant" },
        ],
        "a1",
      ),
    ).toBeUndefined();
  });
});

describe("sessionStartMs", () => {
  it("reads seconds, milliseconds, numeric strings and dates", () => {
    expect(sessionStartMs(1_759_000_000.5)).toBe(1_759_000_000_500);
    expect(sessionStartMs(1_759_000_000_500)).toBe(1_759_000_000_500);
    expect(sessionStartMs("1759000000")).toBe(1_759_000_000_000);
    expect(sessionStartMs("2026-10-01T00:00:00Z")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(sessionStartMs(undefined)).toBeUndefined();
    expect(sessionStartMs("soon")).toBeUndefined();
  });
});

describe("MemorySourcesChip", () => {
  it("shows the count under the reply that used them, and nothing elsewhere", async () => {
    render(
      <>
        <MemorySourcesChip task={TASK} messageId="a1" />
        <MemorySourcesChip task={TASK} messageId="a2" />
      </>,
    );
    expect(await screen.findByRole("button", { name: "Used 2 memories" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // One fetch serves every reply of the chat.
    expect(mocks.forTask).toHaveBeenCalledTimes(1);
  });

  it("lists the memories in a sheet where each can be opened, paused or forgotten", async () => {
    const user = userEvent.setup();
    render(<MemorySourcesChip task={{ ...TASK, id: "task-2" }} messageId="a1" />);
    await user.click(await screen.findByRole("button", { name: "Used 2 memories" }));

    const sheet = screen.getByRole("dialog", { name: "Memories used in this reply" });
    expect(within(sheet).getByText("Lives in Lyon.")).toBeInTheDocument();
    const [firstOpen] = within(sheet).getAllByRole("button", { name: "Open" });
    await user.click(firstOpen as HTMLElement);
    expect(within(sheet).getByRole("button", { name: "Show less" })).toBeInTheDocument();

    await user.click(within(sheet).getAllByRole("button", { name: "Pause" })[0] as HTMLElement);
    expect(mocks.memoryUpdate).toHaveBeenCalledWith({ memoryId: "m1", disabled: true });

    await user.click(within(sheet).getAllByRole("button", { name: "Forget" })[1] as HTMLElement);
    expect(mocks.memoryDelete).toHaveBeenCalledWith("m2");
    await waitFor(() => expect(within(sheet).queryByText("Likes tea.")).not.toBeInTheDocument());
  });

  it("stays hidden when the sources cannot be read", async () => {
    mocks.forTask.mockRejectedValue(new Error("no bridge"));
    render(<MemorySourcesChip task={{ ...TASK, id: "task-3" }} messageId="a1" />);
    await waitFor(() => expect(mocks.forTask).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("MemoryInChatIndicator", () => {
  it("asks for the session with its start and lists what the chat started with", async () => {
    const user = userEvent.setup();
    mocks.forSession.mockResolvedValue({
      recorded: true,
      memories: [memory("m1", "Lives in Lyon.")],
    });
    render(
      <MemoryInChatIndicator
        session={{ id: "session-1", started_at: "1759000000", message_count: 2 }}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Memory in this chat · 1" }));
    expect(mocks.forSession).toHaveBeenCalledWith("session-1", 1_759_000_000_000);
    const dialog = screen.getByRole("dialog", { name: "Memory in this chat" });
    await user.click(within(dialog).getByRole("button", { name: "Forget" }));
    expect(mocks.memoryDelete).toHaveBeenCalledWith("m1");
  });

  it("shows nothing for a draft session, an empty chat or an unknown injection", async () => {
    mocks.forSession.mockResolvedValue({ recorded: false, memories: [] });
    const { rerender } = render(
      <MemoryInChatIndicator session={{ id: "pending:new-session:1:abc", message_count: 1 }} />,
    );
    rerender(<MemoryInChatIndicator session={{ id: "session-2", message_count: 0 }} />);
    expect(mocks.forSession).not.toHaveBeenCalled();
    rerender(<MemoryInChatIndicator session={{ id: "session-2", message_count: 3 }} />);
    await waitFor(() => expect(mocks.forSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
