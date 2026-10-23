/**
 * What a surface sends into a Hermes session: a turn (`prompt.submit`, replayed
 * once on a fresh runtime when the old one is gone), a steer into the running
 * turn (`session.steer`), and the stops (`session.interrupt`, one subagent).
 *
 * A prompt that lands while a turn is running waits behind it: the rendered
 * config pins `busy_input_mode: queue`, so it never kills the turn in flight.
 * A gateway that still answers 4009 "session busy" has its rejection handed
 * back untouched (`isSessionBusyError`), the running turn left alone, so the
 * surface can say so.
 * Everything a surface does around a send (optimistic rows, titles, issue
 * reports) stays with the surface: it passes callbacks.
 */
import { useState } from "react";
import { dispatchAgentSessionStatus } from "../agent-events";
import { type LiveHermesEvent, withRestoredLiveEvents } from "../agent-chat-runtime";
import { sessionUnrestricted } from "../agent-session-modes";
import { messageFromError } from "../errors";
import { hermesActivityStore } from "../hermes-activity-store";
import { type HermesGatewayClient, isSessionBusyError } from "../hermes-gateway";
import { normalizeSteerText, steeringLiveEvent } from "../hermes-session-steer";
import { hermesTraceBuffer } from "../hermes-trace-buffer";
import { t } from "../i18n";
import { hermesModeFor } from "./events";
import { createHermesMethods } from "./methods";
import { isSessionGoneError, sessionRuntimeGoneMessage } from "./session-errors";
import type { HermesGateways } from "./use-hermes-gateways";
import type { SessionActivity } from "./use-session-activity";
import type { LiveEventBuffer, SessionStream } from "./use-session-stream";

export type PromptTurn = {
  gateway: HermesGatewayClient;
  runtimeSessionId: string;
  storedSessionId: string;
  sessionDisplayTitle: string;
  /** What the person typed, for the status broadcast. */
  displayContent: string;
  /** What `prompt.submit` carries (context blocks included). */
  promptSubmitContent: string;
  /** The current turn's live errors before the send, put back on a rejection. */
  liveErrorsBeforeSend: LiveHermesEvent[];
  /** Acquires a mode's gateway the way the send does (working folder included). */
  acquireGateway: (unrestricted: boolean) => Promise<HermesGatewayClient>;
  /** Session state the turn depends on, applied in the runtime before the prompt. */
  beforePrompt?: (context: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    storedSessionId: string;
  }) => Promise<void>;
  /** Re-attaches what lived in a dead runtime (images) before a replay. */
  reattach?: (gateway: HermesGatewayClient, runtimeSessionId: string) => Promise<void>;
  /** The prompt went in: anything the surface refreshes, inside the same try. */
  afterSubmit?: () => Promise<void>;
  /** The prompt never went in: the surface takes back what it showed. */
  onRejected?: () => void;
};

export type SessionCommandsOptions = {
  gateways: HermesGateways;
  activity: SessionActivity;
  buffer: LiveEventBuffer;
  stream: SessionStream;
  sessionTitle: (sessionId: string) => string | undefined;
  /** Pulls what the agent persisted, after a stop. */
  refreshSession: (sessionId: string) => Promise<unknown>;
};

