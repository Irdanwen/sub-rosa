# ADR 0094: The desktop agent reaches past the app only where the person points

- Status: accepted
- Date: 2026-10-08

## Context

Three desktop features had no answer in Sub Rosa (docs/parity/chatgpt.md):
an agent that can use a website, a chat that can be opened from anywhere
with a shortcut, and a question that can carry what the person is looking at
in another app. Each one moves the agent past the app's own window, which is
where the privacy claims of this fork (ADR 0043, the Seatbelt jail of
ADR 0006) are easy to state. The question was how to give the agent that
reach without inventing a second network path, a second permission model or
a background observer.

## Decision

**The agent reaches outside the app only through something the person
started or pointed at, and the app, not the agent runtime, does the
reaching.**

- **The agent browser is the person's own browser, driven by the app.** The
  app finds an installed Chromium-family browser (Chrome, Edge, Brave, Arc,
  Chromium; nothing is downloaded), starts it with a dedicated profile under
  the app's data and `--remote-debugging-port=0` on loopback, and reads the
  random port and the endpoint path from `DevToolsActivePort`. The DevTools
  socket is a small RFC 6455 client in `agent_browser/ws.rs`, not a crate:
  it never leaves the machine and a WebSocket crate would bring a second
  HTTP stack beside `http_client`. The agent's tools are a relay MCP server,
  `june_browser`, that names an action to the provider proxy
  (`/v1/browser/request`); the browser runs outside the Hermes jail and the
  runtime never learns its port.
- **Consent is per site, asked before the first request.** A site is a
  registrable domain, computed without a public-suffix list (a missing
  multi-label suffix errs strict: the person is asked more, never less). A
  new site raises a card in the main window and the chat bar: always, only
  this time, or no; "always" lands in Settings › Agent, where it can be
  removed. A click that leads to a new site is asked about the same way, and
  a refusal goes back. Stop closes the browser now, and the agent cannot
  reopen it until the person says yes again.
- **Some things stay the person's.** Password, payment and one-time-code
  fields are refused before they are focused (`type="password"`,
  `autocomplete` tokens, and names in several languages, short ones matched
  as words), and so are CAPTCHAs. The tool result tells the agent to hand
  over, in English, because it is addressed to the model; what the person
  reads is the journal, words chosen by the webview from structured entries
  that never hold what was typed.
- **Egress is bounded by the allow list, and recorded.** The browser is a
  declared destination whose host is "sites you allow" (`egress.rs`), and
  each opened page is one row in the egress ledger (host, time, duration;
  nothing of the page). The browser's own traffic is the browser's; the app
  makes no request on its behalf.
- **The chat bar is the agent HUD's panel and dictation's hot key
  machinery.** A non-activating NSPanel, so asking about another app does
  not bring Sub Rosa forward; on macOS the shortcut is one more Carbon hot
  key in the dictation helper, which needs no permission and which already
  owns every global chord (ADR 0041); on Windows a thread holds a
  `RegisterHotKey` registration. A chord the system or dictation holds is
  refused before it is saved. The panel talks to the agent runtime like the
  main window does, so its chat is an ordinary chat.
- **What I'm looking at is read on a click, never before.** Off until turned
  on in Settings › Privacy. The dictation helper, which already holds
  Accessibility and already tracks the frontmost app, reads the app, its
  window title and the selected text; a picture of that one window
  (ScreenCaptureKit) is a second opt-in, explained before macOS asks for
  Screen Recording. The capture becomes files (a short note and the
  picture) attached like any other, so the chip, its removal and the prompt
  are the composer's own. Windows reads the window title only.

## Alternatives considered

- **Bundling a browser (Playwright's Chromium) or using the runtime's own
  browser tools.** Hundreds of megabytes to sign and notarize, a browser the
  person does not know, and tools that would run inside the jail and reach
  the network on their own.
- **The person's main profile.** Every cookie and saved password in reach of
  a model's tool call. A dedicated profile costs one sign-in per site.
- **Consent per URL or per host.** Too many questions to read; per site is
  what a person means by "this website".
- **A global shortcut plugin.** The app has none, and a second registrar of
  global chords beside the dictation helper is how two features end up
  fighting over the same keys.
- **Watching the screen continuously, or capturing on the shortcut.** The
  value is in the person deciding what the question is about; a capture on
  every shortcut would read windows they never meant to share.

## Consequences

- Phones have no agent browser, chat bar or screen awareness (n/a in the
  parity matrix): there is no browser to drive and no global shortcut.
- The agent browser needs a Chromium-family browser; Arc is detected but its
  handling of a separate profile is unverified. Card fields inside
  cross-origin payment frames are out of the snapshot's reach, which keeps
  them out of the agent's reach too.
- The chat-bar shortcut is applied to the dictation helper when the app
  starts and whenever the helper says it is ready; on macOS, a missing helper
  means no chat bar from the keyboard (and no screen awareness), the same way
  it means no dictation.

## Addendum 2026-10-08: Arc is not offered, and Screen Recording belongs to the helper

- **Arc is left out of detection.** The decision above listed Arc among the
  browsers the app may drive, with its profile handling unverified. Checked
  since: nothing The Browser Company documents says `--user-data-dir` gives a
  separate profile rather than opening the person's own (the one thing this
  design never does); public reports show Arc crashing when a tab is created
  over DevTools (`Target.createTarget`, which `cdp::attach_to_page` falls
  back to when the window has no page yet); and its updater relaunches it
  without the command-line flags. Arc was not installed on the machine used
  to check, so it could not be tried. `launch::candidates` no longer lists
  it (a test pins that), and the copy names Chrome, Edge, Brave and
  Chromium. Putting it back needs all three verified on a real install.
