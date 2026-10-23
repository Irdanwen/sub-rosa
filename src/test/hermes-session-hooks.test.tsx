// The hooks a Hermes surface drives a session with (src/lib/hermes-control-plane/use-*.ts).
// The chat consumes them and its own suites cover the rendered behaviour; these
// pin the contract a second surface relies on: a subscription that outlives
// the turn, the runtime as the only authority that ends a run (ADR-0016), a
// streamed delta buffered to the next frame, the session-gone replay, and the
// steer delivery guarantee.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_STATUS_EVENT } from "../lib/agent-events";
import {
  type HermesGatewayClient,
  HermesGatewayError,
  type HermesGatewayEvent,
} from "../lib/hermes-gateway";
import { sessionRuntimeGoneMessage } from "../lib/hermes-control-plane/session-errors";
import {
  useHermesGateways,
  type HermesGatewaysOptions,
} from "../lib/hermes-control-plane/use-hermes-gateways";
import {
  agentStatusFromHermesEvent,
  useSessionActivity,
  useSessionRunReconciler,
} from "../lib/hermes-control-plane/use-session-activity";
import { useSessionApprovals } from "../lib/hermes-control-plane/use-session-approvals";
import { useSessionCommands } from "../lib/hermes-control-plane/use-session-commands";
import {
  type SessionStreamOptions,
  useLiveEventBuffer,
  useSessionStream,
} from "../lib/hermes-control-plane/use-session-stream";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

type RequestHandler = (method: string, params: Record<string, unknown>) => unknown;

