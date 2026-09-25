import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentSessionStatusDetail,
  dispatchAgentSessionStatus,
  repeatsLastAgentSessionStatus,
} from "../lib/agent-events";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()) }));

describe("repeatsLastAgentSessionStatus", () => {
  afterEach(() => vi.clearAllMocks());

  const running = (
    overrides: Partial<AgentSessionStatusDetail> = {},
  ): AgentSessionStatusDetail => ({
    sessionId: "status-session",
    title: "Benchmark",
    status: "running",
    summary: "Thinking.",
    ...overrides,
  });

  it("recognises the same status announced again for a session", () => {
    dispatchAgentSessionStatus(running());
    expect(repeatsLastAgentSessionStatus(running())).toBe(true);
    expect(repeatsLastAgentSessionStatus(running({ summary: "Reading a file." }))).toBe(false);
  });

  it("does not swallow a new title for the same status", () => {
    // A conversation is named while it runs: the menu bar must learn the name
    // even though the status and summary did not move.
    dispatchAgentSessionStatus(running({ title: "New chat" }));
    expect(repeatsLastAgentSessionStatus(running({ title: "Benchmark results" }))).toBe(false);
  });
});
