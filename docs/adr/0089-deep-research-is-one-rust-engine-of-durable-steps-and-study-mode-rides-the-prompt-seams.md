---
status: accepted
date: 2026-10-08
---

# Deep research is one Rust engine of durable steps, and study mode rides the prompt seams

## Context

The parity matrix (ADR-0078) left two rows of P5 open. **Deep research**: a
question read across many sources, written up as a report with numbered
sources, run for several minutes, followed live and stoppable. The desktop
had only a slash command that asked Hermes to research; the phones had
nothing. **Study mode**: a chat that teaches rather than answers, with
quizzes, flashcards and spaced repetition. Only custom assistants could
approximate it, with a prompt the person wrote.

The constraints that shaped the answer:

- **iOS suspends the process.** Minutes of searches and reads outlive a
  foreground session many times over, so the work must be rows the sweep
  re-drives, not a task (ADR-0018).
- **Two runtimes.** The desktop agent is Hermes, the phones' is agent-lite.
  A report written by one should read like a report written by the other.
- **Citations must be checkable.** A model that writes its own source list
  invents addresses; ADR-0044 already settled that the model numbers and
  the app resolves.
- **The desktop's SOUL is one file for every chat** (ADR-0009, ADR-0081): a
  per-chat behaviour cannot live there.

## Decision

1. **One engine in Rust for both shells** (`src-tauri/src/research/`). The
   desktop does not hand deep research to Hermes: it runs the same steps,
   through the same sidecar chat completions and the same `/v1/web/search`
   and `/v1/web/fetch` routes agent-lite's tools use, so a report is the same
   whichever device wrote it, and the run is a row the desktop's sweep can
   finish after a quit. Nothing goes in `june-api/` (ADR-0027).
2. **Four moves, each a command.** Clarify (at most three questions, often
   none), plan (sections and searches the person edits, with a depth and the
   ceiling of what it costs: searches, page reads, model calls and the
   tokens priced at the model's own rates), run, report. No money is spent
   past the clarifying call until the plan is approved.
3. **A run is rows.** `research_runs`, one `research_steps` row per search and
   one `research_sources` row per source (migration 057). The engine asks
   the database for the next pending thing, does it, writes that it was done,
   and asks again: a step killed midway is redone (one search or one page
   read twice at most), never the whole run. `background::sweep` re-drives
   running rows; liveness is the in-process `LIVE` registry, never a column.
   Stop marks the row and wakes the step waiting on the network; a stopped
   run resumes, or writes its report from what it read.
4. **Depth is the budget.** Quick, Standard, Deep: 10, 25 or 50 sources and
   4, 8 or 14 searches. The web's share is spread over every search so the
   last section still finds sources; a fifth of the budget may go to the
   person's own notes (`ask::agent_note_search`) and the project's files
   (ADR-0085). Connected apps (P6) plug into the same seam
   (`connector_sources`, kind `connector` already accepted by the table).
5. **The model numbers, the app resolves.** One note per page read, then the
   report pass is handed the notes numbered by the app. Every `[n]` is
   checked against that list, renumbered in order of first mention, and an
   invented number is removed and counted on the run. The sources list is
   written by the app from its rows; a sources section the model wrote
   anyway is cut. The report is an ordinary note.
6. **Exports reuse what exists, plus a Word writer.** Markdown is the note;
   the PDF is the conversation export's writer; the `.docx` is a small
   hand-written WordprocessingML package (`src-tauri/src/docx.rs`: real
   headings, numbered and bulleted lists, tables, clickable links), not a
   dependency. Delivery is the conversation export's (save dialog in Rust on
   the desktop, share sheet on the phone).
7. **Study mode is a per-chat row read at the existing prompt seams.**
   `study_chats` (migration 058) holds the chats in study mode. The phone
   appends the tutoring prompt to its system prompt every turn, so a
   regenerated reply or a turn finished by the sweep reads the mode the
   person chose. The desktop sends the same text after the attached-context
   marker of every message while the mode is on, the seam a project uses
   (ADR-0085), which the transcript and memory extraction already strip.
8. **Quizzes and flashcards are chat blocks** (`subrosa:quiz`,
   `subrosa:flashcards`, ADR-0024), in the shared parser. A quiz is answered
   in place and never stored. "Add to review" writes `study_cards`, kept on
   this device and carried by the archive, scheduled by SM-2 (four answers,
   a lapse back in ten minutes, ease never under 1.3). The Review screen is
   one dialog on both shells.

## Alternatives considered

- **Hermes `/goal` on the desktop, agent-lite on the phones.** Two
  implementations of the same feature drift, the desktop's could not be
  resumed by the sweep, and neither could promise app-resolved citations:
  an agent chooses its own reads and writes its own list.
- **One long agent-lite turn with a bigger tool budget.** A turn is one row;
  a lock in the middle of minute four restarts it from the beginning, and
  pays for every search again.
- **A docx crate.** The vocabulary is the note's, a page of XML; a
  dependency would be more code to audit than the writer.
- **Study mode as a custom assistant.** An assistant's snapshot is immutable
  (ADR-0058) and has its own conversation list; a mode a person toggles in
  the middle of a chat is not an assistant.

## Consequences

- Shared commands (`research_*`, `note_export_document`, `study_*`) are in
  both `generate_handler!` lists.
- The prompts are the product: `research/prompts.rs` with
  `RESEARCH_PROMPT_VERSION`, and `study::STUDY_PROMPT` with
  `STUDY_PROMPT_VERSION`.
- Runs and study cards are not synchronised. A report is a note, so it
  travels like any other note.
- The cost shown before a run is a ceiling for model tokens; searches and
  page reads are billed apart, and the screen says so rather than guessing
  their price.
