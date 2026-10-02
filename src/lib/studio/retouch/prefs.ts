// What a retouch remembers per device: the last settings, where each session
// was left, which one was open, and instructions typed but not sent yet. All
// of it is a convenience; losing it costs a click, never a version.

const SETTINGS_KEY = "os-june:retouch-settings";
const SESSIONS_KEY = "os-june:retouch-sessions";
const OPEN_KEY = "os-june:retouch-open";
const QUEUE_KEY = "os-june:retouch-queue";
const MAX_REMEMBERED_SESSIONS = 50;

export type VariantCount = 1 | 2 | 4;

export interface RetouchSettings {
  /** Empty for the session default. */
  modelId: string;
  resolution?: string;
  quality?: string;
  /** "auto" follows the version's own shape. */
  aspectRatio: string;
  variants: VariantCount;
}

export const DEFAULT_SETTINGS: RetouchSettings = {
  modelId: "",
  aspectRatio: "auto",
  variants: 1,
};

/** An instruction typed while a retouch was rendering. Not paid for yet. */
export interface QueuedInstruction {
  id: string;
  prompt: string;
  /** Gallery ids of its references. Uploaded references are not kept across
   * a restart; the instruction then goes without them, and says so. */
  refIds: string[];
  droppedRefs?: boolean;
  settings: RetouchSettings;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are a nicety.
  }
}

export function readSettings(): RetouchSettings {
  const saved = read<Partial<RetouchSettings>>(SETTINGS_KEY, {});
  const variants = saved.variants === 2 || saved.variants === 4 ? saved.variants : 1;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    modelId: typeof saved.modelId === "string" ? saved.modelId : "",
    aspectRatio: typeof saved.aspectRatio === "string" ? saved.aspectRatio : "auto",
    variants,
  };
}

export function writeSettings(settings: RetouchSettings): void {
  write(SETTINGS_KEY, settings);
}

/** Where a session was left, so reopening it lands on the same version. */
export function readCursor(rootId: string): string | undefined {
  const sessions = read<Record<string, { cursor: string; at: number }>>(SESSIONS_KEY, {});
  return sessions[rootId]?.cursor;
}

export function writeCursor(rootId: string, cursor: string): void {
  const sessions = read<Record<string, { cursor: string; at: number }>>(SESSIONS_KEY, {});
  sessions[rootId] = { cursor, at: Date.now() };
  const kept = Object.entries(sessions)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_REMEMBERED_SESSIONS);
  write(SESSIONS_KEY, Object.fromEntries(kept));
}

export function readOpenRoot(): string | undefined {
  const value = read<string | null>(OPEN_KEY, null);
  return typeof value === "string" && value ? value : undefined;
}

export function writeOpenRoot(rootId: string | undefined): void {
  if (rootId) write(OPEN_KEY, rootId);
  else {
    try {
      window.localStorage.removeItem(OPEN_KEY);
    } catch {
      // Ignore.
    }
  }
}

export function readQueue(rootId: string): QueuedInstruction[] {
  const queues = read<Record<string, QueuedInstruction[]>>(QUEUE_KEY, {});
  const queue = queues[rootId];
  return Array.isArray(queue) ? queue.filter((item) => typeof item?.prompt === "string") : [];
}

export function writeQueue(rootId: string, queue: QueuedInstruction[]): void {
  const queues = read<Record<string, QueuedInstruction[]>>(QUEUE_KEY, {});
  if (queue.length === 0) delete queues[rootId];
  else queues[rootId] = queue;
  write(QUEUE_KEY, queues);
}
