//! What the operator's prompt cache did for this run of the app.
//!
//! Carpe Diem reports, on every chat completion, how much of the prompt it
//! served from its cache and what that saved. Nothing in the app used to read
//! it: the desktop's usage panel is fed by the agent runtime's own accounting,
//! which knows nothing about the operator, and the mobile chat read no usage at
//! all. This ledger is the second source that fills that gap.
//!
//! It is deliberately an in-memory aggregate for the current run, not a table:
//! the question it answers is "is the cache working right now", which does not
//! need history, a schema, or a retention policy. It is fed from the one place
//! every completion passes through on both shells — the June API proxy — so the
//! desktop agent, the mobile chat, memory extraction, session titles and the
//! Studio briefs all count without any of them knowing about it.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Running totals since the app started. All counters saturate: a ledger is
/// never worth crashing or wrapping over.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    /// Completions observed. The denominator for "how much of this run is
    /// measured at all".
    pub turns: u64,
    /// Completions where the operator reported a cache read.
    pub turns_with_cache_hit: u64,
    /// Prompt tokens seen, cached ones included.
    pub prompt_tokens: u64,
    /// Prompt tokens the operator served from its cache.
    pub cached_tokens: u64,
    /// Prompt tokens written into the cache.
    pub cache_creation_tokens: u64,
    /// Completion tokens seen.
    pub completion_tokens: u64,
    /// What the operator says the cache saved, in micro-USDC.
    pub cache_saved_usdc_micro: u64,
    /// What the operator says these turns cost, in micro-USDC.
    pub cost_usdc_micro: u64,
}

impl CacheStats {
    /// Share of prompt tokens served from the cache, 0.0 to 1.0. `None` when no
    /// prompt tokens have been observed yet — a rate with no denominator is not
    /// "zero percent", it is "unknown", and the UI must be able to tell the
    /// difference.
    #[must_use]
    pub fn hit_ratio(self) -> Option<f64> {
        if self.prompt_tokens == 0 {
            return None;
        }
        #[allow(
            clippy::cast_precision_loss,
            reason = "a ratio of token counts does not need u64 precision"
        )]
        Some(self.cached_tokens as f64 / self.prompt_tokens as f64)
    }

    fn add(&mut self, turn: TurnUsage) {
        self.turns = self.turns.saturating_add(1);
        if turn.cached_tokens > 0 {
            self.turns_with_cache_hit = self.turns_with_cache_hit.saturating_add(1);
        }
        self.prompt_tokens = self.prompt_tokens.saturating_add(turn.prompt_tokens);
        // Clamp to the prompt total for the same reason the backend does: an
        // upstream that reports more cached tokens than prompt tokens would
        // otherwise show a hit rate above 100 %.
        self.cached_tokens = self
            .cached_tokens
            .saturating_add(turn.cached_tokens.min(turn.prompt_tokens));
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(turn.cache_creation_tokens);
        self.completion_tokens = self
            .completion_tokens
            .saturating_add(turn.completion_tokens);
        self.cache_saved_usdc_micro = self
            .cache_saved_usdc_micro
            .saturating_add(turn.cache_saved_usdc_micro);
        self.cost_usdc_micro = self.cost_usdc_micro.saturating_add(turn.cost_usdc_micro);
    }
}

/// One completion's metering, as read from the sidecar's response headers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TurnUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_saved_usdc_micro: u64,
    pub cost_usdc_micro: u64,
}

impl TurnUsage {
    /// True when the sidecar reported anything at all. A response that carries
    /// no metering headers (an error, or a build without them) must not be
    /// counted as a turn with zero tokens, which would drag the hit rate down
    /// with turns that were never measured.
    #[must_use]
    pub fn is_measured(self) -> bool {
        self.prompt_tokens > 0 || self.completion_tokens > 0
    }
}

static LEDGER: Mutex<CacheStats> = Mutex::new(CacheStats {
    turns: 0,
    turns_with_cache_hit: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    completion_tokens: 0,
    cache_saved_usdc_micro: 0,
    cost_usdc_micro: 0,
});

/// Records one completion. Never fails and never blocks the turn: a poisoned
/// lock costs a data point, not a reply.
pub fn record(turn: TurnUsage) {
    if !turn.is_measured() {
        return;
    }
    if let Ok(mut stats) = LEDGER.lock() {
        stats.add(turn);
    }
}

/// The totals so far. Returns the default (all zeros, `hit_ratio` `None`) if
/// the lock is poisoned, which reads to the UI as "nothing measured yet".
#[must_use]
pub fn snapshot() -> CacheStats {
    LEDGER.lock().map(|stats| *stats).unwrap_or_default()
}

/// Reads the prompt-cache totals for this run of the app.
///
/// A shared command: it must appear in BOTH `generate_handler!` lists in
/// `lib.rs`, because both shells feed the same ledger.
#[tauri::command]
#[must_use]
pub fn carpe_diem_cache_stats() -> CacheStatsDto {
    let stats = snapshot();
    CacheStatsDto {
        stats,
        hit_ratio: stats.hit_ratio(),
    }
}

