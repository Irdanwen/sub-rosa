import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountSettingsSection,
  accountError,
} from "../components/settings/AccountSettingsSection";
import type { AccountStatus } from "../lib/account";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternalUrl: vi.fn(),
  carpeDiemGetSettings: vi.fn(async () => ({ hasApiKey: false })),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
/** The native side finishes a sign-in and says so; nothing here polls. */
const emit = async (event: string, payload?: unknown) => {
  await act(async () => {
    mocks.listeners.get(event)?.({ payload });
  });
};
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/tauri", () => ({
  openExternalUrl: mocks.openExternalUrl,
  // The guided step asks whether this device already holds a key.
  carpeDiemGetSettings: mocks.carpeDiemGetSettings,
}));

const local: AccountStatus = {
  default_server_url: "https://subrosa.furetier.com",
  server_url: "https://accounts.example.com",
  account: null,
  device_id: null,
  connection: "none",
  device_authorized: false,
  login_pending: false,
  pairing_pending: false,
  vault_unlocked: false,
  vault_exists: null,
  recovery_confirmed: false,
  recovery_available: false,
  sync_enabled: false,
  pending_changes: 0,
  conflicts: 0,
  last_synced_at: null,
};
const connected: AccountStatus = {
  ...local,
  account: { id: "account-1", email: "person@example.com", created_at: "2026-09-14T09:00:00Z" },
  device_id: "device-1",
  connection: "connected",
  device_authorized: true,
  vault_exists: true,
  vault_unlocked: true,
  recovery_confirmed: true,
  recovery_available: true,
};
let state: AccountStatus;
let handlers: Record<string, (args?: Record<string, unknown>) => unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  state = { ...local };
  handlers = {};
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (handlers[command]) return handlers[command](args);
    if (command === "account_status") return state;
    if (command === "account_devices")
      return [
        {
          id: "device-1",
          name: "Phone",
          created_at: "2026-09-14T09:00:00Z",
          last_seen_at: null,
          revoked_at: null,
        },
      ];
    if (command === "account_sync_conflicts") return [];
    return undefined;
  });
});
afterEach(() => vi.useRealTimers());