/** A gateway stand-in: frames are pushed by the test, requests answered by a handler. */
function fakeGateway(handler: RequestHandler = () => ({})) {
  const listeners = new Set<(event: HermesGatewayEvent) => void>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const gateway = {
    onEvent(listener: (event: HermesGatewayEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      return handler(method, params);
    },
  };
  return {
    client: gateway as unknown as HermesGatewayClient,
    requests,
    listenerCount: () => listeners.size,
    emit(event: HermesGatewayEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const notRunningBridge = { running: false } as HermesGatewaysOptions["bridge"];

/** The whole set of hooks, wired the way a surface wires them. */
function useHarness(
  gateway: HermesGatewayClient,
  callbacks: Partial<
    Pick<SessionStreamOptions, "onTurnCompleted" | "onTurnEnded" | "onUnconsumedSteers">
  > = {},
) {
  const buffer = useLiveEventBuffer({ storedMessages: () => [] });
  const activity = useSessionActivity();
  const gateways = useHermesGateways({
    bridge: notRunningBridge,
    startBridge: async () => notRunningBridge,
  });
  const refreshSession = vi.fn(async () => true);
  const stream = useSessionStream({
    activity,
    buffer,
    gateways,
    refreshSession,
    sessionTitle: () => "Session",
    ...callbacks,
  });
  return { buffer, activity, gateways, stream, refreshSession, gateway };
}

let statuses: Array<{ sessionId?: string; status?: string; summary?: string }>;
function recordStatus(event: Event) {
  statuses.push((event as CustomEvent).detail);
}

beforeEach(() => {
  statuses = [];
  window.addEventListener(AGENT_SESSION_STATUS_EVENT, recordStatus);
});

afterEach(() => {
  window.removeEventListener(AGENT_SESSION_STATUS_EVENT, recordStatus);
  vi.useRealTimers();
});

describe("useSessionActivity", () => {
  it("keeps a session inside a tool call until every started call completes", () => {
    const { result } = renderHook(() => useSessionActivity());
    const start = { type: "tool.start", payload: { tool_id: "a" } };
    act(() => {
      result.current.updateSessionToolCallActivity("s1", start, "start");
      result.current.updateSessionToolCallActivity("s1", start, "start");
    });
    expect(result.current.toolCallSessionIds.has("s1")).toBe(true);
    let open = true;
    act(() => {
      open = result.current.updateSessionToolCallActivity(
        "s1",
        { type: "tool.complete", payload: { tool_id: "a" } },
        "complete",
      );
    });
    expect(open).toBe(true);
    act(() => {
      open = result.current.updateSessionToolCallActivity(
        "s1",
        { type: "tool.complete", payload: { tool_id: "a" } },
        "complete",
      );
    });
    expect(open).toBe(false);
    expect(result.current.toolCallSessionIds.has("s1")).toBe(false);
  });

  it("does not hand out a new set when a flag does not change", () => {
    const { result } = renderHook(() => useSessionActivity());
    act(() => result.current.setSessionWorking("s1", true));
    const working = result.current.workingSessionIds;
    act(() => result.current.setSessionWorking("s1", true));
    expect(result.current.workingSessionIds).toBe(working);
  });

  it("clears a session and reports what is still active elsewhere", () => {
    const { result } = renderHook(() =>
      useSessionActivity({ workingSessionIds: ["s1", "s2"], waitingSessionIds: ["s3"] }),
    );
    let counts: { activeCount: number; needsUserCount: number } | undefined;
    act(() => {
      counts = result.current.clearSessionActivity("s1");
    });
    expect(counts).toEqual({ activeCount: 2, needsUserCount: 1 });
    expect(result.current.isSessionBusy("s1")).toBe(false);
    expect(result.current.isSessionBusy("s3")).toBe(true);
  });

  it("moves the flags of a provisional session to its stored id", () => {
    const { result } = renderHook(() => useSessionActivity({ workingSessionIds: ["draft"] }));
    act(() => result.current.moveSessionActivity("draft", "stored"));
    expect([...result.current.workingSessionIds]).toEqual(["stored"]);
  });

  it("maps frames to the session status they imply", () => {
    expect(agentStatusFromHermesEvent({ type: "approval.request" })).toBe("waitingForUser");
    expect(agentStatusFromHermesEvent({ type: "tool.progress" })).toBe("running");
    expect(agentStatusFromHermesEvent({ type: "message.complete" })).toBe("completed");
    expect(agentStatusFromHermesEvent({ type: "error" })).toBe("failed");
    expect(agentStatusFromHermesEvent({ type: "message.delta" })).toBeUndefined();
  });
});

describe("useLiveEventBuffer", () => {
  it("buffers a streamed delta to the next frame and flushes anything else", () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      return window.setTimeout(() => callback(0), 16) as unknown as number;
    });
    const { result } = renderHook(() => useLiveEventBuffer({ storedMessages: () => [] }));
    act(() => {
      result.current.appendLiveEvent("s1", {
        type: "message.delta",
        payload: { text: "Hel" },
        receivedAt: new Date().toISOString(),
      });
    });
    // The ref has the frame at once; the render waits for the animation frame.
    expect(result.current.liveEventsRef.current.s1).toHaveLength(1);
    expect(result.current.liveEvents.s1).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current.liveEvents.s1).toHaveLength(1);
    act(() => {
      result.current.pushLiveEvent("s1", { type: "approval.response", payload: {} });
    });
    expect(result.current.liveEvents.s1).toHaveLength(2);
    raf.mockRestore();
  });
});

