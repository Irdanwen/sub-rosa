import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionUsagePanel } from "../components/agent/SessionUsagePanel";
import { forgetReadings, hasAnyReading, parseSessionUsage } from "../lib/hermes-session-usage";

const EMPTY = () => Promise.resolve(parseSessionUsage("s1", {}));

/** The remembered readings outlive a component, which is the point of them,
 * so they also outlive a test. Every case here uses session "s1". */
beforeEach(() => forgetReadings());

describe("what the runtime does not report", () => {
  it("tells a reading apart from a runtime that has counted nothing", () => {
    expect(hasAnyReading(parseSessionUsage("s1", {}))).toBe(false);
    // What the runtime actually answers once it has dropped a session's agent
    // (`tui_gateway/server.py`, the `session.usage` method): explicit zeros,
    // never an empty object. Reading that as a real reading of zero is what
    // overwrote the panel's counters.
    expect(
      hasAnyReading(parseSessionUsage("s1", { calls: 0, input: 0, output: 0, total: 0 })),
    ).toBe(false);
    // And what it answers on a session it has just reloaded: a fresh agent, so
    // it knows its model and has counted nothing with it.
    expect(
      hasAnyReading(
        parseSessionUsage("s1", { model: "hermes-4", calls: 0, input: 0, output: 0, total: 0 }),
      ),
    ).toBe(false);
    // A live agent that has run turns is a reading, zeros in it or not.
    expect(hasAnyReading(parseSessionUsage("s1", { calls: 3, input: 0, total: 0 }))).toBe(true);
    // Older shapes report no `calls`; a counter above zero still carries.
    expect(hasAnyReading(parseSessionUsage("s1", { total: 4200 }))).toBe(true);
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

  it("keeps the last real reading when the runtime reloads the session", async () => {
    // The reported regression: leave a session alone long enough and the
    // runtime rebuilds its agent, whose counters start at zero. The panel used
    // to take that for a reading and replace 4,200 tokens with 0.
    let first = true;
    const fetchUsage = () => {
      const raw = first
        ? { model: "hermes-4", calls: 7, total: 4200 }
        : { model: "hermes-4", calls: 0, input: 0, output: 0, total: 0 };
      first = false;
      return Promise.resolve(parseSessionUsage("s1", raw));
    };
    const { rerender } = render(
      <SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    expect(await screen.findByText("hermes-4")).toBeInTheDocument();

    expect(screen.getByText((4200).toLocaleString())).toBeInTheDocument();

    // A refresh that comes back counting nothing must not blank the only
    // reading anyone has of that session.
    rerender(<SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />);
    screen.getByLabelText("Refresh usage").click();
    expect(await screen.findByText(/Showing the last reading/)).toBeInTheDocument();
    expect(screen.getByText("hermes-4")).toBeInTheDocument();
    expect(screen.getByText((4200).toLocaleString())).toBeInTheDocument();
  });

  it("still has the reading after the panel is closed and reopened", async () => {
    // Keeping it in component state only postponed the loss: the counters came
    // back on refresh and vanished again the moment the panel was dismissed,
    // which is the same complaint one gesture later.
    let reloaded = false;
    const fetchUsage = () => {
      const raw = reloaded
        ? { model: "hermes-4", calls: 0, input: 0, output: 0, total: 0 }
        : { model: "hermes-4", calls: 7, total: 4200 };
      reloaded = true;
      return Promise.resolve(parseSessionUsage("s1", raw));
    };
    const first = render(
      <SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    expect(await screen.findByText((4200).toLocaleString())).toBeInTheDocument();
    first.unmount();

    render(<SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />);
    expect(await screen.findByText(/Showing the last reading/)).toBeInTheDocument();
    expect(screen.getByText((4200).toLocaleString())).toBeInTheDocument();
  });

  it("does not report a zero it was never told", async () => {
    // A reloaded session with nothing to fall back on. The model is real and
    // stays; its counters count nothing, and "0" would claim this session
    // spent nothing rather than that nobody knows what it spent.
    const fetchUsage = () =>
      Promise.resolve(
        parseSessionUsage("s1", { model: "hermes-4", calls: 0, input: 0, output: 0, total: 0 }),
      );
    render(<SessionUsagePanel sessionId="s1" fetchUsage={fetchUsage} onClose={() => {}} />);

    expect(await screen.findByText("hermes-4")).toBeInTheDocument();
    expect(await screen.findByText(/no counters to report yet/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    // Three token metrics, all of them unknown rather than zero.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
  });
});
