import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor, type TextPrice } from "../lib/carpe-diem-text-pricing";

// The operator's own row for this model, prices as published (multiplier
// already applied).
const FLASH: TextPrice = {
  model: "z-ai-glm-5-3-flash",
  inputUsdPerMtok: 0.1021,
  outputUsdPerMtok: 0.3405,
  cachedInputUsdPerMtok: 0.020428,
};

describe("pricing a chat turn", () => {
  it("bills cached prompt tokens at the cache rate", () => {
    // The session that prompted this: 293,056 prompt tokens of which 138,880
    // were served from cache. Charging all of them at the full input rate
    // overstates the bill by a third on a long agent thread.
    const withCache = estimateCostUsd(
      { promptTokens: 293_056, completionTokens: 1_057, cachedTokens: 138_880 },
      FLASH,
    );
    const withoutCache = estimateCostUsd({ promptTokens: 293_056, completionTokens: 1_057 }, FLASH);
    expect(withCache).toBeLessThan(withoutCache ?? 0);
    expect(withCache).toBeCloseTo(0.0189, 3);
  });

  it("says nothing rather than guessing an unlisted model", () => {
    // A price invented for a model the table does not carry would be
    // indistinguishable on screen from one that is real.
    expect(estimateCostUsd({ promptTokens: 1000 }, undefined)).toBeUndefined();
    expect(priceFor("not-in-the-table", [FLASH])).toBeUndefined();
    expect(priceFor("z-ai-glm-5-3-flash", [FLASH])).toBe(FLASH);
  });

  it("has nothing to say before a turn has run", () => {
    expect(estimateCostUsd({ promptTokens: 0, completionTokens: 0 }, FLASH)).toBeUndefined();
  });

  it("never lets a cache count exceed the prompt it came from", () => {
    // A malformed reading must not produce a negative bill.
    const usd = estimateCostUsd({ promptTokens: 100, cachedTokens: 999_999 }, FLASH);
    expect(usd).toBeGreaterThan(0);
  });
});
