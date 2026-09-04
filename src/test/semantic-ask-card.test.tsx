import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticAskCard, semanticSentence } from "../components/settings/SemanticAskCard";

const mocks = vi.hoisted(() => ({ askIndexStatus: vi.fn(), setAskSettings: vi.fn() }));

vi.mock("../lib/ask", () => ({
  askIndexStatus: mocks.askIndexStatus,
  setAskSettings: mocks.setAskSettings,
}));

describe("semanticSentence", () => {
  it("says what is cut and embedded, or that it is off", () => {
    expect(semanticSentence({ settings: { semantic: false }, passages: 12, embedded: 12 })).toMatch(
      /^Off\./,
    );
    expect(semanticSentence({ settings: { semantic: true }, passages: 0, embedded: 0 })).toMatch(
      /No passage cut yet/,
    );
    expect(semanticSentence({ settings: { semantic: true }, passages: 40, embedded: 40 })).toBe(
      "On. 40 passages cut from your notes, all embedded.",
    );
    expect(semanticSentence({ settings: { semantic: true }, passages: 40, embedded: 8 })).toBe(
      "On. 40 passages cut from your notes, 8 embedded so far, the rest waits for the next pass.",
    );
  });
});

describe("SemanticAskCard", () => {
  beforeEach(() => {
    mocks.askIndexStatus.mockReset();
    mocks.setAskSettings.mockReset();
  });

  it("shows the state and turns the setting off through the bridge", async () => {
    mocks.askIndexStatus.mockResolvedValue({
      settings: { semantic: true },
      passages: 3,
      embedded: 1,
    });
    mocks.setAskSettings.mockResolvedValue({
      settings: { semantic: false },
      passages: 0,
      embedded: 0,
    });
    render(<SemanticAskCard />);
    const toggle = await screen.findByRole("switch", { name: "Understand questions by meaning" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/3 passages cut/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setAskSettings).toHaveBeenCalledWith({ semantic: false }));
    expect(await screen.findByText(/^Off\./)).toBeInTheDocument();
  });

  it("stays quiet on a bridge without the command", async () => {
    mocks.askIndexStatus.mockResolvedValue(undefined);
    render(<SemanticAskCard />);
    const toggle = await screen.findByRole("switch", { name: "Understand questions by meaning" });
    expect(toggle).toBeDisabled();
  });
});
