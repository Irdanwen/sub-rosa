// The account's security history, read natively in the app (ADR-0049
// addendum): the same lines and words as the account site, newest first as
// Rust hands them, with the web page kept as a link.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const openMock = vi.fn(async (_url: string) => true);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../lib/tauri", () => ({
  openExternalUrl: (url: string) => openMock(url),
}));

import {
  AccountSecurityHistory,
  securityEventLabel,
} from "../components/settings/AccountSecurityHistory";

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockClear();
});

describe("the security history in the app", () => {
  it("lists what Rust returns, in its order, in the website's words", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "b",
        kind: "device_added",
        occurredAt: "2026-10-03T09:30:00Z",
        deviceName: "Morgan's iPhone",
      },
      { id: "c", kind: "a_kind_from_the_future", occurredAt: "2026-10-02T10:00:00Z" },
      { id: "a", kind: "signed_in_passkey", occurredAt: "2026-10-01T08:00:00Z" },
    ]);
    render(<AccountSecurityHistory serverUrl="https://subrosa.example.test" />);
    const items = await screen.findAllByRole("listitem");
    expect(invokeMock).toHaveBeenCalledWith("account_security_events", undefined);
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "New device connected",
      "Account activity",
      "Signed in on the website with a passkey",
    ]);
    expect(items[0].textContent).toContain("Morgan's iPhone");
    expect(items[0].querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-03T09:30:00Z");
  });

  it("keeps the web page as a link", async () => {
    invokeMock.mockResolvedValue([]);
    render(<AccountSecurityHistory serverUrl="https://subrosa.example.test" />);
    expect(await screen.findByText("Nothing recorded in the last 90 days.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open on the web" }));
    expect(openMock).toHaveBeenCalledWith("https://subrosa.example.test/account#security-history");
  });

  it("says when the list could not be read, and tries again", async () => {
    invokeMock.mockRejectedValueOnce({ code: "account_network" });
    render(<AccountSecurityHistory serverUrl={null} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "We could not load your security history",
    );
    expect(screen.queryByRole("button", { name: "Open on the web" })).toBeNull();
    invokeMock.mockResolvedValueOnce([
      { id: "x", kind: "passkey_added", occurredAt: "2026-10-05T10:00:00Z" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Passkey added")).toBeTruthy();
  });

  it("names every kind the service records like the website does", () => {
    expect(securityEventLabel("refresh_reuse_blocked")).toBe(
      "Reused session token blocked and the device signed out",
    );
    expect(securityEventLabel("sessions_reset")).toBe("All sessions ended after a service restore");
  });
});
