# ADR 0042: The archive is the bridge between devices, not a synchronisation

- Status: accepted
- Date: 2026-09-03

## Context

Sub Rosa's promise is that nothing leaves the machine except the requests
made of a model, to the endpoint the user configured. That promise had two
costs nobody had paid for: there was no way to take one's notes off the
machine except one note at a time, and no way to bring them back at all.
Desktop and iPhone share the code and the schema; they do not share the
data. ADR 0039 declined to encrypt the database at rest and said, in so many
words, that an encrypted export was the better use of the same effort,
because it covers the case a person actually has: an archive leaving the
machine.

## Decision

**One file, written on purpose, restored on purpose, sealed if asked.**

- `Settings › Import / export` writes an archive of the person's corpus:
  every table that is theirs (notes, transcripts, folders, memories, the
  bible, shot lists, agent conversations, the dictionary), one JSON-lines
  file per table with every column, plus one Markdown file per note so the
  archive is readable without this app, plus the recordings when asked. It
  is a tar stream; with a passphrase it is wrapped in age (scrypt), a format
  `age` and `rage` open on any machine.
- Restoring is an upsert by primary key. Importing an archive twice changes
  nothing; importing into a fuller database adds without removing. Runtime
  state (jobs, ingests, briefs, sittings, checkpoints) is not archived: it
  belongs to the process that started it.
- The archive goes where the native dialog says (desktop) and comes from
  where the native dialog says (both shells); no path crosses IPC
  (`spec/no-write-path-over-ipc.md`). The phone exports through the share
  sheet in a later change.
- **This is not a synchronisation.** No service, no account, no background
  transfer, no conflict resolution. Two devices are two corpora; the archive
  is how one is carried to the other, by a person, when they choose.

## Alternatives considered

- **A sync service.** It would move the database off the machine, which is
  one of ADR 0039's own conditions for revisiting encryption at rest, and it
  would put a third party inside a product whose one claim is that there is
  none.
- **Encrypting the database and copying the file.** The file carries WAL
  state, absolute paths and runtime rows, and a copy of a live SQLite
  database is not a backup. Also ADR 0039.
- **A zip.** Would have needed a new crate above the shell's MSRV; tar is
  pure Rust, older than most of the tree, and every platform opens it.

## Consequences

- The archive format is versioned in its manifest; a newer archive refuses
  to import into an older app rather than importing what it half
  understands.
- `docs/threat-model.md` gains the archive as an asset: sealed, it is safe
  to carry; in the clear, it is the notes.
- ADR 0039 is not superseded. The database on disk is still not encrypted,
  for the reasons it gives; what leaves the disk can be.
