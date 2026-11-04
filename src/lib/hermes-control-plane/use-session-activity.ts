/**
 * Per-session activity of a Hermes conversation: which sessions are working,
 * which are waiting on the person, and which have a tool call in flight
 * (ADR-0016). Shared by every surface that drives a Hermes session, so the
 * chat and any other surface agree on when a run is over.
 *
 * Two hooks:
 * - `useSessionActivity` owns the three sets (state for rendering, refs for the
 *   handlers that run off timers and gateway frames) and their setters.
 * - `useSessionRunReconciler` is ADR-0016's settlement rule: only the runtime
 *   (`session.active_list`) may end a run, the transcript only when the runtime
 *   cannot be asked, and a working session is polled while the bridge runs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentSessionStatusKind, dispatchAgentSessionStatus } from "../agent-events";
import {
  eventText,
  hermesMessagesShowCompletedTurn,
  isTerminalHermesEvent,
  type LiveHermesEvent,
  stringValue,
} from "../agent-chat-runtime";
import { toolActivitySentenceText } from "../agent-tool-label-text";
import { sessionUnrestricted } from "../agent-session-modes";
import type { HermesGatewayEvent } from "../hermes-gateway";
import { hermesTraceBuffer } from "../hermes-trace-buffer";
import { t } from "../i18n";
import type { HermesSessionMessage } from "../tauri";
import type { RuntimeSnapshot } from "./use-hermes-gateways";

export type HermesToolEventPhase = "start" | "progress" | "complete";

/** Tool calls in flight per session, keyed by the call's id, counted. */
export type ActiveToolCallsRecord = Record<string, Record<string, number>>;

/** What a remount carries over so a live run is picked straight back up. */
export type SessionActivitySeed = {
  workingSessionIds?: readonly string[];
  waitingSessionIds?: readonly string[];
  activeToolCallsBySession?: ActiveToolCallsRecord;
};

export function activeToolCallsRecord(
  activeToolCallsBySession: Map<string, Map<string, number>>,
): ActiveToolCallsRecord {
  return Object.fromEntries(
    Array.from(activeToolCallsBySession.entries())
      .filter(([, tools]) => tools.size > 0)
      .map(([sessionId, tools]) => [sessionId, Object.fromEntries(tools)]),
  );
}

export function activeToolCallsMap(activeToolCallsBySession: ActiveToolCallsRecord | undefined) {
  return new Map(
    Object.entries(activeToolCallsBySession ?? {}).map(([sessionId, tools]) => [
      sessionId,
      new Map(
        Object.entries(tools).filter(
          (entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0,
        ),
      ),
    ]),
  );
}

export function hermesToolEventPhase(type: string): HermesToolEventPhase | undefined {
  const normalized = type.toLowerCase();
  if (normalized === "tool.complete") return "complete";
  if (normalized === "tool.start") return "start";
  if (normalized === "tool.progress") return "progress";
  return undefined;
}

export function toolEventActivityKey(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    stringValue(payload?.tool_id) ??
    stringValue(payload?.tool_call_id) ??
    stringValue(payload?.call_id) ??
    stringValue(payload?.id) ??
    stringValue(payload?.request_id)
  );
}

/** The session status a live frame implies, or undefined when it implies none. */
export function agentStatusFromHermesEvent(
  event: HermesGatewayEvent,
): AgentSessionStatusKind | undefined {
  if (event.type === "error") return "failed";
  if (event.type === "clarify.request" || event.type === "approval.request") {
    return "waitingForUser";
  }
  if (event.type === "clarify.response" || event.type === "approval.response") {
    return "running";
  }
  if (isTerminalHermesEvent(event.type)) return "completed";
  if (
    event.type === "message.start" ||
    event.type === "thinking.delta" ||
    event.type === "reasoning.delta" ||
    event.type === "status.update" ||
    event.type.startsWith("tool.")
  ) {
    return "running";
  }
  return undefined;
}

