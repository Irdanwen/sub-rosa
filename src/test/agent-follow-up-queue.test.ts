import { beforeEach, describe, expect, it } from "vitest";
import {
  loadQueuedAgentFollowUps,
  reconcileConsumedAgentFollowUp,
  saveQueuedAgentFollowUps,
} from "../lib/agent-follow-up-queue";

const queued = {
  "session-1": {
    messageId: "message-1",
    prompt: "Continue with the attachment",
    attachments: ["/tmp/brief.pdf"],
    model: "open-software/auto",
    thinkingLevel: "medium" as const,
  },
};

describe("agent follow-up queue", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives a workspace remount", () => {
    saveQueuedAgentFollowUps(queued);
    expect(loadQueuedAgentFollowUps()).toEqual(queued);
  });

  it("drops a fallback once persisted history proves steering consumed it", () => {
    expect(reconcileConsumedAgentFollowUp(queued, "session-1", ["steering:message-1"])).toEqual({});
    expect(reconcileConsumedAgentFollowUp(queued, "session-1", ["steering:other"])).toBe(queued);
  });

  it("ignores malformed stored entries", () => {
    window.localStorage.setItem(
      "june.agent.queuedFollowUps",
      JSON.stringify({ valid: queued["session-1"], invalid: { prompt: 42 } }),
    );
    expect(loadQueuedAgentFollowUps()).toEqual({ valid: queued["session-1"] });
  });
});
