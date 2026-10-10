# ADR-0104: The web client's features run in the tab, under a policy of their own

Date: 2026-10-08. Status: accepted. Builds on
[ADR-0101](0101-the-web-client-runs-agent-lite-from-rusts-own-words.md) (the
web client reads Rust's own words) and amends one clause of
[ADR-0096](0096-a-browser-is-a-device.md) for the `/app` page only.

## Context

WP20b brings to `/app` what the apps already do beyond the chat: deep research
(ADR-0089), study mode and review, Word, Excel and PowerPoint files
(ADR-0090), data analysis in Pyodide (ADR-0086), assignments, scheduled tasks
and the daily brief (ADR-0091), connectors, interactive apps, triggers and
skills (ADR-0092), voice with camera and screen (ADR-0093), finances
(ADR-0099) and protected mode (ADR-0084).

Three constraints decided the shape. The product owner's rule: an agent runs
only while an app is open, a tab on `/app` counts, and nothing executes on the
account service (ADR-0049). ADR-0096's threat analysis rests on a narrow page:
`connect-src` names one origin beyond the site, so material script on the page
could steal cannot be posted anywhere else, and the microphone and camera are
off. And ADR-0101: the prose stays in Rust.

## Decision

1. **Features plug into the chat, they do not fork it.** Each is a module
   under `website/src/client/<feature>/` exporting one `WebFeature`
   (`client/feature.ts`), listed once in `client/features.ts`. It reaches the
   page only through a `FeatureHost`: the synchronised objects, a sealed store
   of its own, the operator and the key, and the page's own turn (`ask`), so a
   research report, an assignment's run or a voice turn is an ordinary chat
   turn with the same prompt, memory and history. A turn gains each feature's
   tools, words, tool narrowing (a skill) and closing cards (a connector)
   through `TurnAddition`.
2. **Rust's words, one file per feature.** `src-tauri/src/agent_lite/web_features/`
   renders `packages/chat-core/web/<feature>.json`: prompts, tool
   declarations, catalogs, limits, the columns of the tables a feature reads,
   and vectors computed by Rust that the TypeScript ports must reproduce (the
   schedule, SM-2, the research ceilings, the run ids, the voice detector).
   The writers of Word, Excel and PowerPoint are ported, not compiled to
   WebAssembly: they sit in the app crate on its error type, `zip` and
   `image`, and a separate wasm crate with `wasm-bindgen` in the site build
   and CI would cost more than a page of XML per format. Rust writes reference
   packages for nine requests and the port is checked part by part.
3. **What a browser pulls stays a decision.** `settings` and `artifact` join
   the pulled kinds, but only for the tables a feature registered; any other
   table of those kinds is authenticated and left unread, and a cursor is kept
   per set of tables so a browser that learns a table reads its kind again.
4. **The tab is the app.** Everything long is durable state sealed under the
   vault key in IndexedDB (`featureStore`): a research run's steps, study
   cards, the assignments' slot ledger, connector calls waiting for approval.
   Each feature's `tick` runs every minute while the page is open; a research
   run whose tab closed is resumed by the next `/app` tab, an assignment's
   missed slot runs once, late, and a run lost with its tab is closed as
   failed. Liveness is a registry in the tab, never a stored flag. Rows
   another device addresses to this browser run only after this browser's own
   switch says so, as for errands (ADR-0054).
5. **`/app` has a policy of its own; the rest of the site keeps ADR-0096's.**
   The web client's page adds, and only there: `'wasm-unsafe-eval'` and
   `worker-src 'self' blob:` for Pyodide (served from the site under
   `/pyodide/`, the worker started from a blob through the `subrosa` Trusted
   Types policy, its `fetch` held to `/pyodide/`); `frame-src 'self'` for the
   connector view host; the microphone, camera and screen in
   `Permissions-Policy`; and, in `connect-src`, the origins of the catalog's
   connectors that a probe from a tab found reachable
   (`client/connectors/web-availability.json`, held equal to the policy by
   `src/test/website-csp.test.ts`). Origins stay named: never `https:`.
6. **Connectors from a tab, or not at all.** A catalog server answers a tab
   only if it allows the site's origin; one that does not (Sentry, Stripe,
   Zapier, monday.com, Cloudflare's documentation server when probed on
   2026-10-08) is shown unavailable on the web with its reason. A custom
   server in developer mode works from a tab only when its origin is one the
   policy names; otherwise the page says to use it in the app. Nothing is
   proxied through the account service. Sign-in is OAuth with PKCE redirecting
   to `/app`; the verifier, the state and the tokens are sealed under a
   non-extractable key in IndexedDB, survive the redirect while the vault is
   locked, and never travel. An interactive view runs in a sandboxed frame
   (`allow-scripts`, no `allow-same-origin`) onto `/connector-view.html`,
   which has its own policy and writes the view under the view's narrower one.
