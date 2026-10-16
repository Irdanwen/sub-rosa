import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCarpeDiemCard } from "../components/carpe-diem/AccountCarpeDiemCard";
import { DeviceKeyLine } from "../components/carpe-diem/DeviceKeyLine";

/**
 * Carpe Diem on the account page: the balance every device draws on, the
 * alert when it runs low, what each device holds and spends, and nothing
 * that points at buying where the store rules a link out.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  linkAllowed: true,
  requestAddCredits: vi.fn(),
  ensurePermission: vi.fn(async () => true),
  openDashboard: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/credits-purchase", () => ({
  usePurchaseLinksAllowed: () => mocks.linkAllowed,
}));
vi.mock("../lib/credits-events", () => ({
  requestAddCredits: mocks.requestAddCredits,
  onCreditsChanged: () => () => {},
}));
vi.mock("../lib/notifications", () => ({ ensureNotificationPermission: mocks.ensurePermission }));
vi.mock("../lib/tauri", () => ({
  carpeDiemGetCredits: () => mocks.invoke("carpe_diem_get_credits"),
  carpeDiemOpenDashboard: mocks.openDashboard,
}));

let threshold: number | null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkAllowed = true;
  threshold = null;
  mocks.invoke.mockImplementation(async (command: string, args?: { threshold?: number | null }) => {
    switch (command) {
      case "carpe_diem_get_credits":
        return { availableCredits: 1234, escrowCredits: 1234 };
      case "carpe_diem_low_balance":
        return { threshold, warned: false };
      case "carpe_diem_set_low_balance":
        threshold = args?.threshold ?? null;
        return { threshold, warned: false };
      case "carpe_diem_issued_key_health":
        return "accepted";
      default:
        return undefined;
    }
  });
});

describe("the Carpe Diem block of the account", () => {
  it("shows the balance and offers to add credits where a link may be offered", async () => {
    render(<AccountCarpeDiemCard issuedKey={false} onKeyChanged={() => undefined} />);
    expect(await screen.findByText(/1,234 credits available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    expect(mocks.requestAddCredits).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open the dashboard" }));
    expect(mocks.openDashboard).toHaveBeenCalledTimes(1);
  });

  it("points at nothing to buy where the store rules a link out", async () => {
    mocks.linkAllowed = false;
    render(<AccountCarpeDiemCard issuedKey={false} onKeyChanged={() => undefined} />);
    expect(
      await screen.findByRole("button", { name: "Balance and purchases" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the dashboard" })).toBeNull();
  });

  it("turns the low-balance alert on, asking for notifications first, and off", async () => {
    render(<AccountCarpeDiemCard issuedKey={false} onKeyChanged={() => undefined} />);
    const select = await screen.findByLabelText("Tell me when the balance runs low");
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("carpe_diem_set_low_balance", { threshold: 100 }),
    );
    expect(mocks.ensurePermission).toHaveBeenCalledWith("balance");
    await waitFor(() => expect(select).toHaveValue("100"));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("carpe_diem_set_low_balance", { threshold: null }),
    );
    expect(mocks.ensurePermission).toHaveBeenCalledTimes(1);
  });

  it("shows this device's issued key with its controls", async () => {
    render(<AccountCarpeDiemCard issuedKey onKeyChanged={() => undefined} />);
    expect(
      await screen.findByText("This device's key, linked to your account"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Renew" })).toBeInTheDocument();
  });
});

describe("a device's Carpe Diem line", () => {
  it("says nothing when Carpe Diem ties no key to the device", () => {
    const { container } = render(<DeviceKeyLine usage={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says what an active key spent, or that it no longer works", () => {
    const usage = {
      deviceId: "d1",
      active: true,
      spentCredits: 175,
      requests: 10,
      lastUsedAt: null,
    };
    const { rerender } = render(<DeviceKeyLine usage={usage} />);
    expect(screen.getByText(/Carpe Diem key active, 175 credits spent/)).toBeInTheDocument();
    rerender(<DeviceKeyLine usage={{ ...usage, spentCredits: 0 }} />);
    expect(screen.getByText(/nothing spent in the last 30 days/)).toBeInTheDocument();
    rerender(<DeviceKeyLine usage={{ ...usage, active: false }} />);
    expect(screen.getByText("Its Carpe Diem key no longer works.")).toBeInTheDocument();
  });
});
