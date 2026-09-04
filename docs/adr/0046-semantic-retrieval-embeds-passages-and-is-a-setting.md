# ADR 0046: Semantic retrieval embeds passages, not notes, and is a setting

- Status: accepted
- Date: 2026-09-04

## Context

"Ask your notes" (ADR 0044) retrieves with the lexical index: the content
words of the question, any of them, ranked by bm25. That finds a note that
uses the question's words. It does not find one that says the same thing
otherwise: "quand migre-t-on ?" and a note that says "la migration est
lundi" share no token (the tokenizer does not stem), and a question in
English over a note in French shares none at all. The memory module solved
the same problem for facts with BGE-M3 vectors and a hybrid ranking (ADR
0009); notes were left out because embedding a corpus is a backfill over
every transcript, and a call per passage to the configured endpoint, in
the background, which is not what a person asked for in any one moment.

## Decision

**Notes are cut into passages; passages get vectors in the background;
the answer merges the two rankings; and all of it is a setting the person
can see and turn off.**

- **Passages, not notes.** A note body is cut on paragraphs into pieces of
  about seven hundred characters, a transcript into windows of six turns.
  One vector for a whole note means nothing; a passage is the unit a
  citation points at anyway.
- **Rows first, work after (ADR 0018).** A note whose source changed
  (hash of title, body and turns) gets its passages re-cut with empty
  vectors, from the sweep and after a note is announced. The backfill
  fills vectors in batches of thirty-two, a bounded number of batches per
  pass, and stops at the first failure. Nothing blocks a note, a search or
  a launch, and a passage without a vector is still found by the lexical
  half.
- **Same vectors, same call, same ledger.** BGE-M3 through the direct
  `/embeddings` call the memory module already makes (ADR 0009's pattern,
  not the sidecar), and every call is a ledger row with the purpose
  `embeddings` (ADR 0043), so Settings › Privacy shows exactly how much
  left, when.
- **Hybrid, one entry per note.** Reciprocal rank fusion of the lexical
  list and the cosine list, keyed by note, so a note both rankings agree on
  comes first and a note only meaning finds still makes it in.
- **A setting, on by default, honest about what it does.** The notes
  already go to this endpoint to be written; what is new is that they go
  once more, in the background. Settings › Privacy says so in one sentence
  with the counts (passages, embedded), and turning it off deletes every
  passage and vector.

## Alternatives considered

- **Embedding whole notes.** One vector for two hours of transcript is an
  average of everything; the passage that answers the question is lost in
  it.
- **A local embedding model.** No inference runtime ships in the app, on
  purpose (the roadmap refuses a local model until the need is measured);
  the endpoint that writes the notes can embed them.
- **Default off.** The lexical retrieval alone answered a paraphrased
  question with "nothing mentions this", which is the answer this decision
  exists to remove. The default is on, and the setting is where the person
  expects it, next to the ledger that shows what it costs.

## Consequences

- `note_passages` (migration 022) is the durable row; `ask::semantic`
  cuts, embeds, searches and fuses; `retrieve_passages` stays the lexical
  half, unchanged.
- The `ask.json` setting is mirrored in-process like `memory.json`; the
  commands `ask_index_status` and `set_ask_settings` are shared commands.
- Turning memory off does not turn this off, and the reverse: they are two
  claims about two kinds of data, and the person decides each.
