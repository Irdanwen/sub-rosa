/**
 * What a chat turn costs, priced from the operator's own table.
 *
 * Not an ideal source, but the only one left. The sidecar used to total the
 * price the operator returned with every settled turn
 * (`carpe_cost_usdc_micro`); the operator stopped publishing it, so that total
 * is now a sum of nothing and reads as $0.00 over a session that spent real
 * money. Measured 2026-08-28 across four models and both rails: `usage` comes
 * back with the OpenAI-standard token counts and nothing else.
 *
 * So the cost is computed here instead, and labelled as the estimate it is.
 * The prices are the operator's own, multiplier already applied - the same
 * multiplier the sidebar shows beside the credit balance - so this tracks what
 * is actually charged rather than a list price.
 */

import { invoke } from "@tauri-apps/api/core";

export interface TextPrice {
  model: string;
  /** USD per million prompt tokens. */
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  /** Prompt tokens the operator served from its cache, when it prices them
   * apart. */
  cachedInputUsdPerMtok?: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/** One fetch per app run, shared by every caller. The table changes about as
 * often as the catalog does, and re-reading it per panel open is waste. */
let inflight: Promise<TextPrice[]> | null = null;

export function textPricing(): Promise<TextPrice[]> {
  if (!inflight) {
    inflight = invoke<TextPrice[]>("carpe_diem_text_pricing").catch(() => {
      // No key, no network, a Venice-direct key: the panel simply has no
      // estimate to show, which it already knows how to render.
      inflight = null;
      return [];
    });
  }
  return inflight;
}

/** Forget the cached table (a key or base URL change makes it stale). */
export function forgetTextPricing(): void {
  inflight = null;
}

export function priceFor(model: string | undefined, prices: TextPrice[]): TextPrice | undefined {
  if (!model) return undefined;
  return prices.find((price) => price.model === model);
}

/**
 * What these tokens cost at this model's prices, in USD.
 *
 * `cachedTokens` is subtracted from the prompt and billed at the cache rate
 * when the model publishes one: on a long agent session most of the prompt is
 * re-sent context, and pricing it all at the full input rate overstates the
 * bill several times over. Undefined when the model is not in the table -
 * guessing a price is worse than saying nothing.
 */
export function estimateCostUsd(
  usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number },
  price: TextPrice | undefined,
): number | undefined {
  if (!price) return undefined;
  const prompt = Math.max(0, usage.promptTokens ?? 0);
  const completion = Math.max(0, usage.completionTokens ?? 0);
  if (prompt === 0 && completion === 0) return undefined;
  const cached = Math.min(prompt, Math.max(0, usage.cachedTokens ?? 0));
  const cachedRate = price.cachedInputUsdPerMtok ?? price.inputUsdPerMtok;
  const usd =
    ((prompt - cached) * price.inputUsdPerMtok +
      cached * cachedRate +
      completion * price.outputUsdPerMtok) /
    TOKENS_PER_MILLION;
  return usd;
}
