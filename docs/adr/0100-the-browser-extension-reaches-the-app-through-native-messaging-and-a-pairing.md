# ADR 0100: The browser extension reaches the app through native messaging and a pairing

- Status: accepted
- Date: 2026-10-08

## Context

People read on the web and want to ask about what they are reading, keep a
passage in a note, or keep the link. A browser extension is the surface for
that, but Sub Rosa has no server to put behind one: inference runs through
the desktop app's sidecar with the person's own key, the notes and the
Library are in the app's database, and the fork's rule is that the binary
talks to nothing it does not need (ADR-0017). So the extension can only be
useful by reaching the app running on the same computer, and every way of
doing that is a new door into the app.

Three questions had to be settled: how the extension reaches the app, how
the app knows the caller is the person's own extension, and what runs the
turn when the desktop chat is a Hermes session driven by the webview.

## Decision

**The extension talks only to the desktop app, through the browsers' native
messaging. The host is the app's own binary in a relay mode; a code shown in
Settings pairs one extension, which is then known by a token bound to its
origin. A question runs as an agent-lite turn filed in the chat list.**

- **Native messaging, no port.** Chrome, Edge, Brave and Firefox all start a
  registered "host" executable and talk to it over stdin and stdout. The app
  registers itself, per user and per browser, from Settings › Browser
  extension (a manifest file in each browser's folder on macOS and Linux, an
  `HKCU` registry key pointing at a manifest on Windows); nothing is
  registered at install. `allowed_origins` names the extension ids
  (`CHROMIUM_EXTENSION_IDS`, the Firefox add-on id), so no other extension can
  start the host.
- **The host is the signed app binary, as a relay.** `main` recognises the
  arguments a browser passes to a host (a `chrome-extension://` origin, or the
  Firefox add-on id) before Tauri starts, and runs `browser_extension::relay`:
  connect to the running app, send the origin the browser reported, then copy
  bytes both ways. It parses nothing and needs no window. It reaches the app
  over a Unix domain socket in the app's data folder (owner-only, peer uid
  checked) or a per-user named pipe on Windows (first instance only, remote
  clients rejected). When the app is not open the relay says so and exits.
- **Pairing is explicit and bound.** "Connect a browser" shows a six-digit
  code for five minutes and five attempts, kept in memory only. The extension
  trades it for a random token; the app keeps the token's hash with the
  origin the relay reported, and a token presented from any other origin is
  refused. Each paired browser is listed and removable in Settings; "Turn off"
  removes every manifest and every pairing. A moved or updated app rewrites
  its manifests at launch.
- **A question is an agent-lite turn.** The desktop chat is Hermes, driven by
  the webview through its gateway; the extension must work with the window
  closed. Agent-lite is the Rust tool loop the phone and custom assistants
  already run on the desktop, so the question becomes an ordinary chat (in the
  app's chat list, titled, memory-eligible) and the answer is streamed back
  from agent-lite's own delta and status events. The page's text travels as a
  text attachment of that turn, marked `[File: …]` in the stored message like
  any other, so a turn resumed without it fails cleanly instead of guessing.
  A connection that closes mid-answer does not stop the turn.
- **The page is read on a click, never in the background.** The extension
  holds `activeTab` and `scripting`, no host permissions and no content
  scripts: the toolbar button, its keyboard shortcut or the selection menu
  grants access to that tab, and the panel reads it with one
  `executeScript` when a button asks. Only `http(s)` pages are read, bounded
  (60 000 characters of text, 20 000 of selection) on both sides.
- **Saving reuses what exists.** "Add to a note" writes an ordinary note
  through `agent_notes::create` (the chosen text or the last answer, then the
  page's link). "Save link to library" writes the same `saved_items` row a
  chat's link card writes (ADR-0088), so it syncs and shows in the Library.
- **The extension is its own package.** `browser-extension/` is a pnpm
  workspace package with no dependencies: plain ES modules, its own
  `_locales` (English and French), and a build script that stages a Chromium
  and a Firefox flavour and writes the store zips. The source manifest pins a
  `key` so an unpacked install has the id the host allows; the store zips
  drop it, and each store's id is added to `CHROMIUM_EXTENSION_IDS` before
  the release that should accept it.

## Consequences

- Nothing new is signed or notarized: the host is `Contents/MacOS/os-june`,
  already signed with the hardened runtime. The Windows installer is
  unchanged; the registry keys are the app's to write and remove.
- The app has to be open. A closed app is a clear message in the extension,
  not a launch: starting a GUI app from a background relay would surprise.
- On a multi-user Windows machine another user could create the pipe first;
  the app then refuses to listen rather than share it, and the token still
  protects the requests. Same-user malware can reach the socket, as it can
  reach everything else that user owns.
- Uninstalling the app leaves manifests pointing at a missing binary; the
  browser then reports the host as unavailable, which the extension explains.
- Safari is not covered: its extensions reach native code through the
  containing app's extension handler, not a registered host.

## Alternatives considered

- **A loopback HTTP port with a token.** Works in every browser and needs no
  registration, but it is an open port any local page can probe, it needs
  CORS and a port-discovery story, and it contradicts "nothing listening".
- **A separate helper binary as the host.** Smaller, but one more executable
  to bundle, sign, notarize and keep in step, for a relay that is a byte pump.
- **Running the turn in a Hermes session.** It would match the desktop chat
  exactly, but Hermes is driven by the webview's gateway; the extension would
  stop working whenever the window is closed, and the app would need a second
  driver for the same session.
- **Content scripts on every site.** Reading pages ahead of time would make
  answers faster and needs `<all_urls>`, which is exactly the standing access
  this extension exists to avoid.
