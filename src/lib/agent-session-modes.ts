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

/** Tells the native side which home a session was created or resumed in. */
export function recordSessionHome(sessionId: string, unrestricted: boolean) {
  try {
    void invoke("hermes_record_session_home", {
      request: { sessionId, unrestricted },
    }).catch(() => {});
  } catch {
    // Outside the app shell (tests, the browser lab) there is no record.
  }
}

export function rememberSessionMode(sessionId: string, unrestricted: boolean) {
  recordSessionHome(sessionId, unrestricted);
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
