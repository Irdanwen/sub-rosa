import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionUsagePanel } from "../components/agent/SessionUsagePanel";
import { type CacheUsage, hasMeasuredTurns, parseCacheUsage } from "../lib/carpe-diem-cache";
import { parseSessionUsage, type SessionUsage } from "../lib/hermes-session-usage";

// The ledger's wire shape, as `carpe_diem_cache_stats` returns it.
const WARM_STATS = {
  turns: 4,
  turnsWithCacheHit: 3,
  promptTokens: 8000,
  cachedTokens: 7500,
  cacheCreationTokens: 0,
  completionTokens: 240,
  cacheSavedUsdcMicro: 41000,
  costUsdcMicro: 9100,
  hitRatio: 0.9375,
};

describe("parseCacheUsage", () => {
  it("normalizes the ledger payload", () => {
    const usage = parseCacheUsage(WARM_STATS);
    expect(usage.turns).toBe(4);
    expect(usage.turnsWithCacheHit).toBe(3);
    expect(usage.promptTokens).toBe(8000);
    expect(usage.cachedTokens).toBe(7500);
    expect(usage.hitRatio).toBeCloseTo(0.9375);
    expect(usage.savedUsd).toBeCloseTo(0.041);
    expect(usage.costUsd).toBeCloseTo(0.0091);
  });

  it("derives the rate when the ledger sent only the token counts", () => {
    const usage = parseCacheUsage({ turns: 1, promptTokens: 1000, cachedTokens: 250 });
    expect(usage.hitRatio).toBeCloseTo(0.25);
  });

  // A rate with no denominator is unknown, not zero. The UI keys off this to
  // stay hidden instead of claiming a fresh launch has a 0 % hit rate.
  it("reports an unknown rate rather than zero when nothing was measured", () => {
    const usage = parseCacheUsage({ turns: 0, promptTokens: 0, cachedTokens: 0 });
    expect(usage.hitRatio).toBeUndefined();
    expect(hasMeasuredTurns(usage)).toBe(false);
  });

  it("clamps a nonsensical split instead of rendering it", () => {
    const usage = parseCacheUsage({ turns: 1, promptTokens: 100, cachedTokens: 900 });
    expect(usage.hitRatio).toBe(1);
  });

  it("survives a shape it does not recognize", () => {
    expect(parseCacheUsage(null)).toEqual({
      turns: undefined,
      turnsWithCacheHit: undefined,
      promptTokens: undefined,
      cachedTokens: undefined,
      hitRatio: undefined,
      savedUsd: undefined,
      costUsd: undefined,
    });
    expect(hasMeasuredTurns(parseCacheUsage("nope"))).toBe(false);
  });
});

function fetchUsageFor(raw: unknown) {
  return vi.fn(
    async (sessionId: string): Promise<SessionUsage> => parseSessionUsage(sessionId, raw),
  );
}

function fetchCacheFor(raw: unknown) {
  return vi.fn(async (): Promise<CacheUsage> => parseCacheUsage(raw));
}

const GATEWAY_USAGE = {
  model: "zai-org-glm-5-2",
  usage: { prompt_tokens: 8000, completion_tokens: 240 },
};

describe("SessionUsagePanel cache block", () => {
  it("shows what the provider served from its cache", async () => {
    const fetchCacheStats = fetchCacheFor(WARM_STATS);
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsageFor(GATEWAY_USAGE)}
        fetchCacheStats={fetchCacheStats}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(fetchCacheStats).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("From cache")).toBeInTheDocument();
    expect(screen.getByText(/7,?500 \/ 8,?000 \(94%\)/)).toBeInTheDocument();
    // The saving is the provider's own number, so it sits outside the estimate.
    expect(screen.getByText("Saved by the cache")).toBeInTheDocument();
    expect(screen.getByText("$0.04")).toBeInTheDocument();
  });

  it("stays hidden until a turn has been measured", async () => {
    const fetchUsage = fetchUsageFor(GATEWAY_USAGE);
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        fetchCacheStats={fetchCacheFor({ turns: 0, promptTokens: 0, cachedTokens: 0 })}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("From cache")).not.toBeInTheDocument();
  });

  // The cache reading is a bonus; the token counts are the point. A ledger read
  // that rejects must not take the panel down with it.
  it("renders the rest of the panel when the ledger cannot be read", async () => {
    const fetchCacheStats = vi.fn(async (): Promise<CacheUsage> => {
      throw new Error("ledger unavailable");
    });
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsageFor(GATEWAY_USAGE)}
        fetchCacheStats={fetchCacheStats}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("zai-org-glm-5-2")).toBeInTheDocument();
    expect(screen.queryByText("From cache")).not.toBeInTheDocument();
  });

  // The panel predates the ledger and must keep working without it.
  it("works with no cache source at all", async () => {
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsageFor(GATEWAY_USAGE)}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("zai-org-glm-5-2")).toBeInTheDocument();
    expect(screen.queryByText("From cache")).not.toBeInTheDocument();
  });
});
