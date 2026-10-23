/**
 * The live side of a Hermes session: the buffer of frames the transcript
 * renders before the runtime persists them, and the gateway subscription that
 * fills it.
 *
 * - `useLiveEventBuffer` holds the frames per session. The ref takes every
 *   frame at once; the render is published at most once per animation frame,
 *   so a streamed reply (ADR-0063 relays it token by token) stops re-rendering
 *   the surface per token. Anything but a streamed delta flushes.
 * - `useSessionStream` owns one subscription per session (ADR-0016: scoped to
 *   the session, not the turn), runs every frame through `classifyHermesEvent`
 *   into the shared stores, derives the session's activity from it, keeps the
 *   steer delivery guarantee, and recovers every subscription after a dropped
 *   socket. What a surface does when a turn ends is its own: it passes
 *   callbacks.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { dispatchAgentSessionStatus, repeatsLastAgentSessionStatus } from "../agent-events";
import {
  appendLiveHermesEvent,
  currentTurnLiveErrors,
  isTerminalHermesEvent,
  type LiveHermesEvent,
  liveEventsForNewTurn,
} from "../agent-chat-runtime";
import { sessionUnrestricted } from "../agent-session-modes";
import { createFrameBatcher } from "../frame-batch";
import { hermesActivityStore } from "../hermes-activity-store";
import { hermesArtifactStore } from "../hermes-artifact-store";
import { hermesBackgroundProcessStore } from "../hermes-background-processes";
import type { HermesGatewayClient, HermesGatewayEvent } from "../hermes-gateway";
import { pendingActionStore } from "../hermes-pending-actions";
import { hermesTraceBuffer } from "../hermes-trace-buffer";
import { unsupportedEventStore } from "../hermes-unsupported-events";
import { t } from "../i18n";
import type { HermesSessionMessage } from "../tauri";
import { classifyHermesEvent } from "./event-classifier";
import { hermesModeFor } from "./events";
import type { HermesGateways } from "./use-hermes-gateways";
import {
  agentStatusFromHermesEvent,
  agentStatusSummaryFromHermesEvent,
  hermesToolEventPhase,
  type SessionActivity,
} from "./use-session-activity";

/** Frames of streamed text: buffered to the next animation frame, not flushed. */
const STREAMED_DELTA = /^(message|thinking|reasoning)\.delta$/;

export type LiveEventsBySession = Record<string, LiveHermesEvent[]>;

export type LiveEventBufferOptions = {
  /** Frames carried over from a previous mount. */
  initial?: LiveEventsBySession;
  /** The persisted transcript plus the sends not yet stored, for one session. */
  storedMessages: (sessionId: string) => HermesSessionMessage[];
};

