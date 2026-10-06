//! How much research one mobile chat turn may do, and how the pages it read
//! ride along: the tool-round budget, the answer pass that follows it, and
//! which fetched pages are resent whole.

use super::truncate;

/// Hard cap on tool rounds per user turn, so a confused model cannot loop
/// forever (each round is a paid completion). Three was enough when the only
/// tools were two searches; eight still ran out on a buying question, where a
/// small model alternates searches and page reads. Only rounds that ran tools
/// count: a replayed stream or a vision fallback is the transport's retry, not
/// the model's research.
pub(super) const MAX_TOOL_ROUNDS: usize = 12;
/// Every completion of the turn, retries included. The retries are each
/// one-shot per round, so this is a backstop that should never be reached.
pub(super) const MAX_COMPLETIONS: usize = MAX_TOOL_ROUNDS * 2 + 4;
// The answer pass needs two completions past the last research round.
const _: () = assert!(MAX_COMPLETIONS > MAX_TOOL_ROUNDS + 2);
/// What a page older than the newest `READ_PAGES_KEPT` shrinks to.
pub(super) const READ_PAGE_CHARS: usize = 2_000;
/// Pages resent whole in every completion: three at `WEB_PAGE_CHARS` each.
const READ_PAGES_KEPT: usize = 3;

/// How the research budget shapes the next completion of a turn.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Completion {
    /// Tools offered, the model decides.
    Research,
    /// The budget is spent: answer now. The first try keeps the tools
    /// declared with `tool_choice: none`, because the history is full of tool
    /// messages that some routes refuse without declarations; the second
    /// sends no declarations at all, for a model that asks for a tool anyway.
    Answer { nudge: bool, withhold_tools: bool },
    /// Both answer tries came back without one.
    GiveUp,
}

#[derive(Default)]
pub(super) struct ToolBudget {
    rounds: usize,
    answer_tries: usize,
    /// The transport is replaying the last completion (a broken or empty
    /// stream): the same step again, not the next answer try.
    replaying: bool,
}

impl ToolBudget {
    pub(super) fn next_completion(&mut self) -> Completion {
        let replaying = std::mem::take(&mut self.replaying);
        if self.rounds < MAX_TOOL_ROUNDS {
            return Completion::Research;
        }
        if replaying && self.answer_tries > 0 {
            return Completion::Answer {
                nudge: false,
                withhold_tools: self.answer_tries >= 2,
            };
        }
        self.answer_tries += 1;
        match self.answer_tries {
            1 => Completion::Answer {
                nudge: true,
                withhold_tools: false,
            },
            2 => Completion::Answer {
                nudge: false,
                withhold_tools: true,
            },
            _ => Completion::GiveUp,
        }
    }

    /// The next completion repeats this one: a transport retry, which must
    /// not spend an answer try.
    pub(super) fn replay(&mut self) {
        self.replaying = true;
    }

    /// Count a round whose tools ran; returns the round's number.
    pub(super) fn ran_tools(&mut self) -> usize {
        self.rounds += 1;
        self.rounds
    }
}

/// Keep the newest `READ_PAGES_KEPT` pages whole and shorten the older ones.
/// The answer is written from these pages and the assistant kept nothing of a
/// page but its call, so a few whole pages are worth resending; a long search
/// past that resends the old ones as their opening only.
pub(super) fn shorten_read_pages(
    messages: &mut [serde_json::Value],
    page_reads: &[(usize, usize)],
    current_round: usize,
) {
    let older = page_reads.len().saturating_sub(READ_PAGES_KEPT);
    for &(index, round) in &page_reads[..older] {
        if round >= current_round {
            continue;
        }
        let Some(content) = messages
            .get_mut(index)
            .and_then(|message| message.get_mut("content"))
        else {
            continue;
        };
        let Some(text) = content.as_str() else {
            continue;
        };
        if text.chars().count() > READ_PAGE_CHARS {
            *content = serde_json::json!(truncate(text.to_string(), READ_PAGE_CHARS));
        }
    }
}