export function agentStatusSummaryFromHermesEvent(
  event: HermesGatewayEvent,
  status: AgentSessionStatusKind,
) {
  if (status === "waitingForUser") {
    return event.type === "approval.request"
      ? t("Sub Rosa needs approval.")
      : t("Sub Rosa has a question.");
  }
  if (status === "completed") return t("Sub Rosa finished.");
  if (status === "failed") return eventText(event) || t("Sub Rosa hit a problem.");
  if (event.type === "status.update") {
    return eventText(event) || t("Sub Rosa is working.");
  }
  if (event.type.startsWith("tool.")) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const name =
      stringValue(payload?.name) ?? stringValue(payload?.tool_name) ?? stringValue(payload?.tool);
    return toolActivitySentenceText(name, payload);
  }
  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    return t("Thinking.");
  }
  return t("Sub Rosa is working.");
}

export function useSessionActivity(seed?: SessionActivitySeed | null) {
  const [workingSessionIds, setWorkingSessionIds] = useState<Set<string>>(
    () => new Set(seed?.workingSessionIds),
  );
  const workingSessionIdsRef = useRef<Set<string>>(workingSessionIds);
  const [toolCallSessionIds, setToolCallSessionIds] = useState<Set<string>>(
    () => new Set(Object.keys(seed?.activeToolCallsBySession ?? {})),
  );
  const toolCallSessionIdsRef = useRef<Set<string>>(toolCallSessionIds);
  const activeToolCallsBySessionRef = useRef<Map<string, Map<string, number>>>(
    activeToolCallsMap(seed?.activeToolCallsBySession),
  );
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(
    () => new Set(seed?.waitingSessionIds),
  );
  const waitingSessionIdsRef = useRef<Set<string>>(waitingSessionIds);

  useEffect(() => {
    workingSessionIdsRef.current = workingSessionIds;
    toolCallSessionIdsRef.current = toolCallSessionIds;
    waitingSessionIdsRef.current = waitingSessionIds;
  }, [toolCallSessionIds, waitingSessionIds, workingSessionIds]);

  const setSessionToolCallActive = useCallback((sessionId: string, active: boolean) => {
    setToolCallSessionIds((current) => {
      const next = new Set(current);
      if (active) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      toolCallSessionIdsRef.current = next;
      return next;
    });
  }, []);

  function clearSessionToolCalls(sessionId: string) {
    activeToolCallsBySessionRef.current.delete(sessionId);
    setSessionToolCallActive(sessionId, false);
  }

  /** Counts a tool frame against its session; true while any call is open. */
  function updateSessionToolCallActivity(
    sessionId: string,
    event: HermesGatewayEvent,
    phase: HermesToolEventPhase,
  ) {
    const eventKey = toolEventActivityKey(event);
    const current = new Map(activeToolCallsBySessionRef.current.get(sessionId) ?? []);

    if (phase === "progress" && eventKey === undefined) {
      return current.size > 0;
    }

    const key = eventKey ?? "__anonymous_tool__";

    if (phase === "start") {
      current.set(key, (current.get(key) ?? 0) + 1);
    } else if (phase === "progress") {
      if (!current.has(key)) current.set(key, 1);
    } else {
      const count = current.get(key) ?? 0;
      if (count > 1) {
        current.set(key, count - 1);
      } else {
        current.delete(key);
      }
    }

    if (current.size > 0) {
      activeToolCallsBySessionRef.current.set(sessionId, current);
      setSessionToolCallActive(sessionId, true);
      return true;
    }

    activeToolCallsBySessionRef.current.delete(sessionId);
    setSessionToolCallActive(sessionId, false);
    return false;
  }

  // Both return the current Set when nothing changes: a new Set per streamed
  // frame re-rendered the workspace and re-armed the working poll's interval.
  const setSessionWorking = useCallback((sessionId: string, working: boolean) => {
    setWorkingSessionIds((current) => {
      if (current.has(sessionId) === working) return current;
      const next = new Set(current);
      if (working) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      workingSessionIdsRef.current = next;
      return next;
    });
  }, []);

  const setSessionWaiting = useCallback((sessionId: string, waiting: boolean) => {
    setWaitingSessionIds((current) => {
      if (current.has(sessionId) === waiting) return current;
      const next = new Set(current);
      if (waiting) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      waitingSessionIdsRef.current = next;
      return next;
    });
  }, []);

  /** Ends a session's activity at once and returns what is still active
   * elsewhere, for the status broadcast that announces the end. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearSessionToolCalls only touches refs and a stable setter
  const clearSessionActivity = useCallback(
    (sessionId: string) => {
      clearSessionToolCalls(sessionId);

      const nextWorking = new Set(workingSessionIdsRef.current);
      nextWorking.delete(sessionId);
      workingSessionIdsRef.current = nextWorking;
      setWorkingSessionIds(nextWorking);

      const nextWaiting = new Set(waitingSessionIdsRef.current);
      nextWaiting.delete(sessionId);
      waitingSessionIdsRef.current = nextWaiting;
      setWaitingSessionIds(nextWaiting);

      return {
        activeCount: nextWorking.size + nextWaiting.size,
        needsUserCount: nextWaiting.size,
      };
    },
    [setSessionToolCallActive],
  );

  /** A provisional session became a stored one: its working and waiting flags
   * follow it to the new id. */
  function moveSessionActivity(fromSessionId: string, toSessionId: string) {
    setWorkingSessionIds((current) => {
      const next = new Set(current);
      if (next.delete(fromSessionId)) next.add(toSessionId);
      workingSessionIdsRef.current = next;
      return next;
    });
    setWaitingSessionIds((current) => {
      const next = new Set(current);
      if (next.delete(fromSessionId)) next.add(toSessionId);
      waitingSessionIdsRef.current = next;
      return next;
    });
  }

  /** Drops the working and waiting flags of sessions that no longer exist. */
  function dropSessionActivity(sessionIds: ReadonlySet<string>) {
    setWorkingSessionIds((current) => {
      const next = new Set(current);
      for (const id of sessionIds) next.delete(id);
      workingSessionIdsRef.current = next;
      return next;
    });
    setWaitingSessionIds((current) => {
      const next = new Set(current);
      for (const id of sessionIds) next.delete(id);
      waitingSessionIdsRef.current = next;
      return next;
    });
  }

  /** Working or waiting: a turn is in progress, whatever it is doing. */
  function isSessionBusy(sessionId: string) {
    return (
      workingSessionIdsRef.current.has(sessionId) || waitingSessionIdsRef.current.has(sessionId)
    );
  }

  return {
    workingSessionIds,
    workingSessionIdsRef,
    waitingSessionIds,
    waitingSessionIdsRef,
    toolCallSessionIds,
    toolCallSessionIdsRef,
    activeToolCallsBySessionRef,
    setSessionWorking,
    setSessionWaiting,
    setSessionToolCallActive,
    clearSessionToolCalls,
    updateSessionToolCallActivity,
    clearSessionActivity,
    moveSessionActivity,
    dropSessionActivity,
    isSessionBusy,
  };
}

