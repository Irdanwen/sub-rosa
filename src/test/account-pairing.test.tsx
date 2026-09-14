import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountPairingSection,
  pairingQrValue,
} from "../components/settings/AccountPairingSection";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => vi.clearAllMocks());

describe("device admission", () => {
  it("puts the one-time code only in a URL fragment", () => {
    const url = new URL(pairingQrValue("srpair1.secret", "https://account.example.com"));
    expect(url.pathname).toBe("/account/pair");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#srpair1.secret");
    expect(pairingQrValue("srpair1.secret", "javascript:alert(1)")).toBe("srpair1.secret");
  });
  it("shows the native generated transfer code and cancels without approving", async () => {
    invoke.mockResolvedValue({
      request_id: "r",
      transfer_code: "srpair1.secret",
      expires_at: "2099-01-01T00:00:00Z",
    });
    const user = userEvent.setup();
    render(<AccountPairingSection unlocked={false} serverUrl={null} onUnlocked={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Connect using another device" }));
    expect(await screen.findByDisplayValue("srpair1.secret")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel device request" }));
    expect(invoke).toHaveBeenCalledWith("account_pairing_cancel", { requestId: "r" });
    expect(screen.queryByDisplayValue("srpair1.secret")).not.toBeInTheDocument();
  });
  it("requires a separate approval before transferring vault access", async () => {
    invoke.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AccountPairingSection unlocked serverUrl={null} onUnlocked={vi.fn()} />);
    await user.type(
      screen.getByLabelText("Code from your new device"),
      "https://account.example.com/account/pair#srpair1.secret",
    );
    await user.click(screen.getByRole("button", { name: "Authorize this device" }));
    expect(invoke).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Authorize this device" }),
    );
    expect(invoke).toHaveBeenCalledWith("account_pairing_approve", {
      transferCode: "srpair1.secret",
    });
    expect(
      await screen.findByText("Device authorized. Return to your new device to finish connecting."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Code from your new device")).toHaveValue("");
  });
  it("keeps a failed admission pending without exposing the rejected secret", async () => {
    invoke.mockRejectedValue(new Error("secret provider error"));
    const user = userEvent.setup();
    render(<AccountPairingSection unlocked serverUrl={null} onUnlocked={vi.fn()} />);
    await user.type(screen.getByLabelText("Code from your new device"), "srpair1.secret");
    await user.click(screen.getByRole("button", { name: "Authorize this device" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Authorize this device" }),
    );
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeInTheDocument(),
    );
    expect(screen.queryByText("secret provider error")).not.toBeInTheDocument();
  });
});
