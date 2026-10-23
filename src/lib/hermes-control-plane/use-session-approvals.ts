/**
 * Answers to what a running turn asks the person: an approval, a
 * clarification, a sudo prompt or a secret. Each answer goes out on the
 * gateway of the runtime process that asked (its write-access mode), is shown
 * at once as a synthesized live frame, and retires the request's "Needs you"
 * row. A request whose runtime is gone can never be answered: its card is
 * retired and the person reads why, never the gateway's 404.
 */
import { useState } from "react";
import type { AgentApprovalChoice } from "../agent-chat-runtime";
import { messageFromError } from "../errors";
import { pendingActionStore } from "../hermes-pending-actions";
import type { HermesMode } from "./events";
import { createHermesMethods } from "./methods";
import { isSessionGoneError, sessionGoneMessage } from "./session-errors";
import type { HermesGateways } from "./use-hermes-gateways";
import type { SessionActivity } from "./use-session-activity";
import type { LiveEventBuffer, SessionStream } from "./use-session-stream";

export type SessionErrorReporter = (
  message: string | null,
  options?: { sessionId?: string | null },
) => void;

export type SessionApprovalsOptions = {
  gateways: Pick<HermesGateways, "ensureHermesGateway">;
  buffer: Pick<LiveEventBuffer, "liveEventsRef" | "liveEventsPublisher" | "pushLiveEvent">;
  stream: Pick<SessionStream, "detachSession">;
  activity: Pick<SessionActivity, "clearSessionActivity">;
  setError: SessionErrorReporter;
  /** An approval found its runtime gone, after the session's live state was
   * scrubbed: the surface drops what it holds for that key. */
  onApprovalSessionGone?: (liveEventKey: string) => void;
};

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  return withoutKey(record, key);
}

export function useSessionApprovals({
  gateways,
  buffer,
  stream,
  activity,
  setError,
  onApprovalSessionGone,
}: SessionApprovalsOptions) {
  const { ensureHermesGateway } = gateways;
  const { pushLiveEvent } = buffer;
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
  // Sudo records which choice (approve/deny) is in flight per request id;
  // secret records only that a submit is in flight (NEVER the value).
  const [sudoSubmitting, setSudoSubmitting] = useState<Record<string, "approve" | "deny">>({});
  const [secretSubmitting, setSecretSubmitting] = useState<Record<string, true>>({});

  async function respondToApproval(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    choice: AgentApprovalChoice,
    unrestricted = false,
  ) {
    setApprovalSubmitting((current) => ({ ...current, [requestId]: choice }));
    try {
      // The approval lives in the runtime process that asked, so the
      // response must go out on that mode's gateway.
      const gateway = await ensureHermesGateway(unrestricted);
      await gateway.request("approval.respond", {
        session_id: sessionId,
        choice,
      });
      pushLiveEvent(liveEventKey, {
        type: "approval.response",
        session_id: sessionId,
        payload: { request_id: requestId, choice },
      });
      // Feature 04: the user just answered this approval — clear its global
      // "Needs you" row immediately (the response itself is the resolution).
      pendingActionStore.resolveRequest(sessionId, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime session is gone. Scrub only the affected session —
        // including its waiting flag, so the "Needs you" badge clears —
        // without clobbering other healthy sessions' working state or live
        // event streams.
        for (const key of new Set([liveEventKey, sessionId])) {
          stream.detachSession(key);
          activity.clearSessionActivity(key);
        }
        buffer.liveEventsRef.current = omitRecordKey(buffer.liveEventsRef.current, liveEventKey);
        buffer.liveEventsPublisher.flush();
        // The request can never be answered now — retire its card so neither the
        // sidebar count nor the inline prompt offers a dead-end "Respond".
        pendingActionStore.resolveRequest(sessionId, requestId);
        onApprovalSessionGone?.(liveEventKey);
        setError(sessionGoneMessage(), { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setApprovalSubmitting((current) => withoutKey(current, requestId));
    }
  }

  async function respondToClarify(
    liveEventKey: string,
    requestId: string,
    answer: string,
    unrestricted = false,
  ) {
    setClarifySubmitting((current) => ({ ...current, [requestId]: answer }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await gateway.request("clarify.respond", {
        request_id: requestId,
        answer,
      });
      pushLiveEvent(liveEventKey, {
        type: "clarify.response",
        payload: { request_id: requestId, answer },
      });
      // Feature 04: the user answered the clarification — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this clarification can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(sessionGoneMessage());
      } else {
        setError(message);
      }
    } finally {
      setClarifySubmitting((current) => withoutKey(current, requestId));
    }
  }

  // Sudo (privilege escalation) is resolved through the typed control-plane
  // method (sudo.respond), not a hand-written request, so the wire shape stays
  // in one place. The optimistic sudo.response event flips the card to
  // resolved before the gateway round-trips.
  async function respondToSudo(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
    mode?: HermesMode,
    unrestricted = false,
  ) {
    setSudoSubmitting((current) => ({
      ...current,
      [requestId]: approved ? "approve" : "deny",
    }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSudo({
        sessionId,
        requestId,
        approved,
        mode,
      });
      pushLiveEvent(liveEventKey, {
        type: "sudo.response",
        session_id: sessionId,
        payload: { request_id: requestId, granted: approved, mode },
      });
      // Feature 04: the user resolved the sudo prompt — clear its pending record.
      pendingActionStore.resolveRequest(sessionId, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this prompt can never be answered — retire
        // its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(sessionId, requestId);
        setError(sessionGoneMessage(), { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSudoSubmitting((current) => withoutKey(current, requestId));
    }
  }

  // Secret entry: the value arrives here only to be handed to the gateway via
  // the typed secret.respond method, and is never stored, logged, or placed on
  // an event. The optimistic secret.response carries ONLY a `provided` flag.
  async function respondToSecret(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    value: string,
    unrestricted = false,
  ) {
    setSecretSubmitting((current) => ({ ...current, [requestId]: true }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSecret({
        sessionId,
        requestId,
        value,
      });
      pushLiveEvent(liveEventKey, {
        type: "secret.response",
        session_id: sessionId,
        payload: { request_id: requestId, provided: true },
      });
      // Feature 04: the user provided the secret — clear its pending record.
      pendingActionStore.resolveRequest(sessionId, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this secret prompt can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(sessionId, requestId);
        setError(sessionGoneMessage(), { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSecretSubmitting((current) => withoutKey(current, requestId));
    }
  }

  return {
    approvalSubmitting,
    clarifySubmitting,
    sudoSubmitting,
    secretSubmitting,
    respondToApproval,
    respondToClarify,
    respondToSudo,
    respondToSecret,
  };
}

export type SessionApprovals = ReturnType<typeof useSessionApprovals>;
