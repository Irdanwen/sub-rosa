---
status: accepted
date: 2026-08-23
---

# A long-form summary is a fork-side map-reduce over turns

## Context

Sub Rosa turns a transcript into a note with one call to `/v1/notes/generate`,
against a system prompt that knows exactly what it is for:

> Prefer useful meeting notes over a faithful summary of every topic.
> — `june-api/crates/services/src/prompts/note_generate.md`

The same prompt instructs the model to drop "offhand speculation", "tentative
ideas" and anything not tied to a decision or an owner. For a standup that is
the right editorial line and the reason the notes are good.

For a two-hour conference talk, a lecture or a podcast it is the wrong line
end to end. There is no decision, no owner and no action item; the value *is*
the argument, the digression and the quotable sentence. And there is a second
failure underneath the editorial one: a single pass over a very long transcript
either overflows the context window or, worse, silently thins out the middle.

Somebody has clearly solved the shape before — `jooray/video-summarizer` is a
hundred and fifty lines of exactly this map-reduce, and its structure is
sound: summarize each chunk, then merge the summaries. Its chunking is the
part not worth copying. `RecursiveCharacterTextSplitter(chunk_overlap=0)` cuts
on character count, which lands mid-sentence, and the output is timestampless
prose because the input was timestampless prose.

So the question was not whether to build a long-form summarizer, but where it
lives. Two homes were available: a new prompt profile and endpoint inside
june-api, next to the note generator; or the fork's own Rust, calling chat
completions through the sidecar.

## Decision

**The map-reduce lives in the fork, in `src-tauri/src/longform/`, and june-api
is not touched.**

It sends its own system prompt to `/v1/chat/completions` through the sidecar —
the pattern `agent_lite` already uses on mobile — so no route, no prompt file
and no service in `june-api/` changes.

The reason is maintenance, not taste. Every line the fork writes into
`june-api/` is a line `.github/workflows/upstream-sync.yml` must re-merge for
as long as the fork tracks upstream, and this feature is entirely a fork
concern: upstream June is a meeting notetaker and has no long-form surface to
want. Keeping it out of `june-api/` also means one implementation serves both
shells, since the desktop and the phone reach the same sidecar.

Four properties define the thing itself.

- **Chunks end on turn boundaries.** A transcript row carries `source`,
  `start_ms`, `end_ms` and `turn_index`, so the chunker fills a token budget
  with whole turns and stops, then backs up a fixed number of turns for the
  next chunk's overlap. No sentence is ever cut, and every chunk knows the
  wall-clock span it covers. Where turn bounds are absent — an imported file
  transcribed as one continuous source — the chunker degrades to paragraph
  boundaries and produces an untimed summary rather than a wrong one.
- **The app owns the clock, the model owns the prose.** A map pass returns
  chapter headings tagged with a *turn index it was given*, never a timestamp.
  The app resolves the index to `start_ms` and renders the time. A model that
  answers with an index outside its chunk is clamped to the chunk's range.
  This is the whole reason chapters can be trusted: the one thing models are
  worst at — arithmetic on durations they cannot see — is never asked of them.
- **The output is markdown on its own row.** Timestamps live inline in the
  headings (`## [00:12:34] The business model`), not in a JSON column, so the
  summary is searchable by the existing note search, readable by the agent's
  `read_note`, and exportable with no special case. A Chapters view parses the
  headings back out; if that parse ever fails, what is left is still a correct
  document.

  The row is `note_summaries`, not a generation block. The two look similar and
  are not the same thing: a generation block is one incremental instalment of
  meeting notes, keyed by the recording session that produced it and composed
  into the body the user edits, whereas a long-form summary is a
  whole-transcript reading, regenerated in place, and re-running it must never
  touch a word the user wrote. Search was widened to cover the new table in the
  same change, because a summary the search cannot find would defeat the point
  of choosing markdown.

The summary is produced short-first: on a multi-part run a provisional
paragraph is written after the first part and replaced by the real one at the
end, so a long run is worth something within seconds instead of only at the
finish.

## Consequences

- The feature is not tied to imported media. Any note with a long transcript
  can be re-read this way, including a three-hour meeting recorded last year.
  That was a side effect of where the code sits, and it is the best thing about
  the decision.
- Cost is knowable before the run: the chunk count is deterministic from the
  transcript, so the app can quote an estimate and ask before spending. The
  merge pass is one extra call, not one per chunk.
- The fork now sends prompts of its own to the model, so `PROMPT_VERSION`
  discipline applies here too: the long-form prompt carries its own version
  string, distinct from `notes-mvp-v5`, and a stored summary records which
  version made it.
- A run is a durable row under [ADR-0018](0018-ios-background-work-is-durable-rows.md),
  and it takes that rule the whole way: each finished map pass is persisted, so
  a run interrupted at part eleven of twelve resumes at part twelve rather than
  re-buying the eleven that landed. Parts are only reused while `chunk_count`
  still matches, because a re-transcribed note chunks differently and reusing
  them would splice an account of the old audio into a summary of the new.
- Deleting the row is the cancel. The run checks for it between parts, so
  stopping a forty-call job costs at most one more call — worth having when
  every call is the user's money.
- A note can hold both a generated note and a long-form summary, on different
  rows, and neither can overwrite the other.
- If upstream June ever grows a long-form endpoint, this module can be pointed
  at it without changing the callers. That is not a plan, only a door left
  open.
