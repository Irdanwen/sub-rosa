import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantsDialog } from "../components/assistants/AssistantsDialog";
import { AssistantChat } from "../components/assistants/AssistantChat";
import type { AgentTaskDto } from "../lib/tauri";
import { emptyAssistant, assistantMediaIds } from "../lib/assistants";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const events = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = events.get(name) ?? new Set();
    handlers.add(handler);
    events.set(name, handlers);
    return () => {
      handlers.delete(handler);
    };
  }),
}));
function emitDone(payload: AgentTaskDto) {
  for (const handler of events.get("agent-lite://done") ?? []) handler({ payload });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock("../components/chat-blocks/AssistantMediaCard", () => ({ AssistantMediaList: () => null }));
const assistant = {
  ...emptyAssistant(),
  id: "a",
  name: "Research partner",
  instructions: "Check evidence",
  revision: 3,
};
const task: AgentTaskDto = {
  safetyProfile: "customAssistant",
  createdAt: "2026-09-21T08:00:00Z",
  updatedAt: "2026-09-21T08:00:01Z",
  id: "task",
  title: "Evidence",
  prompt: "Hello",
  status: "completed",
  messages: [
    { id: "u", taskId: "task", createdAt: "2026-09-21T08:00:00Z", role: "user", content: "Hello" },
    {
      id: "v",
      taskId: "task",
      createdAt: "2026-09-21T08:00:01Z",
      role: "assistant",
      content: "Here are your sources.",
    },
  ],
  toolEvents: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  events.clear();
  Element.prototype.scrollTo = vi.fn();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "assistant_list") return [assistant];
    if (command === "list_venice_models") return { models: [] };
    if (
      command === "assistant_reference_list" ||
      command === "assistant_chat_list" ||
      command === "assistant_chat_archive_list"
    )
      return [];
    if (command === "assistant_draft")
      return {
        name: "Writing companion",
        description: "Develop ideas",
        instructions: "Keep the author's voice.",
        openingMessage: "What are you writing?",
        tools: [],
      };
    if (command === "assistant_save")
      return { ...(args.definition as object), id: "new", revision: 1 };
    if (command === "assistant_chat_start" || command === "assistant_chat_history") return task;
    return null;
  });
});
describe("custom assistants", () => {
  it("deduplicates only complete valid media fences actually rendered as cards", () => {
    const valid =
      '```subrosa:media\n{"v":1,"proposalId":"123e4567-e89b-12d3-a456-426614174000"}\n```';
    expect(assistantMediaIds([valid, valid])).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(
      assistantMediaIds([
        '```subrosa:media\n{"v":1,"proposalId":"123e4567-e89b-12d3-a456-426614174000"}',
        "```subrosa:media\ninvalid\n```",
      ]),
    ).toEqual([]);
  });
  it("prepares a questionnaire draft without saving or granting private context until reviewed", async () => {
    const user = userEvent.setup();
    render(<AssistantsDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Create an assistant" }));
    fireEvent.change(screen.getByLabelText("Your idea"), {
      target: { value: "Help write a novel" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByLabelText("Just me"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText("Ask questions first"));
    await user.click(screen.getByLabelText("Challenge my ideas"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "A chapter outline" },
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Prepare my draft" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Writing companion");
    expect(invoke).toHaveBeenCalledWith("assistant_draft", {
      request: {
        description: "Help write a novel",
        answers: expect.arrayContaining([
          {
            question: "How should it work with you?",
            answer: "Ask questions first; Challenge my ideas",
          },
        ]),
      },
    });
    expect(invoke.mock.calls.some(([command]) => command === "assistant_save")).toBe(false);
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_save", {
        definition: expect.objectContaining({
          name: "Writing companion",
          allow_notes: false,
          allow_memory: false,
          revision: 0,
        }),
      }),
    );
  });
  it("preserves a conflicting edit and requires explicit discard", async () => {
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "assistant_save") throw { message: "Changed on another device" };
      return base?.(command, args);
    });
    const close = vi.fn();
    const user = userEvent.setup();
    render(<AssistantsDialog open onClose={close} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My evidence assistant" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Changed on another device");
    expect(screen.getByLabelText("Name")).toHaveValue("My evidence assistant");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });
  it("does not execute chat on mount; sends once with the saved assistant id", async () => {
    const user = userEvent.setup();
    render(<AssistantChat assistant={assistant} />);
    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
    expect(invoke).toHaveBeenCalledWith("assistant_chat_list", { request: { assistantId: "a" } });
    expect(invoke.mock.calls.some(([command]) => command === "assistant_chat_start")).toBe(false);
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Hello" } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Here are your sources.")).toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([command]) => command === "assistant_chat_start"),
    ).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("assistant_chat_start", {
      request: { assistantId: "a", content: "Hello" },
    });
  });
  it("opens a deleted assistant's archived conversation without creating a new turn", async () => {
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "assistant_list") return [];
      if (command === "assistant_chat_archive_list") return [{ task, definition: assistant }];
      return base?.(command, args);
    });
    const user = userEvent.setup();
    render(<AssistantsDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Evidence Research partner/ }));
    expect(await screen.findByText("Here are your sources.")).toBeInTheDocument();
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "assistant_chat_start" || command === "assistant_chat_send",
      ),
    ).toBe(false);
  });
  it("retains a failed message instead of losing the draft", async () => {
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "assistant_chat_start") throw { message: "No connection" };
      return base?.(command, args);
    });
    const user = userEvent.setup();
    render(<AssistantChat assistant={assistant} />);
    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "Keep this text" },
    });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    expect(screen.getByLabelText("Your message")).toHaveValue("Keep this text");
  });
  it.each(["initial", "resume", "history"] as const)(
    "ignores a %s read that resolves after the completion event",
    async (origin) => {
      const pending = deferred<AgentTaskDto>();
      const stale: AgentTaskDto = {
        ...task,
        status: "running",
        messages: task.messages.slice(0, 1),
      };
      const base = invoke.getMockImplementation();
      let deferReads = origin !== "resume";
      invoke.mockImplementation(async (command, args) => {
        if (command === "assistant_chat_list") return [stale];
        if (command === "assistant_chat_history" && deferReads) return pending.promise;
        return base?.(command, args);
      });
      render(
        <AssistantChat
          assistant={assistant}
          initialTask={origin === "history" ? undefined : origin === "initial" ? stale : task}
        />,
      );
      await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
      if (origin === "history")
        fireEvent.change(await screen.findByLabelText("Chat history"), {
          target: { value: task.id },
        });
      if (origin === "resume") {
        await waitFor(() => expect(screen.getByText("Here are your sources.")).toBeInTheDocument());
        deferReads = true;
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        fireEvent(document, new Event("visibilitychange"));
      }
      await act(async () => emitDone(task));
      await act(async () => {
        pending.resolve(stale);
        await pending.promise;
      });
      expect(screen.getByText("Here are your sources.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
      expect(screen.queryByText("Working")).not.toBeInTheDocument();
    },
  );
  it.each(["retry", "revision", "send"] as const)(
    "keeps canonical completion when a %s response arrives later",
    async (operation) => {
      const pending = deferred<AgentTaskDto>();
      const failed: AgentTaskDto = {
        ...task,
        status: "failed",
        messages: task.messages.slice(0, 1),
        lastError: "Try this request again",
      };
      const initial = operation === "retry" ? failed : task;
      const latest: AgentTaskDto = {
        ...task,
        messages: [
          ...task.messages,
          { ...task.messages[1], id: "latest", content: "Newest completed reply" },
        ],
      };
      const base = invoke.getMockImplementation();
      const commandName =
        operation === "retry"
          ? "assistant_chat_retry"
          : operation === "revision"
            ? "assistant_chat_apply_revision"
            : "assistant_chat_send";
      invoke.mockImplementation(async (command, args) => {
        if (command === "assistant_chat_history") return initial;
        if (command === commandName) return pending.promise;
        return base?.(command, args);
      });
      const user = userEvent.setup();
      render(<AssistantChat assistant={assistant} initialTask={initial} />);
      await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
      if (operation === "send")
        fireEvent.change(screen.getByLabelText("Your message"), {
          target: { value: "Another question" },
        });
      await user.click(
        screen.getByRole("button", {
          name:
            operation === "retry"
              ? "Try again"
              : operation === "revision"
                ? "Apply current assistant settings"
                : "Send",
        }),
      );
      await act(async () => emitDone(latest));
      await act(async () => {
        pending.resolve({ ...initial, status: "queued" });
        await pending.promise;
      });
      expect(screen.getByText("Newest completed reply")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    },
  );
  it("ignores a rejected retry after a successful completion", async () => {
    const pending = deferred<AgentTaskDto>();
    const failed: AgentTaskDto = { ...task, status: "failed", messages: task.messages.slice(0, 1) };
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) =>
      command === "assistant_chat_history"
        ? failed
        : command === "assistant_chat_retry"
          ? pending.promise
          : base?.(command, args),
    );
    const user = userEvent.setup();
    render(<AssistantChat assistant={assistant} initialTask={failed} />);
    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => emitDone(task));
    await act(async () => {
      pending.reject({ message: "Stale transport error" });
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Here are your sources.")).toBeInTheDocument();
  });
  it("invalidates an old selection even after returning to the same conversation", async () => {
    const pending = deferred<AgentTaskDto>();
    const other = { ...task, id: "other", title: "Other chat" };
    const latest = {
      ...task,
      messages: [
        ...task.messages,
        { ...task.messages[1], id: "latest", content: "Fresh selected reply" },
      ],
    };
    const base = invoke.getMockImplementation();
    let reads = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === "assistant_chat_list") return [task, other];
      if (command === "assistant_chat_history") {
        const id = (args.request as { taskId: string }).taskId;
        if (id === task.id && ++reads === 1) return pending.promise;
        return id === task.id ? latest : other;
      }
      return base?.(command, args);
    });
    render(<AssistantChat assistant={assistant} />);
    const history = await screen.findByLabelText("Chat history");
    fireEvent.change(history, { target: { value: task.id } });
    fireEvent.change(history, { target: { value: other.id } });
    fireEvent.change(history, { target: { value: task.id } });
    expect(await screen.findByText("Fresh selected reply")).toBeInTheDocument();
    await act(async () => {
      pending.resolve({ ...task, status: "running", messages: task.messages.slice(0, 1) });
      await pending.promise;
    });
    expect(screen.getByText("Fresh selected reply")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });
  it("does not show an old read error after leaving the conversation", async () => {
    const pending = deferred<AgentTaskDto>();
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) =>
      command === "assistant_chat_history" ? pending.promise : base?.(command, args),
    );
    const user = userEvent.setup();
    render(<AssistantChat assistant={assistant} initialTask={task} />);
    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await act(async () => {
      pending.reject({ message: "Old read failed" });
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Here are your sources.")).not.toBeInTheDocument();
  });
  it("does not let an initial read mark a newly submitted turn complete", async () => {
    const initialRead = deferred<AgentTaskDto>();
    const afterSend = deferred<AgentTaskDto>();
    const base = invoke.getMockImplementation();
    let reads = 0;
    const queued: AgentTaskDto = {
      ...task,
      status: "queued",
      messages: [...task.messages, { ...task.messages[0], id: "next", content: "Next question" }],
    };
    invoke.mockImplementation(async (command, args) => {
      if (command === "assistant_chat_history")
        return ++reads === 1 ? initialRead.promise : afterSend.promise;
      if (command === "assistant_chat_send") return queued;
      return base?.(command, args);
    });
    const user = userEvent.setup();
    render(<AssistantChat assistant={assistant} initialTask={task} />);
    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Next question" } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {
      initialRead.resolve(task);
      await initialRead.promise;
    });
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(screen.getByText("Next question")).toBeInTheDocument();
    await act(async () => {
      emitDone(task);
      afterSend.resolve(queued);
      await afterSend.promise;
    });
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });
});