export function useLiveEventBuffer({ initial, storedMessages }: LiveEventBufferOptions) {
  const [liveEvents, setLiveEvents] = useState<LiveEventsBySession>(() => initial ?? {});
  const liveEventsRef = useRef<LiveEventsBySession>(liveEvents);
  // The ref takes every live frame at once (every handler reads it); the render
  // is published at most once per animation frame, so a streamed reply stops
  // re-rendering the workspace per token. Anything but a streamed delta flushes.
  const liveEventsPublisher = useMemo(
    () => createFrameBatcher(() => setLiveEvents(liveEventsRef.current)),
    [],
  );
  useEffect(() => () => liveEventsPublisher.cancel(), [liveEventsPublisher]);

  /** Appends one received frame; a streamed delta waits for the next frame. */
  function appendLiveEvent(key: string, liveEvent: LiveHermesEvent) {
    const nextEvents = appendLiveHermesEvent(liveEventsRef.current[key] ?? [], liveEvent);
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    if (STREAMED_DELTA.test(liveEvent.type)) {
      liveEventsPublisher.schedule();
    } else {
      liveEventsPublisher.flush();
    }
  }

  /** A frame the app synthesizes (an answered approval, a steer): shown now. */
  function pushLiveEvent(key: string, event: HermesGatewayEvent) {
    const liveEvent = { ...event, receivedAt: new Date().toISOString() };
    const nextEvents = appendLiveHermesEvent(liveEventsRef.current[key] ?? [], liveEvent);
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    liveEventsPublisher.flush();
  }

  // A new prompt (or a steer) opens a new beat of the conversation: drop what a
  // finished turn left in the live buffer (see liveEventsForNewTurn). Returns
  // whether anything went, so a send can fetch the stored copy right away.
  function dropFinishedLiveTurns(sessionId: string, turnInProgress: boolean) {
    const events = liveEventsRef.current[sessionId] ?? [];
    const kept = liveEventsForNewTurn(events, { turnInProgress });
    if (kept === events) return false;
    liveEventsRef.current = { ...liveEventsRef.current, [sessionId]: kept };
    liveEventsPublisher.flush();
    return true;
  }

  function liveErrorsOfCurrentTurn(sessionId: string) {
    return currentTurnLiveErrors(liveEventsRef.current[sessionId] ?? [], storedMessages(sessionId));
  }

  return {
    liveEvents,
    liveEventsRef,
    liveEventsPublisher,
    appendLiveEvent,
    pushLiveEvent,
    dropFinishedLiveTurns,
    liveErrorsOfCurrentTurn,
  };
}

export type LiveEventBuffer = ReturnType<typeof useLiveEventBuffer>;

/** A steer sent into a running turn, until the turn says whether it landed. */
export type PendingSteer = { text: string; accepted: boolean; toolDrained: boolean };

export type SessionSubscription = {
  gateway: HermesGatewayClient;
  runtimeSessionId: string;
  sessionDisplayTitle: string;
  storedSessionId: string;
};

export type SessionStreamOptions = {
  activity: SessionActivity;
  buffer: LiveEventBuffer;
  gateways: HermesGateways;
  /** Fetches a session's stored transcript. `keepLiveFrames` only fetches. */
  refreshSession: (sessionId: string, options?: { keepLiveFrames?: boolean }) => Promise<unknown>;
  sessionTitle: (sessionId: string) => string | undefined;
  /** A turn completed cleanly (not failed, not cancelled). */
  onTurnCompleted?: (storedSessionId: string) => void;
  /** Steers no tool result consumed, joined, to be sent again as a follow-up. */
  onUnconsumedSteers?: (storedSessionId: string, text: string) => void;
  /** Any terminal frame, last: the surface refreshes or promotes what it holds. */
  onTurnEnded?: (storedSessionId: string) => void;
};

