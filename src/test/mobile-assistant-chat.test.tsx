import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantChatScreen } from "../components/mobile/screens/assistants/AssistantChatScreen";
import { type AssistantDefinition, emptyAssistant } from "../lib/assistants";
import type { AgentTaskDto } from "../lib/tauri";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lib/keyboard-inset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));
vi.mock("../components/chat-blocks/AssistantMediaCard", () => ({
  AssistantMediaList: () => null,
}));

const plume: AssistantDefinition = {
  ...emptyAssistant(),
  id: "a1",
  name: "Plume",
  description: "Writes travel letters",
  opening_message: "Where are we writing from today?",
  model: "words-only",
  revision: 4,
};

function task(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: "t1",
    title: "Lisbon letter",
    prompt: "Write from Lisbon",
    status: "completed",
    safetyProfile: "custom_assistant" as AgentTaskDto["safetyProfile"],
    messages: [
      { id: "m1", role: "user", content: "Write from Lisbon", createdAt: "2026-10-01T10:00:00Z" },
      { id: "m2", role: "assistant", content: "Dear friend,", createdAt: "2026-10-01T10:00:05Z" },
    ] as AgentTaskDto["messages"],
    toolEvents: [],
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:05Z",
    ...overrides,
  };
}

type Backend = {
  definition?: AssistantDefinition;
  chats?: AgentTaskDto[];
  conversation?: AgentTaskDto;
};

function backend({ definition = plume, chats = [], conversation }: Backend = {}) {
  let started: AgentTaskDto | undefined;
  invoke.mockImplementation(
    async (command: string, args: { request?: Record<string, unknown> }) => {
      switch (command) {
        case "assistant_list":
          return [plume];
        case "assistant_chat_list":
          return chats;
        case "assistant_chat_definition":
          return definition;
        case "assistant_chat_history":
          return (
            conversation ??
            [...chats, ...(started ? [started] : [])].find(
              (entry) => entry.id === args.request?.taskId,
            )
          );
        case "assistant_chat_start":
        case "assistant_chat_send":
          started = task({
            id: "t9",
            status: "queued",
            messages: [
              {
                id: "u9",
                role: "user",
                content: String(args.request?.content),
                createdAt: "2026-10-04T09:00:00Z",
              },
            ] as AgentTaskDto["messages"],
          });
          return started;
        default:
          return null;
      }
    },
  );
}

function emitDone(payload: AgentTaskDto) {
  act(() => listeners.get("agent-lite://done")?.({ payload }));
}

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe("an assistant's chat on the phone", () => {
  it("opens on who you are talking to and their opening message", async () => {
    backend();
    render(<AssistantChatScreen assistantId="a1" onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Plume", level: 2 })).toBeTruthy();
    expect(screen.getByText("Writes travel letters")).toBeTruthy();
    expect(screen.getByText("Where are we writing from today?")).toBeTruthy();
    expect(screen.getByPlaceholderText("Message Plume…")).toBeTruthy();
  });

  it("sends the files attached with the turn, and keeps only their names in the history", async () => {
    backend();
    const onConversationChange = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AssistantChatScreen
        assistantId="a1"
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onConversationChange={onConversationChange}
      />,
    );
    await screen.findByRole("heading", { name: "Plume", level: 2 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["Itinerary"], "trip.txt", { type: "text/plain" })] },
    });
    await screen.findByRole("button", { name: "Remove trip.txt" });
    await user.type(screen.getByPlaceholderText("Message Plume…"), "Use this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_chat_start", {
        request: {
          assistantId: "a1",
          content: "Use this\n[File: trip.txt]",
          attachments: [{ kind: "text", name: "trip.txt", data: "Itinerary" }],
        },
      }),
    );
    expect(onConversationChange).toHaveBeenCalledWith("t9");
  });

  it("finds an older conversation in a sheet, not a drop-down", async () => {
    const older = task();
    backend({ chats: [older] });
    const user = userEvent.setup();
    render(<AssistantChatScreen assistantId="a1" onBack={vi.fn()} onEdit={vi.fn()} />);
    await screen.findByRole("heading", { name: "Plume", level: 2 });
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("button", { name: "Conversations" }));
    const sheet = await screen.findByRole("dialog", { name: "Conversations with Plume" });
    await user.click(within(sheet).getByRole("button", { name: /^Lisbon letter/ }));
    expect(await screen.findByText("Dear friend,")).toBeTruthy();
  });

  it("offers to try again on a failed reply, and re-sends the same files", async () => {
    backend();
    const user = userEvent.setup();
    const { container } = render(
      <AssistantChatScreen assistantId="a1" onBack={vi.fn()} onEdit={vi.fn()} />,
    );
    await screen.findByRole("heading", { name: "Plume", level: 2 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["Itinerary"], "trip.txt", { type: "text/plain" })] },
    });
    await screen.findByRole("button", { name: "Remove trip.txt" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_chat_start", expect.anything()),
    );
    emitDone(
      task({
        id: "t9",
        status: "failed",
        lastError: "The model provider could not answer this message.",
        messages: [
          { id: "u9", role: "user", content: "[File: trip.txt]", createdAt: "x" },
        ] as AgentTaskDto["messages"],
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(invoke).toHaveBeenCalledWith("assistant_chat_retry", {
      request: {
        taskId: "t9",
        attachments: [{ kind: "text", name: "trip.txt", data: "Itinerary" }],
      },
    });
  });

  it("a reopened turn whose files are gone says so instead of retrying without them", async () => {
    const lost = task({
      status: "failed",
      messages: [
        { id: "u1", role: "user", content: "Look [Image: map.jpg]", createdAt: "x" },
      ] as AgentTaskDto["messages"],
    });
    backend({ chats: [lost], conversation: lost });
    render(<AssistantChatScreen taskId="t1" onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(await screen.findByText(/Attach your files again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("names the newer settings and applies them on request", async () => {
    backend({ chats: [task()], conversation: task(), definition: { ...plume, revision: 2 } });
    const user = userEvent.setup();
    render(<AssistantChatScreen taskId="t1" onBack={vi.fn()} onEdit={vi.fn()} />);
    await screen.findByText("Dear friend,");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(
      await screen.findByRole("button", { name: "Apply current assistant settings" }),
    );
    expect(invoke).toHaveBeenCalledWith("assistant_chat_apply_revision", {
      request: { taskId: "t1" },
    });
  });

  it("the face and name open the assistant", async () => {
    backend();
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<AssistantChatScreen assistantId="a1" onBack={vi.fn()} onEdit={onEdit} />);
    await screen.findByRole("heading", { name: "Plume", level: 2 });
    await user.click(screen.getByRole("button", { name: "Plume" }));
    expect(onEdit).toHaveBeenCalledWith("a1");
  });
});
