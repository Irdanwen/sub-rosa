# ADR 0044: An answer over the notes cites passages the app chose

- Status: accepted
- Date: 2026-09-04

## Context

Search (migration 020, the ⌘K palette's "In your notes") finds where a word
is. It does not answer a question: "when did we say the migration was?" is a
sentence a person wants back, not a list of notes that contain "migration".
The desktop agent can answer it, but only by way of a chat session, a Hermes
turn, and whichever tools it decides to call; the phone's agent-lite can too,
with its `search_notes` tool. In both cases the person gets a paragraph and
has to take it on trust, and what was sent to the model to produce it is not
shown anywhere.

Two properties matter more than fluency here. The answer must be checkable:
each claim has to point at the note it came from, one tap away. And what left
the machine to get it must be visible: the egress ledger (ADR 0043) records
the request's shape, but a person asking a question over their own notes
also wants to know *which* notes went out.

## Decision

**"Ask your notes" is a fork-side command that retrieves passages itself,
sends only those, and resolves the citations the model writes back to the
passages it was handed.**

- **Retrieval is the app's.** `search_note_context` (FTS5, bm25, accents
  folded) picks up to eight passages. The model never chooses what to read;
  it is given numbered passages and a question, and nothing else. What was
  sent is therefore a list the app can show, and does, under "What was
  sent".
- **Citations are indices, resolved by the app.** The prompt asks for `[n]`
  after each claim. The app maps `n` back to the passage's note id and
  title. An index that was never handed out is not a citation; it is listed
  as invented, in words, on the answer. This is the discipline ADR 0027 set
  for chapter timestamps: the model names a position in a list the app
  owns, and the app turns the position into a fact.
- **The request is one ledger row that says "ask".** `egress_ledger::scoped`
  runs the completion under a task-local context, so the row the sidecar
  client records carries the purpose the caller knows rather than the one
  the path implies (`chat`), and the note id when every passage came from
  one note. Other fork features (long-form summary, rewrite, memory
  extraction) can adopt the same scope; the ledger's column was already
  waiting for callers that know.
- **Nothing in `june-api/`** (ADR 0027, spec `no-fork-feature-in-june-api`).
  The prompt lives in `src-tauri/src/ask/mod.rs` with its own version.
- **One command, both shells.** The palette on the desktop (a query that
  reads as a question offers "Ask your notes" above the recents) and the
  notes search on the phone (the same detection offers a button). The panel
  is one component.

## Alternatives considered

- **A tool for the agents.** Hermes and agent-lite already retrieve; the
  missing part was not retrieval but the guarantee that the answer cites,
  and that guarantee cannot be enforced on an agent that chooses its own
  tools and reads. A dedicated command can promise what a turn cannot.
- **Embeddings-first retrieval.** The memory module embeds facts (ADR 0009)
  and a hybrid recall exists there. Notes are not embedded today; doing so
  is a backfill over every transcript and a call per note, and the question
  this decision answers is a lexical one first ("what did we say about X").
  FTS5 ships now; embeddings can join the same retrieval later without
  changing the contract, since the model only ever sees numbered passages.
- **Letting the model quote.** A quoted sentence is not a link, and a model
  quotes loosely. The index is the only citation the app can verify.

## Consequences

- `ask_notes` is a shared command (both `generate_handler!` lists); the
  answer's `sent` list is the per-request truth of what left the machine.
- The prompt is the product: when an answer disappoints, change the prompt
  and bump `ASK_PROMPT_VERSION`.
- `spec/no-fork-feature-in-june-api.md` applies; `CONTEXT.md` gains the
  nouns "ask", "passage", "citation" under the fork section.
