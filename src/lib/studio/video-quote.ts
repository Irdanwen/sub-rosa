// What a video quote is worth in credits.
//
// Carpe Diem's `/video/quote` answers with its own price since operator #481:
// `cost_usdc` (and `quote` alongside) is what `/video/queue` will charge at the
// current multiplier, and Venice's raw figure moved to `venice_quote_usd`.
// Applying the multiplier to that answer again showed every video at about
// 43 % of what it costs. A bare `quote` (Venice direct, or an operator from
// before #481) is still the provider's price and takes the multiplier.

/** The fields a video quote may carry. */
export interface VideoQuoteAnswer {
  quote?: number;
  cost_usdc?: number;
  venice_quote_usd?: number;
}

const round = (credits: number) => Math.round(credits * 100) / 100;

/** Credits a quote stands for, or undefined when it carries no price. */
export function videoQuoteCredits(
  answer: VideoQuoteAnswer | null | undefined,
  multiplier: number,
): number | undefined {
  if (!answer) return undefined;
  if (typeof answer.cost_usdc === "number" && answer.cost_usdc > 0) {
    return round(answer.cost_usdc * 100);
  }
  if (typeof answer.quote !== "number" || !(answer.quote > 0)) return undefined;
  // The operator's own price, labelled by the raw figure beside it.
  if (typeof answer.venice_quote_usd === "number") return round(answer.quote * 100);
  return round(answer.quote * 100 * multiplier);
}
