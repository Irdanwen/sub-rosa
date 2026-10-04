import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantHistory } from "../components/mobile/screens/assistants/AssistantHistory";
import { AssistantsHome } from "../components/mobile/screens/assistants/AssistantsHome";
import { type AssistantDefinition, emptyAssistant } from "../lib/assistants";
import type { AgentTaskDto } from "../lib/tauri";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

function assistant(
  id: string,
  name: string,
  updated = "2026-09-01T00:00:00Z",
): AssistantDefinition {
  return {
    ...emptyAssistant(),
    id,
    name,
    description: `${name} helps`,
    revision: 1,
    updated_at: updated,
  };
}

function conversation(
  id: string,
  who: AssistantDefinition,
  updatedAt: string,
  title = `Talk ${id}`,
) {
  return {
    task: {
      id,
      title,
      prompt: title,
      status: "completed",
      safetyProfile: "custom_assistant",
      messages: [],
      toolEvents: [],
      createdAt: updatedAt,
      updatedAt,
    } as unknown as AgentTaskDto,
    definition: who,
  };
}

function backend(
  definitions: AssistantDefinition[],
  archive: ReturnType<typeof conversation>[] = [],
) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "assistant_list") return definitions;
    if (command === "assistant_chat_archive_list") return archive;
    return null;
  });
}

const handlers = () => ({
  onOpenChat: vi.fn(),
  onOpenConversation: vi.fn(),
  onCreate: vi.fn(),
  onEdit: vi.fn(),
  onOpenHistory: vi.fn(),
});

beforeEach(() => {
  invoke.mockReset();
});

describe("the Assistants tab on the phone", () => {
  it("starts empty with one thing to do, and ideas to start from", async () => {
    backend([]);
    const props = handlers();
    const user = userEvent.setup();
    render(<AssistantsHome {...props} />);
    await user.click(await screen.findByRole("button", { name: "Create an assistant" }));
    expect(props.onCreate).toHaveBeenCalledWith();
    await user.click(screen.getByRole("button", { name: /Writing partner/ }));
    expect(props.onCreate).toHaveBeenLastCalledWith(expect.stringContaining("writing assistant"));
  });

  it("lists the assistant talked to last first, and a tap opens its chat", async () => {
    const plume = assistant("a1", "Plume");
    const atlas = assistant("a2", "Atlas");
    backend([plume, atlas], [conversation("t1", atlas, "2026-10-03T10:00:00Z")]);
    const props = handlers();
    const user = userEvent.setup();
    render(<AssistantsHome {...props} />);
    const list = await screen.findByRole("region", { name: "My assistants" });
    const rows = within(list).getAllByRole("button");
    expect(rows[0]).toHaveAccessibleName(/^Atlas/);
    await user.click(rows[1]);
    expect(props.onOpenChat).toHaveBeenCalledWith("a1");
  });

  it("a long press offers the rest, and deleting is confirmed first", async () => {
    const plume = assistant("a1", "Plume");
    backend([plume]);
    const props = handlers();
    const user = userEvent.setup();
    render(<AssistantsHome {...props} />);
    const row = await screen.findByRole("button", { name: /^Plume/ });
    fireEvent.contextMenu(row);
    const sheet = await screen.findByRole("dialog", { name: "Plume" });
    await user.click(within(sheet).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this assistant?" });
    expect(invoke).not.toHaveBeenCalledWith("assistant_delete", expect.anything());
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_delete", { id: "a1", revision: 1 }),
    );
    expect(props.onOpenChat).not.toHaveBeenCalled();
  });

  it("searches once there are enough assistants to need it", async () => {
    const many = ["Plume", "Atlas", "Clio", "Iris", "Hermine", "Nox"].map((name, index) =>
      assistant(`a${index}`, name),
    );
    backend(many);
    const user = userEvent.setup();
    render(<AssistantsHome {...handlers()} />);
    await user.type(await screen.findByRole("searchbox", { name: "Search assistants" }), "cli");
    const list = screen.getByRole("region", { name: "My assistants" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByRole("button")).toHaveAccessibleName(/^Clio/);
  });

  it("shows the five latest conversations and leads to the rest", async () => {
    const plume = assistant("a1", "Plume");
    const archive = [1, 2, 3, 4, 5, 6].map((day) =>
      conversation(`t${day}`, plume, `2026-10-0${day}T10:00:00Z`),
    );
    backend([plume], archive);
    const props = handlers();
    const user = userEvent.setup();
    render(<AssistantsHome {...props} />);
    const recent = await screen.findByRole("region", { name: "Recent conversations" });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(5);
    await user.click(within(recent).getByRole("button", { name: "See all" }));
    expect(props.onOpenHistory).toHaveBeenCalled();
    await user.click(within(recent).getByRole("button", { name: /^Talk t1/ }));
    expect(props.onOpenConversation).toHaveBeenCalledWith("t1");
  });

  it("the history finds a conversation by its assistant's name", async () => {
    const plume = assistant("a1", "Plume");
    const atlas = assistant("a2", "Atlas");
    backend(
      [plume, atlas],
      [
        conversation("t1", plume, "2026-10-01T10:00:00Z"),
        conversation("t2", atlas, "2026-10-02T10:00:00Z"),
      ],
    );
    const user = userEvent.setup();
    const onOpenConversation = vi.fn();
    render(<AssistantHistory onBack={vi.fn()} onOpenConversation={onOpenConversation} />);
    await user.type(await screen.findByRole("searchbox", { name: "Search conversations" }), "atl");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Talk t2/ }));
    expect(onOpenConversation).toHaveBeenCalledWith("t2");
  });
});