7. **Protected mode is per browser.** Like the app's, it does not travel: a
   PIN sealed in this browser's store, hashed with PBKDF2-SHA256 (WebCrypto
   has no scrypt), the same guards (adult models, quiet hours, memory, past
   chats, media, voice) applied by the page before a request leaves.

## Alternatives considered

- **`connect-src https:` on `/app`.** Every custom server would work, and the
  page could then post a stolen key or a decrypted note anywhere: the bound
  ADR-0096 counts on would be gone for the page that holds the most.
- **Relaying connectors through the account service.** It would see tokens
  and tool results, and run on behalf of a closed tab; ADR-0049 forbids both.
- **One policy for the whole site.** WebAssembly, blob workers, the
  microphone and third-party origins would reach the account and sign-in
  pages, which need none of them.
- **A scheduler on the service for the web.** Refused by the product owner's
  rule; the tab's clock is the honest one.

## Consequences

- Deploying the web client now means installing the `/app`, `/connector-view.html`
  and `/pyodide/` blocks of `nginx-account.conf.example` (or the Caddy
  example, or `public/_headers`), and the site build grows by Pyodide's
  20.35 MB (about 13 MB compressed). Nothing works before ADR-0096's
  deployment gates.
- Adding a catalog connector to the web is a probe run
  (`node website/scripts/probe-connectors.mjs`), the JSON, and the policy in
  three files, which the test keeps equal.
- A closed tab runs nothing: no assignment, no trigger, no research step.
- Calendar, places, imports and long-form summaries remain app-only, and the
  page tells the model so.

## Addendum 2026-10-08: one web client with the shares, projects and pictures

The web client's other half (shares, memory, projects, files and vision,
cards, the canvas, pictures, the library, assistants and publishing, ADR-0101
addendum) was merged into this one. Each shared mechanism kept one
implementation:

- **One tool registry.** A chat's own shape of a turn (`turn-plan.ts`) is a
  `ChatPlan`: a `TurnAddition` like a feature's, plus the memory scope and,
  when it has one, its own system prompt. `turnTools` offers agent-lite's
  tools, the plan's, then each feature's, a name once; a custom assistant's
  permitted tools are a `narrow`, so a feature's tool is offered to an
  assistant only if it permits it. The assistant's prompt carries protected
  mode's instruction and no feature's words.
- **One picture rule.** A photo from the composer and a feature's picture (a
  voice turn's camera or screen frame) both go through
  `attachments.ts::visionModelFor`: a model exactly as private that reads
  images, or a refusal. The voice module no longer routes on its own.
- **One block contract.** `BlockRenderer(name, payload, id)` in
  `lib/chat-blocks.tsx`, called only for a payload that parsed; the page tries
  the features' blocks, then the workspace's cards, then the list.
- **One gallery module.** `client/gallery.ts` files pictures and documents on
  the Studio lane and reads them back with the manifest checks of
  `files.rs::manifest_chunks`; one zip reader (`documents/unzip.ts`) serves
  attached files and the documents written here.
- **What a browser pulls.** The tables Rust exports in `agent-lite.json`
  (projects, saved items, assistants, gallery files) are always read; a
  feature's `registerTables` adds to them. Decision 3 otherwise stands.