export type SessionActivity = ReturnType<typeof useSessionActivity>;

export type SessionRunReconcilerOptions = {
  activity: SessionActivity;
  /** The runtime's own view of which sessions are running, per write-access
   * mode (`session.active_list`), and whether a stored session is in it. */
  liveRuntimeSessionsForModes: (modes: boolean[]) => Promise<RuntimeSnapshot>;
  runtimeSnapshotHasSession: (snapshot: RuntimeSnapshot, sessionId: string) => boolean;
  /** The current turn's live error frames: a turn that failed settles as failed. */
  liveErrorsOfCurrentTurn: (sessionId: string) => LiveHermesEvent[];
  /** The persisted transcript plus the sends not yet stored. */
  transcript: (sessionId: string) => HermesSessionMessage[];
  sessionTitle: (sessionId: string) => string | undefined;
  /** Polls working sessions while true (the bridge is running). */
  pollEnabled: boolean;
  /** Fetches one session's stored transcript on each poll tick. */
  refreshSession: (sessionId: string) => Promise<unknown>;
};

export function useSessionRunReconciler({
  activity,
  liveRuntimeSessionsForModes,
  runtimeSnapshotHasSession,
  liveErrorsOfCurrentTurn,
  transcript,
  sessionTitle,
  pollEnabled,
  refreshSession,
}: SessionRunReconcilerOptions) {
  const { clearSessionActivity, workingSessionIds, workingSessionIdsRef } = activity;
  // Consecutive runtime-reconcile polls in which a locally-working session was
  // absent from the gateway's live list. Cleared the moment it's seen live.
  const workingReconcileMissesRef = useRef(new Map<string, number>());

  /** Ends one session's run and announces it. `summary` differs per caller —
   * the runtime reconciler knows only that the run is gone ("stopped"), while a
   * transcript-shape fallback knows the turn produced an answer ("finished").
   * A live `error` frame still outranks both: the fork surfaces a turn that died
   * mid-tool-loop as failed rather than letting it settle silently. */
  function settleSessionRun(sessionId: string, summary: string, reason: string) {
    const activityCounts = clearSessionActivity(sessionId);
    // Only this turn's failure counts: an error the user has sent past is over.
    const turnFailed = liveErrorsOfCurrentTurn(sessionId).length > 0;
    // Which authority ended this run is the first question to ask when a chat
    // looks stuck (or looks finished while it is not), and the answer used to
    // exist nowhere. Recorded next to the gateway frames it sits between.
    hermesTraceBuffer.recordLocal({
      sessionId,
      event: "activity.settled",
      reason,
      detail: { turnFailed },
    });
    dispatchAgentSessionStatus({
      sessionId,
      title: sessionTitle(sessionId) ?? t("Agent session"),
      // "completed" (not "failed") keeps a clean end quiet: the status title
      // falls back to lastStatus when nothing is active, and a stale "running"
      // there would still render "Working…".
      status: turnFailed ? "failed" : "completed",
      summary: turnFailed ? t("Sub Rosa hit a problem.") : summary,
      ...activityCounts,
    });
  }

  // ADR-0016: the runtime is the authority on whether a session is still
  // running. Message-shape reconciliation cannot be: an agent loop persists an
  // assistant row (mid-turn commentary, a tool-calling step) from its first
  // step onward, so "the model has answered" is true seconds into a turn that
  // has minutes of work left — settling on it ended live runs. `session.active_list`
  // is ground truth, so any locally-working session absent from it (or sitting
  // idle) for two consecutive polls gets its activity cleared. Two misses, not
  // one: a just-submitted prompt can race the runtime session registering.
  async function reconcileWorkingSessionsAgainstRuntime() {
    const working = Array.from(workingSessionIdsRef.current);
    const misses = workingReconcileMissesRef.current;
    for (const sessionId of misses.keys()) {
      if (!working.includes(sessionId)) misses.delete(sessionId);
    }
    if (working.length === 0) return;
    // Working sessions may span both runtime processes; ask each mode that
    // has one and union the answers. A mode we can't reach falls back to the
    // transcript below rather than being marked dead on a guess — so a
    // one-gateway failure must not end the other mode's sessions either.
    const modes = Array.from(new Set(working.map((sessionId) => sessionUnrestricted(sessionId))));
    const snapshot = await liveRuntimeSessionsForModes(modes);
    for (const sessionId of working) {
      if (!snapshot.reachableModes.has(sessionUnrestricted(sessionId))) {
        // The runtime that owns this session did not answer, so there is no
        // ground truth this tick. Fall back to the persisted transcript, which
        // may only settle a turn it can prove is closed — a dangling tool call
        // keeps the session running until the runtime can be asked again. A
        // gateway that stays unreachable means the runtime is gone anyway, so a
        // turn it left mid-loop is settled by the interrupted notice, not here.
        if (hermesMessagesShowCompletedTurn(transcript(sessionId))) {
          misses.delete(sessionId);
          settleSessionRun(
            sessionId,
            t("Sub Rosa finished."),
            "transcript-fallback-runtime-unreachable",
          );
        }
        continue;
      }
      if (runtimeSnapshotHasSession(snapshot, sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const seen = (misses.get(sessionId) ?? 0) + 1;
      if (seen < 2) {
        misses.set(sessionId, seen);
        continue;
      }
      misses.delete(sessionId);
      settleSessionRun(sessionId, "Sub Rosa stopped.", "runtime-idle-two-polls");
    }
  }

  // Poll every working session — not just the selected one — so a run whose
  // live gateway stream died (disconnect, navigation) still reconciles from
  // persisted messages instead of staying "working" forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the interval keeps the closures of the render that armed it, re-armed when the working set changes
  useEffect(() => {
    if (!pollEnabled || workingSessionIds.size === 0) return;
    const sessionIds = Array.from(workingSessionIds);
    const interval = window.setInterval(() => {
      for (const sessionId of sessionIds) {
        void refreshSession(sessionId);
      }
      void reconcileWorkingSessionsAgainstRuntime();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [pollEnabled, workingSessionIds]);

  return { settleSessionRun, reconcileWorkingSessionsAgainstRuntime };
}