describe("Account settings", () => {
  it("keeps a renewable device signed in while it reconnects", async () => {
    state = { ...connected, connection: "renewable", sync_enabled: true };
    render(<AccountSettingsSection />);
    expect(
      await screen.findByText(
        "This device will reconnect automatically when the account service is available.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in or create an account" })).toBeNull();
  });

  it("opens public registration without setup or enabling sync for a new library", async () => {
    state = { ...local, server_url: null };
    handlers.account_login_open = () => ({
      request_id: "login-public",
      start_url: `${state.default_server_url}/auth/native/start?request=handle`,
      expires_at: "2099-01-01T00:00:00Z",
    });
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    const signup = await screen.findByRole("button", { name: "Sign in or create an account" });
    expect(signup).toBeEnabled();
    expect(screen.getByLabelText("Account service address")).not.toBeVisible();
    expect(mocks.invoke).not.toHaveBeenCalledWith("account_configure", expect.anything());
    await user.click(signup);
    // No code to read out: the page comes back on its own.
    expect(
      await screen.findByText("Finish signing in in your browser. This screen updates by itself."),
    ).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("account_configure", {
      serverUrl: state.default_server_url,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("account_login_open", { deviceName: "My computer" });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      `${state.default_server_url}/auth/native/start?request=handle`,
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith("account_sync_set_enabled", expect.anything());
  });

  it("keeps the existing custom service and makes its destination visible before login", async () => {
    handlers.account_login_open = () => ({
      request_id: "login-custom",
      start_url: `${local.server_url}/auth/native/start?request=handle`,
      expires_at: "2099-01-01T00:00:00Z",
    });
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    await screen.findByText(`Continue securely at ${local.server_url}.`);
    await user.click(screen.getByRole("button", { name: "Sign in or create an account" }));
    expect(
      await screen.findByText("Finish signing in in your browser. This screen updates by itself."),
    ).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("account_configure", { serverUrl: local.server_url });
  });

  it.each([
    ["sync_file_too_large", "A file exceeds the sync size limit"],
    ["sync_object_too_large", "Some content exceeds the sync size limit"],
    ["account_network", "The sync service is unavailable"],
    ["secret-in-unrecognized-server-code", "Synchronization could not finish"],
  ])("shows durable %s without reporting synchronization complete", async (code, message) => {
    state = {
      ...connected,
      sync_enabled: true,
      pending_changes: 0,
      last_synced_at: "2026-09-14T09:00:00Z",
      last_sync_error: code,
    };
    render(<AccountSettingsSection />);
    expect(
      await screen.findByText("Some items could not sync. Your local copies are preserved."),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.queryByText(/Last synced:/)).not.toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });
  it("allows pausing sync while the vault is locked", async () => {
    state = {
      ...connected,
      sync_enabled: true,
      vault_unlocked: false,
      last_sync_error: "vault_locked",
    };
    handlers.account_sync_set_enabled = () => ({ ...state, sync_enabled: false });
    render(<AccountSettingsSection />);
    const pause = await screen.findByRole("button", { name: "Pause sync" });
    expect(pause).not.toBeDisabled();
    await userEvent.click(pause);
    expect(mocks.invoke).toHaveBeenCalledWith("account_sync_set_enabled", { enabled: false });
  });

  it("shows isolated items and lets the person retry them", async () => {
    state = {
      ...connected,
      sync_enabled: true,
      sync_issue_count: 1,
      sync_issues: [
        {
          lane: "upload",
          item_id: "artifact-1",
          code: "sync_file_unavailable",
          created_at: "2026-09-14T09:00:00Z",
          label: "Meeting recording.m4a",
        },
      ],
    };
    handlers.account_sync_retry_issues = () => ({ ...state, sync_issue_count: 0, sync_issues: [] });
    render(<AccountSettingsSection />);
    expect(
      await screen.findByText("Some items could not sync. Your local copies are preserved."),
    ).toBeInTheDocument();
    expect(screen.getByText(/A file could not be read/)).toBeInTheDocument();
    expect(screen.getByText("Meeting recording.m4a")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry blocked items" }));
    expect(mocks.invoke).toHaveBeenCalledWith("account_sync_retry_issues");
  });

  it("keeps account setup optional and asks the native process to open the sign-in page", async () => {
    const user = userEvent.setup();
    handlers.account_login_open = () => ({
      request_id: "login-1",
      start_url: "https://accounts.example.com/auth/native/start?request=handle",
      expires_at: "2099-01-01T00:00:00Z",
    });
    render(<AccountSettingsSection />);
    await screen.findByLabelText("Name this device");
    await user.click(screen.getByText("Advanced settings"));
    await user.type(screen.getByLabelText("Name this device"), "My phone");
    await user.click(screen.getByRole("button", { name: "Sign in or create an account" }));
    expect(
      await screen.findByText("Finish signing in in your browser. This screen updates by itself."),
    ).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("account_login_open", { deviceName: "My phone" });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://accounts.example.com/auth/native/start?request=handle",
    );
    expect(mocks.invoke.mock.calls.some(([name]) => name === "account_sync_set_enabled")).toBe(
      false,
    );
  });

  it("finishes on the event the native side sends, without ever polling", async () => {
    const user = userEvent.setup();
    handlers.account_login_open = () => ({
      request_id: "login-1",
      start_url: "https://accounts.example.com/auth/native/start?request=handle",
      expires_at: "2099-01-01T00:00:00Z",
    });
    render(<AccountSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Sign in or create an account" }));
    await screen.findByText("Finish signing in in your browser. This screen updates by itself.");
    // The return code is spent in Rust. Nothing in this screen asks for it.
    expect(mocks.invoke.mock.calls.some(([name]) => name === "account_login_exchange")).toBe(false);
    state = { ...connected };
    await emit("subrosa://account-updated");
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
  });

  it("says plainly when a sign-in it did not start comes back", async () => {
    render(<AccountSettingsSection />);
    await screen.findByRole("button", { name: "Sign in or create an account" });
    await emit("subrosa://account-login-failed", "account_login_unsolicited");
    expect(
      await screen.findByText(
        "A sign-in finished that this app did not start. Nothing was connected.",
      ),
    ).toBeInTheDocument();
  });

  it("picks a sign-in back up after the window that started it went away", async () => {
    handlers.account_login_pending = () => ({
      request_id: "login-1",
      start_url: "https://accounts.example.com/auth/native/start?request=handle",
      expires_at: "2099-01-01T00:00:00Z",
    });
    render(<AccountSettingsSection />);
    // The same request, not a fresh one that would strand it.
    expect(
      await screen.findByText("Finish signing in in your browser. This screen updates by itself."),
    ).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "account_login_open")).toBe(false);
  });

  it("falls back to a code, polling only the opaque request id, and stops on cancellation", async () => {
    handlers.account_login_start = () => ({
      request_id: "login-1",
      verification_uri: "https://accounts.example.com/device",
      user_code: "ABCD-1234",
      expires_at: "2099-01-01T00:00:00Z",
      interval_seconds: 5,
    });
    handlers.account_login_exchange = () => Promise.reject({ code: "authorization_pending" });
    render(<AccountSettingsSection />);
    await screen.findByLabelText("Name this device");
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByText("The page did not come back?"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show me a code" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.invoke).toHaveBeenCalledWith("account_login_exchange", { requestId: "login-1" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(
      mocks.invoke.mock.calls.filter(([name]) => name === "account_login_exchange"),
    ).toHaveLength(1);
  });

  it("requires explicit consent before enabling sync and waits for native confirmation", async () => {
    state = { ...connected };
    handlers.account_sync_set_enabled = () => {
      state = { ...state, sync_enabled: true };
      return state;
    };
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    const enable = await screen.findByRole("button", { name: "Enable encrypted sync" });
    expect(enable).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(enable);
    expect(mocks.invoke).toHaveBeenCalledWith("account_sync_set_enabled", { enabled: true });
    expect(await screen.findByRole("button", { name: "Pause sync" })).toBeInTheDocument();
  });

  it("requires recovery confirmation retained by native storage before sharing or sync", async () => {
    state = { ...connected, recovery_confirmed: false };
    handlers.account_vault_recovery_kit = () => ({ recovery_key: "a-random-recovery-key" });
    handlers.account_vault_confirm_recovery = () => {
      state = { ...state, recovery_confirmed: true };
      return state;
    };
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    await screen.findByText("person@example.com");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Share this device's key" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Show my recovery key" }));
    await screen.findByLabelText("Enter the saved key to confirm");
    expect(screen.getByRole("button", { name: "I have saved my recovery key" })).toBeDisabled();
    await user.type(
      screen.getByLabelText("Enter the saved key to confirm"),
      "a-random-recovery-key",
    );
    await user.click(screen.getByRole("button", { name: "I have saved my recovery key" }));
    expect(mocks.invoke).toHaveBeenCalledWith("account_vault_confirm_recovery", {
      recoveryKey: "a-random-recovery-key",
    });
    await waitFor(() =>
      expect(screen.queryByDisplayValue("a-random-recovery-key")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
  });

  it("shares an existing key without reading credentials into JavaScript", async () => {
    state = { ...connected };
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Share this device's key" }));
    expect(mocks.invoke).toHaveBeenCalledWith("account_vault_share_carpe_diem");
    expect(
      await screen.findByText("Your saved Carpe Diem key has been shared through your vault."),
    ).toBeInTheDocument();
  });

  it("requires confirmation before replacing this device's key", async () => {
    state = { ...connected };
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Use the key from my vault" }));
    expect(
      mocks.invoke.mock.calls.some(([name]) => name === "account_vault_restore_carpe_diem"),
    ).toBe(false);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Use this key" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("account_vault_restore_carpe_diem");
  });

  it("keeps a failed account deletion visible and never reports success", async () => {
    state = { ...connected };
    handlers.account_delete = () =>
      Promise.reject({ code: "recent_auth_required", message: "secret-token" });
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Delete my account" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete my account" }),
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(await screen.findByText("Sign in again, then retry this action.")).toBeInTheDocument();
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
    expect(screen.getByText("person@example.com")).toBeInTheDocument();
  });

  it("preserves conflict copies and asks native storage to restore a separate note", async () => {
    state = { ...connected, conflicts: 1 };
    handlers.account_sync_conflicts = () => [
      { id: "conflict-1", kind: "note", object_id: "note-1", created_at: "2026-09-14T09:00:00Z" },
    ];
    const user = userEvent.setup();
    render(<AccountSettingsSection />);
    handlers.account_sync_conflict_preview = () => ({
      local_preview: "Local",
      remote_preview: "Remote",
      kind: "note",
      deleted: false,
    });
    await user.click(await screen.findByRole("button", { name: "Review versions" }));
    await user.click(await screen.findByRole("radio", { name: "Keep both as separate notes" }));
    await user.click(screen.getByRole("button", { name: "Confirm my choice" }));
    expect(mocks.invoke).toHaveBeenCalledWith("account_sync_resolve_conflict", {
      conflictId: "conflict-1",
      resolution: "copy",
    });
  });

  it("offers retry when local account status cannot load", async () => {
    handlers.account_status = () => Promise.reject(new Error("internal-secret"));
    render(<AccountSettingsSection />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("internal-secret")).not.toBeInTheDocument();
  });

  it("redacts unexpected error payloads", () => {
    expect(accountError({ code: "http_error", message: "Bearer secret" })).not.toContain("secret");
    expect(accountError({ code: "invalid_recovery_key" })).toBe(
      "This recovery key could not unlock your vault. Check it and try again.",
    );
  });
});
