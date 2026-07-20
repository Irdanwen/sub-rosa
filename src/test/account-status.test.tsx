import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_STATUS_TIMEOUT_MS, useAccountStatus } from "../lib/account-status";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsLogout: vi.fn(),
  osAccountsStatus: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsStatus: mocks.osAccountsStatus,
}));

function StatusProbe({ forceLogoutOnMount = false }: { forceLogoutOnMount?: boolean }) {
  const { account, error, loading } = useAccountStatus({ forceLogoutOnMount });
  return (
    <div>
      <div>{account.signedIn ? "Signed in" : "Signed out"}</div>
      <div>{loading ? "Loading" : "Ready"}</div>
      {error ? <div>{error}</div> : null}
    </div>
  );
}

describe("useAccountStatus", () => {
  it("logs out before loading account status when forced on mount", async () => {
    const calls: string[] = [];
    const signedOut: AccountStatus = { signedIn: false, configured: true };
    mocks.osAccountsLogout.mockImplementation(async () => {
      calls.push("logout");
    });
    mocks.osAccountsStatus.mockImplementation(async () => {
      calls.push("status");
      return signedOut;
    });

    render(<StatusProbe forceLogoutOnMount />);

    await screen.findByText("Signed out");
    expect(mocks.osAccountsLogout.mock.calls[0]?.[0]?.clearBrowserSession).not.toBe(true);
    await waitFor(() => expect(calls).toEqual(["logout", "status"]));
  });

  it("leaves the loading gate with a retryable error when the account lookup stalls", async () => {
    vi.useFakeTimers();
    mocks.osAccountsStatus.mockImplementation(() => new Promise<AccountStatus>(() => {}));

    render(<StatusProbe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_TIMEOUT_MS);
    });

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Account status took too long. Please try again.")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
