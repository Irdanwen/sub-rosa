import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, AgentSessionDto } from "../lib/agent-runtime-contract";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  runtimeListener: undefined as ((event: { payload: AgentRuntimeEvent }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => path),
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(
    async (_name: string, listener: (event: { payload: AgentRuntimeEvent }) => void) => {
      mocks.runtimeListener = listener;
      return vi.fn();
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { AgentWorkspace } from "../components/agent/AgentWorkspace";
import { markAgentNewSessionPending } from "../components/agent/session-persistence";
import { agentComposerClearance } from "../components/agent/composer/layout";
import { AGENT_NEW_SESSION_EVENT } from "../lib/agent-events";

const session: AgentSessionDto = {
  id: "session-1",
  title: "Existing session",
  status: "idle",
  model: "fast",
  safetyMode: "sandboxed",
  workspacePath: "/tmp/session-1",
  source: "user",
  createdAt: "2026-07-22T12:00:00Z",
  updatedAt: "2026-07-22T12:00:00Z",
};

const newSession: AgentSessionDto = {
  ...session,
  id: "session-2",
  title: "Fresh request",
  workspacePath: "/tmp/session-2",
};

describe("AgentWorkspace runtime wiring", () => {
  beforeEach(() => {
    mocks.runtimeListener = undefined;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "list_agent_sessions") return Promise.resolve([session]);
      if (command === "get_agent_session") return Promise.resolve(session);
      if (command === "list_agent_items") {
        return Promise.resolve([
          {
            id: "message-1",
            sessionId: session.id,
            sequence: 1,
            createdAt: session.createdAt,
            kind: "message",
            role: "assistant",
            text: "Earlier answer",
            status: "complete",
          },
        ]);
      }
      if (command === "list_agent_artifacts") return Promise.resolve([]);
      if (command === "list_agent_skills") {
        return Promise.resolve([
          {
            id: "notes",
            name: "Notes",
            description: "Work with June notes.",
            source: "managed",
            enabled: true,
            editable: true,
          },
          {
            id: "disabled",
            name: "Disabled",
            description: "Disabled skill.",
            source: "managed",
            enabled: false,
            editable: true,
          },
        ]);
      }
      if (command === "list_venice_models") {
        return Promise.resolve({
          mode: "generation",
          selectedModel: "open-software/auto",
          modelType: "text",
          models: [
            {
              provider: "june",
              id: "fast",
              name: "Fast",
              modelType: "text",
              traits: [],
              capabilities: ["tools"],
              privacy: "private",
              contextTokens: 200_000,
              inputCreditsPerMillionTokens: 2_000,
              outputCreditsPerMillionTokens: 4_000,
            },
          ],
        });
      }
      if (command === "create_agent_session") return Promise.resolve(newSession);
      if (command === "start_agent_run") {
        return Promise.resolve({
          id: "run-1",
          sessionId: session.id,
          status: "running",
          model: "auto",
        });
      }
      return Promise.resolve(undefined);
    });
  });

  it("reserves the overlap between the transcript and fixed composer", () => {
    expect(agentComposerClearance(800, 620)).toBe(180);
    expect(agentComposerClearance(600, 620)).toBe(0);
  });

  it("hydrates history, shows an optimistic turn, and cancels", async () => {
    const user = userEvent.setup();
    const { container } = render(<AgentWorkspace initialSession={session} />);

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sandboxed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model: Fast" })).toBeEnabled();
    expect(container.querySelector(".agent-scroll .agent-main > .agent-composer")).not.toBeNull();
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.click(composer);
    await user.type(composer, "New request");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("New request")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("start_agent_run", {
        request: expect.objectContaining({
          model: "fast",
          safetyMode: "sandboxed",
          enabledSkillIds: ["notes"],
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Model: Fast" })).not.toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop June" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_agent_run", { runId: "run-1" }),
    );

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-cancelled",
          sessionId: session.id,
          runId: "run-1",
          sequence: 3,
          method: "run.cancelled",
          data: { completedAt: "2026-07-22T12:01:00Z" },
        },
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Model: Fast" })).toBeEnabled());
  });

  it("shows context, estimated charge, and per-tool usage for the latest run", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.type(composer, "Use a tool");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("start_agent_run", expect.anything()),
    );
    await screen.findByRole("button", { name: "Stop June" });

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "tool-start",
          sessionId: session.id,
          runId: "run-1",
          sequence: 2,
          method: "tool.started",
          data: {
            itemId: "tool-item-1",
            callId: "call-1",
            name: "read_file",
            arguments: { path: "notes.md" },
            createdAt: "2026-07-25T12:00:01Z",
          },
        },
      });
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "usage",
          sessionId: session.id,
          runId: "run-1",
          sequence: 3,
          method: "usage.updated",
          data: {
            inputTokens: 10_000,
            outputTokens: 2_000,
            totalTokens: 12_000,
            provider: "phala",
            privacyLevel: "tee",
            endpoint: "phala-glm-5.2",
          },
        },
      });
    });

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));
    const usagePanel = screen.getByLabelText("Session usage");
    expect(usagePanel).toHaveTextContent("10,000 of 200,000 (5.0%)");
    expect(usagePanel).toHaveTextContent("28 credits (about $0.0280)");
    expect(usagePanel).toHaveTextContent("read_file");
    expect(usagePanel).toHaveTextContent("1 call");
    expect(usagePanel).toHaveTextContent("phala");
    expect(usagePanel).toHaveTextContent("tee");
    expect(usagePanel).toHaveTextContent("phala-glm-5.2");
  });

  it("shows route-only persisted usage without crashing", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_agent_sessions") return [session];
      if (command === "get_agent_session") return session;
      if (command === "list_agent_items") {
        return [
          {
            id: "message-route-only",
            sessionId: session.id,
            sequence: 1,
            createdAt: session.createdAt,
            kind: "message",
            role: "assistant",
            text: "Earlier answer",
            status: "complete",
          },
        ];
      }
      if (command === "list_agent_artifacts") return [];
      if (command === "get_latest_agent_run") {
        return {
          id: "run-route-only",
          sessionId: session.id,
          status: "completed",
          model: "zai-org-glm-5-2",
          usage: {
            provider: "qa-fixture",
            privacyLevel: "isolated",
            endpoint: "localhost",
          },
        };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));

    const usagePanel = screen.getByLabelText("Session usage");
    expect(usagePanel).toHaveTextContent("qa-fixture");
    expect(usagePanel).toHaveTextContent("isolated");
    expect(usagePanel).toHaveTextContent("localhost");
    expect(usagePanel).toHaveTextContent("Token counts were not reported for this request.");
  });

  it("steers an active run at the next model boundary and retires the fallback queue", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");

    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.type(composer, "Start the analysis");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop June" })).toBeVisible());

    const activeComposer = screen.getByRole("textbox", { name: "Message June" });
    activeComposer.textContent = "Use the launch plan";
    fireEvent.input(activeComposer);
    await user.click(await screen.findByRole("button", { name: "Queue follow-up" }));

    const steerCall = mocks.invoke.mock.calls.find(([command]) => command === "steer_agent_run");
    expect(steerCall?.[1]).toMatchObject({
      runId: "run-1",
      text: "Use the launch plan",
      messageId: expect.any(String),
    });
    expect(screen.getByText("Queued follow-up")).toBeVisible();

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-steering",
          sessionId: session.id,
          runId: "run-1",
          sequence: 3,
          method: "steering.consumed",
          data: {
            itemId: "steering-1",
            messageId: String((steerCall?.[1] as { messageId?: string })?.messageId),
            text: "Use the launch plan",
            createdAt: "2026-07-22T12:01:00Z",
          },
        },
      });
    });

    expect(await screen.findByText("Steering: Use the launch plan")).toBeVisible();
    expect(screen.queryByText("Queued follow-up")).not.toBeInTheDocument();
  });

  it("submits an unconsumed live instruction as the next run after settlement", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");

    let composer = screen.getByRole("textbox", { name: "Message June" });
    await user.type(composer, "Start the analysis");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop June" })).toBeVisible());

    composer = screen.getByRole("textbox", { name: "Message June" });
    composer.textContent = "Send this next";
    fireEvent.input(composer);
    await user.click(await screen.findByRole("button", { name: "Queue follow-up" }));

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-completed",
          sessionId: session.id,
          runId: "run-1",
          sequence: 3,
          method: "run.completed",
          data: { completedAt: "2026-07-22T12:01:00Z" },
        },
      });
    });

    await waitFor(() => {
      const starts = mocks.invoke.mock.calls.filter(([command]) => command === "start_agent_run");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.[1]).toMatchObject({
        request: expect.objectContaining({ prompt: "Send this next" }),
      });
    });
  });

  it("resolves clarification interruptions through the typed host command", async () => {
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-2",
          sessionId: session.id,
          runId: "run-2",
          sequence: 2,
          method: "interruption.requested",
          data: {
            itemId: "clarify-item",
            interruption: {
              id: "clarify-1",
              kind: "clarification",
              sessionId: session.id,
              runId: "run-2",
              status: "pending",
              createdAt: "2026-07-22T12:00:02Z",
              question: "Which project?",
              choices: ["June", "Platform"],
            },
          },
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /June/ }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("resolve_agent_interruption", {
        request: {
          interruptionId: "clarify-1",
          resolution: { kind: "clarification", answer: "June" },
        },
      }),
    );
  });

  it("presents retryable runtime failures as a retry action and resumes through the typed host command", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "list_agent_sessions") return Promise.resolve([session]);
      if (command === "get_agent_session") return Promise.resolve(session);
      if (command === "list_agent_items") {
        return Promise.resolve([
          {
            id: "message-1",
            sessionId: session.id,
            runId: "run-failed",
            sequence: 1,
            createdAt: session.createdAt,
            kind: "message",
            role: "user",
            text: "Retry this",
            status: "complete",
          },
          {
            id: "error-1",
            sessionId: session.id,
            runId: "run-failed",
            sequence: 2,
            createdAt: session.updatedAt,
            kind: "error",
            message: "upstream_provider_failed",
            retryable: true,
          },
        ]);
      }
      if (command === "list_agent_artifacts") return Promise.resolve([]);
      if (command === "list_agent_skills") return Promise.resolve([]);
      if (command === "list_venice_models") {
        return Promise.resolve({ mode: "generation", models: [] });
      }
      if (command === "retry_agent_run") {
        return Promise.resolve({
          id: "run-retry",
          sessionId: session.id,
          status: "running",
          model: "fast",
        });
      }
      return Promise.resolve(undefined);
    });

    render(<AgentWorkspace initialSession={session} />);

    expect(await screen.findByText("June could not complete this request.")).toBeVisible();
    expect(screen.queryByText("upstream_provider_failed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("retry_agent_run", { runId: "run-failed" }),
    );
  });

  it("resets an open conversation when a new session is requested", async () => {
    const user = userEvent.setup();
    const onSessionSelected = vi.fn();
    const { container } = render(
      <AgentWorkspace initialSession={session} onSessionSelected={onSessionSelected} />,
    );
    await screen.findByText("Earlier answer");

    act(() => {
      markAgentNewSessionPending();
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });

    expect(await screen.findByRole("heading", { level: 2 })).toBeVisible();
    expect(screen.queryByText("Earlier answer")).not.toBeInTheDocument();
    expect(onSessionSelected).toHaveBeenLastCalledWith(undefined);
    expect(
      container.querySelector(".agent-workspace > .agent-main[data-hero='true']"),
    ).not.toBeNull();
    expect(container.querySelector(".agent-scroll")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add files or notes" }));
    expect(screen.getByRole("menuitem", { name: "Attach files" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Reference a note" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add files or notes" }));

    await user.click(screen.getByRole("button", { name: "Sandboxed" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Unrestricted/ }));
    expect(screen.getByRole("dialog", { name: "Turn on Unrestricted?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.click(composer);
    await user.type(composer, "Fresh request");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("create_agent_session", {
        request: expect.objectContaining({ title: "Fresh request" }),
      }),
    );
    expect(onSessionSelected).toHaveBeenLastCalledWith(newSession);
  });

  it("uses the priced June Auto model id for a fresh workspace", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.click(composer);
    await user.type(composer, "Fresh request");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("create_agent_session", {
        request: expect.objectContaining({
          model: "open-software/auto",
          title: "Fresh request",
        }),
      }),
    );
  });

  it("keeps explicit Venice BYOK text available when June credits are unavailable", async () => {
    const user = userEvent.setup();
    const veniceSession = { ...session, model: "venice-text" };
    const defaultInvoke = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "list_agent_sessions") return Promise.resolve([veniceSession]);
      if (command === "get_agent_session") return Promise.resolve(veniceSession);
      if (command === "list_venice_models") {
        return Promise.resolve({
          mode: "generation",
          selectedModel: "venice-text",
          modelType: "text",
          models: [
            {
              provider: "venice",
              id: "venice-text",
              name: "Venice text",
              modelType: "text",
              traits: [],
              capabilities: ["tool-calling"],
              privacy: "private",
              contextTokens: 128_000,
            },
          ],
        });
      }
      if (command === "provider_model_settings") {
        return Promise.resolve({ effectiveSettings: { veniceApiKeyConfigured: true } });
      }
      return defaultInvoke?.(command, args);
    });

    render(
      <AgentWorkspace
        initialSession={veniceSession}
        creditActionsDisabledReason="Add credits to continue"
      />,
    );
    await screen.findByText("Earlier answer");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "Use my Venice key");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("start_agent_run", {
        request: expect.objectContaining({ model: "venice-text" }),
      }),
    );
  });
});
