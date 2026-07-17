import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionScreen } from "../components/mobile/screens/AgentScreen";
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
  createAgentTask: vi.fn(),
  sendAgentMessage: vi.fn(),
  agentLiteRun: vi.fn(),
  setAgentTaskModel: vi.fn(),
  forkAgentTask: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
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
  beforeEach(() => {
    for (const mock of Object.values(tauriMocks)) mock.mockReset();
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
});
