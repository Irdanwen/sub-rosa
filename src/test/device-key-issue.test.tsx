import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarpeDiemGate } from "../components/carpe-diem/CarpeDiemGate";
import { CONFIRMATION_POLL_MS, DeviceKeyIssue } from "../components/carpe-diem/DeviceKeyIssue";
import type { AccountStatus } from "../lib/account";

/**
 * A new person with an email address and nothing else (ADR-0069): they create
 * the account, come back, and the phone makes its own Carpe Diem key. Carpe
 * Diem may ask them to confirm by mail first, and an old sign-in needs a fresh
 * one; each of those ends with the key and never with a dead end.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternalUrl: vi.fn(async (_url: string) => true),
  hasApiKey: false,
  keyOrigin: undefined as string | undefined,
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
  openExternalUrl: mocks.openExternalUrl,
  carpeDiemRestartSidecar: vi.fn(() => Promise.resolve()),
  carpeDiemGetSettings: vi.fn(async () => ({
    hasApiKey: mocks.hasApiKey,
    keyOrigin: mocks.keyOrigin,
  })),
}));
vi.mock("../components/settings/CarpeDiemSettings", () => ({
  SIDECAR_STATUS_EVENT: "carpe-diem://sidecar-status",
  CarpeDiemSettings: () => <div data-testid="settings" />,
}));

const base: AccountStatus = {
  default_server_url: "https://subrosa.furetier.com",
  server_url: "https://subrosa.furetier.com",
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
const signedIn: AccountStatus = {
  ...base,
  account: { id: "account-1", email: "new@example.com", created_at: "2026-09-30T09:00:00Z" },
  device_id: "device-1",
  connection: "connected",
  device_authorized: true,
};

let state: AccountStatus;
let keyIssuance: boolean;
let issue: () => Promise<unknown>;
let poll: () => Promise<unknown>;

const calls = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);
const emit = (event: string) => act(() => mocks.listeners.get(event)?.({ payload: null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.hasApiKey = false;
  mocks.keyOrigin = undefined;
  state = { ...base };
  keyIssuance = true;
  issue = async () => ({ status: "issued" });
  poll = async () => ({ status: "confirmation_required", code: "K7Q2MX" });
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "account_status":
      case "account_configure":
        return state;
      case "account_login_open":
        return {
          request_id: "0192f3c4-5d6e-7f80-9123-456789abcdef",
          start_url: "https://subrosa.furetier.com/auth/native/start?request=handle",
          expires_at: "2030-01-01T00:00:00Z",
        };
      case "account_login_pending":
        return null;
      case "account_devices":
      case "account_sync_conflicts":
        return [];
      case "carpe_diem_issuance_status":
        return { keyIssuance, fiat: true, issued: false, blockedCountries: ["US"] };
      case "carpe_diem_issue_key":
        return issue();
      case "carpe_diem_issue_poll":
        return poll();
      default:
        return undefined;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the phone's new-person path", () => {
  it("offers an email account first when Carpe Diem can make keys", async () => {
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I am new here/ }));
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I already have an account/ })).toBeInTheDocument();
  });

  it("keeps the paste path as the new-person path when it cannot", async () => {
    keyIssuance = false;
    render(<CarpeDiemGate reason="no-key" />);
    await waitFor(() => expect(calls("carpe_diem_issuance_status")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /I am new here/ }));
    expect(screen.getByRole("heading", { name: "Start with your key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /I have a Carpe Diem key/ })).toBeNull();
  });

  it("opens the registration form, not the sign-in one", async () => {
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I am new here/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create my account" }));
    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1));
    const opened = new URL(String(mocks.openExternalUrl.mock.calls[0]?.[0]));
    expect(opened.searchParams.get("intent")).toBe("signup");
    expect(opened.searchParams.get("request")).toBe("handle");
  });

  it("makes the key by itself once the person is back, with no vault", async () => {
    state = { ...signedIn, vault_exists: false };
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I am new here/ }));
    await waitFor(() => expect(calls("carpe_diem_issue_key")).toHaveLength(1));
    expect(
      await screen.findByText(
        "This device has its own key now. It draws on your account's credits.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/recovery key/i)).toBeNull();
  });

  it("never replaces a key that is already on the device", async () => {
    state = { ...signedIn, vault_exists: false };
    mocks.hasApiKey = true;
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I am new here/ }));
    expect(
      await screen.findByText("This device already has a Carpe Diem key. It stays as it is."),
    ).toBeInTheDocument();
    expect(calls("carpe_diem_issue_key")).toHaveLength(0);
  });
});

describe("the returning path", () => {
  it("prefers the vault when there is one, and offers a new key only on request", async () => {
    state = { ...signedIn, vault_exists: true };
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I already use Sub Rosa/ }));
    expect(await screen.findByText("Or create a new key for this device")).toBeInTheDocument();
    expect(calls("carpe_diem_issue_key")).toHaveLength(0);
  });

  it("makes the key directly for an account without a vault", async () => {
    state = { ...signedIn, vault_exists: false };
    render(<CarpeDiemGate reason="no-key" />);
    fireEvent.click(await screen.findByRole("button", { name: /I already use Sub Rosa/ }));
    await waitFor(() => expect(calls("carpe_diem_issue_key")).toHaveLength(1));
  });
});

describe("the device key card", () => {
  it("shows the code to confirm by mail, and finishes when it is entered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    issue = async () => ({
      status: "confirmation_required",
      code: "K7Q2MX",
      expiresAt: "2030-01-01T00:00:00Z",
      emailHint: "n***@example.com",
    });
    render(<DeviceKeyIssue autoStart />);
    expect(await screen.findByText("K7Q2MX")).toBeInTheDocument();
    expect(screen.getByText(/n\*\*\*@example.com/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL_MS);
    });
    expect(calls("carpe_diem_issue_poll")).toHaveLength(1);
    expect(screen.getByText("K7Q2MX")).toBeInTheDocument();

    poll = async () => ({ status: "issued" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL_MS);
    });
    expect(
      await screen.findByText(
        "This device has its own key now. It draws on your account's credits.",
      ),
    ).toBeInTheDocument();
  });

  it("asks for a fresh sign-in and resumes by itself when it lands", async () => {
    let attempts = 0;
    issue = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw { code: "carpe_diem_reauth_required", message: "Sign in again." };
      }
      return { status: "issued" };
    };
    const onIssued = vi.fn();
    render(<DeviceKeyIssue autoStart onIssued={onIssued} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1));
    expect(calls("carpe_diem_issue_key")).toHaveLength(1);

    emit("subrosa://account-updated");
    await waitFor(() => expect(onIssued).toHaveBeenCalledTimes(1));
    expect(calls("carpe_diem_issue_key")).toHaveLength(2);
  });

  it("does not retry on an unrelated sign-in", async () => {
    render(<DeviceKeyIssue />);
    emit("subrosa://account-updated");
    await act(async () => undefined);
    expect(calls("carpe_diem_issue_key")).toHaveLength(0);
  });

  it("says a deleted Carpe Diem account was deleted, and asks before opening a new one", async () => {
    let attempts = 0;
    issue = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: "carpe_diem_account_closed",
          message:
            "Your Carpe Diem account was deleted. Its credits are gone and cannot be refunded.",
          details: { closedAt: "2026-10-10T12:30:00.000Z" },
        };
      }
      return { status: "issued" };
    };
    const onIssued = vi.fn();
    render(<DeviceKeyIssue autoStart onIssued={onIssued} onUseKey={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Your Carpe Diem account was deleted on .*2026\. Its credits are gone and cannot be refunded\./,
    );
    // Nothing is retried, and no "try again" sends the same refusal back.
    await act(async () => undefined);
    expect(calls("carpe_diem_issue_key")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Paste a key instead" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open a new, empty account" }));
    await waitFor(() => expect(onIssued).toHaveBeenCalledTimes(1));
    const sent = calls("carpe_diem_issue_key");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.[1]).toBeUndefined();
    expect(sent[1]?.[1]).toEqual({ reactivate: true });
  });

  it("keeps the person's choice of a new account across a fresh sign-in", async () => {
    let attempts = 0;
    issue = async () => {
      attempts += 1;
      if (attempts === 1) throw { code: "carpe_diem_account_closed", message: "Deleted." };
      if (attempts === 2) throw { code: "carpe_diem_reauth_required", message: "Sign in again." };
      return { status: "issued" };
    };
    const onIssued = vi.fn();
    render(<DeviceKeyIssue autoStart onIssued={onIssued} />);
    // No readable date: the sentence without one, never the raw message.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your Carpe Diem account was deleted. Its credits are gone and cannot be refunded.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open a new, empty account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1));

    emit("subrosa://account-updated");
    await waitFor(() => expect(onIssued).toHaveBeenCalledTimes(1));
    expect(calls("carpe_diem_issue_key").map(([, args]) => args)).toEqual([
      undefined,
      { reactivate: true },
      { reactivate: true },
    ]);
  });

  it("says what failed and lets the person try again or paste a key", async () => {
    issue = async () => {
      throw { code: "carpe_diem_issue_limited", message: "Your account created several keys." };
    };
    const onUseKey = vi.fn();
    render(<DeviceKeyIssue autoStart onUseKey={onUseKey} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your account created several keys.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste a key instead" }));
    expect(onUseKey).toHaveBeenCalledTimes(1);
  });
});
