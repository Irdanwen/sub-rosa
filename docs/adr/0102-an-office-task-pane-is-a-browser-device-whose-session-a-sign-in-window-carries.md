# ADR-0102: An Office task pane is a browser device whose session a sign-in window carries

Date: 2026-10-08. Status: accepted. Builds on
[ADR-0096](0096-a-browser-is-a-device.md) (a browser is a device),
[ADR-0101](0101-the-web-client-runs-agent-lite-from-rusts-own-words.md) and
[ADR-0104](0104-the-web-clients-features-run-in-the-tab-under-a-policy-of-their-own.md)
(the web client's turn, Rust's words, a policy per route), and applies
[ADR-0038](0038-a-note-rewrite-is-proposed-never-applied.md) to Office
documents.

## Context

Parity work package WP22 puts Sub Rosa in Word, Excel and PowerPoint. An
Office add-in is a web page Office shows in a task pane: on the desktop apps
(Windows with WebView2, Mac with WKWebView) the pane is a top-level web view;
in Office on the web it is a frame inside Microsoft's page. Three facts shaped
the design.

- **A pane is a browser context.** It can hold WebCrypto keys no script can
  copy, so it can be a device under ADR-0096 with its own bounded Carpe Diem
  key. It cannot be "the app".
- **In Office on the web, the pane has no session.** The account cookie is
  `SameSite=Lax`, so a cross-site frame never sends it; the frame's storage is
  partitioned under Microsoft's site. Signing in inside the frame is also
  impossible: the identity provider's pages refuse to be framed. Office's own
  answer is the dialog API, a top-level window on the add-in's origin.
- **Office requires its library from Microsoft's CDN**
  (`appsforoffice.microsoft.com/lib/1/hosted/office.js`), updated in place, so
  it cannot be pinned by Subresource Integrity. Read on 2026-10-08, it supports
  Trusted Types when its tag carries `data-enable-trusted-types="1"`: it then
  loads its host files through a policy named `officejs` that admits only its
  own origin. It also frames a telemetry service
  (`telemetryservice.firstpartyapps.oaspapps.com`).

## Decision

1. **The pane is a browser device of its own.** It runs the site's own
   `browser-device.ts` and `BrowserDeviceCard`: a non-extractable device key, a
   key minted by Carpe Diem with the browser bound (two dollars a day, seven
   days), sealed in the pane's IndexedDB. It needs a session only to become a
   device, renew the key or renounce; inference goes straight to Carpe Diem
   with the key, like `/app`. A pane does not unlock the vault: it reads no
   notes, memory or history, and writes nothing to the account.
2. **When the frame has no session, a sign-in window carries it.** The pane
   opens `/office/session.html` with `displayDialogAsync`. The window signs in
   on the account origin like any page (the service accepts it as a
   `return_to`), then relays exactly seven calls (`/me`, the device list,
   pairing, admission, the key's assertion, renouncing) over Office's
   `messageChild`/`messageParent` channel, adding its cookie and CSRF token.
   Every device proof is signed in the pane, single-use and bound to its URL;
   the assertion is bound to an ephemeral key that never leaves the pane. What
   crosses Office's channel spends nothing. The window refuses a recovery-key
   admission (`recovery_proof`), since that value would cross Microsoft's host
   page: through the window, only the app's approval admits a pane. When the
   frame does have a session (the desktop panes, signed in in place), it
   calls the service directly and the recovery key is offered as on the site.
   The window closes itself once the key it was opened for is there.
   `website/src/lib/api.ts` gained one seam for this, `setApiTransport`.
3. **Everything a pane does is proposed, then applied on confirmation.** A
   rewrite replaces the selection only if it is still the passage it was
   written for; a formula goes to the cell it was made for; an analysis goes
   to a new sheet; slides are inserted in the destination's theme. Text a
   model put in a table is written as text (a leading `=`, `+`, `-` or `@`
   gets Excel's apostrophe), never as a formula.
4. **The words are Rust's, the loop is the web client's.** Word's rewrites are
   the note editor's own messages (`note_ai::prompts`); what has no app
   counterpart (a summary, a draft at the cursor, formula help, range analysis,
   slide drafting) is rendered by `agent_lite/web_features/office.rs` into
   `packages/chat-core/web/office.json`. Drafting and analysis run
   `agent.ts::runTurn` with only the web tools and the pane's own; Excel mounts
   the selected range for `run_python` as `/data/selection.csv` through the
   same Pyodide worker as `/app`; PowerPoint offers `make_document`'s own
   declaration and builds the deck with the site's ported writer, then
   `insertSlidesFromBase64`.
5. **`/office/` has a policy of its own.** The site's policy plus:
   `https://appsforoffice.microsoft.com` in `script-src` and `frame-src`
   (Office's error page), `trusted-types subrosa officejs`, WebAssembly and a
   blob worker for the Excel pane's Python (one policy for the three panes),
   no `X-Frame-Options`, and `frame-ancestors` naming Office's own hosts
   (`*.officeapps.live.com`, `onedrive.live.com`, `*.office.com`,
   `*.office365.com`, `*.cloud.microsoft`, `*.sharepoint.com`). `connect-src`
   stays the site and Carpe Diem: Office.js's telemetry frame is refused on
   purpose.

## Alternatives considered

- **`SameSite=None` on the account cookie.** The pane would have a session in
  Office on the web, and so would every other site that frames or posts to the
  account origin: a weaker cookie for every page to serve one.
- **The window mints the key and hands it to the pane.** Simpler, but the
  spending key would cross Microsoft's host page in clear.
- **Office's single sign-on or nested app authentication.** They give a
  Microsoft identity token; Sub Rosa accounts are not Microsoft accounts, and
  the service would have to trust Microsoft's issuer.
- **A pane that runs nothing until the person pastes a key.** An unbounded key
  typed into a frame on someone else's site; ADR-0096 refused the same thing
  for the website.
- **Dropping Trusted Types on `/office/`.** Unnecessary once Office.js's own
  opt-in was found.
- **One unified JSON manifest.** Still in preview for Word, Excel and
  PowerPoint when written; one XML add-in-only manifest per host sideloads
  everywhere today.

## Consequences

- `office-addins/` is a workspace package built after the site
  (`pnpm build:website`) into `website/dist/office/`, served by the account
  origin. `office-addins/manifests/*.xml` are generated from one script and
  validated by `office-addin-manifest`, which calls Microsoft's online
  service.
- The account vhost needs the `/office/` block of
  `nginx-account.conf.example` (or the Caddy example, or `_headers`), and the
  service needs the new `return_to` entry, before a pane can sign in.
- A pane in Office on the web asks for the sign-in window to become a device
  and every few days to renew its key; a desktop pane signed in in place
  does not. A recovery key cannot admit a pane through the window.
- Nothing here ran inside real Office when it was written: the panes were
  tested with Office.js replaced, the built pages in headless Chromium with a
  stub and with Microsoft's real library outside Office, and the manifests
  with Microsoft's validator. Before announcing the add-ins, sideload each on
  Windows, Mac and the web and check the sign-in window, the frame-ancestors
  list and the telemetry refusal there (docs/office-addins.md).
- AppSource submission is an external gate: a publisher account, the
  validation run, and Microsoft's review.
