# ADR-0101: The web client runs agent-lite from Rust's own words

Date: 2026-10-08. Status: accepted. Builds on
[ADR-0096](0096-a-browser-is-a-device.md) (a browser device may write) and
[ADR-0052](0052-the-surfaces-share-primitives-not-a-stylesheet.md) (surfaces
share primitives, not components).

## Context

The web client (`/app`, parity WP19) is a chat that has to behave like the
phone's: the same system prompt, the same tools, the same memory and
personalization blocks, the same rows on the account, and the app's revision
and conflict rules when it writes them. All of that lives in Rust
(`agent_lite`, `memory`, `personalization`, `account/sync_tables.rs`,
`account/sync.rs`) and the site is TypeScript with no Rust at runtime. A second
copy of the prompt prose or of the table allowlist would drift the first time
somebody edited one side.

## Decision

1. **Rust renders, the site reads.** A Rust test
   (`src-tauri/src/agent_lite/web_client_export.rs`) writes
   `packages/chat-core/agent-lite.json`: the system prompt, the answer-pass
   nudge, the memory and personalization words, the default model, the
   research limits, the declarations of the tools a browser can run, and the
   columns and routing kind of the tables it touches. The test fails when the
   committed file no longer matches (`SUBROSA_WRITE_WEB_EXPORT=1` rewrites
   it). The prose stays in Rust consts; the site never restates it. The only
   web-only prose is one appended paragraph naming what a browser cannot do.
2. **Pure chat logic is a workspace package.** `packages/chat-core`
   (`@subrosa/chat-core`) holds the framework-free modules both surfaces use:
   the context gauge, the reasoning-effort levels and alias, speakable text and
   speech chunks, the chat-block fence and conversation Markdown. Their words
   are each surface's own (the app's `t()` catalogs, the site's two-language
   `t()`), injected, so neither catalog leaks into the other bundle. The
   markdown renderer and the chat-block cards stay per surface, as ADR-0052
   decided.
3. **One protocol, ported.** `website/src/client/sync.ts` ports the rules of
   `account/sync.rs` for the conversation, memory, note and folder kinds: a
   write names its parent, is frozen before its first send and retried byte
   for byte, a received revision applies only when it descends from the local
   head with nothing unsent, anything else is kept as a conflict, and an
   identical sibling is acknowledged. A fixture written by the TypeScript
   writer (`src-tauri/tests/fixtures/web-client-objects-v1.json`) must pass the
   app's `verify` and `apply` (`sync_tests.rs`).
4. **Only ciphertext at rest in the browser.** The IndexedDB cache keeps the
   revisions as the service sent them and unsent writes sealed under the vault
   key with a local context; ratings and the chosen model are the only clear
   values. Personalization is sealed and stays in the browser, because the app
   keeps it per device too.

## Alternatives considered

- **Copy the prompt into TypeScript, with a test comparing it.** Rejected: the
  comparison needs Rust to produce the text anyway, at which point the file is
  the copy.
- **Move the prose to text files both read (`include_str!` and `?raw`).**
  Workable for the prompt, awkward for the tool declarations and the table
  allowlist, which are Rust values; one generated file covers all three.
- **Import the app's modules from `src/` directly.** Rejected: they import the
  app's translation catalogs and Tauri bindings, which would land in the site's
  bundle.
- **A cleartext IndexedDB cache.** Rejected: the page already holds the vault
  key only in memory and locks after fifteen minutes; a readable cache would
  outlive both.

## Consequences

- Editing agent-lite's prompt, a tool declaration, the memory or
  personalization words, or a travelling table's columns means rerunning the
  export test with the write flag and committing the JSON; CI fails otherwise.
- The web client's tools are a subset (notes, memories, web search and page
  reading, note writes, remember). Calendar, places, imports, long-form
  summaries, files and Python stay in the app until WP20.
- Conflicts the browser keeps are reviewed in the app; the web client shows
  that some exist and resolves only identical ones.

## Addendum 2026-10-08: what WP20a adds to the web client

The second half of the web client's parity work (shares, memory management,
past chats, projects, files and vision, chart and table cards, the canvas,
pictures, the saved library, custom assistants and publishing) keeps the
decision above and extends it in four places.

1. **More of Rust's words are exported, never restated.** `agent-lite.json`
   now also carries the project section of `agent_lite_section` and its
   `search_project_files` tool, the past-chats block and its tool, a custom
   assistant's system prompt and `search_references`, `CARDS_PROMPT`, the
   canvas rewrite (`note_ai`, `note-rewrite-v2`) and the refine pass's
   critique, edit suffix, pass limit and edit models. Sentences built with
   `format!` are rendered by the export with placeholders (`{name}`,
   `{instructions}`, `{files}`, `{title}`), so the template is Rust's own
   output rather than a copy. The parsers both surfaces need (chart and table
   blocks, chart geometry, the canvas and try-on blocks, the try-on prompt)
   moved to `@subrosa/chat-core`, their words injected as before.
2. **The browser reads two more kinds, and only the tables it uses within
   them.** `artifact` and `settings` join the pulled kinds, for project files,
   saved items, assistants, assistant references and gallery files. A revision
   of any other table of those kinds (a health day, a recording, an
   assignment) is left undecrypted into the page's state and uncached: the
   allowlist is per table, not per kind.
3. **A project's settings share their folder's object.** The app keys
   `project_settings` by its folder's id (migration 048), so on the service
   the folder and its settings are one object whose revisions alternate
   between the two tables. The browser keeps the two rows apart under one
   object (one head, one revision chain) and rewrites an unsent write in place
   only when it is for the same table. `sync_web_tests.rs` applies a fixture
   written by the browser (`web-client-objects-v2.json`) with the app's own
   `verify` and `apply`.
4. **What the browser cannot do durably, it says.** A queued picture is polled
   while the tab is open and its queue id is kept, sealed, so a reload fetches
   it rather than paying for it twice; there is no background runner. A
   document is read in the tab (pdf.js on the page's thread, since a worker
   URL would need a Trusted Types policy; Office files through the browser's
   own `DecompressionStream`), and only its text travels.
