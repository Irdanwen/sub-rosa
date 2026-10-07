---
status: accepted
date: 2026-10-07
---

# A reply rating stays on the device, and a conversation file is drawn by the shell

## Context

Work package P1-WP4 of the parity plan (ADR-0078) adds, on the desktop and the
phones, a thumbs up or down on every reply (with an optional reason on a thumbs
down) and the export of a conversation as Markdown or PDF.

In the vendor's product a rating is feedback: it goes to the vendor, to improve
the model. Sub Rosa has no server that trains anything, sends no telemetry, and
says so in Settings › Privacy. Chats themselves synchronise, as ciphertext, to
the person's other devices when they enabled an account (ADR-0049).

For the export, the desktop already turns a note into a PDF with
`window.print()` and print CSS. The phones cannot: `window.print()` does nothing
in WKWebView or the Android WebView. A desktop chat lives in Hermes; the app
reads its stored transcript through the gateway, and only an agent task's
replies are mirrored into `agent_messages`.

## Decision

1. **A rating is the person's, kept on this device.** One row per reply in
   `reply_ratings` (migration 045), keyed by the conversation (the phone's task
   id, the desktop's stored Hermes session id) and the message id. The table
   has no sync trigger (`account::sync::TABLES` does not list it, and a test
   asserts no trigger exists) and nothing reads it to send it anywhere. It
   travels only inside an archive the person writes (ADR-0042), which lists it.
   The reasons are a closed list the shell validates; a free-text reason is
   capped at 500 characters. Settings › Privacy says it in one sentence.
2. **The webview writes the Markdown, the shell writes the file.** Only the
   webview holds the desktop transcript as the person reads it (the attachment
   scaffolding stripped, cards as the lists Copy already makes), so it writes
   the document. `export_conversation` turns it into the file: as is, or as a
   PDF drawn in Rust with the four PDF base fonts, the same on every platform.
   The desktop opens the save dialog in Rust (the path never crosses IPC); the
   phone writes to the app's own export folder, emptied each time, and opens the
   share sheet.

## Consequences

- Ratings do not follow a person to their other devices, and deleting a chat
  leaves its ratings in place until the archive or the device goes. Both are
  the cost of a rating that never leaves; a later synchronised rating would be
  a new kind on the wire and a supersession of point 1.
- The PDF has no embedded font, so it stays small and needs no font file per
  platform, but it covers what WinAnsi covers: English, French and the other
  Western European languages. An emoji is dropped and another script prints as
  `?`. The Markdown export keeps every character, and is the one to choose for
  such a chat.
- The PDF understands what the export writes (headings, paragraphs, lists,
  quotes, rules, fenced code); inline emphasis is dropped and a link prints its
  address after its text.

## Alternatives considered

- **Synchronising ratings with the chat.** Rejected: a rating is not part of
  the conversation, and a new synchronised kind is refused by every older app
  version until it updates (the `studio_marks` precedent, ADR-0073), for a
  feature whose point is a private note.
- **Printing the chat from the webview** (the note's route). Rejected: it works
  on the desktop only, and the chat's layout is not a page.
- **Embedding a Unicode font in the PDF.** Deferred: each platform would need a
  font file shipped or found, and a subsetter, for a case the Markdown export
  already covers.
- **Reading the desktop transcript in Rust from Hermes' state database.**
  Rejected: the webview already holds it, rendered as the person reads it, and
  the database layout is the pinned runtime's, not ours.
