/**
 * What the operator's prompt cache did for this run of the app, normalized for
 * the UI.
 *
 * This is a SECOND usage source, deliberately separate from
 * `hermes-session-usage.ts`. That one reads the agent runtime's own accounting
 * per session; this one reads what Carpe Diem reported about the prompt cache,
 * counted in Rust across every completion both shells make. The two answer
 * different questions and neither can be derived from the other, so the panel
 * shows them side by side rather than merging them into one number.
 *
 * Defensive by design, like its sibling: unknown shape in, normalized shape
 * out, missing fields left undefined rather than guessed at.
 */

import { asRecord, pickNumber } from "./hermes-control-plane";

/** One micro-USDC is one millionth of a dollar. */
const MICRO_PER_USD = 1_000_000;

/** UI-ready prompt-cache totals. Every metric is optional: present only when
 * the ledger actually reported a usable value. */
export type CacheUsage = {
  /** Completions counted since the app started. */
  turns?: number;
  /** Completions where the operator reported a cache read. */
  turnsWithCacheHit?: number;
  /** Prompt tokens seen, cached ones included. The denominator of the rate. */
  promptTokens?: number;
  /** Prompt tokens the operator served from its cache. */
  cachedTokens?: number;
  /** 0 to 1. Undefined when nothing has been measured, which is "unknown"
   * rather than "zero percent". */
  hitRatio?: number;
  /** What the operator says the cache saved, in USD. */
  savedUsd?: number;
  /** What the operator says these turns cost, in USD. */
  costUsd?: number;
};

/** True when at least one completion has been measured, so the panel can tell
 * "no cache" apart from "nothing has run yet". */
export function hasMeasuredTurns(usage: CacheUsage): boolean {
  return (usage.turns ?? 0) > 0 && (usage.promptTokens ?? 0) > 0;
}

/**
 * Parse the raw `carpe_diem_cache_stats` result into a {@link CacheUsage}.
 *
 * `hitRatio` is recomputed from the token counts when the ledger did not send
 * one, so a future caller that only forwards the raw totals still gets a rate.
 * It is clamped to 0 to 1: an upstream reporting more cached tokens than prompt
 * tokens must not render a 340 % hit rate.
 */
export function parseCacheUsage(raw: unknown): CacheUsage {
  const root = asRecord(raw);
  const containers = [root];

  const promptTokens = pickNumber(containers, ["promptTokens", "prompt_tokens"]);
  const cachedTokens = pickNumber(containers, ["cachedTokens", "cached_tokens"]);
  const reportedRatio = pickNumber(containers, ["hitRatio", "hit_ratio"]);
  const derivedRatio =
    promptTokens !== undefined && promptTokens > 0 && cachedTokens !== undefined
      ? cachedTokens / promptTokens
      : undefined;
  const ratio = reportedRatio ?? derivedRatio;

  return {
    turns: pickNumber(containers, ["turns"]),
    turnsWithCacheHit: pickNumber(containers, ["turnsWithCacheHit", "turns_with_cache_hit"]),
    promptTokens,
    cachedTokens,
    hitRatio: ratio === undefined ? undefined : Math.min(1, Math.max(0, ratio)),
    savedUsd: usdFromMicro(
      pickNumber(containers, ["cacheSavedUsdcMicro", "cache_saved_usdc_micro"]),
    ),
    costUsd: usdFromMicro(pickNumber(containers, ["costUsdcMicro", "cost_usdc_micro"])),
  };
}

/** Micro-USDC to USD, or undefined when the field was absent. Zero stays zero:
 * "the cache saved nothing yet" is a real reading, not a missing one. */
function usdFromMicro(micro?: number): number | undefined {
  return micro === undefined ? undefined : micro / MICRO_PER_USD;
}