- **The `/app` policy is unchanged.** The other half needs nothing beyond it:
  pdf.js runs on the page's thread from a same-origin chunk (`script-src
  'self'`, its PostScript functions compiled under the `'wasm-unsafe-eval'`
  already granted), pictures are `data:` URLs (`img-src 'self' data:`), and
  pictures are fetched only from Carpe Diem's origin.

## Addendum 2026-10-08: connectors a tab cannot reach

Decision 6 stands for what a tab reaches itself. A connector it cannot reach
is no longer only "use it in the app": one of the person's own open apps can
make the call for the tab, as an errand, under that device's rules
([ADR-0107](0107-a-connector-a-tab-cannot-reach-is-an-errand-to-an-open-app.md)).
Nothing is proxied through the account service, and the page's policy is
unchanged.

## Addendum, 2026-10-10: Python runs in an opaque-origin frame

Decision 5 put Python's worker on `/app` itself, held by the page's policy and
a `fetch` guard. A post-release audit (finding S1) showed what that left: a
blob worker shares the page's origin, so the model's code could open the
origin's IndexedDB (the browser device record of ADR-0096, the connectors'
sealed tokens of decision 6) and post through `XMLHttpRequest` or `WebSocket`
to any of the seven outside hosts `/app`'s `connect-src` names. A hidden
instruction in an attached file was enough.

**Decision.** The worker now hardens itself (ADR-0086 addendum of the same
day), and on the web, in the Excel pane too, it is started inside a frame:

- `website/python-sandbox.html`, its own build entry, is framed by
  `createSandboxedWorker()` (`client/analysis/worker-url.ts`) with
  `sandbox="allow-scripts"` and nothing else, so the frame and its worker have
  an opaque origin: no IndexedDB, storage or cookies of the account origin are
  theirs to open, whatever Python finds.
- The page and the frame speak once by `postMessage` (the frame says it is
  ready; the page, checking `event.source === frame.contentWindow`, hands it a
  MessagePort), then only on that port. To the bridge the frame is a
  `WorkerLike`: runs go in, answers come out, `terminate()` removes the frame
  and the worker with it; a frame that is not ready within 15 seconds or whose
  worker fails is reported as "unavailable". `bridge.ts` is unchanged.
- The frame starts the worker from a one-line `data:` module through its own
  Trusted Types policy, `subrosa-python`. Not a blob: Chromium refuses a blob
  URL minted by an opaque origin as a worker script. A worker from a local URL
  inherits the frame's policy, measured in Chromium and WebKit.
- The frame's policy, in `public/_headers`, `nginx-account.conf.example` and
  `Caddyfile.example` (held equal by `src/test/website-csp.test.ts`):
  `default-src 'none'; script-src <origin>/assets/ <origin>/pyodide/
  'wasm-unsafe-eval'; worker-src data: <origin>/assets/; connect-src
  <origin>/pyodide/; frame-ancestors <origin>` plus Office's hosts; `base-uri
  'none'; form-action 'none'; require-trusted-types-for 'script';
  trusted-types subrosa-python`. `worker-src` names `/assets/` because a module
  worker's static imports are worker requests. The origin is written out, not
  `'self'`, which an opaque document cannot be trusted to resolve: the examples
  carry `https://account.example.invalid`, replaced at deployment like the
  vhost's name. No `X-Frame-Options`, which `frame-ancestors` supersedes and
  which would keep Office on the web out.
- The frame fetches from an opaque origin, so `/assets/python-sandbox*` (the
  frame's entry and the worker chunk, the only names the build gives them) and
  `/pyodide/` answer with `Access-Control-Allow-Origin: *`; nothing else does.
  The site build turns Vite's module preload polyfill off, which would
  otherwise become a chunk both pages share under another name; every browser
  the site supports preloads modules natively.
- `/app` no longer starts a worker, so its `worker-src` loses `blob:`. The
  Office panes' `frame-src` gains `'self'` for the frame; their `worker-src` is
  left as it was, since Office.js's needs were not measured here.
- On the development server, which answers no CORS request from an opaque
  origin, the frame is not sandboxed; every build is. The Office dev server
  serves the site's sandbox page itself.

**Measured** by `website/scripts/python-sandbox-smoke.mjs` against the built
site under these policies, in headless Chromium 151, Playwright's WebKit 26.4
and Safari on the iOS 26.3 simulator: every probe for a way out raised, the
chart, table, `asyncio.sleep` and pandas runs answered, the page's
`subrosa-browser-device` IndexedDB kept its version, stores and record,
and the server saw no request outside the harness, the sandbox page, its
scripts and `/pyodide/`. Nothing was refused by Safari that Chromium allowed.

**Consequences.** Deploying the web client now also means the
`/python-sandbox.html`, `/assets/python-sandbox` and `/pyodide/` (CORS) blocks,
with the site's own origin in the sandbox's policy. Python on the web costs one
hidden frame more, a few kilobytes. The `/pyodide/` path stays reachable from
the worker, so a run could still request a file there; the vhost keeps no
access log, and nothing under it is secret.
