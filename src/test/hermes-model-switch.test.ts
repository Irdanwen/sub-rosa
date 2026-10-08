import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";
import {
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
  MODEL_SWITCH_FAILED_NOTICE,
  modelSwitchSuccessNotice,
  resolveModelSwitchOutcome,
} from "../lib/hermes-model-switch";

describe("switchActiveSessionModel — typed control-plane seam", () => {
  it("switches the live session through config.set, kept to the session", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const methods = createHermesMethods(request);

    await methods.switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "kimi-k2-6",
    });

    // The pinned gateway refuses `/model` on command.dispatch (it reads only
    // name/arg there); config.set is its per-session switch, and `--session`
    // keeps the profile default untouched. The ack is the source of truth.
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "sess-1",
      key: "model",
      value: "kimi-k2-6 --session",
    });
    expect(request).not.toHaveBeenCalledWith("command.dispatch", expect.anything());
  });

  it("hands the runtime a reasoning-effort alias verbatim", async () => {
    const request = vi.fn(async () => ({}));
    await createHermesMethods(request).switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "zai-org-glm-5-2@reasoning-effort=high",
    });

    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "sess-1",
      key: "model",
      value: "zai-org-glm-5-2@reasoning-effort=high --session",
    });
  });

  it("returns the gateway result so the caller can confirm the ack", async () => {
    const request = vi.fn(async () => ({ accepted: true }));
    const methods = createHermesMethods(request);

    const result = await methods.switchActiveSessionModel({
      mode: "unrestricted",
      sessionId: "sess-2",
      model: "glm-5-2",
    });

    expect(result).toEqual({ accepted: true });
  });
});

describe("resolveModelSwitchOutcome — honest three-state decision", () => {
  it("reports an active-session switch only when the dispatch was accepted", () => {
    const outcome = resolveModelSwitchOutcome({
      hasActiveSession: true,
      dispatchSucceeded: true,
      modelName: "Kimi K2.6",
    });
    expect(outcome.state).toBe("active-session-switched");
    expect(outcome.notice).toBe(modelSwitchSuccessNotice("Kimi K2.6"));
  });

  it("reports default-only when there is no active session", () => {
    const outcome = resolveModelSwitchOutcome({
      hasActiveSession: false,
      dispatchSucceeded: false,
      modelName: "Kimi K2.6",
    });
    expect(outcome.state).toBe("default-changed");
    expect(outcome.notice).toBe(MODEL_SWITCH_DEFAULT_ONLY_NOTICE);
  });

  it("never claims success when the active-session dispatch failed", () => {
    const outcome = resolveModelSwitchOutcome({
      hasActiveSession: true,
      dispatchSucceeded: false,
      modelName: "Kimi K2.6",
    });
    expect(outcome.state).toBe("switch-failed");
    expect(outcome.notice).toBe(MODEL_SWITCH_FAILED_NOTICE);
    // The per-chat override is saved regardless, so the honest copy says this
    // chat will use the new model next time rather than the running session.
    expect(outcome.notice).toContain("next time");
    // It must NOT claim the global default moved — the open-chat path never
    // touches the default.
    expect(outcome.notice).not.toContain("default");
  });

  it("copy carries no em or en dashes", () => {
    const notices = [
      modelSwitchSuccessNotice("Kimi K2.6"),
      MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
      MODEL_SWITCH_FAILED_NOTICE,
    ];
    for (const notice of notices) {
      expect(notice).not.toMatch(/[–—]/);
    }
  });
});
