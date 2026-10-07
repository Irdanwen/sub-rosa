---
status: accepted
date: 2026-10-07
---

# A project is a folder its chats read at the memory seams

## Context

The parity matrix (ADR-0078) left "Projects with instructions, files and
memory" and "File uploads (PDF, Word, Excel)" partial. A project already
existed as a note folder that chats can be filed in (`session_folders`,
synchronised since ADR-0080). What it lacked: instructions its chats follow,
files they can search, and a memory that can stay inside the project. Separately,
the phone's chat refused PDF and Office files, and the desktop handed Hermes a
path to a `.docx` its file tools read as a zip.

Three constraints shaped the answer:

- **Two prompt seams, one of them shared.** The phone rebuilds its prompt every
  turn; the desktop's SOUL is one file every Hermes chat of a runtime reads
  (ADR-0009, ADR-0081). A project is per chat.
- **Sync refuses what it does not know.** `account::sync::apply` rejects a row
  with an unknown column, and an older device refuses the page that holds it
  until it updates (ADR-0058 addendum, ADR-0080).
- **Assistant references already solved files**: extraction for PDF and modern
  Office formats, a durable `queued` row re-driven by the background sweep
  (ADR-0018), and an encrypted file lane.

## Decision

1. **Settings and files beside the folder, not in it.** `project_settings`
   (instructions, memory mode; its id is the folder's) and `project_files`
   (migration 048) are two new synchronised tables. The folder row older
   devices read is untouched. Two devices editing one project edit one object.
2. **Project files are assistant references with another owner.** Same
   extractors (`assistants::extract_bytes`), same directory, same `assistant`
   file lane (ownership queries union `project_files`), same search
   (`reference_context_over`). Their own table exists only because
   `assistant_references.assistant_id` is a foreign key to an assistant.
3. **The memory scope is a column, filtered by the store.** `memories.scope` is
   NULL for the person's own memory and the folder id for a "Project only"
   project. `Repositories` carries a memory scope, `None` unless a caller asks
   (`with_memory_scope`), and every injection, recall, dedup, consolidation and
   insert query reads it. So both seams and extraction filter by construction:
   a caller that never heard of projects reads only the person's own memory.
   Past chats follow the same line: a "Project only" project reads its own
   chats, every other chat reads none of them.
4. **The scope travels only when it exists.** A memory's synchronised row gains
   `scope` only when it is not NULL (`json_patch` in the trigger body). The
   person's own memories keep the shape every device reads. A device too old to
   know scopes refuses a project's memory rather than applying it as its
   owner's own, which is the safe failure.
5. **Phone: the prompt, every turn.** A general chat filed in a project gets a
   project section in its system prompt, `search_project_files` when the
   project has files, and its turn's store is scoped. A custom assistant's
   conversation keeps its snapshot (ADR-0058): no project reaches into it.
6. **Desktop: the first message, not the SOUL.** The project rides with a
   chat's first message after Hermes' own `--- Attached Context ---` marker,
   which the transcript and memory extraction already strip, and again when its
   fingerprint changes (instructions, files, mode or project memories edited).
   `search_project_files` and a `project_id` on `search_user_memories` and
   `search_past_chats` extend the read-only `june_context` MCP. An `@` in the
   person's text is broken so Hermes cannot expand it into a file read. The
   desktop's extraction names its session, so a "Project only" chat stores what
   it learns in the project.
7. **Documents in chat are read on the device.** `document_extract` (shared)
   returns the text of a PDF, Word, Excel or PowerPoint file with its page,
   sheet or slide count; the phone attaches it as a text attachment under the
   existing `[File: …]` marker. A scan says it is a scan. The desktop writes
   the text beside an imported document (`report.docx.txt`) and the attachment
   block names it.

## Consequences

- The desktop SOUL still carries the person's own memory into a "Project only"
  chat; the project context tells the agent not to rely on it and gives the
  project's memories instead. That direction is prompt-level. The other
  direction is enforced: a project's memory never reaches the SOUL, another
  project, or a chat outside it.
- A project's settings, files and scoped memories synchronise; an older device
  refuses those pages until it updates, as for ADR-0073 and ADR-0080. The local
  archive (`archive.rs`) does not carry project files yet.
- Deleting a project keeps its scoped memories; they stay visible and
  deletable in Settings › Memory.
- Scanned PDFs and legacy binary Office formats remain unread (ADR-0058).

## Alternatives rejected

- **Columns on `folders`.** Every older device would refuse every folder row,
  not only projects.
- **A hidden assistant per project, its references as the files.** The hidden
  assistant would show in every older device's assistant list, and its snapshot
  rules do not fit a chat that joins a project later.
- **The project in the desktop SOUL.** The SOUL is shared by every chat of the
  runtime; rewriting it per chat races concurrent chats.
- **A separate memory table per project.** Recall, embeddings, consolidation,
  the journal and sync would all need a second path; one column and one store
  rule keep them one.

## Addendum (2026-10-07): "Project only" is enforced on the desktop too

The first consequence above left the desktop's direction prompt-level: the
shared SOUL carried the person's own memory into a "Project only" chat and the
project context only asked the agent not to rely on it. That is closed where
every Hermes request passes, the provider proxy
(`hermes_bridge/project_memory.rs`):

- The SOUL's memory block sits between its own markers
  (`<!-- sub-rosa:user-memory -->`, always written, even empty) inside the
  personal section. An HTML comment in a fact or a preference is broken, so a
  remembered sentence cannot close the section early.
- The project context opens with a marker of its own
  (`<!-- sub-rosa:project-context <id> -->`), read only right after Hermes'
  `--- Attached Context ---` marker in a user message. The latest one names
  the chat's project. The mode is read from the store, never from the text: a
  Default project, a deleted one, or no context leaves the request untouched.
- For a "Project only" project, every request leaves with the person's memory
  section replaced by the project's memories (read fresh each time, so they
  no longer ride in the project context or change its fingerprint), with
  `project_id` pinned to the project on `search_user_memories` and
  `search_past_chats`, and with the result of any memory search that ran
  without that id replaced by a notice to search again inside the project.
  Hermes' transcript keeps what it had; the cut is made on every request.
- If the store cannot be read, the person's memory is cut and nothing is put
  back: an unreadable mode fails closed.

What stays outside: personalization (settings, not memory) still applies in a
project, as on the phone; a SOUL written before this build has no memory
markers and is cut only from the next runtime start; and a first message lost
to Hermes' context compression takes its marker with it.

The archive (ADR-0042) now carries `project_settings`, `project_files` (with
their extracted text) and the files' stored bytes, which the reference
ownership query now counts as owned.
