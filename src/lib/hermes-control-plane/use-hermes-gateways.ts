/**
 * The gateways a surface talks to and the live runtime id each stored session
 * is keyed by (ADR-0016, the resolver addendum).
 *
 * One gateway client per write-access mode: the sandboxed and unrestricted
 * runtime processes run side by side, each with its own socket, and a session
 * routes to the gateway matching its recorded mode. Every RPC a session makes
 * is keyed by its RUNTIME session id, which `resolveRuntimeSession` owns: memo,
 * resume, eviction, and the one-directional fallback to the sandboxed runtime.
 */
import { useEffect, useRef, useState } from "react";
import { rememberSessionMode, sessionUnrestricted } from "../agent-session-modes";
import { messageFromError } from "../errors";
import { hermesConnectionForMode } from "../hermes-connection";
import { HermesGatewayClient } from "../hermes-gateway";
import { t } from "../i18n";
import type { HermesBridgeStatus } from "../tauri";
import { isSessionGoneError, sessionRuntimeGoneMessage } from "./session-errors";

/** What `session.create` and `session.resume` answer. */
export type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

/** The runtime's `session.active_list`, unioned over the modes that answered. */
export type RuntimeSnapshot = { live: Set<string>; reachableModes: Set<boolean> };

export type HermesGatewaysOptions = {
  /** The bridge status of this render: which runtime processes are up. */
  bridge: HermesBridgeStatus;
  /** Starts (or restarts) one mode's runtime process and returns the status. */
  startBridge: (fullMode?: boolean, workingDir?: string | null) => Promise<HermesBridgeStatus>;
  /** Runtime ids carried over from a previous mount. */
  initialRuntimeSessionIds?: Record<string, string>;
};

