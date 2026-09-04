# ADR 0048: The share sheet drops into an inbox the app reads

- Status: accepted
- Date: 2026-09-05

## Context

On the phone, the way something gets into an app is the share sheet: a
link in Safari, a voice memo, a recording someone sent, a paragraph in a
message. Sub Rosa could take a link through `subrosa://import?url=…` and a
file through the notes screen's picker, but it was not in the share
sheet, so the phone's most natural gesture did not reach it. An iOS share
extension is a separate process with its own bundle, its own signing and
no access to the host app's files, database or keychain; the question was
what it should do, and how little.

## Decision

**The extension does one thing: it drops what was shared into an inbox in
the app group container and opens the app on `subrosa://share/<id>`. The
app does everything else, the way it already does for every import.**

- **A manifest per share.** `share-inbox/<id>.json` with one of three
  shapes: a link (`https?` only), a file (copied next to the manifest, one
  path segment, the id as prefix, at most 512 MB), or a text. The id is a
  UUID the extension made; the app refuses anything else.
- **The app validates before it acts.** `share_inbox::import_shared_item`
  checks the id, reads the manifest, refuses a link that is not a web link,
  a file name with a separator, an empty or oversized text; then a link
  starts an ingest (ADR 0028, with its own refusal of loopback and private
  hosts), a file goes through the same staging and import as a picked file
  (ADR 0026), a text becomes a note with its first line as the title. The
  manifest and the file are deleted once consumed: a share is acted on
  once.
- **Rows, not sessions (ADR 0018).** The extension never waits for the
  app; the app never waits for the extension. A share the app did not
  get to (killed before the URL arrived) is a manifest still in the inbox,
  and the destination router can be pointed at it again.
- **The destination router is the only entry (ADR 0025's vocabulary).**
  `subrosa://share/<id>` is one more arm in `parseDestination`; the phone
  shell handles it like a notification tap: switch to the notes tab, act,
  open the note when one was made.
- **Signing is two profiles and one group.** The extension is its own
  bundle (`xyz.carpediem.subrosa.share`) with the app group
  `group.xyz.carpediem.subrosa` on both entitlements; the release lane
  installs the extension's provisioning profile next to the app's and
  maps both in the export options. The App Store Connect steps that create
  the group, the extension's App ID and the two profiles are in
  `HANDOFF.md`; until they are done, the lane fails at export, on purpose,
  rather than shipping an app whose share sheet entry does not work.

## Alternatives considered

- **Doing the work in the extension.** It has no key, no database, no
  sidecar, and a few seconds of memory budget; a transcription there is
  impossible and a fetch there would duplicate the ingest rail.
- **A Darwin notification or a URL with the payload.** A URL cannot carry
  a file; a notification cannot carry anything and is lost when the app is
  not running. A file in a shared container survives both.
- **Handing the file through the app's own document picker.** The share
  sheet is where people are when they want to hand something over; the
  picker is a second gesture in another place.

## Consequences

- `gen/apple/project.yml` declares the `os-june_Share` target and the app
  embeds it; the project is regenerated with `xcodegen` (a placeholder
  `assets/` folder is needed for the spec to validate outside a Tauri
  build). The Swift is one file, `ShareExtension/ShareViewController.swift`.
- `import_shared_item` is a mobile-only command (allowlisted in
  `tests/shared_commands.rs`); the manifest rules are tested on every
  platform.
- The extension's Info.plist carries the same placeholder version as the
  app's; `tauri ios build` stamps the real one.
