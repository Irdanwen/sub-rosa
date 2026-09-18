import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const signedIn = { account: { id: "a", email: "you@example.test", created_at: "" } };

describe("watching the account", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
  });

  it("tells a watcher what every status-answering command returned", async () => {
    mocks.invoke.mockResolvedValue(signedIn);
    const { accountStatus, accountLoginExchange, accountLogout, onAccountStatus } = await import(
      "../lib/account"
    );
    const seen: unknown[] = [];
    const stop = onAccountStatus((status) => seen.push(status.account?.email ?? null));
    await accountStatus();
    await accountLoginExchange("request");
    mocks.invoke.mockResolvedValue({ account: null });
    await accountLogout();
    stop();
    await accountStatus();
    expect(seen).toEqual(["you@example.test", "you@example.test", null]);
  });

  it("says nothing when the command fails, and keeps working after", async () => {
    const { accountStatus, onAccountStatus } = await import("../lib/account");
    const seen: unknown[] = [];
    onAccountStatus(() => seen.push("called"));
    mocks.invoke.mockRejectedValueOnce(new Error("offline"));
    await expect(accountStatus()).rejects.toThrow();
    expect(seen).toEqual([]);
    mocks.invoke.mockResolvedValue(signedIn);
    await accountStatus();
    expect(seen).toEqual(["called"]);
  });
});
