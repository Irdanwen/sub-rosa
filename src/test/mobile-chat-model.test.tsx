import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentScreen, AgentSessionScreen } from "../components/mobile/screens/AgentScreen";
import { applyLocale } from "../lib/i18n";
import type { MediaModel } from "../lib/studio/types";
import type { AgentTaskDto } from "../lib/tauri";

// Two fake text models so the picker has something to switch between and the
// composer can resolve a display name for a stored model id.
const MODELS: MediaModel[] = [
  { id: "venice-uncensored", mediaType: "text", name: "Venice Uncensored", offline: false },
  { id: "qwen3-4b", mediaType: "text", name: "Qwen 3", offline: false },
];

const tauriMocks = vi.hoisted(() => ({
  getAgentTask: vi.fn(),
  listAgentTasks: vi.fn(),
  listSessionFolders: vi.fn(),
  assignSessionToFolder: vi.fn(),
  removeSessionFromFolder: vi.fn(),
  deleteAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  sendAgentMessage: vi.fn(),
  agentLiteRun: vi.fn(),
  setAgentTaskModel: vi.fn(),
  forkAgentTask: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
}));

const eventListeners = vi.hoisted(
  () => new Map<string, (event: { payload: AgentTaskDto }) => void>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name, callback) => {
    eventListeners.set(name, callback);
    return Promise.resolve(() => eventListeners.delete(name));
  }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: () => null }));
vi.mock("../lib/keyboard-inset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: () => Promise.resolve({ backend: "carpe-diem", models: MODELS }),
  modelsOfType: () => MODELS,
}));
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  ...tauriMocks,
}));

function makeTask(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: "task-1",
    title: "Draft a reply",
    prompt: "hi",
    status: "queued",
    safetyProfile: "autonomousPrivate",
    messages: [],
    toolEvents: [],
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z",
    ...overrides,
  };
}

