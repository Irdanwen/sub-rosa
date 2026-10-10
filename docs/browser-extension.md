# Browser extension

The Sub Rosa extension asks the desktop app about the page you are reading,
adds a passage or an answer to a note, and saves the page's link to the
Library. It talks only to the app on the same computer, through native
messaging. Decision record: [ADR-0100](adr/0100-the-browser-extension-reaches-the-app-through-native-messaging-and-a-pairing.md).

```
browser-extension/        the extension (pnpm workspace package, no dependencies)
  manifest.json           the source manifest; the build derives each flavour
  _locales/{en,fr}/       its own strings (chrome.i18n), tested for parity
  src/protocol.js         the message protocol (mirror of protocol.rs)
  src/panel.{html,js,css} side panel and popup (one page, two surfaces)
  src/background.js       the selection menu
  scripts/build.mjs       dist/chrome, dist/firefox, and the store zips
src-tauri/src/browser_extension/
  host_manifest.rs        per-browser registration (folders, HKCU keys)
  relay.rs                the binary as a native messaging host
  endpoint.rs             the socket or pipe the relay connects to
  pairing.rs              codes, tokens, the saved book
  session.rs              what one frame means (pure)
  server.rs               the listener and the agent-lite turn
src/components/settings/BrowserExtensionSection.tsx   Settings › Browser extension
```

## Build

```
pnpm --filter @subrosa/browser-extension build
```

writes `browser-extension/dist/chrome/` (load unpacked in Chrome, Edge or
Brave), `dist/firefox/` (load as a temporary add-on), and
`dist/subrosa-chromium-<version>.zip` / `dist/subrosa-firefox-<version>.zip`
(the store uploads). The icons come from `src-tauri/icons`, the colours and
type from `packages/design/primitives.css`. The extension's version is its own
(`manifest.json` and `package.json`, kept equal by a test); bump it for each
store submission, independently of the app.

## Try it locally

1. Run the app (`pnpm tauri:dev`), open Settings › Browser extension and
   choose **Connect a browser**. The app writes a host manifest for every
   browser it finds and shows a six-digit code.
2. Chrome, Edge, Brave: `chrome://extensions`, Developer mode, **Load
   unpacked**, pick `browser-extension/dist/chrome`. The pinned `key` gives it
   the id `aphalahbhpimjbfdkjkdfgfbohboceig`, which only a development build
   allows (or a release built with `SUBROSA_ALLOW_UNPACKED_EXTENSION=1`): the
   key that fixes that id is public, so anyone could load an extension under
   it. Firefox's add-on id is allowed in every build.
   Firefox: `about:debugging`, This Firefox, **Load Temporary Add-on**, pick
   `browser-extension/dist/firefox/manifest.json`.
3. Click the toolbar button, type the code. The panel shows the actions.
4. On a web page: **Summarize** (streams into the panel; the chat also
   appears in the app's chat list), a question, **Add to a note**, **Save link
   to library**; select text and use **Ask Sub Rosa** from the context menu.
5. Settings lists the paired browser; **Remove** makes the extension ask for a
   new code; **Turn off** removes the manifests.

A debug build registers its own binary under the same host name, and a
release build rewrites the manifest at its next launch: after switching
between them, reopen the one you are testing.

What the automated tests cover and what they do not: the protocol, pairing,
manifest generation, the relay's argument detection and byte pump, the
session decisions and the framing loop are unit tested (Rust and vitest).

A real-browser run (2026-10-08): the built `dist/chrome` loaded into Chrome
for Testing 151 (new headless, throwaway `--user-data-dir`, driven over
DevTools), English and French UI. Without a host manifest the panel says the
browser is not set up; with one pointing at the debug `os-june` and no app,
the relay answers "Sub Rosa is not open"; against a stand-in app socket that
speaks `protocol.rs`, a wrong code, the right code, then the toolbar action
on a local page (`Extensions.triggerAction`, which grants `activeTab`) and a
question streamed back through the real relay, followed by Save link and Add
to a note. It found one bug, since fixed: the main view showed under the
pairing form, because blocks that set `display` beat the `hidden` attribute.
Not covered: the registry half on Windows, and a full turn through a running
app (the stand-in does not run agent-lite).

Testing with a throwaway profile: Chromium looks for user-level host
manifests in `<user data dir>/NativeMessagingHosts/`, so a browser started
with `--user-data-dir` does not see the manifests the app writes in the
default profile's folder (`~/Library/Application Support/Google/Chrome/...`).
Copy the manifest into the throwaway profile's `NativeMessagingHosts`, or
test in the browser's normal profile.

Two traps seen on 2026-10-10 (`docs/qa/parity-1.89.1.md`), with Brave on
macOS. A Brave started with `--user-data-dir` read neither that folder nor
Brave's own `NativeMessagingHosts`, but Chrome's
(`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`); the
app writes that one too, so the normal flow works, but an edit to Brave's
copy changes nothing. And a debug build run from a checkout under
`~/Documents`: the browser starts the host from there, macOS holds it in
`dyld` behind the folder's privacy prompt ("june" would like to access
files in your Documents folder), and the panel waits with no message.
Point the manifest's `path` at a copy of the binary outside `~/Documents`,
or keep the checkout elsewhere. A release build in `/Applications` is not
affected.

