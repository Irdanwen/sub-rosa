import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionUsagePanel } from "../components/agent/SessionUsagePanel";
import { hasAnyReading, parseSessionUsage } from "../lib/hermes-session-usage";

const EMPTY = () => Promise.resolve(parseSessionUsage("s1", {}));

describe("what the runtime does not report", () => {
  it("tells an empty reading apart from a reading of zero", () => {
    // The runtime answers `{}` once it has dropped a session's agent, and a
    // session that genuinely used nothing reports zeros. Rendering both as a
    // wall of "Unavailable" is what made the panel look broken.
    expect(hasAnyReading(parseSessionUsage("s1", {}))).toBe(false);
    // A session that has genuinely spent nothing reports zeros, and that is a
    // reading: it must not be mistaken for the runtime having dropped it.
    expect(hasAnyReading(parseSessionUsage("s1", { total: 0 }))).toBe(true);
    expect(hasAnyReading(parseSessionUsage("s1", { model: "hermes-4" }))).toBe(true);
  });

  it("names the provider the binary actually reaches", async () => {
    // Never in the payload: the runtime talks to the local sidecar and reports
    // no provider at all. This binary contacts one operator (ADR-0017).
    render(<SessionUsagePanel sessionId="s1" fetchUsage={EMPTY} onClose={() => {}} />);
    expect(await screen.findByText("Carpe Diem")).toBeInTheDocument();
  });

  it("shows what was actually charged rather than an estimate it never gets", async () => {
    render(
      <SessionUsagePanel
        sessionId="s1"
        fetchUsage={EMPTY}
        fetchCacheStats={() => Promise.resolve({ costUsd: 1.25, savedUsd: 0.4 })}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Spent since launch")).toBeInTheDocument();
    // Scoped honestly: this figure is app-wide, the panel is per session.
    expect(
      await screen.findByText(/across every request this app has made since it started/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Estimated cost, this session")).not.toBeInTheDocument();
  });

  it("does not print a bill of nothing over real spending", async () => {
    // The operator stopped returning a per-turn price, so the total of a field
    // that is never there is zero. Printing "$0.00" over 400,000 spent tokens
    // is more confidently wrong than the "Unavailable" it replaced.
    render(
      <SessionUsagePanel
        sessionId="s1"
        fetchUsage={EMPTY}
        fetchCacheStats={() =>
          Promise.resolve({ turns: 12, promptTokens: 293_056, costUsd: 0, savedUsd: 0 })
        }
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Not reported")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("still shows a real charge when the provider reports one", async () => {
    render(
      <SessionUsagePanel
        sessionId="s1"
        fetchUsage={EMPTY}
        fetchCacheStats={() => Promise.resolve({ turns: 3, costUsd: 1.25 })}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("$1.25")).toBeInTheDocument();
  });

  it("keeps the last real reading when the runtime forgets the session", async () => {
    let first = true;
    const fetchUsage = () => {
      const raw = first ? { model: "hermes-4", total: 4200 } : {};
      first = false;
      return Promise.resolve(parseSessionUsage("s1", raw));
    };
    const { rerender } = render(
      <SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    expect(await screen.findByText("hermes-4")).toBeInTheDocument();

    // A refresh that comes back empty must not blank the only reading anyone
    // has of that session.
    rerender(<SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />);
    screen.getByLabelText("Refresh usage").click();
    expect(await screen.findByText(/Showing the last reading/)).toBeInTheDocument();
    expect(screen.getByText("hermes-4")).toBeInTheDocument();
  });
});
