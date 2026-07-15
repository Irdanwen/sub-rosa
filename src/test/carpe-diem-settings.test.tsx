import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  carpeDiemGetSettings: vi.fn(),
  carpeDiemSidecarStatus: vi.fn(),
  carpeDiemSetApiKey: vi.fn(),
  carpeDiemSetBaseUrl: vi.fn(),
  carpeDiemClearApiKey: vi.fn(),
  carpeDiemTestConnection: vi.fn(),
  carpeDiemRestartSidecar: vi.fn(),
  carpeDiemGetBilling: vi.fn(),
  carpeDiemSetRail: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  carpeDiemGetSettings: mocks.carpeDiemGetSettings,
  carpeDiemSidecarStatus: mocks.carpeDiemSidecarStatus,
  carpeDiemSetApiKey: mocks.carpeDiemSetApiKey,
  carpeDiemSetBaseUrl: mocks.carpeDiemSetBaseUrl,
  carpeDiemClearApiKey: mocks.carpeDiemClearApiKey,
  carpeDiemTestConnection: mocks.carpeDiemTestConnection,
  carpeDiemRestartSidecar: mocks.carpeDiemRestartSidecar,
  carpeDiemGetBilling: mocks.carpeDiemGetBilling,
  carpeDiemSetRail: mocks.carpeDiemSetRail,
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { CarpeDiemSettings } from "../components/settings/CarpeDiemSettings";

const settingsDto = (over: Record<string, unknown> = {}) => ({
  baseUrl: "https://carpe-diem.xyz/api/operator/v1",
  defaultBaseUrl: "https://carpe-diem.xyz/api/operator/v1",
  hasApiKey: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(() => {});
  mocks.carpeDiemGetSettings.mockResolvedValue(settingsDto());
  mocks.carpeDiemSidecarStatus.mockResolvedValue({ status: "unconfigured", hasApiKey: false });
  // Default: no billing (Venice key / unreachable) → the Payment panel hides.
  mocks.carpeDiemGetBilling.mockRejectedValue(new Error("unsupported"));
});

const billingDto = (over: Record<string, unknown> = {}) => ({
  availableCredits: 1000,
  availableUsdc: 10,
  prepaidRegistered: true,
  prepaidUsdcBalance: 0,
  rail: "auto",
  railFallback: false,
  hasPrepaidAccount: true,
  ...over,
});

describe("CarpeDiemSettings", () => {
  it("renders base URL + API key fields and a link to get a key", async () => {
    render(<CarpeDiemSettings />);
    expect(await screen.findByLabelText("Carpe Diem API key")).toBeInTheDocument();
    expect(screen.getByLabelText("Carpe Diem base URL")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get a key/i })).toBeInTheDocument();
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
  });

  it("saves the API key via the backend command", async () => {
    mocks.carpeDiemSetApiKey.mockResolvedValue(settingsDto({ hasApiKey: true }));
    render(<CarpeDiemSettings />);
    const input = await screen.findByLabelText("Carpe Diem API key");
    fireEvent.change(input, { target: { value: "cdm_test_key" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.carpeDiemSetApiKey).toHaveBeenCalledWith("cdm_test_key"));
  });

  it("shows an actionable connection test result", async () => {
    mocks.carpeDiemGetSettings.mockResolvedValue(settingsDto({ hasApiKey: true }));
    mocks.carpeDiemSidecarStatus.mockResolvedValue({
      status: "ready",
      hasApiKey: true,
      port: 51000,
    });
    mocks.carpeDiemTestConnection.mockResolvedValue({
      ok: true,
      modelCount: 6,
      message: "Connected. 6 models available.",
    });
    render(<CarpeDiemSettings />);
    const testButton = await screen.findByRole("button", { name: "Test connection" });
    fireEvent.click(testButton);
    expect(await screen.findByText("Connected. 6 models available.")).toBeInTheDocument();
  });

  it("surfaces an invalid-key error from the test", async () => {
    mocks.carpeDiemGetSettings.mockResolvedValue(settingsDto({ hasApiKey: true }));
    mocks.carpeDiemSidecarStatus.mockResolvedValue({
      status: "ready",
      hasApiKey: true,
      port: 51000,
    });
    mocks.carpeDiemTestConnection.mockResolvedValue({
      ok: false,
      code: "invalid_key",
      message: "The API key was rejected. Check that you pasted the full cdm_ key.",
    });
    render(<CarpeDiemSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/The API key was rejected/i)).toBeInTheDocument();
  });

  it("warns when the active rail is empty and switches rails to credits", async () => {
    mocks.carpeDiemGetSettings.mockResolvedValue(settingsDto({ hasApiKey: true }));
    mocks.carpeDiemGetBilling.mockResolvedValue(billingDto());
    mocks.carpeDiemSetRail.mockResolvedValue(billingDto({ rail: "credits" }));
    render(<CarpeDiemSettings />);
    // The empty-prepaid-while-credits-available warning appears (text is split
    // across nodes by interpolation, so match a single-node substring).
    expect(await screen.findByText(/is out of funds/i)).toBeInTheDocument();
    expect(screen.getByText(/switch rails below/i)).toBeInTheDocument();
    // Switching to the credits rail calls the backend.
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    await waitFor(() => expect(mocks.carpeDiemSetRail).toHaveBeenCalledWith("credits"));
  });

  it("hides the Payment panel for a key with no payment rails", async () => {
    mocks.carpeDiemGetSettings.mockResolvedValue(settingsDto({ hasApiKey: true }));
    mocks.carpeDiemGetBilling.mockRejectedValue(new Error("carpe_diem_billing_unsupported"));
    render(<CarpeDiemSettings />);
    await screen.findByRole("button", { name: "Test connection" });
    expect(screen.queryByText("Payment")).not.toBeInTheDocument();
  });
});
