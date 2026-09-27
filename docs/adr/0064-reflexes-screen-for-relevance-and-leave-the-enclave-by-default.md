---
status: accepted
date: 2026-09-27
---

# Reflexes screen for relevance, and leave the enclave by default

## Context

Every search in the app ends the same way. A lexical list (FTS5, bm25) and,
where the notes are embedded, a semantic list (ADR-0046) are fused by
reciprocal rank, and the fused list is cut at a fixed length. The cut does not
know whether the eighth passage says anything about the question. It knows the
passage came eighth.

The four searches that end this way do not even agree on what to fuse:

- **Ask your notes** fuses any-of-the-words passages with meaning.
- **agent-lite's `search_notes`** required every word, so the four to six
  words a model sends found nothing more often than not.
- **Memory recall** matched the whole query as one `LIKE` phrase, which a
  sentence never matches, and leaned entirely on embeddings.
- **The desktop agent's MCP** has words only.

A weak cut costs twice:
- the answering model is handed passages that do not bear on the question, and
  writes around them;
- when nothing in the notes answers, a model is paid to say so, or to find
  something plausible in near misses.

In September 2026 Carpe Diem began serving a **decision model** on
`POST /v1/decisions` (Jev, relayed from Venice). It is not a language model:
- it takes a `state` and several typed questions;
- it answers every question in one pass, in parallel: `noul` gives a
  probability of yes, `choice` gives a label with a distribution, `score` gives
  a position on an ordered scale;
- it takes about a second;
- it costs a fraction of a chat call, and is free during the beta.

The documented shapes were incomplete, so the working ones were settled live
and frozen in `reflex/question.rs`. On twenty French passages and three
questions (60 judgements):
- passages that answered scored 0.63 to 0.97;
- passages beside the point never scored above 0.28;
- a question nothing answered peaked at 0.20.

Two facts shape how the app may use it:

1. **Its privacy label is "anonymized", not "private".** The request leaves
   the Carpe Diem enclave for the model's operator, without the person's
   identity. Every other request the app makes for inference stays in the
   enclave (on the `/v1` rail).
2. **It is confidently wrong when the answer is not in what it was given**
   (independent evaluations, September 2026). It also follows an option's
   name more than its description, and is weaker outside English.

## Decision

**A reflex is a typed, one-pass decision asked of the decision model. Reflexes
are on by default, never a dependency, and never write.**

- **Screening is the first use.** Each search gathers a wider pool than it keeps
  (24 fused candidates instead of 8). It asks one `noul` per candidate, in one
  call: "does this passage bear on the question in the state". Then it keeps
  what clears `KEEP_AT` (0.3), best first. This applies to:
  - Ask your notes;
  - agent-lite's `search_notes`, which now also fuses any-of-the-words passages
    and meaning;
  - memory recall, which now finds by any word through `memories_fts` instead
    of the phrase `LIKE`.
- **Abstention.** When every candidate scores under `NOTHING_BELOW` (0.25), the
  screen says nothing is relevant:
  - Ask answers "Nothing in your notes answers this." without calling the
    answering model;
  - the agent tool and memory recall return nothing.
  Between the two thresholds, the three best go through and the answering
  model decides.
- **Never a dependency.** In each of these cases the screen returns the
  candidates in the order they arrived, cut at the old length:
  - reflexes are off;
  - there is no key;
  - the endpoint fails;
  - a breaker has opened (three failures in a row pause reflexes for ten
    minutes);
  - an answer is missing.
  A screen is never worse than its absence.
- **Questions a reflex may ask are decidable from the state.** Instructions are
  in English, content in its own language. Labels are words, and the builder
  refuses numeric labels.
- **What left the machine is visible.** Every call is an egress-ledger row
  (ADR-0043), tagged with the caller's purpose ("ask (reflex)").
  Ask's answer carries `screened`: the passages sent only to be screened. The
  panel lists them under "what was sent", keeping ADR-0044's promise that a
  person sees which notes went out.
- **On by default, said once, turned off in one place.** Settings › Privacy
  names the one thing that differs from every other request: these leave the
  enclave, anonymized. The switch is `reflex.json` (`enabled`), shared by both
  shells.
- **Direct call, catalog base.** `reflex/client.rs` posts to
  `catalog_base_url_of(base)/decisions` through `http_client`, as the
  embeddings call does (ADR-0009). Nothing in `june-api/` (ADR-0027), and never
  through the `/router` rail, which no external market serves for this path.

## Consequences

- The three searches that screen now agree on their candidates, and a question
  the notes cannot answer is answered as such, for free.
- A person who never opens Settings has passages of their notes sent, anonymized,
  outside the enclave. That was chosen knowingly, as the `/router` rail was: the
  gain is on every search, and the switch and the ledger say what it costs.
- The thresholds are constants from one measurement. They move when a
  calibration exists: implicit labels from what people undo, or a sample
  re-judged by a language model.

## Alternatives considered

- **Off by default, opt-in.** It is the more private default. It was rejected
  because the gain lives in searches people make without thinking of settings,
  and the operator never learns who sent the request.
- **Send only metadata** (titles, queries). Screening needs the passage. What is
  left (routing on a query alone) is worth a fraction of the gain.
- **A local reranker model.** No bundled model runtime exists on either shell,
  and adding one (weights, memory, iOS size) costs more than a second-long call
  that degrades to the old cut.
- **A language model as reranker.** It is slower and dearer by one to two orders
  of magnitude. Its "confidence" is verbalised, not a probability to threshold.

## Later uses

This ADR covers screening. The same client and question types are meant for:
- consolidating memory (a `choice` between adding, updating and ignoring a fact
  against its neighbours);
- the calendar match the app now asks the person about;
- routing a turn to a model.

Each one that acts without a tap will say so in its own ADR, with an undo.

## Addendum (2026-09-27): every search that feeds a model

The screen now also runs on:

- **The desktop agent's search.** The `june_context` MCP holds the notes
  database read-only and has neither the embeddings nor the screen, so
  `search_meeting_notes` and `search_user_memories` ask the app first. They
  call two read routes on the local provider proxy, `/v1/notes/search` and
  `/v1/memories/search` (`hermes_bridge/local_reads.rs`), which run the same
  searches as agent-lite. When the app cannot be reached, the MCP keeps its
  own SQLite search.
- **Meeting briefs.** The title and each attendee's first name are searched
  through `ask::screened_note_search`. A reflex keeps what would help prepare
  this meeting. When nothing would, the context is empty, and the silence rule
  fires before the brief's model is paid.
- **Assistant references.** Candidates are the passages sharing the most words
  with the request and, room permitting, the rest, so meaning can find what
  words miss. Without a reflex, the old word-overlap cut applies unchanged.

**The notice is said once.** A banner in both shells, `ReflexNotice`, tells a
person who never opens Settings that checks leave the enclave. It offers
"Got it" and "Turn off". Whether it was read is kept in `reflex.json`
(`noticeSeen`), and the settings command takes a partial change so the switch
cannot bring the notice back.

**Not screened, on purpose.** The ⌘K palette is not screened. Reordering a list
a second after it appears moves results under the pointer, and a question in
natural language already goes to Ask, which screens.