export function useHermesGateways({
  bridge,
  startBridge,
  initialRuntimeSessionIds,
}: HermesGatewaysOptions) {
  // One gateway client per write-access mode: the sandboxed and unrestricted
  // runtime processes run side by side, each with its own socket. Sessions
  // route to the gateway matching their recorded mode.
  const gatewaysRef = useRef<Map<boolean, HermesGatewayClient>>(new Map());
  // The gateway's close listener is registered once per client instance, so
  // it routes through this ref to always run the latest render's recovery
  // closure (see recoverFromGatewayClose in use-session-stream).
  const gatewayCloseHandlerRef = useRef((_fullMode: boolean) => {});
  const [runtimeSessionIds, setRuntimeSessionIds] = useState<Record<string, string>>(
    () => initialRuntimeSessionIds ?? {},
  );
  const runtimeSessionIdsRef = useRef(runtimeSessionIds);

  useEffect(() => {
    runtimeSessionIdsRef.current = runtimeSessionIds;
  }, [runtimeSessionIds]);

  // Returns the gateway for the given write-access mode, starting that
  // mode's runtime process if it isn't up. The two modes run side by side
  // (the sandbox is applied at spawn and can't change on a live process, so
  // per-session modes mean a process per mode) — ensuring one never touches
  // the other's process or in-flight work.
  //
  // `workingDir` is the target session's working-folder requirement, same
  // tri-state as startHermesBridge: undefined = no preference (background
  // callers must never move a runtime a session pointed at a folder), null =
  // the default workspace, string = that folder. The send path passes it; a
  // requirement that differs from the live process's folder restarts that
  // mode's runtime (the backend owns the comparison and the restart).
  async function ensureHermesGateway(fullMode = false, workingDir?: string | null) {
    let connection = hermesConnectionForMode(bridge.running ? bridge : undefined, fullMode);
    const mismatch =
      connection !== undefined &&
      workingDir !== undefined &&
      (connection.workingDir ?? null) !== workingDir;
    if (!connection || mismatch) {
      const next = await startBridge(fullMode, workingDir);
      connection = hermesConnectionForMode(next, fullMode);
      if (mismatch) {
        // The restart killed the process the mode's gateway was talking to.
        // Detach its (possibly still-open) socket so the reconnect below
        // dials the new process instead of reusing a dying connection.
        gatewaysRef.current.get(fullMode)?.close();
      }
    }
    const wsUrl = connection?.wsUrl;
    if (!wsUrl) throw new Error(t("Hermes bridge did not return a gateway URL."));
    let gateway = gatewaysRef.current.get(fullMode);
    if (!gateway) {
      gateway = new HermesGatewayClient();
      gatewaysRef.current.set(fullMode, gateway);
      // Fires only on unexpected drops — the unmount close() detaches the
      // socket first, and a superseded socket never notifies.
      gateway.onClose(() => gatewayCloseHandlerRef.current(fullMode));
    }
    await gateway.connect(wsUrl);
    return gateway;
  }

  /** Drops a stored session's memo of its live runtime id, so the next resolve
   * asks the gateway for a fresh one instead of reusing a dead process. */
  function forgetRuntimeSessionId(storedSessionId: string) {
    if (!(storedSessionId in runtimeSessionIdsRef.current)) return;
    const next = { ...runtimeSessionIdsRef.current };
    delete next[storedSessionId];
    runtimeSessionIdsRef.current = next;
    setRuntimeSessionIds(next);
  }

  function rememberRuntimeSessionId(storedSessionId: string, runtimeSessionId: string) {
    const next = { ...runtimeSessionIdsRef.current, [storedSessionId]: runtimeSessionId };
    // Written to the ref as well as state: a retry inside the same send must see
    // the new id before React re-renders.
    runtimeSessionIdsRef.current = next;
    setRuntimeSessionIds(next);
    return runtimeSessionId;
  }

  /**
   * Resolves the LIVE runtime session id a stored session's RPCs must be keyed
   * by, and the gateway that owns it.
   *
   * Every call site used to inline `cached ?? session.resume`, and none of them
   * evicted the memo when it went stale. A runtime dies between turns all the
   * time (Hermes restarted, the process reaped, the machine slept), and the
   * gateway then answers `Session not found` — so the cached id kept being
   * replayed and EVERY later send in that session failed identically until the
   * app was restarted. That is the reported "session not found" when picking a
   * conversation back up.
   *
   * `forceRefresh` skips the memo (used by a caller retrying after exactly that
   * failure). A resume that 404s is retried once on the sandboxed runtime when
   * the session is recorded as Unrestricted: each mode runs its own Hermes
   * process with its own session store, so a mis-recorded mode is otherwise
   * permanently unreachable. That fallback is deliberately one-directional —
   * resuming a sandboxed session on the Unrestricted runtime would silently
   * widen its write access, and this map's whole design is that absence means
   * sandboxed.
   */
  async function resolveRuntimeSession(
    storedSessionId: string,
    gateway: HermesGatewayClient,
    options: {
      forceRefresh?: boolean;
      acquireGateway?: (unrestricted: boolean) => Promise<HermesGatewayClient>;
    } = {},
  ): Promise<{ gateway: HermesGatewayClient; runtimeSessionId: string }> {
    if (!options.forceRefresh) {
      const cached = runtimeSessionIdsRef.current[storedSessionId];
      if (cached) return { gateway, runtimeSessionId: cached };
    }
    const resume = async (target: HermesGatewayClient) =>
      (
        await target.request<HermesRuntimeSessionResponse>("session.resume", {
          session_id: storedSessionId,
          cols: 96,
        })
      ).session_id;

    let sessionGone = false;
    try {
      const resumed = await resume(gateway);
      if (resumed)
        return { gateway, runtimeSessionId: rememberRuntimeSessionId(storedSessionId, resumed) };
    } catch (err) {
      if (!isSessionGoneError(messageFromError(err))) throw err;
      sessionGone = true;
    }

    if (sessionUnrestricted(storedSessionId)) {
      try {
        const acquire = options.acquireGateway ?? ((mode: boolean) => ensureHermesGateway(mode));
        const sandboxedGateway = await acquire(false);
        const resumed = await resume(sandboxedGateway);
        if (resumed) {
          // The sandboxed runtime owns it: correct the record so follow-ups
          // route straight there (and the session bar stops claiming a write
          // access it does not have).
          rememberSessionMode(storedSessionId, false);
          return {
            gateway: sandboxedGateway,
            runtimeSessionId: rememberRuntimeSessionId(storedSessionId, resumed),
          };
        }
      } catch {
        // Neither runtime knows it; fall through to the terminal message.
      }
    }

    forgetRuntimeSessionId(storedSessionId);
    throw new Error(
      sessionGone ? sessionRuntimeGoneMessage() : t("Hermes did not resume the session."),
    );
  }

  // Message-based reconciliation can only END a run when an assistant reply
  // eventually persists. A run that died without one (provider failure,
  // gateway drop, app quit mid-turn) — or a session wrongly resumed as
  // working from a trailing user message — would otherwise stay "working"
  // forever, leaving the menu bar stuck on "Working…". The gateway's
  // session.active_list is ground truth for what is actually running.
  async function liveRuntimeSessionsForModes(modes: boolean[]): Promise<RuntimeSnapshot> {
    let rows: Array<{ id?: string; session_key?: string; status?: string }> = [];
    const reachableModes = new Set<boolean>();
    for (const mode of modes) {
      try {
        const gateway = await ensureHermesGateway(mode);
        const response = await gateway.request<{
          sessions?: Array<{
            id?: string;
            session_key?: string;
            status?: string;
          }>;
        }>("session.active_list", {});
        rows = rows.concat(Array.isArray(response?.sessions) ? response.sessions : []);
        reachableModes.add(mode);
      } catch {
        // Can't reach this runtime — keep ITS sessions' current state rather
        // than guess, while the reachable mode still reconciles below.
      }
    }
    const live = new Set<string>();
    for (const row of rows) {
      // "idle" means the runtime session exists but isn't processing a turn.
      if (!row || row.status === "idle") continue;
      if (row.session_key) live.add(String(row.session_key));
      if (row.id) live.add(String(row.id));
    }
    return { live, reachableModes };
  }

  function runtimeSnapshotHasSession(snapshot: { live: Set<string> }, sessionId: string) {
    const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
    return (
      snapshot.live.has(sessionId) ||
      Boolean(runtimeSessionId && snapshot.live.has(runtimeSessionId))
    );
  }

  /** Closes every gateway socket (unmount). A closed client never notifies. */
  function closeGateways() {
    for (const gateway of gatewaysRef.current.values()) {
      gateway.close();
    }
  }

  return {
    gatewaysRef,
    gatewayCloseHandlerRef,
    runtimeSessionIds,
    runtimeSessionIdsRef,
    ensureHermesGateway,
    forgetRuntimeSessionId,
    rememberRuntimeSessionId,
    resolveRuntimeSession,
    liveRuntimeSessionsForModes,
    runtimeSnapshotHasSession,
    closeGateways,
  };
}

export type HermesGateways = ReturnType<typeof useHermesGateways>;