## Publishing (not automated)

The stores assign their own extension ids. Each one must be added to
`STORE_CHROMIUM_EXTENSION_IDS` in `src-tauri/src/browser_extension/host_manifest.rs`
and shipped in an app release **before** the store listing goes live, or the
browser will refuse to start the host for the store copy.

**That list is empty today (2026-10-10):** the extension is not published in
any Chromium store yet, so a release build answers no Chromium extension at
all, and the unpacked id works only with a development build. Firefox works
in every build (its id is fixed by the manifest). The app also checks the
origin the relay reports against the same list when a connection names it
(`session.rs`), and on Windows its pipe carries a DACL that admits only the
user the app runs as (`pipe_security.rs`).

- **Chrome Web Store** (also what Brave installs from): create the item with
  the developer account, upload `subrosa-chromium-<version>.zip`, fill the
  privacy practices (no data collected; the page is sent to the app on this
  computer only, on the user's click; `nativeMessaging` justification: talks
  to the Sub Rosa desktop app; `activeTab`/`scripting`: reads the current page
  when asked), and submit. Copy the assigned id into `STORE_CHROMIUM_EXTENSION_IDS`.
- **Microsoft Edge Add-ons** (Partner Center): upload the same zip; Edge
  assigns a different id, which is added to the list too.
- **Firefox Add-ons (AMO)**: upload `subrosa-firefox-<version>.zip`. The id is
  fixed by `browser_specific_settings.gecko.id`
  (`browser-extension@subrosa.carpediem.xyz`), so nothing changes in the app.
  The manifest declares `data_collection_permissions: none`. Self-distribution
  (a signed `.xpi` from AMO's unlisted channel) is an alternative.
- **Safari**: `xcrun safari-web-extension-converter browser-extension/dist/chrome`
  produces an Xcode project, but Safari has no registered native messaging
  host: its extensions reach native code through the containing app's
  extension handler. Supporting it means a Safari app extension that forwards
  to the same socket; out of scope for now.

## What the release pipeline needs

- **macOS**: nothing to sign. The host is the app binary itself
  (`Sub Rosa.app/Contents/MacOS/os-june`), signed with the hardened runtime
  and notarized with the bundle. Should a separate helper ever replace it, it
  must be signed like the Swift helpers in `release.yml` (with
  `HelperEntitlements.plist`, before the bundle is sealed). A copy run from a
  quarantined download is translocated to a random folder; Settings refuses
  to register it and asks to move the app to Applications.
- **Windows**: nothing in the installer. The app writes
  `HKCU\Software\{Google\Chrome,Microsoft\Edge,BraveSoftware\Brave-Browser,Mozilla}\NativeMessagingHosts\xyz.carpediem.subrosa`
  (default value: a manifest under the app's data folder) when the person
  connects a browser, and removes them on **Turn off**. Follow-up: an NSIS
  `NSIS_HOOK_POSTUNINSTALL` hook (`bundle.windows.nsis.installerHooks`) could
  delete those four keys on uninstall; today they are left pointing at a
  missing binary, which the browser reports as an unavailable host. To verify
  on the first Windows build: the release binary is a GUI-subsystem
  executable, and the relay relies on the browser handing it redirected
  standard handles, which Chromium and Firefox do.
- **Optional**: attach the two zips to the GitHub release (a step running
  `pnpm --filter @subrosa/browser-extension build` and `gh release upload` of
  `browser-extension/dist/*.zip`), so a store submission always matches a
  tagged source.