/// The totals plus the derived rate, so the two shells do not each reimplement
/// the "no denominator means unknown, not zero" rule.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsDto {
    #[serde(flatten)]
    pub stats: CacheStats,
    /// 0.0 to 1.0, or `null` when nothing has been measured yet.
    pub hit_ratio: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::{CacheStats, TurnUsage};

    /// `generate_handler!` cannot cfg individual entries, so `lib.rs` carries
    /// two full command lists — one for desktop, one for mobile. A shared
    /// command added to only one of them compiles fine and then fails at
    /// runtime on the other platform, which is exactly the kind of bug nobody
    /// finds until a user hits it. Both shells feed this ledger, so both must
    /// be able to read it.
    #[test]
    fn the_cache_command_is_registered_on_both_shells() {
        let lib_rs = include_str!("../lib.rs");

        let registrations = lib_rs
            .matches("carpe_diem::cache_stats::carpe_diem_cache_stats")
            .count();

        assert_eq!(
            registrations, 2,
            "carpe_diem_cache_stats must appear in BOTH generate_handler! lists in lib.rs"
        );
    }

    fn turn(prompt: u64, cached: u64) -> TurnUsage {
        TurnUsage {
            prompt_tokens: prompt,
            completion_tokens: 10,
            cached_tokens: cached,
            ..TurnUsage::default()
        }
    }

    #[test]
    fn an_empty_ledger_has_no_hit_rate_rather_than_a_zero_one() {
        assert_eq!(CacheStats::default().hit_ratio(), None);
    }

    #[test]
    fn accumulates_hits_and_misses_into_one_rate() {
        let mut stats = CacheStats::default();
        stats.add(turn(1_000, 0));
        stats.add(turn(1_000, 900));

        assert_eq!(stats.turns, 2);
        assert_eq!(stats.turns_with_cache_hit, 1);
        assert_eq!(stats.prompt_tokens, 2_000);
        assert_eq!(stats.cached_tokens, 900);
        assert_eq!(stats.hit_ratio(), Some(0.45));
    }

    /// A response with no metering headers is an unmeasured turn, not a cold
    /// one: counting it would invent a miss the operator never reported.
    #[test]
    fn an_unmeasured_turn_is_not_counted() {
        assert!(!TurnUsage::default().is_measured());
        assert!(turn(1, 0).is_measured());
    }

    /// The webview reads these keys by name. `#[serde(flatten)]` plus two
    /// `rename_all` attributes is exactly the kind of thing that silently
    /// renames a field, and the failure would be a card that renders zeros
    /// forever rather than an error anyone would notice.
    #[test]
    fn the_dto_serializes_the_keys_the_webview_reads() {
        let dto = super::CacheStatsDto {
            stats: CacheStats {
                turns: 2,
                turns_with_cache_hit: 1,
                prompt_tokens: 2_000,
                cached_tokens: 900,
                cache_creation_tokens: 40,
                completion_tokens: 120,
                cache_saved_usdc_micro: 41_000,
                cost_usdc_micro: 9_100,
            },
            hit_ratio: Some(0.45),
        };

        let json = serde_json::to_value(dto).expect("serializes");

        assert_eq!(json["turns"], 2);
        assert_eq!(json["turnsWithCacheHit"], 1);
        assert_eq!(json["promptTokens"], 2_000);
        assert_eq!(json["cachedTokens"], 900);
        assert_eq!(json["cacheCreationTokens"], 40);
        assert_eq!(json["completionTokens"], 120);
        assert_eq!(json["cacheSavedUsdcMicro"], 41_000);
        assert_eq!(json["costUsdcMicro"], 9_100);
        assert_eq!(json["hitRatio"], 0.45);
    }

    /// An empty ledger must send `null`, not `0.0` — the webview keys off the
    /// difference to keep the card hidden on a fresh launch.
    #[test]
    fn an_unmeasured_ledger_serializes_an_absent_rate() {
        let stats = CacheStats::default();
        let dto = super::CacheStatsDto {
            stats,
            hit_ratio: stats.hit_ratio(),
        };

        let json = serde_json::to_value(dto).expect("serializes");

        assert!(json["hitRatio"].is_null());
    }

    #[test]
    fn a_nonsensical_split_cannot_push_the_rate_over_one() {
        let mut stats = CacheStats::default();
        stats.add(turn(100, 9_999));

        assert_eq!(stats.cached_tokens, 100);
        assert_eq!(stats.hit_ratio(), Some(1.0));
    }

    #[test]
    fn totals_saturate_instead_of_wrapping() {
        let mut stats = CacheStats::default();
        stats.add(TurnUsage {
            prompt_tokens: u64::MAX,
            cached_tokens: u64::MAX,
            ..TurnUsage::default()
        });
        stats.add(TurnUsage {
            prompt_tokens: u64::MAX,
            cached_tokens: u64::MAX,
            ..TurnUsage::default()
        });

        assert_eq!(stats.prompt_tokens, u64::MAX);
        assert_eq!(stats.cached_tokens, u64::MAX);
    }
}