describe("useSessionStream", () => {
  it("keeps the subscription after the turn ends, so a turn the gateway starts is seen", () => {
    const fake = fakeGateway();
    const onTurnCompleted = vi.fn();
    const onTurnEnded = vi.fn();
    const { result } = renderHook(() => useHarness(fake.client, { onTurnCompleted, onTurnEnded }));
    act(() => {
      result.current.stream.attachSessionEventListener({
        gateway: fake.client,
        runtimeSessionId: "rt-1",
        sessionDisplayTitle: "Session",
        storedSessionId: "s1",
      });
    });

    act(() => fake.emit({ type: "message.start", session_id: "rt-1" }));
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);

    // A frame for another session is not this session's.
    act(() => fake.emit({ type: "approval.request", session_id: "other" }));
    expect(result.current.activity.waitingSessionIds.has("s1")).toBe(false);

    act(() => fake.emit({ type: "message.complete", session_id: "rt-1" }));
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(false);
    expect(onTurnCompleted).toHaveBeenCalledWith("s1");
    expect(onTurnEnded).toHaveBeenCalledWith("s1");
    expect(statuses.at(-1)).toMatchObject({ sessionId: "s1", status: "completed" });

    // ADR-0016: a background job finishing chains a turn on its own.
    act(() => fake.emit({ type: "message.start", session_id: "rt-1" }));
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);
    expect(fake.listenerCount()).toBe(1);
  });

  it("replaces the previous subscription instead of stacking a second one", () => {
    const fake = fakeGateway();
    const { result } = renderHook(() => useHarness(fake.client));
    const attach = () =>
      result.current.stream.attachSessionEventListener({
        gateway: fake.client,
        runtimeSessionId: "rt-1",
        sessionDisplayTitle: "Session",
        storedSessionId: "s1",
      });
    act(() => {
      attach();
      attach();
    });
    expect(fake.listenerCount()).toBe(1);
    act(() => fake.emit({ type: "status.update", session_id: "rt-1", payload: {} }));
    expect(result.current.buffer.liveEventsRef.current.s1).toHaveLength(1);
  });

  it("hands back a steer no tool drained, and drops one a tool consumed", () => {
    const fake = fakeGateway();
    const onUnconsumedSteers = vi.fn();
    const { result } = renderHook(() => useHarness(fake.client, { onUnconsumedSteers }));
    act(() => {
      result.current.stream.attachSessionEventListener({
        gateway: fake.client,
        runtimeSessionId: "rt-1",
        sessionDisplayTitle: "Session",
        storedSessionId: "s1",
      });
    });
    const consumed = result.current.stream.recordPendingSteer("s1", "use the tests");
    result.current.stream.recordPendingSteer("s1", "and the docs");
    consumed.accepted = true;
    act(() => fake.emit({ type: "tool.complete", session_id: "rt-1", payload: { tool_id: "t" } }));
    // Only the first was accepted by Hermes, so only it was drained.
    act(() => fake.emit({ type: "message.complete", session_id: "rt-1" }));
    expect(onUnconsumedSteers).toHaveBeenCalledWith("s1", "and the docs");
  });

  it("drops pending steers when the turn fails", () => {
    const fake = fakeGateway();
    const onUnconsumedSteers = vi.fn();
    const { result } = renderHook(() => useHarness(fake.client, { onUnconsumedSteers }));
    act(() => {
      result.current.stream.attachSessionEventListener({
        gateway: fake.client,
        runtimeSessionId: "rt-1",
        sessionDisplayTitle: "Session",
        storedSessionId: "s1",
      });
    });
    result.current.stream.recordPendingSteer("s1", "never mind");
    act(() => fake.emit({ type: "error", session_id: "rt-1", payload: { message: "boom" } }));
    expect(onUnconsumedSteers).not.toHaveBeenCalled();
    expect(result.current.stream.pendingSteerBySessionIdRef.current.s1).toBeUndefined();
  });
});

describe("useHermesGateways", () => {
  it("reuses the memoized runtime id, resumes otherwise, and forgets a dead one", async () => {
    let resumeAnswer: () => unknown = () => ({ session_id: "rt-2" });
    const fake = fakeGateway((method) => {
      if (method === "session.resume") return resumeAnswer();
      return {};
    });
    const { result } = renderHook(() =>
      useHermesGateways({
        bridge: notRunningBridge,
        startBridge: async () => notRunningBridge,
        initialRuntimeSessionIds: { s1: "rt-1" },
      }),
    );

    await expect(result.current.resolveRuntimeSession("s1", fake.client)).resolves.toMatchObject({
      runtimeSessionId: "rt-1",
    });
    expect(fake.requests).toHaveLength(0);

    let resolved: { runtimeSessionId: string } | undefined;
    await act(async () => {
      resolved = await result.current.resolveRuntimeSession("s1", fake.client, {
        forceRefresh: true,
      });
    });
    expect(resolved?.runtimeSessionId).toBe("rt-2");
    expect(result.current.runtimeSessionIds.s1).toBe("rt-2");

    resumeAnswer = () => {
      throw new Error("Hermes API returned 404: Session not found");
    };
    let failure: unknown;
    await act(async () => {
      failure = await result.current
        .resolveRuntimeSession("s1", fake.client, { forceRefresh: true })
        .catch((err: unknown) => err);
    });
    expect((failure as Error).message).toBe(sessionRuntimeGoneMessage());
    expect(result.current.runtimeSessionIds.s1).toBeUndefined();
  });
});