export function useSessionStream({
  activity,
  buffer,
  gateways,
  refreshSession,
  sessionTitle,
  onTurnCompleted,
  onUnconsumedSteers,
  onTurnEnded,
}: SessionStreamOptions) {
  const {
    clearSessionActivity,
    setSessionWaiting,
    setSessionWorking,
    updateSessionToolCallActivity,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  } = activity;
  // One live gateway subscription per Hermes session. A follow-up send while
  // the previous turn is still streaming must replace the old handler, not
  // stack a second one — otherwise every event lands twice in liveEvents.
  const sessionGatewayUnlistenRef = useRef<Map<string, () => void>>(new Map());
  // Steers we've sent that Hermes may not have delivered yet. Hermes only
  // injects a steer into the next tool result, so a no-tool turn drops it; we
  // track the text and resend it as a follow-up on completion when no tool
  // consumed it (cleared on a tool.complete or a clean terminal).
  const pendingSteerBySessionIdRef = useRef<Record<string, PendingSteer[]>>({});
  // Per-mode: both gateways can drop together (network reconnect), and one
  // mode's in-flight recovery must not swallow the other's only onClose.
  const gatewayRecoveringRef = useRef<Set<boolean>>(new Set());
  // A subscription outlives the render that attached it (it spans turns), so
  // the turn-end callbacks are read through a ref: a caller that reads React
  // state in them sees the latest value, never the one of the attach render.
  const turnCallbacksRef = useRef({ onTurnCompleted, onUnconsumedSteers, onTurnEnded });
  turnCallbacksRef.current = { onTurnCompleted, onUnconsumedSteers, onTurnEnded };

  /** Ends a session's subscription, if it has one. */
  function detachSession(sessionId: string) {
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
  }

  /** Records a steer before it is sent; the turn's end decides its fate. */
  function recordPendingSteer(sessionId: string, text: string): PendingSteer {
    const entry: PendingSteer = { text, accepted: false, toolDrained: false };
    pendingSteerBySessionIdRef.current = {
      ...pendingSteerBySessionIdRef.current,
      [sessionId]: [...(pendingSteerBySessionIdRef.current[sessionId] ?? []), entry],
    };
    return entry;
  }

  function forgetPendingSteers(sessionId: string) {
    delete pendingSteerBySessionIdRef.current[sessionId];
  }

  /** Subscribes a session to its gateway, replacing any earlier subscription. */
  function attachSessionEventListener({
    gateway,
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
  }: SessionSubscription) {
    sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
    let unlisten = () => {};
    const removeListener = gateway.onEvent((event) => {
      if (event.session_id !== runtimeSessionId && event.session_id !== storedSessionId) return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      // Run every live frame through the typed control plane alongside the
      // string-based handling below. Unknown frames classify as `unsupported`
      // rather than being dropped, so a Hermes upgrade that adds an event shows
      // up in dev instead of silently doing nothing.
      const classified = classifyHermesEvent(liveEvent);
      // Feature 15: record every inbound frame (raw type + the kind it
      // classified to) into the bounded, sanitized trace buffer so the dev/debug
      // trace panel can reconstruct the session. recordInbound re-classifies and
      // sanitizes internally; nothing raw is retained.
      hermesTraceBuffer.recordInbound(liveEvent);
      if (classified.kind === "unsupported") {
        // Feed the bounded per-session store so the user gets a recoverable
        // notice (when this is the active session) and developers get a
        // sanitized, issue-report-safe export. The payload is already sanitized
        // by the classifier; nothing raw is retained or logged.
        unsupportedEventStore.record(classified);
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only unsupported-event diagnostic
          console.debug(
            "[hermes] unsupported event",
            classified.rawType,
            classified.sanitizedPayload,
          );
        }
      } else if (classified.kind === "pending_action") {
        // Feature 04: aggregate this blocker into the pending-action store
        // keyed by mode + session + request. The session's mode comes from its
        // recorded opt-in (sudo carries its own; the rest derive it here). A
        // fresh event for a known request also re-confirms a row that went
        // stale across a reconnect (see the store's reconcile logic).
        pendingActionStore.record(classified, hermesModeFor(storedSessionId));
      }
      // Feature 11: roll EVERY classified event into the global activity store
      // that backs the Agent activity drawer. The store is total and ignores
      // unattributable events, so one unconditional call covers all kinds.
      hermesActivityStore.record(classified, hermesModeFor(storedSessionId));
      // Feature 14: extract any file/artifact reference this event carries into
      // the per-session artifact timeline. The store is total and only acts on
      // `tool` completions that name a known file/url field, so one
      // unconditional call is safe for every kind.
      hermesArtifactStore.record(classified, hermesModeFor(storedSessionId));
      // Track background processes (the `background=true` shell launches the
      // agent parks long work in) so the chat can say a job is still running
      // once the turn that started it has ended. Total and conservative: a
      // frame that does not identify a background process is ignored.
      hermesBackgroundProcessStore.record(classified, {
        sessionId: storedSessionId,
        receivedAt: liveEvent.receivedAt,
      });
      // A new assistant message means the chained turn the completion triggered
      // has begun, so "finished, being picked back up" has served its purpose.
      if (event.type === "message.start") {
        hermesBackgroundProcessStore.clearFinished(storedSessionId);
      }
      // A turn the gateway starts on its own (a finished background job, the
      // goal loop) has no send to clear the finished turn's frames, which would
      // render again under the prompt the gateway stores. Clear them as a send
      // does and fetch their stored copy.
      if (
        event.type === "message.start" &&
        !workingSessionIdsRef.current.has(storedSessionId) &&
        !waitingSessionIdsRef.current.has(storedSessionId) &&
        buffer.dropFinishedLiveTurns(storedSessionId, true)
      ) {
        void refreshSession(storedSessionId, { keepLiveFrames: true });
      }
      buffer.appendLiveEvent(storedSessionId, liveEvent);
      const toolEventPhase = hermesToolEventPhase(event.type);
      if (toolEventPhase === "complete") {
        // Hermes drains every accepted steer into the tool result it just
        // produced (run_agent.steer). Mark the pending entries drained rather
        // than removing them here: whether a steer was ACCEPTED is settled
        // asynchronously (the steer RPC's .then), which can resolve AFTER this
        // event, so the consume-vs-resend decision is deferred to the terminal
        // handler where both flags are final.
        const list = pendingSteerBySessionIdRef.current[storedSessionId];
        if (list) {
          for (const entry of list) entry.toolDrained = true;
        }
      }
      if (toolEventPhase !== undefined) {
        updateSessionToolCallActivity(storedSessionId, event, toolEventPhase);
      }
      const status = agentStatusFromHermesEvent(event);
      if (status === "waitingForUser") {
        setSessionWorking(storedSessionId, false);
        setSessionWaiting(storedSessionId, true);
      } else if (status === "running") {
        setSessionWaiting(storedSessionId, false);
        setSessionWorking(storedSessionId, true);
      }
      const activityCounts =
        status === "completed" || status === "failed" || status === "cancelled"
          ? clearSessionActivity(storedSessionId)
          : undefined;
      if (activityCounts) {
        // The fast path of ADR-0016's settlement rule, traced like the poll's
        // so a session's whole activity history reads in one place.
        hermesTraceBuffer.recordLocal({
          sessionId: storedSessionId,
          event: "activity.settled",
          reason: `terminal-event:${event.type}`,
        });
        // Feature 04: the session reached a terminal state — the agent is no
        // longer blocked, so any of its outstanding "Needs you" rows are moot.
        pendingActionStore.resolveSession(storedSessionId);
      }
      const statusDetail = status && {
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        status,
        summary: agentStatusSummaryFromHermesEvent(event, status),
        ...activityCounts,
      };
      if (statusDetail && !(status === "running" && repeatsLastAgentSessionStatus(statusDetail))) {
        dispatchAgentSessionStatus(statusDetail);
      }
      if (isTerminalHermesEvent(event.type)) {
        // The subscription deliberately OUTLIVES the turn (it is replaced by the
        // next submit, and torn down on unmount / session delete). The app is no
        // longer the only thing that starts a turn: the notification poller
        // chains one when a background process finishes, the goal loop continues
        // one after its post-turn judge, and a routine can run one on a
        // schedule. Detaching here meant every gateway-initiated turn ran
        // invisibly (ADR-0016).
        if (!activityCounts) {
          clearSessionActivity(storedSessionId);
        }
        if (status === "completed") turnCallbacksRef.current.onTurnCompleted?.(storedSessionId);
        // Delivery guarantee: any steer not consumed by a tool result this turn
        // (Hermes only injects steers into tool output) would otherwise be lost.
        // On a clean completion hand the leftovers back to be resent as a
        // follow-up; drop them on a failed/cancelled run.
        const unconsumedSteers =
          status === "completed"
            ? pendingSteerBySessionIdRef.current[storedSessionId]?.filter(
                // Consumed = Hermes accepted it AND a tool result drained it.
                // Resend the rest (rejected, or accepted but no tool ran).
                (entry) => !(entry.accepted && entry.toolDrained),
              )
            : undefined;
        delete pendingSteerBySessionIdRef.current[storedSessionId];
        if (unconsumedSteers?.length) {
          turnCallbacksRef.current.onUnconsumedSteers?.(
            storedSessionId,
            unconsumedSteers.map((entry) => entry.text).join("\n"),
          );
        }
        turnCallbacksRef.current.onTurnEnded?.(storedSessionId);
      }
    });
    unlisten = () => {
      removeListener();
      if (sessionGatewayUnlistenRef.current.get(storedSessionId) === unlisten) {
        sessionGatewayUnlistenRef.current.delete(storedSessionId);
      }
    };
    sessionGatewayUnlistenRef.current.set(storedSessionId, unlisten);
    return unlisten;
  }

  // prompt.submit is ack-style: once acked there are no pending RPCs, so a
  // socket drop mid-run rejects nothing and no event will ever arrive — the
  // session would otherwise stay "working" forever. Try to reconnect and
  // resubscribe the runtime sessions; either way, refresh them immediately so
  // the working-gated poll reconciles their true state. Only the dropped
  // mode's gateway is rebuilt — sessions of that mode are the ones it served.
  async function recoverFromGatewayClose(fullMode: boolean) {
    if (gatewayRecoveringRef.current.has(fullMode)) return;
    // Every session this app instance holds a runtime for, not only the ones
    // visibly working: since the live subscription now outlives a turn, an IDLE
    // session can still receive a gateway-initiated one (a background process
    // completing, the goal loop continuing, a routine firing) — and that only
    // reaches it if the socket comes back with its subscription attached.
    const recoverableSessionIds = new Set(
      [
        ...workingSessionIdsRef.current,
        ...waitingSessionIdsRef.current,
        ...Object.keys(gateways.runtimeSessionIdsRef.current),
      ].filter((sessionId) => sessionUnrestricted(sessionId) === fullMode),
    );
    if (!recoverableSessionIds.size) return;
    gatewayRecoveringRef.current.add(fullMode);
    try {
      const gateway = await gateways.ensureHermesGateway(fullMode);
      await Promise.all(
        Array.from(recoverableSessionIds).map(async (sessionId) => {
          try {
            // forceRefresh: the drop may have taken the runtime with it, so the
            // memoized id is exactly what must not be trusted here.
            const resolved = await gateways.resolveRuntimeSession(sessionId, gateway, {
              forceRefresh: true,
            });
            // Re-point the subscription at the runtime the resume just minted:
            // the surviving handler filters on the id captured when it was
            // attached, so a new one would silently drop every frame.
            attachSessionEventListener({
              gateway: resolved.gateway,
              runtimeSessionId: resolved.runtimeSessionId,
              sessionDisplayTitle: sessionTitle(sessionId) ?? t("Agent session"),
              storedSessionId: sessionId,
            });
          } catch {
            // The runtime session may be gone; the poll reconciles it.
          }
        }),
      );
    } catch {
      // Reconnect failed — fall back to the persisted-message poll.
    } finally {
      gatewayRecoveringRef.current.delete(fullMode);
    }
    // Feature 04: the gateway is back. Any pending action not re-announced by a
    // fresh event is now unverifiable across the drop, so mark it stale —
    // visible but visually distinct — rather than silently dropping a possible
    // blocker. A re-announced request flips its row back to open in the feed.
    pendingActionStore.reconcileAfterReconnect();
    for (const sessionId of recoverableSessionIds) {
      void refreshSession(sessionId);
    }
  }

  return {
    sessionGatewayUnlistenRef,
    pendingSteerBySessionIdRef,
    attachSessionEventListener,
    detachSession,
    recordPendingSteer,
    forgetPendingSteers,
    recoverFromGatewayClose,
  };
}

export type SessionStream = ReturnType<typeof useSessionStream>;
