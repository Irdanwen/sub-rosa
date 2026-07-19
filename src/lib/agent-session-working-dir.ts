/**
 * Per-session record of the working folder (the user-picked directory the
 * runtime is started in, and — sandboxed — the one user folder it may
 * write). Like the write-access mode, the folder is a spawn-time property of
 * the runtime process: it can't vary across the sessions a process serves,
 * so every send restarts the mode's runtime into the target session's
 * recorded folder when they differ. Absence means the default workspace —
 * the safe direction, and what every session from before this record
 * existed gets.
 *
 * localStorage (not the backend) for the same reasons as
 * `agent-session-modes.ts`: the runtime's session store is machine-local
 * too, and the map must be readable synchronously on render for the
 * composer chip and the session-bar affordance. Paths stored here are the
 * CANONICAL paths returned by `validate_agent_working_dir`, so the mismatch
 * check against the connection's recorded folder is a plain string equality.
 */

const STORAGE_KEY = "june.agent.sessionWorkingDirs";
const RECENTS_KEY = "june.agent.recentWorkingDirs";
const RECENTS_MAX = 5;

function readMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>) {
  try {
    if (Object.keys(map).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore; worst case a follow-up runs in the default workspace — the
    // safe direction.
  }
}

/** The canonical working folder this session was created with, if any. */
export function sessionWorkingDir(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return readMap()[sessionId];
}

export function rememberSessionWorkingDir(sessionId: string, workingDir: string | null) {
  const map = readMap();
  if (workingDir) {
    map[sessionId] = workingDir;
  } else {
    delete map[sessionId];
  }
  writeMap(map);
}

export function forgetSessionWorkingDir(sessionId: string) {
  rememberSessionWorkingDir(sessionId, null);
}

/** Recently used working folders, most recent first, for the picker menu. */
export function recentWorkingDirs(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

export function pushRecentWorkingDir(workingDir: string) {
  try {
    const next = [workingDir, ...recentWorkingDirs().filter((dir) => dir !== workingDir)].slice(
      0,
      RECENTS_MAX,
    );
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Ignore; the picker just won't offer this folder as a recent.
  }
}

export function removeRecentWorkingDir(workingDir: string) {
  try {
    const next = recentWorkingDirs().filter((dir) => dir !== workingDir);
    if (next.length === 0) {
      window.localStorage.removeItem(RECENTS_KEY);
      return;
    }
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Ignore.
  }
}

/** The folder's own name — what the chip and badges show. */
export function workingDirDisplayName(workingDir: string): string {
  const trimmed = workingDir.replace(/[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
  return name || workingDir;
}
