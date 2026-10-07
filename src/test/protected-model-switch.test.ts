// The model switch of an open desktop chat goes to the runtime's gateway
// directly; protected mode is asked first (ADR-0084 addendum).

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

import { createHermesMethods } from "../lib/hermes-control-plane";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("switching an open chat's model under protected mode", () => {
  it("never sends the switch when Rust refuses the model", async () => {
    invokeMock.mockRejectedValue({
      code: "protected_mode_model",
      message: "Protected mode blocks this model. Choose another one.",
    });
    const request = vi.fn(async () => ({}));
    await expect(
      createHermesMethods(request).switchActiveSessionModel({
        mode: "sandboxed",
        sessionId: "sess-1",
        model: "venice-uncensored@reasoning-effort=high",
      }),
    ).rejects.toMatchObject({ code: "protected_mode_model" });
    expect(invokeMock).toHaveBeenCalledWith("protected_mode_check_model", {
      model: "venice-uncensored@reasoning-effort=high",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends it once Rust allows the model", async () => {
    invokeMock.mockResolvedValue(undefined);
    const request = vi.fn(async () => ({ ok: true }));
    await createHermesMethods(request).switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "zai-org-glm-5-2",
    });
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "sess-1",
      key: "model",
      value: "zai-org-glm-5-2 --session",
    });
  });

  it("lets the switch go when the shell cannot answer: the chat proxy still refuses", async () => {
    invokeMock.mockRejectedValue(new Error("no native shell"));
    const request = vi.fn(async () => ({}));
    await createHermesMethods(request).switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "zai-org-glm-5-2",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
