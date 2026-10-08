---
status: accepted
date: 2026-10-08
---

# Connectors are definitions that travel and access that stays

## Context

The parity matrix (ADR-0078) left the P6 rows open: MCP on the phones, a
catalog of connectors, Google and Microsoft, connector events as triggers,
interactive apps in chat, skills on the phones, and connectors inside deep
research. The computer already reached MCP servers through Hermes, with its
own OAuth login and exposure policy. The phones run no Hermes (agent-lite,
no subprocess), so nothing there could talk to a server, sign in to one, or
read a skill.

Four constraints decided the shape before any code. Inference stays on Carpe
Diem's boundary and the account service holds only ciphertext (ADR-0049).
Every host the binary can reach is declared (ADR-0043). Work that outlives a
foreground session is a durable row (ADR-0018). A custom assistant gets only
what its definition grants (ADR-0058).

## Decision

**A connector is a synchronised definition plus device-local access. The
phones speak MCP themselves; the computer keeps Hermes. Every call goes
through one rule per tool, and every "ask" is a row.**

- **Definitions travel, tokens never do.** `connectors` (migration 063) and
  `skill_packs` (064) join the settings routing class of the sync registry.
  Tokens live in the OS keychain under `xyz.carpediem.subrosa.connectors`,
  wrapped in `Redacted` the moment they are read; no column, log line, DTO or
  webview message carries one, and a connector added on the computer needs
  one sign-in on each phone.
- **A Streamable HTTP client in Rust** (`connectors/mcp.rs`): JSON-RPC over
  `POST`, plain JSON or an event stream answered, the session id echoed,
  `404` on it treated as an expired session, a minute and four megabytes per
  request, two hundred tools at most. The legacy SSE-only transport is not
  supported: every catalog server speaks Streamable HTTP.
- **OAuth 2.1 by the protocol's rules** (`connectors/oauth.rs`): a `401`'s
  `resource_metadata` (RFC 9728), the authorization server's metadata (RFC
  8414 or OpenID, with path insertion), dynamic registration as a public
  client (RFC 7591), PKCE `S256` (a server that does not declare it is
  refused), the resource indicator (RFC 8707), and refresh with the old
  refresh token kept when no new one comes. The browser returns through
  `subrosa://connector/callback`, the pattern of ADR-0055: the verifier is in
  the keychain before the browser opens, the flow is keyed by a 256-bit
  state, single use, refused after fifteen minutes, and must come back to the
  redirect it left with. Scheme squatting is the residual risk ADR-0055
  already states; a squatter gets a code without its verifier.
- **One catalog for both shells**, in Rust (`connectors/catalog.rs`): only
  vendor-hosted servers whose own documentation gives the address, that sign
  in with dynamic registration (or need no sign-in) and speak Streamable
  HTTP. Each was read on its vendor's page on 2026-10-08 and each host is a
  `DECLARED_EGRESS` row. GitHub, Asana, HubSpot, Box and Atlassian's current
  server need a client registered by hand, Vercel and Figma admit only
  approved clients, PayPal's documented address answers 404: none is listed.
  They stay reachable in developer mode as custom connectors, with a token.
  On the computer, connecting from the catalog also writes Hermes's MCP
  server list and signs in there (`hermes_mcp_oauth_login`), so one tap
  serves the agent and the definition reaches the phones.
- **Tool rules.** Each tool is allow, ask first or off, the three choices of
  the MCP security page. A tool nobody ruled on follows its server's hint:
  `readOnlyHint` runs, anything else asks. The hint only chooses the
  default. Tools are offered namespaced `<connector>__<tool>`; dispatch looks
  the name up in the routes that turn offered and reads the rule again, so a
  declaration is never the boundary.
- **"Ask" is a row, not a promise.** An "ask" files a pending
  `connector_calls` row and puts a `subrosa:connector` card under the reply.
  Approving claims the row in one statement (pending to running), runs the
  call, and hands its result back to the conversation as a new turn; a lock,
  a kill or a second device's tap cannot run it twice. Calls that run are
  filed too, so the card shows what ran and what came back.
- **Connectors reach general conversations only**: the phone's Chat tab, and
  a scheduled run whose assignment ticks the new `connectors` group. A custom
  assistant keeps exactly its definition's tools.
