import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  videomakerGetSettings: vi.fn(),
  videomakerSetBaseUrl: vi.fn(),
  videomakerActivate: vi.fn(),
  videomakerDeactivate: vi.fn(),
  videomakerAccountStatus: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  videomakerGetSettings: mocks.videomakerGetSettings,
  videomakerSetBaseUrl: mocks.videomakerSetBaseUrl,
  videomakerActivate: mocks.videomakerActivate,
  videomakerDeactivate: mocks.videomakerDeactivate,
  videomakerAccountStatus: mocks.videomakerAccountStatus,
}));

import {
  diemBalanceOf,
  shortAddress,
  VideomakerSettings,
} from "../components/settings/VideomakerSettings";

const settingsDto = (over: Record<string, unknown> = {}) => ({
  baseUrl: "https://studio.furetier.com",
  defaultBaseUrl: "https://studio.furetier.com",
  activated: false,
  hasCarpeDiemKey: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.videomakerGetSettings.mockResolvedValue(settingsDto());
  mocks.videomakerAccountStatus.mockResolvedValue({
    walletAddress: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
    hasKey: true,
    balance: { available_diem: 512.4 },
    quota: null,
  });
});

describe("VideomakerSettings", () => {
  it("gates activation behind an explicit consent confirmation", async () => {
    mocks.videomakerActivate.mockResolvedValue(settingsDto({ activated: true }));
    render(<VideomakerSettings />);
    const activateButton = await screen.findByRole("button", {
      name: "Activate film production",
    });
    // First click only reveals the confirmation — nothing is shared yet.
    fireEvent.click(activateButton);
    expect(mocks.videomakerActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share key and activate" }));
    await waitFor(() => expect(mocks.videomakerActivate).toHaveBeenCalledTimes(1));
  });

  it("disables activation when no Carpe Diem key is stored", async () => {
    mocks.videomakerGetSettings.mockResolvedValue(settingsDto({ hasCarpeDiemKey: false }));
    render(<VideomakerSettings />);
    const activateButton = await screen.findByRole("button", {
      name: "Activate film production",
    });
    expect(activateButton).toBeDisabled();
    expect(
      screen.getByText(/Add your Carpe Diem key in the Carpe Diem settings tab first/i),
    ).toBeInTheDocument();
  });

  it("shows the studio account and DIEM balance once activated", async () => {
    mocks.videomakerGetSettings.mockResolvedValue(
      settingsDto({
        activated: true,
        walletAddress: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
      }),
    );
    render(<VideomakerSettings />);
    expect(await screen.findByText(/0x2c75…5c23/)).toBeInTheDocument();
    expect(await screen.findByText(/512.4 DIEM available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("deactivates through the backend command", async () => {
    mocks.videomakerGetSettings.mockResolvedValue(settingsDto({ activated: true }));
    mocks.videomakerDeactivate.mockResolvedValue(settingsDto({ activated: false }));
    render(<VideomakerSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(mocks.videomakerDeactivate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Film production is off/i)).toBeInTheDocument();
  });

  it("saves a custom base URL", async () => {
    mocks.videomakerSetBaseUrl.mockResolvedValue(settingsDto({ baseUrl: "https://x.test" }));
    render(<VideomakerSettings />);
    const input = await screen.findByLabelText("Videomaker base URL");
    fireEvent.change(input, { target: { value: "https://x.test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.videomakerSetBaseUrl).toHaveBeenCalledWith("https://x.test"));
  });
});

describe("diemBalanceOf", () => {
  it("reads the first known numeric field and tolerates unknown shapes", () => {
    expect(diemBalanceOf({ available_diem: 12.5 })).toBe(12.5);
    expect(diemBalanceOf({ balance_diem: 3 })).toBe(3);
    expect(diemBalanceOf({ something_else: true })).toBeNull();
    expect(diemBalanceOf(null)).toBeNull();
  });
});

describe("shortAddress", () => {
  it("shortens long addresses and keeps short ones", () => {
    expect(shortAddress("0x2c7536E3605D9C16a7a3D7b1898e529396a65c23")).toBe("0x2c75…5c23");
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});