describe("mobile chat model persistence", () => {
  afterEach(() => {
    applyLocale("en");
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    for (const mock of Object.values(tauriMocks)) mock.mockReset();
    eventListeners.clear();
    tauriMocks.listAgentTasks.mockResolvedValue({ items: [makeTask()] });
    tauriMocks.listSessionFolders.mockResolvedValue([]);
    tauriMocks.getAgentTask.mockResolvedValue(makeTask());
    tauriMocks.createAgentTask.mockResolvedValue(makeTask());
    tauriMocks.agentLiteRun.mockResolvedValue(makeTask());
    tauriMocks.setAgentTaskModel.mockResolvedValue(makeTask());
    tauriMocks.forkAgentTask.mockResolvedValue(makeTask({ id: "task-2" }));
    tauriMocks.sendAgentMessage.mockResolvedValue(makeTask());
    tauriMocks.suggestAgentSessionTitle.mockResolvedValue({ title: "Draft a reply" });
    localStorage.clear();
    // jsdom elements have no scrollTo; the composer scrolls to the latest turn.
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("restores the session's remembered model on open", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(makeTask({ model: "venice-uncensored" }));

    render(<AgentSessionScreen sessionId="task-1" />);

    const modelButton = await screen.findByRole("button", { name: "Choose model" });
    await waitFor(() => expect(modelButton).toHaveTextContent("Venice Uncensored"));
  });

  it("persists a mid-conversation switch on the session itself", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(makeTask({ model: "venice-uncensored" }));
    const user = userEvent.setup();

    render(<AgentSessionScreen sessionId="task-1" />);

    const modelButton = await screen.findByRole("button", { name: "Choose model" });
    await waitFor(() => expect(modelButton).toHaveTextContent("Venice Uncensored"));

    await user.click(modelButton);
    const sheet = await screen.findByRole("dialog", { name: "Chat model" });
    await user.click(within(sheet).getByText("Qwen 3"));

    expect(tauriMocks.setAgentTaskModel).toHaveBeenCalledWith({
      taskId: "task-1",
      model: "qwen3-4b",
    });
    // The composer reflects the switch immediately, before any reload.
    await waitFor(() => expect(modelButton).toHaveTextContent("Qwen 3"));
  });

  it("records the chosen model when a new chat is created", async () => {
    localStorage.setItem("subrosa:mobile:chat-model", "qwen3-4b");
    const user = userEvent.setup();

    render(<AgentSessionScreen />);

    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Summarize my notes");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(tauriMocks.createAgentTask).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Summarize my notes", model: "qwen3-4b" }),
      ),
    );
  });

  it("forks the chat onto another model and opens the new thread", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(
      makeTask({ id: "task-1", model: "venice-uncensored" }),
    );
    tauriMocks.forkAgentTask.mockResolvedValue(makeTask({ id: "task-2", model: "qwen3-4b" }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();

    render(<AgentSessionScreen sessionId="task-1" onOpenSession={onOpenSession} />);
    const modelButton = await screen.findByRole("button", { name: "Choose model" });
    await waitFor(() => expect(modelButton).toHaveTextContent("Venice Uncensored"));

    await user.click(modelButton);
    const sheet = await screen.findByRole("dialog", { name: "Chat model" });
    // The per-model branch action forks instead of switching in place.
    await user.click(within(sheet).getByRole("button", { name: "Fork chat to Qwen 3" }));

    await waitFor(() =>
      expect(tauriMocks.forkAgentTask).toHaveBeenCalledWith({
        sourceTaskId: "task-1",
        model: "qwen3-4b",
      }),
    );
    // The original chat is not switched; the fork opens as its own thread.
    expect(tauriMocks.setAgentTaskModel).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("task-2"));
  });

  it("re-runs a failed turn without retyping or re-persisting the message", async () => {
    tauriMocks.agentLiteRun.mockRejectedValueOnce(new Error("This model is busy right now."));
    const user = userEvent.setup();

    render(<AgentSessionScreen />);

    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Summarize my notes");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The failure surfaces a one-tap retry; the message was persisted once.
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(tauriMocks.createAgentTask).toHaveBeenCalledTimes(1);
    expect(tauriMocks.agentLiteRun).toHaveBeenCalledTimes(1);

    await user.click(retry);

    // The retry re-issues the run only; it does not create or resend a message.
    await waitFor(() => expect(tauriMocks.agentLiteRun).toHaveBeenCalledTimes(2));
    expect(tauriMocks.createAgentTask).toHaveBeenCalledTimes(1);
    expect(tauriMocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("restores the composer when creating the chat itself fails", async () => {
    tauriMocks.createAgentTask.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();

    render(<AgentSessionScreen />);

    const composer = screen.getByPlaceholderText("Ask about your notes");
    await user.type(composer, "Summarize my notes");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Nothing was persisted, so the message must not vanish: it returns to the
    // composer, and no retry is offered (there is no task to re-run yet).
    await waitFor(() => expect(composer).toHaveValue("Summarize my notes"));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
  });

  it("retries a failed turn on a newly chosen model", async () => {
    tauriMocks.agentLiteRun.mockRejectedValueOnce(new Error("This model is busy right now."));
    localStorage.setItem("subrosa:mobile:chat-model", "venice-uncensored");
    const user = userEvent.setup();

    render(<AgentSessionScreen />);

    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Summarize my notes");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });

    // Switch to another model, then retry: the re-run uses the new model.
    await user.click(screen.getByRole("button", { name: "Choose model" }));
    const sheet = await screen.findByRole("dialog", { name: "Chat model" });
    await user.click(within(sheet).getByText("Qwen 3"));
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(tauriMocks.agentLiteRun).toHaveBeenLastCalledWith("task-1", "qwen3-4b", undefined),
    );
  });

  it("restores an unsaved message and attachments when an existing chat write fails", async () => {
    tauriMocks.sendAgentMessage.mockRejectedValueOnce(new Error("Could not save message"));
    const user = userEvent.setup();
    const { container } = render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Draft a reply");
    const composer = screen.getByPlaceholderText("Ask about your notes");
    await user.type(composer, "Keep my draft");
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Missing attachment input");
    await user.upload(
      fileInput,
      new File(["Supporting text"], "context.txt", { type: "text/plain" }),
    );
    await screen.findByRole("button", { name: "Remove context.txt" });
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByRole("alert");
    expect(composer).toHaveValue("Keep my draft");
    expect(screen.getByRole("button", { name: "Remove context.txt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(tauriMocks.agentLiteRun).toHaveBeenCalledTimes(1));
    expect(tauriMocks.sendAgentMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        content: "Keep my draft\n[File: context.txt]",
      }),
    );
  });

  it("preserves the next draft typed while a failed write was pending", async () => {
    let rejectWrite: (error: Error) => void = () => {};
    tauriMocks.createAgentTask.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen />);
    const composer = screen.getByPlaceholderText("Ask about your notes");
    await user.type(composer, "First message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(composer, "Next thought");
    await act(async () => rejectWrite(new Error("Could not save message")));
    expect(composer).toHaveValue("First message\nNext thought");
  });

  it("waits for existing history before sending instead of creating a different chat", async () => {
    let resolveLoad: (task: AgentTaskDto) => void = () => {};
    tauriMocks.getAgentTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Continue here");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => resolveLoad(makeTask()));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(tauriMocks.sendAgentMessage).toHaveBeenCalled());
    expect(tauriMocks.createAgentTask).not.toHaveBeenCalled();
  });

  it("allows history loading to be retried while keeping the draft", async () => {
    tauriMocks.getAgentTask.mockRejectedValueOnce(new Error("Could not load chat"));
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByRole("button", { name: "Try again" });
    const composer = screen.getByPlaceholderText("Ask about your notes");
    await user.type(composer, "Continue here");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    expect(composer).toHaveValue("Continue here");
  });

  it("restores the retry action for a persisted failed turn after reopening", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(
      makeTask({
        status: "failed",
        lastError: "Model busy",
        messages: [
          {
            id: "message-1",
            taskId: "task-1",
            role: "user",
            content: "Summarize my notes",
            createdAt: "2026-07-17T00:00:00Z",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauriMocks.agentLiteRun).toHaveBeenCalledTimes(1));
    expect(tauriMocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("keeps a reopened unfinished turn busy until its native completion arrives", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(
      makeTask({
        status: "running",
        messages: [
          {
            id: "message-1",
            taskId: "task-1",
            role: "user",
            content: "Question",
            createdAt: "2026-07-17T00:00:00Z",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Thinking");
    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Next question");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
  });

  it("does not replace native completion with a stale history response", async () => {
    let resolveLoad: (task: AgentTaskDto) => void = () => {};
    tauriMocks.getAgentTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await act(async () => {
      eventListeners.get("agent-lite://done")?.({
        payload: makeTask({ status: "completed", title: "Finished chat" }),
      });
      resolveLoad(
        makeTask({
          status: "running",
          messages: [
            {
              id: "m1",
              taskId: "task-1",
              role: "user",
              content: "Old question",
              createdAt: "2026-09-05T00:00:00Z",
            },
          ],
        }),
      );
    });
    await screen.findByText("Finished chat");
    await user.type(screen.getByPlaceholderText("Ask about your notes"), "Next question");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByText("Old question")).toBeNull();
  });

  it("asks for lost attachments again and never runs a text-only retry", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(
      makeTask({
        status: "failed",
        lastError: "Old failure",
        messages: [
          {
            id: "m1",
            taskId: "task-1",
            role: "user",
            content: "Describe this\n[Image: photo.jpg]",
            createdAt: "2026-09-05T00:00:00Z",
          },
        ],
      }),
    );
    render(<AgentSessionScreen sessionId="task-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attach your files again and send a new message.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
  });

  it.each(["Archive", "Restore", "Delete"])(
    "shows a failed %s action and keeps the conversation",
    async (action) => {
      const user = userEvent.setup();
      const error = new Error("Cannot read properties of undefined");
      tauriMocks.assignSessionToFolder.mockRejectedValue(error);
      tauriMocks.removeSessionFromFolder.mockRejectedValue(error);
      tauriMocks.deleteAgentTask.mockRejectedValue(error);
      if (action === "Restore") {
        tauriMocks.listSessionFolders.mockResolvedValue([
          { sessionId: "task-1", folderId: "archive" },
        ]);
      }
      render(
        <AgentScreen
          onOpenSession={vi.fn()}
          archiveFolderId="archive"
          ensureArchiveFolder={async () => "archive"}
        />,
      );
      if (action === "Restore")
        await user.click(await screen.findByRole("button", { name: "Archived (1)" }));
      await user.click(await screen.findByRole("button", { name: action }));
      if (action === "Delete") {
        await user.click(
          within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }),
        );
      }
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Couldn't ${action.toLowerCase()} this chat.`,
      );
      expect(screen.getByText("Draft a reply")).toBeInTheDocument();
    },
  );

  it("ignores an old load rejection after the native reply completes", async () => {
    let rejectLoad: (error: Error) => void = () => {};
    tauriMocks.getAgentTask.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );
    render(<AgentSessionScreen sessionId="task-1" />);
    await act(async () => {
      eventListeners.get("agent-lite://done")?.({
        payload: makeTask({ status: "completed", title: "Finished chat" }),
      });
      rejectLoad(new Error("Outdated load failure"));
    });
    expect(screen.getByText("Finished chat")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Loading")).toBeNull();
  });

  it("does not let the previous session's rejected load unlock the next session", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    let resolveSecond: (task: AgentTaskDto) => void = () => {};
    tauriMocks.getAgentTask
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const user = userEvent.setup();
    const { rerender } = render(<AgentSessionScreen sessionId="task-1" />);
    rerender(<AgentSessionScreen sessionId="task-2" />);
    await user.type(screen.getByPlaceholderText("Ask about your notes"), "For the second chat");
    await act(async () => {
      eventListeners.get("agent-lite://done")?.({
        payload: makeTask({ status: "completed", title: "Previous chat" }),
      });
      rejectFirst(new Error("Old chat unavailable"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => resolveSecond(makeTask({ id: "task-2", title: "Second chat" })));
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });

  it("ignores the failed-turn refresh when native completion arrives first", async () => {
    let resolveRefresh: (task: AgentTaskDto) => void = () => {};
    tauriMocks.agentLiteRun.mockRejectedValueOnce(new Error("Temporary failure"));
    tauriMocks.getAgentTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentSessionScreen />);
    await user.type(screen.getByPlaceholderText("Ask about your notes"), "A question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => {
      eventListeners.get("agent-lite://done")?.({
        payload: makeTask({ status: "completed", title: "Finished chat" }),
      });
      resolveRefresh(makeTask({ status: "failed", title: "Outdated history" }));
    });
    expect(screen.getByText("Finished chat")).toBeInTheDocument();
    expect(screen.queryByText("Outdated history")).toBeNull();
  });

  it("uses the chosen app language for greetings and suggested messages", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    vi.spyOn(Date.prototype, "getHours").mockReturnValue(10);
    applyLocale("fr");
    const user = userEvent.setup();
    render(<AgentSessionScreen />);
    expect(screen.getByText("Bonjour")).toBeInTheDocument();
    const suggestion = screen.getByRole("button", { name: "Résume ma dernière réunion" });
    await user.click(suggestion);
    expect(screen.getByRole("textbox")).toHaveValue("Résume ma dernière réunion");
    expect(screen.queryByText("Good morning")).toBeNull();
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
  });

  it("translates resumed activity and dynamic archived counts into French", async () => {
    applyLocale("fr");
    tauriMocks.getAgentTask.mockResolvedValue(
      makeTask({
        status: "running",
        messages: [
          {
            id: "m1",
            taskId: "task-1",
            role: "user",
            content: "Question",
            createdAt: "2026-09-05T00:00:00Z",
          },
        ],
      }),
    );
    const { unmount } = render(<AgentSessionScreen sessionId="task-1" />);
    expect(await screen.findByText("Réflexion en cours")).toBeInTheDocument();
    unmount();
    tauriMocks.listSessionFolders.mockResolvedValue([{ sessionId: "task-1", folderId: "archive" }]);
    render(
      <AgentScreen
        onOpenSession={vi.fn()}
        archiveFolderId="archive"
        ensureArchiveFolder={async () => "archive"}
      />,
    );
    expect(await screen.findByRole("button", { name: "Archivées (1)" })).toBeInTheDocument();
  });
});
