import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CarpeDiemGate } from "../components/carpe-diem/CarpeDiemGate";
import type { AccountStatus } from "../lib/account";

/**
 * The phone's first screen asks whether you have used Sub Rosa before.
 *
 * A signed-in person on an iPhone was stuck on it: the account panel sat
 * folded above the key form, the page could not scroll, and opening the vault
 * never brought the key down. Only a button further down did, behind a sync
 * consent form. The returning path now opens the vault and the key follows.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hasApiKey: false,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("../lib/mobile", () => ({
  isMobilePlatform: () => true,
  supportsNativePasskeys: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/tauri", () => ({
  openExternalUrl: vi.fn(),
  carpeDiemRestartSidecar: vi.fn(() => Promise.resolve()),
  carpeDiemGetSettings: vi.fn(async () => ({ hasApiKey: mocks.hasApiKey })),
}));
vi.mock("../components/settings/CarpeDiemSettings", () => ({
  SIDECAR_STATUS_EVENT: "carpe-diem://sidecar-status",
  CarpeDiemSettings: ({ firstRun }: { firstRun?: boolean }) => (
    <div data-testid="settings" data-first-run={firstRun ? "true" : "false"} />
  ),
}));

const signedIn: AccountStatus = {
  default_server_url: "https://subrosa.furetier.com",
  server_url: "https://subrosa.furetier.com",
  account: { id: "account-1", email: "person@example.com", created_at: "2026-09-14T09:00:00Z" },
  device_id: "device-1",
  connection: "connected",
  device_authorized: true,
  login_pending: false,
  pairing_pending: false,
  vault_unlocked: false,
  vault_exists: true,
  recovery_confirmed: false,
  recovery_available: false,
  sync_enabled: false,
  pending_changes: 0,
  conflicts: 0,
  last_synced_at: null,
};

let state: AccountStatus;
let restore: () => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.hasApiKey = false;
  state = { ...signedIn };
  restore = async () => undefined;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "account_status") return state;
    if (command === "account_vault_restore_carpe_diem") return restore();
    if (command === "account_vault_unlock") {
      state = { ...state, vault_unlocked: true, recovery_confirmed: true };
      return state;
    }
    if (command === "account_devices") return [];
    if (command === "account_sync_conflicts") return [];
    if (command === "account_login_pending") return null;
    return undefined;
  });
});

const restoreCalls = () =>
  mocks.invoke.mock.calls.filter(([command]) => command === "account_vault_restore_carpe_diem")
    .length;

describe("the phone's welcome", () => {
  it("asks which path before showing any control", () => {
    render(<CarpeDiemGate reason="no-key" />);

    expect(screen.getByRole("heading", { name: "Welcome to Sub Rosa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I already use Sub Rosa/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I am new here/ })).toBeInTheDocument();
    expect(screen.queryByTestId("settings")).toBeNull();
    expect(screen.queryByText("Create a Sub Rosa account or sign in")).toBeNull();
  });

  it("takes a new person to the key, with the endpoint folded away, and back", () => {
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(screen.getByRole("button", { name: /I am new here/ }));

    expect(screen.getByRole("heading", { name: "Start with your key" })).toBeInTheDocument();
    expect(screen.getByTestId("settings")).toHaveAttribute("data-first-run", "true");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /I am new here/ })).toBeInTheDocument();
  });

  it("keeps the failed-engine screen as it was", () => {
    render(<CarpeDiemGate reason="failed" />);
    expect(screen.getByRole("heading", { name: "Sub Rosa could not start" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /I am new here/ })).toBeNull();
  });
});

describe("the returning path", () => {
  const openReturning = () => {
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(screen.getByRole("button", { name: /I already use Sub Rosa/ }));
  };

  it("shows only what opening the vault needs", async () => {
    openReturning();

    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open your vault" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock your vault" })).toBeInTheDocument();
    for (const later of ["Sync your work", "Your devices", "Delete your account"]) {
      expect(screen.queryByText(later)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Enable encrypted sync" })).toBeNull();
  });

  it("brings the key back once, as soon as the vault opens", async () => {
    openReturning();
    const field = await screen.findByLabelText("Recovery key");
    fireEvent.change(field, { target: { value: "recovery words" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock your vault" }));

    expect(
      await screen.findByText("Your key is back on this device. Sub Rosa is starting."),
    ).toBeInTheDocument();
    expect(restoreCalls()).toBe(1);

    // A later status refresh must not restore a second time.
    await act(async () => {
      mocks.listeners.get("subrosa://sync-updated")?.({ payload: undefined });
    });
    expect(restoreCalls()).toBe(1);
  });

  it("does not replace a key this device already holds", async () => {
    mocks.hasApiKey = true;
    state = { ...signedIn, vault_unlocked: true, recovery_confirmed: true };
    openReturning();
    await screen.findByText("person@example.com");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_status"));
    expect(restoreCalls()).toBe(0);
  });

  it("says where to share the key when the vault has none, and offers a way out", async () => {
    state = { ...signedIn, vault_unlocked: true, recovery_confirmed: true };
    restore = async () => {
      throw { code: "vault_credential_missing", message: "missing" };
    };
    openReturning();

    expect(await screen.findByText(/Your vault does not hold a Carpe Diem key yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Paste a key instead" }));
    expect(screen.getByRole("heading", { name: "Start with your key" })).toBeInTheDocument();
  });

  it("points an account with no vault to the key path", async () => {
    state = { ...signedIn, vault_exists: false };
    openReturning();

    expect(await screen.findByText("No vault on this account yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start with a key" }));
    expect(screen.getByRole("heading", { name: "Start with your key" })).toBeInTheDocument();
  });
});