describe("useSessionRunReconciler", () => {
  function useReconciler(
    snapshot: () => { live: Set<string>; reachableModes: Set<boolean> },
    transcriptDone = false,
  ) {
    const activity = useSessionActivity({ workingSessionIds: ["s1"] });
    const reconciler = useSessionRunReconciler({
      activity,
      liveRuntimeSessionsForModes: async () => snapshot(),
      runtimeSnapshotHasSession: (current, sessionId) => current.live.has(sessionId),
      liveErrorsOfCurrentTurn: () => [],
      transcript: () =>
        transcriptDone
          ? [
              { id: "u", role: "user", content: "hi" },
              { id: "a", role: "assistant", content: "hello" },
            ]
          : [],
      sessionTitle: () => "Session",
      pollEnabled: false,
      refreshSession: async () => true,
    });
    return { activity, reconciler };
  }

  it("ends a run only after the runtime has missed it twice", async () => {
    const { result } = renderHook(() =>
      useReconciler(() => ({ live: new Set(), reachableModes: new Set([false]) })),
    );
    await act(async () => {
      await result.current.reconciler.reconcileWorkingSessionsAgainstRuntime();
    });
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);
    await act(async () => {
      await result.current.reconciler.reconcileWorkingSessionsAgainstRuntime();
    });
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ sessionId: "s1", status: "completed" });
  });

  it("keeps a run the runtime still lists", async () => {
    const { result } = renderHook(() =>
      useReconciler(() => ({ live: new Set(["s1"]), reachableModes: new Set([false]) })),
    );
    for (let poll = 0; poll < 3; poll += 1) {
      await act(async () => {
        await result.current.reconciler.reconcileWorkingSessionsAgainstRuntime();
      });
    }
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);
  });

  it("falls back to a closed transcript only when the runtime cannot be asked", async () => {
    const { result } = renderHook(() =>
      useReconciler(() => ({ live: new Set(), reachableModes: new Set() }), true),
    );
    await act(async () => {
      await result.current.reconciler.reconcileWorkingSessionsAgainstRuntime();
    });
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(false);
  });
});

