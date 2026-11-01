import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { recordSessionHome, rememberSessionMode } from "../lib/agent-session-modes";

describe("the home of a session (ADR-0140)", () => {
  beforeEach(() => {
    invoke.mockClear();
    window.localStorage.clear();
  });

  it("is recorded natively when a session's mode is remembered", () => {
    rememberSessionMode("s-1", true);
    rememberSessionMode("s-2", false);
    expect(invoke).toHaveBeenCalledWith("hermes_record_session_home", {
      request: { sessionId: "s-1", unrestricted: true },
    });
    expect(invoke).toHaveBeenCalledWith("hermes_record_session_home", {
      request: { sessionId: "s-2", unrestricted: false },
    });
  });

  it("never breaks the caller when the native side is absent", () => {
    invoke.mockImplementationOnce(() => {
      throw new Error("no shell");
    });
    expect(() => recordSessionHome("s-3", false)).not.toThrow();
  });
});
