import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionScreen } from "../components/mobile/screens/AgentScreen";
import { applyLocale } from "../lib/i18n";
import type { MediaModel } from "../lib/studio/types";
import type { AgentMessageDto, AgentTaskDto } from "../lib/tauri";

// One model that honours a reasoning effort (and publishes its window), one
// that does not.
const MODELS: MediaModel[] = [
  {
    id: "thinker",
    mediaType: "text",
    name: "Thinker",
    offline: false,
    supportsReasoningEffort: true,
    contextTokens: 8_000,
  },
  { id: "plain", mediaType: "text", name: "Plain", offline: false },
];

const tauriMocks = vi.hoisted(() => ({
  getAgentTask: vi.fn(),
  listAgentTasks: vi.fn(),
  listSessionFolders: vi.fn(),
  createAgentTask: vi.fn(),
  sendAgentMessage: vi.fn(),
  agentLiteRun: vi.fn(),
  setAgentTaskModel: vi.fn(),
  forkAgentTask: vi.fn(),
}));
const controlMocks = vi.hoisted(() => ({
  agentLiteCancel: vi.fn(),
  agentLiteRegenerate: vi.fn(),
  agentLiteEditLast: vi.fn(),
  agentLiteEditBranch: vi.fn(),
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
vi.mock("../lib/notifications", () => ({ ensureNotificationPermission: vi.fn() }));
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
vi.mock("../lib/chat-titles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chat-titles")>()),
  renameAgentTask: vi.fn(),
  onChatTitle: () => () => undefined,
}));
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  ...tauriMocks,
}));
// The model the backend runs a chat on when the chat names none.
const defaultChatModel = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock("../lib/default-chat-model", () => ({
  useDefaultChatModelId: () => defaultChatModel.id,
}));
vi.mock("../lib/agent-lite-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agent-lite-controls")>()),
  ...controlMocks,
}));

function message(id: string, role: AgentMessageDto["role"], content: string): AgentMessageDto {
  return { id, taskId: "task-1", role, content, createdAt: "2026-10-07T00:00:00Z" };
}

const THREAD = [
  message("q1", "user", "First question"),
  message("a1", "assistant", "First answer"),
  message("q2", "user", "Second question"),
  message("a2", "assistant", "Second answer"),
];