- **Screen Recording is granted to "Sub Rosa Dictation Helper", not to
  "Sub Rosa".** The window picture is taken by the dictation helper, which is
  its own app bundle inside Sub Rosa (`xyz.carpediem.subrosa.dictation-helper`,
  display name "Sub Rosa Dictation Helper"). Measured on the installed 1.88.1
  with `responsibility_get_pid_responsible_for_pid`: the helper the app spawns
  is its own responsible process, so macOS attributes its permission requests
  to it, the same way the system audio helper already holds its own Audio
  Capture entry (`xyz.carpediem.subrosa.audio-capture` in the TCC database).
  For the person this means the macOS prompt and the switch in System
  Settings, Privacy and Security, Screen Recording, both say "Sub Rosa
  Dictation Helper", and a grant takes effect once the helper restarts, which
  restarting Sub Rosa does. Settings › Privacy now says so before macOS asks
  and again when the permission is missing. Moving the capture into the main
  binary was not chosen: the helper already owns the frontmost-app tracking
  and Accessibility this feature reads, and a second capture path would split
  one permission story into two.

## Addendum (2026-10-10): consent is held in the browser, before the page loads

The post-release audit of 1.89.0 found the consent gate one step late and the
socket too open. Four changes, all in `src-tauri/src/agent_browser/`:

- **The host is read the way the browser reads it.** `site::host_of` and
  `openable` now parse with the `url` crate (WHATWG rules, already in the
  lockfile through reqwest): http and https only, the host as the browser
  will contact it, IDN in its ASCII form, trailing dot dropped. The hand
  parser took `https://evil.example\@allowed.example/` for `allowed.example`;
  a browser opens `evil.example`, and so does the gate's reading now. Table
  tests cover the backslash, `%2F@`, userinfo, a suffix that is not a site
  and an international name.
- **Consent before load (`gate.rs`).** The decision above said "a click that
  leads to a new site is asked about the same way, and a refusal goes back":
  by then the page had loaded. Every page target is now held by the
  DevTools `Fetch` domain, paused on document requests at the request stage:
  the agent's tab from the moment it is attached, and every tab the browser
  opens later through `Target.setAutoAttach` with `waitForDebuggerOnStart`
  (held, then let run). A main-frame document of a site not yet allowed is
  asked about (120 seconds), then continued or failed with
  `BlockedByClient`; a redirect is a new paused request, so each hop is
  decided; a document inside a frame of an allowed page goes on. The gate
  runs on its own task fed by the client's event channel and never takes the
  action lock; it shares only the consent (`Arc<tokio::Mutex<Consent>>`).
  `open_url` still asks first, so a refusal is its answer; the old check after
  an action (`admit_current`, and `back()` when it fails) stays as a backstop
  only. A refused navigation is reported as the action's result and the tab
  is not sent back, since nothing loaded.
- **The ledger counts what loaded.** One egress row per document the gate
  let through (each redirect hop, each popup), not only per `open_url`.
- **No port on macOS and Linux.** The browser is started with
  `--remote-debugging-pipe` and the app's two pipe ends placed on its fds 3
  and 4 (`pipe.rs`, NUL-framed JSON, the same 48 MB cap), so no other local
  process can reach the browser the agent drives. Readiness is the answer to
  `Browser.getVersion`. Windows keeps the loopback port (handing a child
  extra handles is not something the standard library does there), and
  `--remote-allow-origins` is still never passed, so no web page can open it.

Verified: mock-socket tests (a click toward a refused site is failed before
it loads with no history navigation; an allowed site is continued with a
ledger row; redirects and frames; an attached popup is held before it runs,
a worker only let run) and the opt-in real-browser test, run once over the
pipe against Brave on macOS on 2026-10-10 (`connected to Brave over Pipe`;
the link to a refused site never reached the test server and the tab showed
`chrome-error://chromewebdata/`). The main-frame test assumes a page target's
id is its main frame's id, which that run confirmed.

## Addendum (2026-10-10): the runtime's own browser is switched off

The alternative rejected above was still switched on: the pinned runtime
offers its `browser` toolset (`browser_navigate` and the rest) by default,
and in the parity run of 1.89.1 the agent called it first. It starts a
browser of its own, which fails inside the jail, and only then did the agent
turn to `june_browser`. The `config.yaml` the app writes now carries
`agent.disabled_toolsets: [browser]` (`builtin_mcp::RUNTIME_DISABLED_TOOLSETS`,
rendered by `render_hermes_config`), which the runtime applies last when it
resolves a platform's toolsets, so the model is never offered those tools and
the app's browser is the only one. `web_search`, which the `browser` toolset
also lists, stays reachable through the `web` toolset. Checked against the
pinned runtime's `_get_platform_tools`: `browser` is in the default set and
gone with the key, `web` is kept. Not covered: the runtime's opt-in "focus"
coding posture returns its own `coding` toolset, which lists the browser
tools, before that resolution; the app does not turn that posture on. Test:
`hermes_bridge::config_tests::render_hermes_config_switches_the_runtime_browser_off`.
