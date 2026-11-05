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

  it("says when the native side could not record it, without breaking the caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockImplementationOnce(() => {
      throw new Error("no shell");
    });
    expect(() => rememberSessionMode("s-3", false)).not.toThrow();
    invoke.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    await expect(recordSessionHome("s-4", true)).rejects.toThrow("refused");
    await Promise.resolve();
    expect(logged).toHaveBeenCalledTimes(2);
    expect(String(logged.mock.calls[0][0])).toContain("s-3");
    logged.mockRestore();
  });
});