function makeTask(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: "task-1",
    title: "A chat",
    prompt: "First question",
    status: "completed",
    safetyProfile: "autonomousPrivate",
    messages: THREAD,
    toolEvents: [],
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile chat controls", () => {
  afterEach(() => {
    applyLocale("en");
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    for (const mock of [...Object.values(tauriMocks), ...Object.values(controlMocks)]) {
      mock.mockReset();
    }
    eventListeners.clear();
    tauriMocks.listSessionFolders.mockResolvedValue([]);
    tauriMocks.getAgentTask.mockResolvedValue(makeTask());
    tauriMocks.setAgentTaskModel.mockResolvedValue(makeTask());
    tauriMocks.sendAgentMessage.mockResolvedValue(makeTask());
    localStorage.clear();
    defaultChatModel.id = undefined;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("stops a reply being written and keeps what it had said", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(makeTask({ messages: THREAD.slice(0, 2) }));
    const run = deferred<AgentTaskDto>();
    tauriMocks.agentLiteRun.mockReturnValue(run.promise);
    controlMocks.agentLiteCancel.mockResolvedValue(makeTask({ status: "running" }));
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("First answer");

    await user.type(screen.getByPlaceholderText("Ask anything, privately…"), "Second question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Stop reply" }));
    expect(controlMocks.agentLiteCancel).toHaveBeenCalledWith("task-1");

    // The turn saves the partial reply, marks the chat stopped and the run
    // resolves with it: no error, and the composer is back.
    await act(async () => {
      run.resolve(
        makeTask({
          status: "cancelled",
          messages: [...THREAD.slice(0, 3), message("a2", "assistant", "Half an")],
        }),
      );
    });
    expect(await screen.findByText("Half an")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop reply" })).toBeNull();
  });

  it("regenerates only the last reply, on the model chosen now", async () => {
    const regenerated = deferred<AgentTaskDto>();
    controlMocks.agentLiteRegenerate.mockReturnValue(regenerated.promise);
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");

    const regenerate = screen.getAllByRole("button", { name: "Regenerate reply" });
    expect(regenerate).toHaveLength(1);
    await user.click(regenerate[0]);

    expect(controlMocks.agentLiteRegenerate).toHaveBeenCalledWith("task-1", {
      model: undefined,
      reasoningEffort: undefined,
    });
    // The replaced answer leaves at once.
    await waitFor(() => expect(screen.queryByText("Second answer")).toBeNull());
    expect(screen.getByRole("button", { name: "Stop reply" })).toBeInTheDocument();
    expect(screen.getByText("First answer")).toBeInTheDocument();
    await act(async () => {
      regenerated.resolve(
        makeTask({ messages: [...THREAD.slice(0, 3), message("a3", "assistant", "Better")] }),
      );
    });
    // Running while it regenerated; done once the new answer is saved.
    expect(screen.queryByRole("button", { name: "Stop reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
  });

  it("edits the last question in place", async () => {
    controlMocks.agentLiteEditLast.mockResolvedValue(makeTask());
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");

    const edits = screen.getAllByRole("button", { name: "Edit message" });
    await user.click(edits[1]);
    expect(screen.getByText("Editing your message")).toBeInTheDocument();
    const field = screen.getByPlaceholderText("Ask anything, privately…");
    expect(field).toHaveValue("Second question");
    await user.clear(field);
    await user.type(field, "Second question, better");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(controlMocks.agentLiteEditLast).toHaveBeenCalledWith({
      taskId: "task-1",
      messageId: "q2",
      content: "Second question, better",
      model: undefined,
      attachments: undefined,
      reasoningEffort: undefined,
    });
    expect(controlMocks.agentLiteEditBranch).not.toHaveBeenCalled();
  });

  it("edits an earlier question in a new chat", async () => {
    controlMocks.agentLiteEditBranch.mockResolvedValue(makeTask({ id: "task-2" }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" onOpenSession={onOpenSession} />);
    await screen.findByText("Second answer");

    await user.click(screen.getAllByRole("button", { name: "Edit message" })[0]);
    expect(screen.getByText("Editing an earlier message opens a new chat")).toBeInTheDocument();
    const field = screen.getByPlaceholderText("Ask anything, privately…");
    await user.type(field, " again");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("task-2"));
    expect(controlMocks.agentLiteEditBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        messageId: "q1",
        content: "First question again",
      }),
    );
    expect(controlMocks.agentLiteEditLast).not.toHaveBeenCalled();
  });

  it("cancels an edit without sending anything", async () => {
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");
    await user.click(screen.getAllByRole("button", { name: "Edit message" })[1]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByPlaceholderText("Ask anything, privately…")).toHaveValue("");
    expect(screen.queryByText("Editing your message")).toBeNull();
  });

  it("branches the chat from a reply and opens the branch", async () => {
    tauriMocks.forkAgentTask.mockResolvedValue(makeTask({ id: "task-3" }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" onOpenSession={onOpenSession} />);
    await screen.findByText("Second answer");

    await user.click(screen.getAllByRole("button", { name: "Branch from here" })[0]);
    expect(tauriMocks.forkAgentTask).toHaveBeenCalledWith({
      sourceTaskId: "task-1",
      upToMessageId: "a1",
    });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("task-3"));
  });

  it("offers a reasoning effort only for a model that honours one, and sends it", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(makeTask({ model: "plain" }));
    tauriMocks.agentLiteRun.mockResolvedValue(makeTask());
    const user = userEvent.setup();
    render(<AgentSessionScreen sessionId="task-1" />);
    const modelButton = await screen.findByRole("button", { name: /^Choose model/ });
    await waitFor(() => expect(modelButton).toHaveTextContent("Plain"));

    await user.click(modelButton);
    let sheet = await screen.findByRole("dialog", { name: "Chat model" });
    expect(within(sheet).queryByRole("group", { name: "Reasoning effort" })).toBeNull();
    await user.click(within(sheet).getByText("Thinker"));

    await user.click(modelButton);
    sheet = await screen.findByRole("dialog", { name: "Chat model" });
    const efforts = within(sheet).getByRole("group", { name: "Reasoning effort" });
    await user.click(within(efforts).getByRole("button", { name: "High effort" }));
    expect(localStorage.getItem("subrosa:mobile:chat-reasoning-effort")).toBe("high");
    await user.click(within(sheet).getByText("Thinker"));

    await user.type(screen.getByPlaceholderText("Ask anything, privately…"), "Think hard");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(tauriMocks.agentLiteRun).toHaveBeenCalledWith("task-1", "thinker", undefined, "high"),
    );
  });

  it("offers read aloud and thumbs on each reply, and export in the header", async () => {
    render(<AgentSessionScreen sessionId="task-1" />);
    const reply = (await screen.findByText("First answer")).closest(".mobile-chat-bubble");
    for (const name of ["Read aloud", "Good reply", "Bad reply"]) {
      expect(within(reply as HTMLElement).getByRole("button", { name })).toBeInTheDocument();
    }
    const question = screen.getByText("First question").closest(".mobile-chat-bubble");
    expect(
      within(question as HTMLElement).queryByRole("button", { name: "Read aloud" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Export chat" })).toBeInTheDocument();
  });

  it("shows how full the conversation is against the model's window", async () => {
    tauriMocks.getAgentTask.mockResolvedValue(makeTask({ model: "thinker" }));
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");
    // 4,000 tokens of allowance plus the thread, against an 8K window.
    expect(
      await screen.findByRole("button", { name: /^About 4K of 8K tokens used$/ }),
    ).toBeInTheDocument();
  });

  it("reads the window of the model the backend uses when the chat is on Default", async () => {
    // Not the app's built-in default: the person chose another one in Settings.
    defaultChatModel.id = "thinker";
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");
    expect(
      await screen.findByRole("button", { name: /^About 4K of 8K tokens used$/ }),
    ).toBeInTheDocument();
  });

  it("draws no gauge while the default model is not known", async () => {
    render(<AgentSessionScreen sessionId="task-1" />);
    await screen.findByText("Second answer");
    expect(screen.queryByRole("button", { name: /tokens used$/ })).toBeNull();
  });

  it("puts files shared in from another app in the composer, unsent", async () => {
    const used = vi.fn();
    const shared = [{ kind: "text" as const, name: "report.pdf", data: "Quarterly figures" }];
    render(<AgentSessionScreen initialAttachments={shared} onInitialAttachmentsUsed={used} />);
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(used).toHaveBeenCalledTimes(1);
    expect(tauriMocks.agentLiteRun).not.toHaveBeenCalled();
    expect(tauriMocks.createAgentTask).not.toHaveBeenCalled();
  });
});
