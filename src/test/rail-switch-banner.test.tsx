import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  carpeDiemGetCredits: vi.fn(),
  carpeDiemSetRail: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  carpeDiemGetCredits: mocks.carpeDiemGetCredits,
  carpeDiemSetRail: mocks.carpeDiemSetRail,
}));

import { RailSwitchBanner } from "../components/carpe-diem/RailSwitchBanner";

const emptyPrepaid = {
  availableCredits: 0,
  escrowCredits: 0,
  rail: "prepaid" as const,
  suggestSwitchTo: "credits" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RailSwitchBanner", () => {
  it("offers a one-click switch when the active rail is empty and credits are available", async () => {
    mocks.carpeDiemGetCredits.mockResolvedValue(emptyPrepaid);
    mocks.carpeDiemSetRail.mockResolvedValue({ availableCredits: 1000, rail: "credits" });
    render(<RailSwitchBanner />);
    expect(await screen.findByText(/out of funds/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to credits" }));
    await waitFor(() => expect(mocks.carpeDiemSetRail).toHaveBeenCalledWith("credits"));
    // After a successful switch the prompt hides itself.
    await waitFor(() => expect(screen.queryByText(/out of funds/i)).not.toBeInTheDocument());
  });

  it("renders nothing when no switch is suggested", async () => {
    mocks.carpeDiemGetCredits.mockResolvedValue({
      availableCredits: 1000,
      escrowCredits: 0,
      rail: "credits",
    });
    const { container } = render(<RailSwitchBanner />);
    await waitFor(() => expect(mocks.carpeDiemGetCredits).toHaveBeenCalled());
    expect(container.querySelector(".carpe-diem-rail-prompt")).toBeNull();
  });

  it("can be dismissed without switching", async () => {
    mocks.carpeDiemGetCredits.mockResolvedValue(emptyPrepaid);
    render(<RailSwitchBanner />);
    await screen.findByText(/out of funds/i);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText(/out of funds/i)).not.toBeInTheDocument());
    expect(mocks.carpeDiemSetRail).not.toHaveBeenCalled();
  });
});
