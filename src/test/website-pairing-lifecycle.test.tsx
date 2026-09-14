import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PairApproval, PairReceiver } from "../../website/src/pages/pairing";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  decodedKey: new Uint8Array(32),
}));
vi.mock("../../website/src/lib/api", () => ({ api: mocks.api }));
vi.mock("../../website/src/lib/vault", () => ({
  encrypt: mocks.encrypt,
  decrypt: mocks.decrypt,
  encode: (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ""),
  decode: (value: string) =>
    value === "returned-key"
      ? mocks.decodedKey
      : Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
          c.charCodeAt(0),
        ),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.decodedKey.fill(7);
});

describe("browser pairing lifecycle", () => {
  it("never reopens a vault if the receiver unmounts while awaiting acknowledgement", async () => {
    const ack = deferred<unknown>();
    mocks.api.mockImplementation((_path: string, options?: RequestInit) => {
      if (options?.method === "POST") return Promise.resolve({});
      if (options?.method === "DELETE") return ack.promise;
      return Promise.resolve({ envelope: "encrypted", expires_at: "2099-01-01" });
    });
    mocks.decrypt.mockResolvedValue({ v: 1, key: "returned-key" });
    const opened = vi.fn();
    const view = render(<PairReceiver accountId="account-a" onOpen={opened} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect using another device" }));
    await waitFor(() =>
      expect(mocks.api.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(true),
    );
    view.unmount();
    await act(async () => ack.resolve({}));
    expect(opened).not.toHaveBeenCalled();
    expect(mocks.decodedKey.every((byte) => byte === 0)).toBe(true);
    expect(mocks.api.mock.calls.find((c) => c[1]?.method === "DELETE")?.[1].signal.aborted).toBe(
      true,
    );
  });
  it("does not start polling if creation finishes after unmount", async () => {
    const create = deferred<unknown>();
    mocks.api.mockReturnValue(create.promise);
    const opened = vi.fn();
    const view = render(<PairReceiver accountId="account-a" onOpen={opened} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect using another device" }));
    view.unmount();
    await act(async () => create.resolve({}));
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][1].signal.aborted).toBe(true);
    expect(opened).not.toHaveBeenCalled();
  });
  it("does not send an approval encrypted before the authorizer was locked", async () => {
    const encrypted = deferred<string>();
    mocks.encrypt.mockReturnValue(encrypted.promise);
    const account = "11111111-1111-4111-8111-111111111111";
    const code =
      "srpair1." +
      btoa(
        JSON.stringify({
          account_id: account,
          request_id: "22222222-2222-4222-8222-222222222222",
          secret: btoa("x".repeat(32)).replaceAll("=", ""),
        }),
      ).replaceAll("=", "");
    const view = render(<PairApproval accountId={account} vaultKey={new Uint8Array(32)} />);
    await userEvent.type(screen.getByLabelText("Pairing code"), code);
    await userEvent.click(screen.getByRole("button", { name: "Authorize this device" }));
    await waitFor(() => expect(mocks.encrypt).toHaveBeenCalledOnce());
    const secret = mocks.encrypt.mock.calls[0][0] as Uint8Array;
    view.unmount();
    await act(async () => encrypted.resolve("envelope"));
    expect(mocks.api).not.toHaveBeenCalled();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });
});
