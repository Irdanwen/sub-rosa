# ADR 0043: The egress ledger records shapes, never contents

- Status: accepted
- Date: 2026-09-03

## Context

Sub Rosa's claim is that nothing leaves the machine except the requests made
of a model, to the endpoint the user configured. Settings › Privacy made the
claim legible: the list of hosts the binary can reach, with a reason each,
read from the constant `tests/egress.rs` holds. A list of what *can* happen
is the claim stated. Nothing in the app showed what *did* happen: when the
last request went out, to whom, how large, for what. A person who wanted to
check the promise had to take the sentence's word, or read a log.

## Decision

**Every outbound request the process makes is one row in `egress_ledger`,
and the row carries the request's shape and never its content.**

- A row is: when, host, purpose, method, bytes sent, bytes received, status,
  duration, the model when the request named one, and the note it was about
  when that is known. The prompt, the audio, the reply and any header are not
  in the row and there is no column for them. The ledger has to be safe to
  show on a screen and safe to leave on disk in the clear, and a byte count
  already says what a person wants to know.
- The purpose is a word derived from the path (`chat`, `transcription`,
  `embeddings`, `catalog`, `image`…), and an unknown path keeps its path,
  which is more honest than "other".
- Writes never block a request. `egress_ledger::record` pushes into a
  bounded in-memory buffer from any thread; a flusher started at setup drains
  it into SQLite every few seconds; the screen also drains before it reads,
  so a request made two seconds ago is on the page that claims to list every
  request. A row the buffer could not hold is a dropped row that is counted,
  never a failed request.
- The seam is the sidecar client (`june_api.rs`), because on both shells
  every model request goes through it and the sidecar forwards to the one
  endpoint; the host recorded is that endpoint, not the loopback hop.
  Direct calls (Studio media, embeddings, places, imports) join the ledger as
  they are touched, through the same `record`.
- Rows older than ninety days are pruned at launch. The ledger is a window a
  person can check, not an audit trail to keep forever.

## Alternatives considered

- **Logging.** Logs are for maintainers, rotate on size, and are not safe to
  show: they carry paths, titles and errors. The ledger is for the person.
- **Recording the request body, redacted.** Redaction is a scan for known
  shapes; a prompt is prose, and prose is where a name or a number hides. Not
  recording is the only redaction that cannot fail.
- **Counting at the sidecar.** `june-api/` is upstream's code (ADR 0040 keeps
  it close to upstream), and its process is not where the note context lives.

## Consequences

- Settings › Privacy shows the ledger under the host list: a sentence with
  the totals of the last seven days, the purposes, and the rows.
- A future per-note view ("what left about this note") only needs the
  `note_id` column filled by the callers that know it; the table and the
  query already take it.
- `docs/threat-model.md` can point at the ledger as the way to check the
  claim it makes about egress, next to `tests/egress.rs`.
