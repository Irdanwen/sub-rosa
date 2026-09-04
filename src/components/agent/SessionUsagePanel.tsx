import { intlLocale, t } from "../../lib/i18n";
import { IconAiTokens } from "central-icons/IconAiTokens";
import { messageFromError } from "../../lib/errors";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBolt } from "central-icons/IconBolt";
import { IconCoins } from "central-icons/IconCoins";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconGauge } from "central-icons/IconGauge";
import { useCallback, useEffect, useRef, useState } from "react";
import { PROVIDER_NAME } from "../../lib/branding";
import { estimateCostUsd, priceFor, textPricing } from "../../lib/carpe-diem-text-pricing";
import { type CacheUsage, hasMeasuredTurns } from "../../lib/carpe-diem-cache";
import {
  hasAnyReading,
  lastReading,
  rememberReading,
  type SessionUsage,
  withoutCounters,
} from "../../lib/hermes-session-usage";

/**
 * Self-contained session usage / context / cost panel (feature 09). Renders the
 * metrics the gateway reports for one session: active model/provider, token
 * counts, context window fill, and an ESTIMATED cost (always labeled as an
 * estimate, never as exact), plus any per-tool/subagent cost breakdown.
 *
 * Decoupled from the gateway on purpose: it takes a `fetchUsage(sessionId)`
 * function that already normalizes the raw `session.usage` result into a
 * {@link SessionUsage} (see `parseSessionUsage`). That keeps the panel trivially
 * testable and lets feature 11's activity drawer reuse it as a tab by passing
 * the same fetcher. Missing fields degrade to "Unavailable" rather than break.
 *
 * The prompt-cache block has a SECOND source. The gateway reports the runtime's
 * own accounting, which knows nothing about the operator serving the tokens, so
 * the cache read can only come from the app's own ledger (`fetchCacheStats`).
 * It is optional: without it the panel renders exactly as it did before, and a
 * failure to read it never takes the rest of the panel down, because a cache
 * reading is nice to have and the token counts are the point.
 */
