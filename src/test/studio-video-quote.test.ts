// A video quote in credits (video-quote.ts): Carpe Diem answers with its own
// price since operator #481, and multiplying it again showed every video at
// about 43 % of what it costs.

import { describe, expect, it } from "vitest";
import { videoQuoteCredits } from "../lib/studio/video-quote";

describe("a video quote in credits", () => {
  it("takes Carpe Diem's own price as it is", () => {
    // Measured 2026-10-20: kling-v3-standard-motion-control, billed 30.95.
    const answer = { quote: 0.295001, cost_usdc: 0.295001, venice_quote_usd: 0.69 };
    expect(videoQuoteCredits(answer, 0.4275)).toBe(29.5);
  });
  it("still applies the multiplier to a bare provider price", () => {
    expect(videoQuoteCredits({ quote: 0.69 }, 0.4275)).toBe(29.5);
    expect(videoQuoteCredits({ quote: 0.5 }, 1)).toBe(50);
  });
  it("knows a quote with no price for what it is", () => {
    expect(videoQuoteCredits(undefined, 1)).toBeUndefined();
    expect(videoQuoteCredits({}, 1)).toBeUndefined();
    expect(videoQuoteCredits({ quote: 0 }, 1)).toBeUndefined();
  });
});
