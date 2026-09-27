import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReflexNotice } from "../components/carpe-diem/ReflexNotice";

const mocks = vi.hoisted(() => ({ reflexSettings: vi.fn(), setReflexSettings: vi.fn() }));

vi.mock("../lib/reflex", () => ({
  reflexSettings: mocks.reflexSettings,
  setReflexSettings: mocks.setReflexSettings,
}));

describe("ReflexNotice", () => {
  beforeEach(() => {
    mocks.reflexSettings.mockReset();
    mocks.setReflexSettings.mockReset();
  });

  it("says once that checks leave the enclave, and is gone once read", async () => {
    mocks.reflexSettings.mockResolvedValue({ enabled: true, noticeSeen: false });
    mocks.setReflexSettings.mockResolvedValue({ enabled: true, noticeSeen: true });
    render(<ReflexNotice />);
    expect(await screen.findByText(/outside the Carpe Diem enclave/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() =>
      expect(mocks.setReflexSettings).toHaveBeenCalledWith({ enabled: true, noticeSeen: true }),
    );
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("turns reflexes off from the notice itself", async () => {
    mocks.reflexSettings.mockResolvedValue({ enabled: true, noticeSeen: false });
    mocks.setReflexSettings.mockResolvedValue({ enabled: false, noticeSeen: true });
    render(<ReflexNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(mocks.setReflexSettings).toHaveBeenCalledWith({ enabled: false, noticeSeen: true }),
    );
  });

  it("stays away once seen, when off, and on a bridge without the command", async () => {
    for (const answer of [{ enabled: true, noticeSeen: true }, { enabled: false }, undefined]) {
      mocks.reflexSettings.mockResolvedValue(answer);
      const view = render(<ReflexNotice />);
      await waitFor(() => expect(mocks.reflexSettings).toHaveBeenCalled());
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      view.unmount();
      mocks.reflexSettings.mockClear();
    }
  });
});