export function SessionUsagePanel({
  sessionId,
  fetchUsage,
  fetchCacheStats,
  onClose,
}: {
  sessionId: string;
  fetchUsage: (sessionId: string) => Promise<SessionUsage>;
  fetchCacheStats?: () => Promise<CacheUsage>;
  onClose: () => void;
}) {
  /** Seeded from what this run of the app already read for this session, so
   * closing the panel and reopening it does not lose the reading a reloaded
   * runtime can no longer produce. */
  const [usage, setUsage] = useState<SessionUsage | null>(
    () => lastReading(sessionId)?.usage ?? null,
  );
  const [prices, setPrices] = useState<Awaited<ReturnType<typeof textPricing>>>([]);
  /** The runtime answered with counters that count nothing: it rebuilt this
   * session's agent, or dropped it. What is on screen is the last real
   * reading, and saying when it was taken is the difference between stale
   * data and a lie. */
  const [stale, setStale] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(() => lastReading(sessionId)?.readAt ?? null);
  const [cache, setCache] = useState<CacheUsage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // The reason the fetch rejected, surfaced so the failure is honest about
  // whether the session ended, the gateway is down, or usage is unsupported —
  // each of which the user can act on differently.
  const [errorReason, setErrorReason] = useState<string | null>(null);
  // Guards against a resolve landing after unmount or after a newer refresh.
  const requestSeq = useRef(0);

  // The operator's price table, once per panel. Best-effort like the cache
  // ledger: no table, no estimate, and the panel already renders that.
  useEffect(() => {
    let cancelled = false;
    textPricing().then(
      (next) => {
        if (!cancelled) setPrices(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setStatus("loading");
    // Best-effort and independent: the cache ledger is a local read that cannot
    // fail the way a gateway round-trip can, and if it does, the panel simply
    // has no cache reading to show.
    fetchCacheStats?.().then(
      (next) => {
        if (seq === requestSeq.current) setCache(next);
      },
      () => {
        if (seq === requestSeq.current) setCache(null);
      },
    );
    fetchUsage(sessionId).then(
      (next) => {
        if (seq !== requestSeq.current) return;
        if (hasAnyReading(next)) {
          const at = Date.now();
          rememberReading(next, at);
          setUsage(next);
          setReadAt(at);
          setStale(false);
        } else {
          // Counters live on the agent, and the runtime builds a new one every
          // time it reloads a session, so they restart at zero without warning.
          // Three things follow. Keep the last reading and date it, rather than
          // blanking the only numbers anyone has. Take it from `lastReading`
          // rather than from state, which may still describe a session this
          // panel was showing a moment ago, and which a reopened panel does not
          // have at all. And keep the model live: the counters are what went
          // stale, while the runtime is reporting the model the session runs on
          // now, so a user who switched models must not read the old name.
          //
          // With nothing remembered, the model is still worth showing and its
          // zeros are not: "0 tokens" claims this session spent nothing, when
          // what is true is that nobody knows what it spent.
          const remembered = lastReading(sessionId);
          setStale(true);
          setUsage(
            remembered
              ? {
                  ...remembered.usage,
                  model: next.model ?? remembered.usage.model,
                  provider: next.provider ?? remembered.usage.provider,
                }
              : withoutCounters(next),
          );
          setReadAt(remembered?.readAt ?? null);
        }
        setStatus("ready");
      },
      (err: unknown) => {
        if (seq !== requestSeq.current) return;
        setErrorReason(messageFromError(err));
        setStatus("error");
      },
    );
  }, [fetchCacheStats, fetchUsage, sessionId]);

  // Fetch once on mount (and whenever the target session changes). Refresh is
  // an explicit user action — we do not poll.
  useEffect(() => {
    load();
    return () => {
      // Invalidate any in-flight request so it cannot setState post-unmount.
      requestSeq.current++;
    };
  }, [load]);

  return (
    <section className="agent-usage-panel" aria-label={t("Session usage")}>
      <header className="agent-usage-header">
        <span className="agent-usage-title">
          <IconGauge size={15} ariaHidden />
          {t("Usage")}
        </span>
        <div className="agent-usage-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("Refresh usage")}
            title={t("Refresh")}
            disabled={status === "loading"}
            onClick={load}
          >
            <IconArrowRotateClockwise size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Close usage")}
            title={t("Close")}
            onClick={onClose}
          >
            <IconCrossSmall size={14} />
          </button>
        </div>
      </header>

      {status === "error" ? (
        <div className="agent-usage-error" role="status">
          <p>{t("Couldn't load usage for this session.")}</p>
          {errorReason ? <p className="agent-usage-error-detail">{errorReason}</p> : null}
          <button type="button" className="agent-usage-retry" onClick={load}>
            {t("Try again")}
          </button>
        </div>
      ) : (
        <div className="agent-usage-body" aria-busy={status === "loading"}>
          {stale ? (
            <p className="agent-usage-stale" role="status">
              {readAt
                ? `The runtime has run no turn in this session since it loaded it, so its counters restarted at zero. Showing the last reading, taken at ${formatClock(readAt)}.`
                : "The runtime has run no turn in this session since it loaded it, so it has no counters to report yet."}
            </p>
          ) : null}
          <dl className="agent-usage-grid">
            <Metric label={t("Model")} value={usage?.model} />
            {/* The runtime reports no provider, and never will: it talks to the
             * local sidecar. This binary reaches one operator (ADR-0017), so
             * naming it is a fact rather than a guess. */}
            <Metric label={t("Provider")} value={usage?.provider ?? PROVIDER_NAME} />
            <Metric label={t("Prompt tokens")} value={formatCount(usage?.promptTokens)} />
            <Metric label={t("Completion tokens")} value={formatCount(usage?.completionTokens)} />
            <Metric label={t("Total tokens")} value={formatCount(usage?.totalTokens)} />
          </dl>

          <ContextMeter used={usage?.contextUsed} limit={usage?.contextLimit} />

          <CacheMeter cache={cache} />

          <CostSection
            estimatedCostUsd={
              usage?.estimatedCostUsd ??
              estimateCostUsd(
                {
                  promptTokens: usage?.promptTokens,
                  completionTokens: usage?.completionTokens,
                },
                priceFor(usage?.model, prices),
              )
            }
            toolCosts={usage?.toolCosts}
            cacheSavedUsd={cache?.savedUsd}
            spentUsd={cache?.costUsd}
            measured={cache ? hasMeasuredTurns(cache) : false}
          />
        </div>
      )}
    </section>
  );
}

/** Hours and minutes, local. The stale notice says when the reading was taken,
 * not how long ago: a duration would go stale itself between renders. */
function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
}

/** A label/value row. Empty/absent values render the sentence-case
 * "Unavailable" placeholder rather than a blank or a guessed zero. */
function Metric({ label, value }: { label: string; value?: string }) {
  const present = value !== undefined && value !== "";
  return (
    <div className="agent-usage-metric">
      <dt>{label}</dt>
      <dd data-unavailable={present ? undefined : "true"}>{present ? value : "Unavailable"}</dd>
    </div>
  );
}

/** Context window fill. Shows a proportional bar only when both used and limit
 * are known; otherwise the row still renders with an "Unavailable" reading so
 * the user sees the metric exists. */
function ContextMeter({ used, limit }: { used?: number; limit?: number }) {
  const hasBoth = used !== undefined && limit !== undefined && limit > 0;
  const pct = hasBoth ? Math.min(100, Math.max(0, (used / limit) * 100)) : null;
  const reading = hasBoth ? `${formatCount(used)} / ${formatCount(limit)}` : "Unavailable";

  return (
    <div className="agent-usage-context">
      <div className="agent-usage-context-head">
        <span className="agent-usage-context-label">{t("Context used")}</span>
        <span
          className="agent-usage-context-reading"
          data-unavailable={hasBoth ? undefined : "true"}
        >
          {reading}
          {pct !== null ? ` (${Math.round(pct)}%)` : ""}
        </span>
      </div>
      {pct !== null ? (
        <div
          className="agent-usage-bar"
          role="progressbar"
          aria-label={t("Context used")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="agent-usage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Prompt-cache block. Reads across the whole run of the app, not just this
 * session, because that is what the ledger counts and pretending otherwise
 * would be a lie about the number. Renders nothing at all when no turn has been
 * measured yet: an empty panel is honest, a "0%" hit rate is not. */
function CacheMeter({ cache }: { cache: CacheUsage | null }) {
  if (!cache || !hasMeasuredTurns(cache)) return null;

  const cached = cache.cachedTokens ?? 0;
  const prompt = cache.promptTokens ?? 0;
  const pct = cache.hitRatio === undefined ? null : Math.round(cache.hitRatio * 100);

  return (
    <div className="agent-usage-cache">
      <div className="agent-usage-cache-head">
        <span className="agent-usage-cache-label">
          <IconBolt size={14} ariaHidden />
          {t("From cache")}
        </span>
        <span className="agent-usage-cache-reading">
          {formatCount(cached)} / {formatCount(prompt)}
          {pct !== null ? ` (${pct}%)` : ""}
        </span>
      </div>
      {pct !== null ? (
        <div
          className="agent-usage-bar"
          role="progressbar"
          aria-label={t("Prompt tokens from cache")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className="agent-usage-bar-fill agent-usage-bar-fill-cache"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      <p className="agent-usage-cache-note">
        {t(
          "Prompt tokens the provider served from its cache, across every request this app has made since it started.",
        )}
      </p>
    </div>
  );
}

/** Cost block. The dollar figure is ALWAYS framed as an estimate, never exact,
 * and the per-tool breakdown (if any) is listed beneath it. */
function CostSection({
  estimatedCostUsd,
  toolCosts,
  cacheSavedUsd,
  spentUsd,
  measured,
}: {
  estimatedCostUsd?: number;
  toolCosts?: SessionUsage["toolCosts"];
  cacheSavedUsd?: number;
  /** What the operator actually billed, totalled from the per-turn metering
   * headers it returns. */
  spentUsd?: number;
  /** Whether any turn has been metered at all this run. */
  measured?: boolean;
}) {
  const hasTotal = estimatedCostUsd !== undefined;
  // Zero after real turns is not a bill of nothing: the operator stopped
  // publishing the per-turn price this figure is totalled from (`usage` now
  // carries only the OpenAI-standard token counts), so the sum of a field that
  // is never there is zero. Printing "$0.00" over 400,000 spent tokens states
  // something false with more confidence than the "Unavailable" it replaced.
  const billed = spentUsd !== undefined && spentUsd > 0;
  const silentlyZero = spentUsd === 0 && Boolean(measured);
  return (
    <div className="agent-usage-cost">
      {/* What was charged, not a reconstruction of it: the operator prices each
       * settled turn in a response header and Rust adds them up. It leads
       * because it is the only money figure here that is measured.
       *
       * It spans every request this app has made since it started, which is not
       * the session above it, and the note says so. The alternative was the
       * runtime's own estimate, which this runtime does not send and never
       * will, so the line read "Unavailable" forever. */}
      {billed ? (
        <>
          <div className="agent-usage-cost-head">
            <span className="agent-usage-cost-label">
              <IconCoins size={14} ariaHidden />
              {t("Spent since launch")}
            </span>
            <span className="agent-usage-cache-reading">{formatUsd(spentUsd)}</span>
          </div>
          <p className="agent-usage-cost-note">
            {t(
              "Charged by the provider, across every request this app has made since it started, not this session alone.",
            )}
          </p>
        </>
      ) : null}
      {silentlyZero ? (
        <>
          <div className="agent-usage-cost-head">
            <span className="agent-usage-cost-label">
              <IconCoins size={14} ariaHidden />
              {t("Spent since launch")}
            </span>
            <span className="agent-usage-cost-value" data-unavailable="true">
              {t("Not reported")}
            </span>
          </div>
          <p className="agent-usage-cost-note">
            {t(
              "The provider stopped returning a price per turn, so there is nothing to total. Your balance is what to read instead.",
            )}
          </p>
        </>
      ) : null}
      {hasTotal ? (
        <>
          <div className="agent-usage-cost-head">
            <span className="agent-usage-cost-label">
              {spentUsd === undefined ? <IconCoins size={14} ariaHidden /> : null}
              {t("Estimated cost, this session")}
            </span>
            <span className="agent-usage-cost-value">{formatUsd(estimatedCostUsd)}</span>
          </div>
          <p className="agent-usage-cost-note">
            {t(
              "At most: priced from this session's tokens at the provider's rates. Prompt tokens served from the cache cost less and are not counted apart here, so the real charge is lower.",
            )}
          </p>
        </>
      ) : null}
      {!billed && !silentlyZero && !hasTotal ? (
        <div className="agent-usage-cost-head">
          <span className="agent-usage-cost-label">
            <IconCoins size={14} ariaHidden />
            {t("Cost")}
          </span>
          <span className="agent-usage-cost-value" data-unavailable="true">
            {t("Not reported yet")}
          </span>
        </div>
      ) : null}
      {cacheSavedUsd !== undefined && cacheSavedUsd > 0 ? (
        // The one number here that is NOT an estimate: the provider reports it.
        <div className="agent-usage-cost-head">
          <span className="agent-usage-cost-label">{t("Saved by the cache")}</span>
          <span className="agent-usage-cache-reading">{formatUsd(cacheSavedUsd)}</span>
        </div>
      ) : null}
      {toolCosts && toolCosts.length > 0 ? (
        <ul className="agent-usage-tool-costs" aria-label={t("Tool and subagent costs")}>
          {toolCosts.map((cost) => (
            <li key={cost.name}>
              <span className="agent-usage-tool-name">
                <IconAiTokens size={13} ariaHidden />
                {cost.name}
              </span>
              <span
                className="agent-usage-tool-value"
                data-unavailable={cost.estimatedCostUsd === undefined ? "true" : undefined}
              >
                {cost.estimatedCostUsd !== undefined
                  ? formatUsd(cost.estimatedCostUsd)
                  : "Unavailable"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Group-format a token count, or undefined when absent (so the caller can
 * fall back to "Unavailable"). */
function formatCount(value?: number): string | undefined {
  return value === undefined ? undefined : value.toLocaleString(intlLocale());
}

/** Format a USD amount with enough precision for small per-call costs. Sub-cent
 * values keep four decimals so they don't collapse to "$0.00". */
function formatUsd(value: number): string {
  const decimals = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
}
