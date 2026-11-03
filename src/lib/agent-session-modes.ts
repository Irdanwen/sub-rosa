/**
 * Per-session record of the Unrestricted opt-in. The Seatbelt write-jail is
 * applied when June's runtime process spawns, so the mode can't vary across
 * the sessions a single process serves — instead, every send restarts the
 * runtime into the target session's recorded mode when they differ. This map
 * is what makes that enforcement possible: absence means sandboxed, so
 * sessions from before this record existed fall back to the safe default.
 *
 * localStorage (not the backend) because the runtime's session store is
 * machine-local too, and the map must be readable synchronously on render
 * for the session bar's badge.
 *
 * The native side keeps its own record of the home each session lives in
 * (ADR-0140): it reads a session from that home only, so the sandboxed
 * runtime cannot stand in for a session of the unrestricted one.
 */

import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "june.agent.unrestrictedSessions";

function readStore(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, true>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, true>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore; worst case a follow-up runs sandboxed — the safe direction.
  }
}

/** Whether this session opted into Unrestricted at creation. */
export function sessionUnrestricted(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return readStore()[sessionId] === true;
}

/** Tells the native side which home a session was created or resumed in.
 * The promise rejects when it could not: the caller decides, and the failure
 * is always logged (a session left unrecorded is read from the shared home
 * when that home has it, never from the jail's in its place). */
export function recordSessionHome(sessionId: string, unrestricted: boolean): Promise<void> {
  let pending: Promise<unknown>;
  try {
    pending = invoke("hermes_record_session_home", {
      request: { sessionId, unrestricted },
    });
  } catch (error) {
    pending = Promise.reject(error);
  }
  return pending.then(
    () => undefined,
    (error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: the only trace of a failed record, the background caller swallows it
      console.error(`Could not record where the session ${sessionId} lives:`, error);
      throw error;
    },
  );
}

/** Records the home without waiting; a failure is logged by
 * {@link recordSessionHome}. */
export function recordSessionHomeInBackground(sessionId: string, unrestricted: boolean) {
  recordSessionHome(sessionId, unrestricted).catch(() => undefined);
}

export function rememberSessionMode(sessionId: string, unrestricted: boolean) {
  recordSessionHomeInBackground(sessionId, unrestricted);
  const store = readStore();
  if (unrestricted) {
    store[sessionId] = true;
  } else {
    delete store[sessionId];
  }
  writeStore(store);
}

export function forgetSessionMode(sessionId: string) {
  rememberSessionMode(sessionId, false);
}
