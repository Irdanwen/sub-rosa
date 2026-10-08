---
status: accepted
date: 2026-10-08
---

# Office files are written by the app, and Code mode reviews from a recorded start

## Context

Two rows of the parity matrix (ADR-0078) were open in lot P5. **Work
deliverables**: the assistant should hand over a Word document, an Excel
workbook or a PowerPoint deck, not only text, on the phone as on the
computer. **Code surface**: a chat pointed at a project folder (ADR-0014)
should be able to edit code, and the person should see and judge every file
it changed.

For the files, the obvious route on the desktop was the runtime's own
Python (`python-docx`, `openpyxl`, `python-pptx`). The bundled runtime ships
none of them, installing packages at run time is outside its jail, and the
phone has no Python process at all (ADR-0086 runs Pyodide in the webview,
without those packages). Each shell would have made different files, or
the phone none.

For code, the runtime already edits files in a working folder and already
drives the Claude Code and Codex CLIs the person installed. What was
missing was a trustworthy answer to "what did this chat change", and a safe
way to undo one file of it.

## Decision

**One tool, `make_document`, backed by the app's own writers, on both
shells.** Agent-lite calls `crate::deliverables::agent_tool` in-process; the
desktop agent calls the `june_media` MCP's tool of the same name, which posts
to the loopback route `/v1/media/document`. Both reach
`crate::deliverables::make`, so one request makes one file on either shell.

- The writers are hand-written, like the Word writer the research report
  already uses (ADR-0089): `docx.rs` (extended to keep an escaped `\|`
  inside a table cell), `deliverables/xlsx.rs` (SpreadsheetML: several
  sheets, inline strings, formulas without cached values and a recalculation
  on load, number formats, ISO dates as serial dates, bold, column widths,
  a frozen header) and `deliverables/pptx.rs` (PresentationML from a fixed
  template: title, bullets with levels, two columns, a gallery picture fitted
  without distortion, speaker notes with their own notes master and theme).
  No crate was added: `zip`, `image` (to read a picture's size and turn WebP
  or TIFF into PNG) and `quick-xml` (tests only) were already dependencies.
- **The file is a gallery file** (ADR-0020) in the gallery's `documents`
  folder, named by a fresh UUID. The Studio's media views list only the
  gallery's top level, so a workbook never appears there as a broken
  picture.
- **The chat shows a `subrosa:file` block** (ADR-0024) that names the file,
  never a path: an absolute path goes stale on iOS across reinstalls, and the
  card's commands (`deliverable_open`, `deliverable_path`) accept only a
  `<uuid>.<docx|xlsx|pptx>` name and resolve it inside the documents folder.
  The computer opens the file in its default app or saves a copy through the
  gallery's save dialog; the phone opens the share sheet, which offers the
  apps that read it and "Save to Files".
- **What the model wrote is data.** Every writer escapes text and drops the
  characters XML refuses; a formula that reaches outside the workbook (a web
  service, DDE, a macro call) is written as text.
- Tests unzip what the writers produce and check the package rules a reader
  enforces before it opens a file (content types for every part, every
  internal relationship resolving, well-formed XML, the main document named
  at the root), and read the files back with the app's own extractor.

**Code mode records where the folder started, and reviews against that.**
A chat with a working folder turns it on from the session bar
(`crate::code_review`, desktop only):

- In a git repository with a commit, the start is that commit plus a copy of
  every file that already differed from it or was untracked (`.gitignore`
  respected). The comparison is with that start, not with the HEAD of the
  moment, so a commit the agent makes does not hide its work, and work the
  person had in progress before the mode started is neither listed nor
  offered for revert.
- Elsewhere the start is a copy of the folder's files, rebuilt folders
  (`node_modules`, `target`, ...) skipped, 20 000 files at most; a file over
  2 MiB is followed by its hash and can be listed but not reverted.
