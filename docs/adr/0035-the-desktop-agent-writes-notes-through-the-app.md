# 35. The desktop agent writes notes through the app, never through the database

Date: 2026-08-28

## Status

Accepted

## Context

The desktop agent could read the user's notes and could not write one. Its only
local toolset, the `june_context` MCP server (`src-tauri/src/hermes/june_context_mcp.py`),
offers `search_meeting_notes`, `get_note`, `search_dictation_history`,
`search_user_memories` and `search_calendar`. All of them read.

Asked to "write this up as a note", the agent did the only thing it could: it
wrote a markdown file into its Hermes workspace, then tried AppleScript against
Apple Notes, which the Seatbelt write-jail refused. It reported both accurately
and pointed the user at the file. The note they asked for never existed, in an
app whose whole subject is notes.

The phone's agent has been able to do this since it shipped: `agent_lite` has
`create_note` and `append_to_note` and writes through `Repositories` in-process,
because on iOS the agent *is* the Rust process (ADR-0018). The desktop's agent
is a separate runtime talking to a Python MCP subprocess, and that subprocess
opens the notes database **read-only on purpose** (`connect_readonly`, `mode=ro`).

So the question was not whether the desktop agent should write notes. It was
where the write happens.

## Decision

**The MCP asks the app to write. It never writes itself.**

`create_note` and `append_to_note` are declared by the MCP and dispatched over
the local provider proxy to `POST /v1/notes/create` and `POST /v1/notes/append`,
which land in `crate::agent_notes` — the same module `agent_lite` now calls. The
Python side builds a payload and reads a result; it holds no write handle.

Three consequences follow, and they are the reason for the shape:

- **One writer.** The Rust process owns the database. A second writer, in
  another process, on a file opened read-only by contract, is how a corrupt
  page or a lost update gets introduced, and nothing about a note is worth
  that.
- **One behavior on both shells.** `crate::agent_notes` is the only place
  either assistant writes a note, so "add that to the note" cannot mean one
  thing on the phone and another on the desktop. Append means append to what
  the user sees (`edited_content` when they have edits, the generated note
  otherwise) because that is what the module does, once.
- **One thing to tell the shell.** A write emits `june://notes-changed` and
  refreshes the search index from inside the app, which a Python process could
  not do at all. Without it, the note the agent just confirmed would be missing
  from the list until the next reload, and the tool would read as a liar.

The tools are advertised **only when the app hands the MCP proxy coordinates**,
exactly like `search_calendar`: a tool the agent cannot reach is worse than one
it does not know about.

The SOUL is part of the decision, not a footnote to it. A model that can see a
filesystem will use the filesystem, so `JUNE_SOUL_CONTEXT_MD` now says where a
note belongs, that a file in the workspace is not one, and that a note nobody
asked for must not be written.

## Alternatives considered

**Write from Python.** Reopen the database read-write in the MCP. Shortest
diff, and it was rejected outright: two writers, one of them outside the
process that owns the schema and the migrations, with no way to notify the UI
or the index. `connect_readonly` exists precisely to make this not an option.

**A Tauri command instead of a proxy route.** The MCP is not a webview and
holds no IPC channel; it already speaks HTTP to the proxy for the calendar and
the media tools, re-reading its coordinates file per call so it survives an app
relaunch on a new port. A command would have meant inventing a second transport
for one caller.

**Give the agent a "notes" directory in its workspace and import it.** Turns
every note into a file round-trip, invents a second source of truth for note
bodies, and collides with `ingest`, which is about media the user brings in
(ADR-0026), not about the agent's own output.

**Have the agent produce a *meeting note*.** Rejected as a vocabulary error. A
meeting note is what a transcribed recording becomes; a report the agent writes
has no recording behind it. It is an ordinary note, and CONTEXT.md keeps those
words apart.

## Consequences

- Every new local-write tool follows this path: declare it in the MCP, route it
  through the proxy, implement it once in Rust, and let both shells share it.
- The agent can now change a note the user may have open in the editor. The
  list refreshes; the open editor does not. Appending under an open note is a
  known gap, not a solved problem.
- The write tools are bounded in Rust (`MAX_TITLE_CHARS`, `MAX_BODY_CHARS`) and
  cut on character boundaries, because every byte of that text came from a
  model and a byte-indexed cut inside an accented character panics.
