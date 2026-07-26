import type { ThinkingLevel } from "./thinking-level";

export type QueuedAgentFollowUp = {
  messageId: string;
  prompt: string;
  attachments: string[];
  model: string;
  thinkingLevel: ThinkingLevel;
};

export type QueuedAgentFollowUps = Record<string, QueuedAgentFollowUp>;

const STORAGE_KEY = "june.agent.queuedFollowUps";

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "instant" || value === "medium" || value === "hard";
}

function queuedFollowUp(value: unknown): QueuedAgentFollowUp | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.messageId !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.model !== "string" ||
    !Array.isArray(record.attachments) ||
    !record.attachments.every((path) => typeof path === "string") ||
    !isThinkingLevel(record.thinkingLevel)
  ) {
    return undefined;
  }
  return {
    messageId: record.messageId,
    prompt: record.prompt,
    attachments: record.attachments,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
  };
}

export function loadQueuedAgentFollowUps(): QueuedAgentFollowUps {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: QueuedAgentFollowUps = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const queued = queuedFollowUp(value);
      if (sessionId && queued) result[sessionId] = queued;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveQueuedAgentFollowUps(queued: QueuedAgentFollowUps) {
  try {
    if (Object.keys(queued).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queued));
  } catch {
    // The current mounted workspace still owns the in-memory queue.
  }
}

/** Steering items are persisted as `steering:<messageId>`. Drop a restored
 * fallback once native history proves the active run consumed it. */
export function reconcileConsumedAgentFollowUp(
  queued: QueuedAgentFollowUps,
  sessionId: string,
  itemIds: readonly string[],
): QueuedAgentFollowUps {
  const current = queued[sessionId];
  if (!current || !itemIds.includes(`steering:${current.messageId}`)) return queued;
  const next = { ...queued };
  delete next[sessionId];
  return next;
}