export function useSessionCommands({
  gateways,
  activity,
  buffer,
  stream,
  sessionTitle,
  refreshSession,
}: SessionCommandsOptions) {
  const { ensureHermesGateway, resolveRuntimeSession, runtimeSessionIds } = gateways;
  const [stoppingSessionIds, setStoppingSessionIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * Runs one turn: marks the session working, subscribes it, applies the
   * pre-turn state and submits the prompt. When the runtime the send was keyed
   * to is gone, it resolves a live one and replays the turn once. Resolves to
   * the stored session id; a rejection has already undone the working state
   * (except for a busy rejection, where the running turn is healthy).
   */
  async function runPromptTurn(turn: PromptTurn): Promise<string> {
    const { storedSessionId, sessionDisplayTitle, promptSubmitContent } = turn;
    let turnGateway = turn.gateway;
    let runtimeSessionId = turn.runtimeSessionId;
    activity.setSessionWorking(storedSessionId, true);
    activity.setSessionWaiting(storedSessionId, false);
    dispatchAgentSessionStatus({
      sessionId: storedSessionId,
      title: sessionDisplayTitle,
      prompt: turn.displayContent,
      status: "running",
      summary: t("Sub Rosa is working."),
    });
    // Runs the turn against one runtime: the pre-turn state hook, then the
    // prompt itself. Factored out so it can be replayed once against a fresh
    // runtime — `beforePrompt` state lives IN the runtime process, so a replay
    // must re-apply it or the turn runs without what it was armed with.
    const runTurnOn = async (target: HermesGatewayClient, targetRuntimeSessionId: string) => {
      stream.attachSessionEventListener({
        gateway: target,
        runtimeSessionId: targetRuntimeSessionId,
        sessionDisplayTitle,
        storedSessionId,
      });
      // Session-scoped pre-turn state (the `/goal` flow) applies here, inside
      // the same try as the submit: a failed hook aborts the send through the
      // shared cleanup below instead of launching a turn missing the state it
      // was supposed to run under.
      if (turn.beforePrompt) {
        await turn.beforePrompt({
          gateway: target,
          runtimeSessionId: targetRuntimeSessionId,
          storedSessionId,
        });
      }
      // Feature 15: record the outbound prompt.submit in the trace buffer. Its
      // params are sanitized before storage (the text is the user's own prompt,
      // kept; any secret-like value would be masked).
      hermesTraceBuffer.recordOutbound({
        sessionId: storedSessionId,
        method: "prompt.submit",
        params: { session_id: targetRuntimeSessionId, text: promptSubmitContent },
      });
      await target.request("prompt.submit", {
        session_id: targetRuntimeSessionId,
        text: promptSubmitContent,
      });
    };
    try {
      try {
        await runTurnOn(turnGateway, runtimeSessionId);
      } catch (err) {
        // The runtime this send was keyed to is gone (reaped between turns,
        // Hermes restarted). Nothing was queued, so resolve a live one and
        // replay the turn once — without this the memoized dead id was replayed
        // on every retry and the conversation could not be used again until the
        // app restarted.
        if (!isSessionGoneError(messageFromError(err))) throw err;
        hermesTraceBuffer.recordLocal({
          sessionId: storedSessionId,
          event: "runtime.recovered",
          reason: "prompt-submit-session-not-found",
        });
        const recovered = await resolveRuntimeSession(storedSessionId, turnGateway, {
          forceRefresh: true,
          acquireGateway: turn.acquireGateway,
        });
        turnGateway = recovered.gateway;
        runtimeSessionId = recovered.runtimeSessionId;
        // What lived in the dead process (attached images) died with it; the
        // fresh runtime must see it or the turn runs blind.
        if (turn.reattach) await turn.reattach(turnGateway, runtimeSessionId);
        await runTurnOn(turnGateway, runtimeSessionId);
      }
      if (turn.afterSubmit) await turn.afterSubmit();
      return storedSessionId;
    } catch (err) {
      // Record the rejection so the trace panel shows failed outbound calls
      // alongside the inbound stream. messageFromError yields a user-safe string.
      hermesTraceBuffer.recordError({
        sessionId: storedSessionId,
        method: "prompt.submit",
        message: messageFromError(err),
      });
      turn.onRejected?.();
      // Hermes never stores a failure: the current turn's live errors go back.
      buffer.liveEventsRef.current = {
        ...buffer.liveEventsRef.current,
        [storedSessionId]: withRestoredLiveEvents(
          buffer.liveEventsRef.current[storedSessionId] ?? [],
          turn.liveErrorsBeforeSend,
        ),
      };
      buffer.liveEventsPublisher.flush();
      if (isSessionBusyError(err)) {
        // The gateway rejected this prompt because the previous turn is still
        // running — the session itself is healthy, so keep the listener and
        // working state. Callers translate this into the composer notice.
        throw err;
      }
      stream.detachSession(storedSessionId);
      activity.setSessionWorking(storedSessionId, false);
      activity.setSessionWaiting(storedSessionId, false);
      // A session-gone failure that survived the recovery replay above means no
      // runtime can host this conversation. Say that, rather than leaking the
      // wire text ("Hermes API returned 404 … Session not found").
      const failure = isSessionGoneError(messageFromError(err))
        ? new Error(sessionRuntimeGoneMessage())
        : err;
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        status: "failed",
        summary: messageFromError(failure),
        // The send never left the app: the person is looking at the composer,
        // which restores their text and shows the reason inline. A desktop
        // notification on top of that is noise — the status still flows so
        // the menu bar leaves its running state.
        silent: true,
      });
      throw failure;
    }
  }

  // Feature 06: steer a STILL-WORKING session with a mid-run instruction,
  // through the dedicated typed control-plane method (session.steer) — never
  // prompt.submit, which the gateway rejects while a turn runs. The
  // instruction shows in the transcript at once as a local "Steering" item
  // (pushed onto the same live-event channel Hermes frames use, so it orders
  // and survives re-renders for free). Rejections bubble to the caller so it
  // can keep the unsent text and show recoverable copy.
  async function steerActiveSession(sessionId: string, text: string) {
    const instruction = normalizeSteerText(text);
    if (!instruction) return;
    // Show the instruction in the transcript right away so the user sees it
    // landed — the gateway ack can lag a beat behind a fast send, and we never
    // want a sent message to silently vanish.
    buffer.pushLiveEvent(
      sessionId,
      steeringLiveEvent({
        sessionId,
        text: instruction,
        receivedAt: new Date().toISOString(),
      }),
    );
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    await createHermesMethods(gateway).steerSession({
      sessionId,
      text: instruction,
    });
  }

  // Stops a running turn: interrupts the runtime session over the gateway,
  // then clears the local working/waiting flags regardless — the user asked
  // for it to stop, so the UI must not stay "thinking" even when the RPC fails
  // (gateway drop, runtime session already gone).
  async function stopHermesSession(sessionId: string) {
    if (stoppingSessionIds.has(sessionId)) return;
    setStoppingSessionIds((current) => new Set(current).add(sessionId));

    // Stop the UI FIRST, synchronously, before the interrupt RPC. Stopping
    // must feel instant: the moment the user clicks, the session reads as
    // stopped (the Stop control gives way to Send) rather than staying
    // "working" until the gateway round-trip acks. Tearing down the
    // per-session listener here also means a straggler "running" event
    // arriving while the interrupt is in flight can't flip the session back
    // to working (and on a gateway drop no terminal event ever comes to do
    // it). The interrupt then fires below to actually halt the runtime agent.
    stream.detachSession(sessionId);
    // Interrupting tears the listener down before any cancelled terminal event
    // reaches the terminal handler, so clear the delivery-guarantee steers here
    // too -- otherwise a steer typed-then-stopped lingers and could auto-submit
    // as a follow-up after a later run in the same session.
    stream.forgetPendingSteers(sessionId);
    const activityCounts = activity.clearSessionActivity(sessionId);
    // Feature 11: the per-session listener is gone, so no terminal frame will
    // reach the activity store to retire this row. Record a synthetic terminal
    // lifecycle so the drawer flips the session out of "running" the instant
    // the user clicks stop (the row persists, now reading as complete).
    hermesActivityStore.record(
      { kind: "lifecycle", sessionId, status: "cancelled" },
      hermesModeFor(sessionId),
    );
    dispatchAgentSessionStatus({
      sessionId,
      title: sessionTitle(sessionId) ?? t("Agent session"),
      status: "cancelled",
      summary: t("Stopped."),
      ...activityCounts,
    });

    try {
      const runtimeSessionId = runtimeSessionIds[sessionId];
      if (runtimeSessionId) {
        const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
        await gateway.request("session.interrupt", {
          session_id: runtimeSessionId,
        });
      }
    } catch {
      // The UI already reflects stopped; a failed interrupt (gateway down)
      // must not leave the session reading as working.
    } finally {
      setStoppingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      // Pull whatever the agent managed to persist before the interrupt so
      // the transcript reflects the partial turn.
      void refreshSession(sessionId);
    }
  }

  // Feature 13: interrupt ONE background subagent from the activity drawer. The
  // drawer already vetted the target and owns the optimistic "stopping"
  // overlay, so this just routes the call to the gateway that owns the parent
  // session. The RPC's session id is the runtime id (as the whole-session
  // interrupt uses). The promise is returned so the drawer can reconcile: a
  // rejection (the subagent already finished) drops the overlay and the row
  // settles from the event stream rather than showing a noisy failure.
  async function stopHermesSubagent({
    sessionId,
    subagentId,
  }: {
    sessionId: string;
    subagentId: string;
  }): Promise<unknown> {
    const runtimeSessionId = runtimeSessionIds[sessionId] ?? sessionId;
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    return createHermesMethods(gateway).interruptSubagent({
      sessionId: runtimeSessionId,
      subagentId,
    });
  }

  return {
    stoppingSessionIds,
    runPromptTurn,
    steerActiveSession,
    stopHermesSession,
    stopHermesSubagent,
  };
}

export type SessionCommands = ReturnType<typeof useSessionCommands>;