describe("useSessionCommands", () => {
  function useCommands(gateway: HermesGatewayClient) {
    const harness = useHarness(gateway);
    const commands = useSessionCommands({
      gateways: harness.gateways,
      activity: harness.activity,
      buffer: harness.buffer,
      stream: harness.stream,
      sessionTitle: () => "Session",
      refreshSession: async () => true,
    });
    return { ...harness, commands };
  }

  it("replays a turn once on a fresh runtime when the old one is gone", async () => {
    const fake = fakeGateway((method, params) => {
      if (method === "prompt.submit" && params.session_id === "rt-dead") {
        throw new Error("Hermes API returned 404: Session not found");
      }
      if (method === "session.resume") return { session_id: "rt-live" };
      return {};
    });
    const { result } = renderHook(() => useCommands(fake.client));
    const reattach = vi.fn(async () => {});
    const afterSubmit = vi.fn(async () => {});
    await act(async () => {
      await result.current.commands.runPromptTurn({
        gateway: fake.client,
        runtimeSessionId: "rt-dead",
        storedSessionId: "s1",
        sessionDisplayTitle: "Session",
        displayContent: "hello",
        promptSubmitContent: "hello",
        liveErrorsBeforeSend: [],
        acquireGateway: async () => fake.client,
        reattach,
        afterSubmit,
      });
    });
    const submits = fake.requests.filter((request) => request.method === "prompt.submit");
    expect(submits.map((request) => request.params.session_id)).toEqual(["rt-dead", "rt-live"]);
    expect(reattach).toHaveBeenCalledWith(fake.client, "rt-live");
    expect(afterSubmit).toHaveBeenCalledTimes(1);
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);
  });

  it("keeps the running turn when the gateway answers busy", async () => {
    const fake = fakeGateway((method) => {
      if (method === "prompt.submit") throw new HermesGatewayError("session busy", 4009);
      return {};
    });
    const { result } = renderHook(() => useCommands(fake.client));
    const onRejected = vi.fn();
    let failure: unknown;
    await act(async () => {
      failure = await result.current.commands
        .runPromptTurn({
          gateway: fake.client,
          runtimeSessionId: "rt-1",
          storedSessionId: "s1",
          sessionDisplayTitle: "Session",
          displayContent: "again",
          promptSubmitContent: "again",
          liveErrorsBeforeSend: [],
          acquireGateway: async () => fake.client,
          onRejected,
        })
        .catch((err: unknown) => err);
    });
    expect(failure).toBeInstanceOf(HermesGatewayError);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(true);
    expect(fake.listenerCount()).toBe(1);
  });

  it("stops at once and detaches before the interrupt answers", async () => {
    const fake = fakeGateway();
    const { result } = renderHook(() => useCommands(fake.client));
    act(() => {
      result.current.activity.setSessionWorking("s1", true);
      result.current.stream.attachSessionEventListener({
        gateway: fake.client,
        runtimeSessionId: "rt-1",
        sessionDisplayTitle: "Session",
        storedSessionId: "s1",
      });
    });
    await act(async () => {
      await result.current.commands.stopHermesSession("s1");
    });
    expect(result.current.activity.workingSessionIds.has("s1")).toBe(false);
    expect(fake.listenerCount()).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ sessionId: "s1", status: "cancelled" });
  });
});

describe("useSessionApprovals", () => {
  function useApprovals(gateway: HermesGatewayClient, setError = vi.fn()) {
    const harness = useHarness(gateway);
    const approvals = useSessionApprovals({
      gateways: { ensureHermesGateway: async () => gateway },
      buffer: harness.buffer,
      stream: harness.stream,
      activity: harness.activity,
      setError,
    });
    return { ...harness, approvals, setError };
  }

  it("answers on the gateway and shows the answer at once", async () => {
    const fake = fakeGateway();
    const { result } = renderHook(() => useApprovals(fake.client));
    await act(async () => {
      await result.current.approvals.respondToApproval("s1", "rt-1", "req-1", "once");
    });
    expect(fake.requests).toEqual([
      { method: "approval.respond", params: { session_id: "rt-1", choice: "once" } },
    ]);
    expect(result.current.buffer.liveEvents.s1?.at(-1)).toMatchObject({
      type: "approval.response",
      payload: { request_id: "req-1", choice: "once" },
    });
    expect(result.current.approvals.approvalSubmitting["req-1"]).toBeUndefined();
  });

  it("retires a request whose runtime is gone and says why", async () => {
    const fake = fakeGateway(() => {
      throw new Error("Hermes API returned 404: Session not found");
    });
    const setError = vi.fn();
    const { result } = renderHook(() => useApprovals(fake.client, setError));
    act(() => result.current.activity.setSessionWaiting("s1", true));
    await act(async () => {
      await result.current.approvals.respondToApproval("s1", "s1", "req-1", "deny");
    });
    expect(result.current.activity.waitingSessionIds.has("s1")).toBe(false);
    expect(setError).toHaveBeenLastCalledWith(
      "This session has ended, so the request can no longer be answered.",
      { sessionId: "s1" },
    );
  });
});
