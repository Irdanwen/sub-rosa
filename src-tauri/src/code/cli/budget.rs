//! The run budget.
//!
//! What a run spent is what the operator metered on every completion that
//! went through this process's provider proxy (`carpe_diem::cache_stats`, fed
//! by `june_api::proxy_agent_chat_completions`), plus what earlier
//! invocations of the run spent. The runtime's own token counts are not used:
//! they know nothing of prices.
//!
//! The budget is a stop line, not a guaranteed ceiling. A completion is
//! metered once it has been read to its end, so the run notices the line only
//! after the completion that crossed it, and whatever else was in flight at
//! that moment is billed too: a run can end over its budget by what was in
//! flight. A completion cut halfway (an interrupt, a lost connection, a killed
//! process) never brings its usage frame; the operator may bill it all the
//! same, so the run says its cost is incomplete rather than pretend.

use crate::carpe_diem::cache_stats::CacheStats;
use crate::code::event::CodeEvent;

const MICRO_PER_USD: f64 = 1_000_000.0;

#[derive(Debug)]
pub struct BudgetMeter {
    limit_usd: f64,
    spent_before_usd: f64,
    /// The ledger when this invocation started: the process ledger counts
    /// from zero, but a test or a second use of the process may not.
    baseline: CacheStats,
    last_reported: Option<CacheStats>,
}

impl BudgetMeter {
    #[must_use]
    pub fn new(limit_usd: f64, spent_before_usd: f64, baseline: CacheStats) -> Self {
        Self {
            limit_usd,
            spent_before_usd,
            baseline,
            last_reported: None,
        }
    }

    #[must_use]
    pub fn limit_usd(&self) -> f64 {
        self.limit_usd
    }

    /// What the run has spent in all, at ledger `stats`.
    #[must_use]
    pub fn spent_usd(&self, stats: CacheStats) -> f64 {
        let micro = stats
            .cost_usdc_micro
            .saturating_sub(self.baseline.cost_usdc_micro);
        self.spent_before_usd + micro as f64 / MICRO_PER_USD
    }

    /// Nothing left to spend: a run whose earlier invocations already reached
    /// the budget does not start a turn.
    #[must_use]
    pub fn exhausted(&self, stats: CacheStats) -> bool {
        self.spent_usd(stats) >= self.limit_usd
    }

    /// A `usage` event when the ledger moved since the last one.
    pub fn report(&mut self, stats: CacheStats) -> Option<CodeEvent> {
        if self.last_reported == Some(stats) || stats.turns == self.baseline.turns {
            return None;
        }
        self.last_reported = Some(stats);
        let tokens = |now: u64, then: u64| now.saturating_sub(then);
        Some(CodeEvent::Usage {
            input_tokens: tokens(stats.prompt_tokens, self.baseline.prompt_tokens),
            output_tokens: tokens(stats.completion_tokens, self.baseline.completion_tokens),
            cached_tokens: tokens(stats.cached_tokens, self.baseline.cached_tokens),
            cost_usd: Some(round_usd(self.spent_usd(stats))),
            budget_usd: Some(self.limit_usd),
        })
    }

    /// A completion came without the operator's price: the budget cannot be
    /// enforced on it, and the run must say so. Checked per completion, so a
    /// free model (a price of zero, reported) passes and one unpriced
    /// completion among priced ones does not.
    #[must_use]
    pub fn unpriced(&self, stats: CacheStats) -> bool {
        let completions = stats.turns.saturating_sub(self.baseline.turns);
        let priced = stats
            .priced_turns
            .saturating_sub(self.baseline.priced_turns);
        completions > priced
    }

    /// Some completion of this invocation ended without its usage, or is
    /// still under way: what it cost is not in [`Self::spent_usd`].
    #[must_use]
    pub fn cost_incomplete(&self, stats: CacheStats) -> bool {
        stats.unmetered_streams > self.baseline.unmetered_streams || stats.open_streams > 0
    }
}

/// Dollars to the micro-dollar, so a JSON line does not carry float noise.
#[must_use]
pub fn round_usd(value: f64) -> f64 {
    (value * MICRO_PER_USD).round() / MICRO_PER_USD
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(turns: u64, cost_usdc_micro: u64) -> CacheStats {
        CacheStats {
            turns,
            prompt_tokens: turns * 1_000,
            completion_tokens: turns * 100,
            cost_usdc_micro,
            priced_turns: turns,
            ..CacheStats::default()
        }
    }

    #[test]
    fn spending_counts_earlier_invocations_and_ignores_the_baseline() {
        let meter = BudgetMeter::new(0.03, 0.01, stats(2, 5_000));
        assert!((meter.spent_usd(stats(2, 5_000)) - 0.01).abs() < 1e-12);
        assert!((meter.spent_usd(stats(4, 15_000)) - 0.02).abs() < 1e-12);
        assert!(!meter.exhausted(stats(4, 15_000)));
        assert!(meter.exhausted(stats(5, 25_000)));
    }

    #[test]
    fn a_run_already_over_its_budget_does_not_start() {
        let meter = BudgetMeter::new(1.0, 1.0, CacheStats::default());
        assert!(meter.exhausted(CacheStats::default()));
    }

    #[test]
    fn usage_is_reported_once_per_change_and_never_before_a_completion() {
        let mut meter = BudgetMeter::new(2.0, 0.5, stats(1, 1_000));
        assert_eq!(meter.report(stats(1, 1_000)), None);
        let first = meter.report(stats(2, 3_500)).unwrap();
        assert_eq!(
            first,
            CodeEvent::Usage {
                input_tokens: 1_000,
                output_tokens: 100,
                cached_tokens: 0,
                cost_usd: Some(0.5025),
                budget_usd: Some(2.0),
            }
        );
        assert_eq!(meter.report(stats(2, 3_500)), None);
        assert!(meter.report(stats(3, 4_000)).is_some());
    }

    #[test]
    fn a_completion_without_a_price_is_noticed_and_a_free_one_is_not() {
        let meter = BudgetMeter::new(1.0, 0.0, CacheStats::default());
        assert!(!meter.unpriced(CacheStats::default()));
        // A free model: priced at zero, the run goes on.
        assert!(!meter.unpriced(stats(1, 0)));
        assert!(!meter.unpriced(stats(1, 10)));
        // One completion without a price among priced ones stops it.
        let one_unpriced = CacheStats {
            priced_turns: 1,
            ..stats(2, 10)
        };
        assert!(meter.unpriced(one_unpriced));
    }

    #[test]
    fn a_cut_or_unfinished_completion_makes_the_cost_incomplete() {
        let baseline = CacheStats {
            unmetered_streams: 3,
            ..CacheStats::default()
        };
        let meter = BudgetMeter::new(1.0, 0.0, baseline);
        assert!(!meter.cost_incomplete(baseline));
        assert!(meter.cost_incomplete(CacheStats {
            unmetered_streams: 4,
            ..baseline
        }));
        assert!(meter.cost_incomplete(CacheStats {
            open_streams: 1,
            ..baseline
        }));
    }

    #[test]
    fn dollars_are_rounded_to_the_micro_dollar() {
        assert_eq!(round_usd(0.1 + 0.2), 0.3);
    }
}