- The review lists each changed file with a unified diff (`diffy`, already a
  dependency), and keeps or reverts it. Keeping makes the current state the
  file's new start. Reverting is accepted only for a file listed as changed
  at that moment, named by a plain relative path without `.git`, confined to
  the folder by `path_confinement::confine_new` (a link leading out is
  refused), and the folder must still pass the working-folder gate.
- The record lives in the app's data folder under a hash of the session id,
  never in the working folder; turning the mode off, or deleting the chat,
  removes it and touches nothing else.
- The agent is told with each message, after the context marker like study
  mode, that it works on code in that folder, may drive an installed coding
  CLI, and must not revert or commit unasked because the person reviews.

## Consequences

- No new dependency, nothing added to the runtime bundle, and the phone and
  the computer make the same file from the same request (only its creation
  time and name differ).
- The files carry what the writers know: no charts in a workbook, no
  pictures in a Word document, no slide transitions, one built-in look for
  decks. Adding one is a writer change and a package test, in one place.
- Office files do not synchronise: the account's file lane carries Studio
  media only. They are also absent from the Library and the Studio gallery
  views; the chat card is their surface. Both are follow-ups if documents
  become a primary use.
- In git mode, a file the agent changes and the person later commits stays
  listed until kept, which is the intent: the review answers "what did this
  chat change", not "what is uncommitted".
- A clean filter or LFS pointer is compared as `git cat-file --filters`
  renders it; a repository relying on unusual filters may show spurious
  changes.

## Alternatives rejected

- **Python libraries in the desktop runtime.** Not in the bundle, not
  installable inside the jail, and nothing on the phone.
- **`rust_xlsxwriter` / `docx-rs`.** Each would add a crate and its
  transitive weight for a fraction of its surface; the formats this tool
  needs are a page of XML each, the same reasoning as ADR-0089.
- **Plain `git diff` against HEAD.** It lists the person's own uncommitted
  work as the chat's and offers to revert it, and loses the chat's work the
  moment the agent commits.
- **A temporary git index over the working tree** (a tree object per
  refresh). Exact, but it writes objects into the person's repository and
  runs clean filters (LFS uploads among them) on every refresh.
- **Documents beside the Studio media in the gallery's top level.** The
  Studio would have adopted them as pictures it cannot draw.

## Addendum 2026-10-08: documents in the Library and on the gallery's lane, an assistant permission, Code mode from a new chat

The consequences above left three gaps; they are closed here.

- **Office files synchronise on the gallery's file lane.** A document is a
  gallery file, so it rides the Studio lane of account sync
  (`account/studio.rs`) rather than a new one: an `account_studio_files`
  record and an upload row naming the file alone, `source_kind` `studio`.
  Where a file of that lane lives follows from its extension
  (`studio::folder`): `docx`, `xlsx` and `pptx` in `documents/`, everything
  else at the top level. Upload, download and a remote deletion all resolve
  the name that way, and registering refuses a file outside the folder of its
  kind. `make_document` registers its file when it is saved, and the lane's
  inventory scans `documents/` too. Nothing is added to the wire contract
  (ADR-0049). A build older than this one cannot place such a file: its
  download stops on `sync_file_type_unsupported`, which is isolated as a
  download issue for that one file and holds up nothing else.
- **The Library has a "Files" section** on both shells (ADR-0088), listing
  `documents/` newest first (`deliverable_list`) with the title read from the
  file's own `docProps/core.xml`, so a document synchronised from another
  device is titled too. Each row is the chat's `subrosa:file` card.
- **`make_document` is an assistant permission** (`documents`, ADR-0058),
  in the editor of both shells. An assistant saved before it existed does
  not have it; the default chat keeps the tool.
- **Code mode can be chosen in the new-chat composer** once a working folder
  is picked. The choice is held for that folder until the first message
  creates the session; the start is recorded under the new session before
  the message reaches the agent, and the first message carries the Code mode
  block. A start the app refuses leaves the session bar's Code button off,
  with the reason.