- **Google and Microsoft are built in**, written in Rust against their APIs,
  signed in with the app's own client ids from the build
  (`SUBROSA_GOOGLE_CLIENT_ID`, `SUBROSA_MS_CLIENT_ID`); a build without one
  does not offer that provider. Only non-restricted scopes: Calendar events,
  Drive `drive.file` (files the app created or the person opened with it,
  said in the UI), Contacts read; Graph calendars, files read, mail read.
  Google accepts a custom scheme only as the reversed client id of an iOS
  client, so a build that ships Google sets `SUBROSA_GOOGLE_REDIRECT_URI` and
  registers that scheme in the bundle.
- **Gmail is behind an external gate.** Full Gmail read is a restricted
  scope that Google allows only after an independent security assessment
  (CASA). The code path exists behind `builtin::GMAIL_VERIFIED`, false, and
  the screens say "requires verification". Turning it on is a build change
  made after the assessment, never a setting.
- **Interactive views run apart.** A `ui://` resource (MCP Apps, or the older
  `openai/outputTemplate`) is stored (`connector_app_resources`, bounded) and
  served from the app's own `subrosa-app:` scheme under its own policy: the
  server's origin for everything it loads or calls, inline script for what it
  carries, nothing else, no `unsafe-eval`. The card frames it with `sandbox`
  `allow-scripts` and without `allow-same-origin`, so it has an opaque
  origin, no storage and no IPC. Its only way out is `postMessage`, and the
  bridge checks every message (source, opaque origin, JSON-RPC 2.0, an
  allowlist of methods, size) before answering; a tool call from a view runs
  on its own connector under the same rules, an "ask" through a dialog. The
  app's own CSP gains `frame-src` for that scheme and nothing else.
- **Triggers are evaluated where the assignment runs, while the app is
  open** (ADR-0091): every five minutes a trigger calls its look (a calendar
  listing, a mail search, a read-only listing tool, or a resource read) and
  fires a run for what is new, three at most per look; its first look only
  learns the backlog. A server that offers resource subscriptions gets a
  held notification stream instead, in-process (ADR-0018: whether it listens
  is asked of the process, never a column). An event starts an ordinary run
  with slot `event:<trigger>:<item>`, single use like any slot.
- **Skill packs** are agent-lite's skills: the description of each enabled
  pack every turn, `load_skill` for its body, or `/name` at the start of a
  phone message to pick one, whose body then joins that turn and whose tool
  list narrows the turn (never widens it).
- **Deep research** fills ADR-0089's `connector_sources` hook: the
  connectors chosen for a run (none by default) are searched with a tool
  that runs without asking, and what they return is a `connector` source.

## Alternatives rejected

- **Run Hermes's MCP client on the phones.** No subprocess on iOS, and
  embedding Python's client means embedding Python's runtime for it.
- **Synchronise tokens through the vault.** Ciphertext would protect them in
  transit, but a token copied to every device multiplies where it can leak
  and outlives a device's revocation; one sign-in per device is the price.
- **A loopback redirect on the phones.** Not available on iOS; the deep link
  already exists and ADR-0055 already argued its risks.
- **Render views with `srcdoc`.** A `srcdoc` frame inherits the app's CSP,
  whose `script-src` refuses inline script, so no view would run; loosening
  the app's own policy to let them run is the wrong direction.
- **Let a view load from any origin it declares.** Many views load scripts
  from a CDN; allowing their declared domains would let a server name any
  origin. Views that depend on a third-party origin do not render.
- **Trust the server's hints as rules.** A malicious server says it only
  reads. The hint chooses the default; the person's rule decides.

## Consequences

- A phone can use the catalog's servers, any custom server in developer
  mode, Google and Microsoft (when the build carries their ids), with every
  change confirmed unless allowed.
- Release gates that are not code: Google and Microsoft client registration
  (with the redirect each needs), Google's CASA assessment for Gmail, and a
  check on real hardware that each catalog server accepts the
  `subrosa://connector/callback` redirect at registration.
- Desktop custom assistants and Hermes runs do not use the native
  connectors; Hermes has its own MCP servers, and the catalog fills both.
