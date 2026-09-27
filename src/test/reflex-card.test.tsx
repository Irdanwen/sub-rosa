import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReflexCard } from "../components/settings/ReflexCard";

const mocks = vi.hoisted(() => ({ reflexSettings: vi.fn(), setReflexSettings: vi.fn() }));

vi.mock("../lib/reflex", () => ({
  reflexSettings: mocks.reflexSettings,
  setReflexSettings: mocks.setReflexSettings,
}));

describe("ReflexCard", () => {
  beforeEach(() => {
    mocks.reflexSettings.mockReset();
    mocks.setReflexSettings.mockReset();
  });

  it("says where the requests go and turns the setting off through the bridge", async () => {
    mocks.reflexSettings.mockResolvedValue({ enabled: true });
    mocks.setReflexSettings.mockResolvedValue({ enabled: false });
    render(<ReflexCard />);
    const toggle = await screen.findByRole("switch", {
      name: "Check relevance with quick decisions",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/leave the Carpe Diem enclave/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setReflexSettings).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("stays quiet on a bridge without the command", async () => {
    mocks.reflexSettings.mockResolvedValue(undefined);
    render(<ReflexCard />);
    const toggle = await screen.findByRole("switch", {
      name: "Check relevance with quick decisions",
    });
    expect(toggle).toBeDisabled();
  });
});
