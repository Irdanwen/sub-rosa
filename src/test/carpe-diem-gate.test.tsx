import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CarpeDiemGate } from "../components/carpe-diem/CarpeDiemGate";

/**
 * The gate has two reasons and must not confuse them.
 *
 * It greeted everyone with "Welcome to Sub Rosa, paste your key to get
 * started" -- including someone who had pasted their key months ago and whose
 * engine had just failed to start. Telling a returning user to get started,
 * when starting is precisely what failed, is the moment an app stops being
 * trusted.
 */

vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => false }));
vi.mock("../components/settings/CarpeDiemSettings", () => ({
  // The settings panel talks to the keychain; the gate's own copy is the
  // subject here, and the panel appears in both cases either way.
  CarpeDiemSettings: () => <div data-testid="settings" />,
}));

describe("the Carpe Diem gate", () => {
  it("welcomes someone who has not configured anything", () => {
    render(<CarpeDiemGate reason="no-key" />);

    expect(screen.getByRole("heading", { name: "Welcome to Sub Rosa" })).toBeInTheDocument();
    expect(screen.getByText(/Need a key\?/)).toBeInTheDocument();
  });

  it("says what happened when the engine failed", () => {
    render(<CarpeDiemGate reason="failed" />);

    expect(screen.getByRole("heading", { name: "Sub Rosa could not start" })).toBeInTheDocument();
    // The reassurance matters as much as the diagnosis: the first fear on a
    // failed launch is that the notes went with it.
    expect(screen.getByText(/Your notes are untouched/)).toBeInTheDocument();
    expect(screen.queryByText(/get started/i)).toBeNull();
  });

  it("offers the way to fix it in both cases", () => {
    const { rerender } = render(<CarpeDiemGate reason="no-key" />);
    expect(screen.getByTestId("settings")).toBeInTheDocument();

    rerender(<CarpeDiemGate reason="failed" />);
    expect(screen.getByTestId("settings")).toBeInTheDocument();
  });

  it("never guesses at a cause it does not know", () => {
    render(<CarpeDiemGate reason="failed" />);

    // The app knows the engine did not come up. It does not know why, and a
    // confident wrong cause sends someone chasing the wrong thing.
    for (const guess of [/because/i, /port/i, /firewall/i, /corrupt/i]) {
      expect(screen.queryByText(guess)).toBeNull();
    }
  });
});
