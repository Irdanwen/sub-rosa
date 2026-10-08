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

## Addendum (2026-10-08): one runtime for every shell, GitHub by device flow

The first cut left the computer with two connector systems. Connecting from
the catalog wrote the server into Hermes's own MCP list and signed in there,
so Hermes held a second token, never saw the person's allow/ask/deny rules,
offered neither Google nor Microsoft, and kept the server after the
connector was removed. This addendum supersedes the "On the computer,
connecting from the catalog also writes Hermes's MCP server list" sentence,
the "A custom assistant keeps exactly its definition's tools" bullet, and
the last consequence above.

- **Hermes reaches the connectors through the app.** The app registers one
  built-in MCP server, `subrosa_connectors` (`hermes/subrosa_connectors_mcp.py`,
  standard library only), beside `june_web` and the others. It holds no
  connector, no token and no rule: `tools/list` and `tools/call` go to
  `POST /v1/connectors` on the loopback provider proxy, where
  `connectors::hermes` offers exactly what agent-lite offers
  (`agent::usable`) and runs calls through the same runtime. One sign-in per
  device; removing or turning off a connector removes its tools, which the
  server announces with `notifications/tools/list_changed` (it polls the
  app's fingerprint every twenty seconds). The catalog no longer writes
  Hermes's MCP list; removing a connector also removes a copy an earlier
  build wrote there (same name and address).
- **"Ask" is Hermes's own approval.** The guard plugin (ADR-0083) reads a
  `connectorRules` map from its ledger, keyed by the runtime's tool name
  (`mcp__subrosa_connectors__<connector>__<tool>`): `allow` runs, `deny` is
  refused, and `ask`, a name it does not find or a ledger it cannot read
  answers `approve`, which stops the call on the runtime's human gate with a
  sentence the app wrote in the person's language and the call's arguments.
  The ledger is rewritten whenever a connector changes on this device and
  after every synchronisation. The proxy then checks again what the plugin
  could have known: `deny` is refused whatever the ledger says, and an `ask`
  the ledger still called `allow` is refused (nobody was asked) until the
  ledger catches up. "Always" is not offered for a connector approval: the
  rule in Settings is where a tool is allowed for good. Routines run with
  `cron_mode: deny`, so an "ask" tool never runs unattended.
- **Custom assistants get a "Connectors" permission.** A definition grants a
  connector with a `connector:<id>` entry in its tools (no new column, so it
  synchronises like the rest of the definition). Agent-lite, which runs
  every custom assistant on every shell, offers only those connectors
  (`agent::Grant::Only`), under the same rules. Skill packs stay with general
  conversations.
- **GitHub is built in, signed in with the device flow.** GitHub's remote MCP
  server (`https://api.githubcopilot.com/mcp/`, documented in
  `github/github-mcp-server`) names `https://github.com/login/oauth` as its
  authorization server in its protected resource metadata, which serves
  only clients registered by hand. The app's own OAuth app signs in with the
  device flow (RFC 8628), which needs a client id and no secret
  (`SUBROSA_GITHUB_CLIENT_ID` at build time; a build without one does not
  list GitHub). The person types a code on github.com; the app polls in
  process, bounded by the code's lifetime, and only the latest start may
  finish. The token is the server's bearer; every tool there follows the
  usual rules. A device sign-in frozen by a phone's suspension is started
  again, never resumed from a row (ADR-0018 does not apply to a sign-in the
  person is watching).
- **Real servers.** Ignored tests (`cargo test real_server -- --ignored`)
  drive Cloudflare's documentation server through `initialize`,
  `tools/list` and `tools/call` and run OAuth discovery against Linear,
  Notion, Hugging Face and GitHub without signing in. They showed that
  Hugging Face answers without a token while publishing OAuth metadata: an
  OAuth connector that answers anonymously is now signed in to through its
  metadata instead of being marked connected with no credential (which had
  offered none of its tools).

Release gates added: registering the GitHub OAuth app with the device flow
enabled, and a check on real hardware that Hermes's approval card shows the
connector sentence.

## Addendum (2026-10-08): a connector travels under a UUID derived from its id

The definition row never travelled. A catalog connector's id is its catalog
name (`sentry`, `google`) and a custom one's is a slug with a short suffix,
while the account service accepts only UUID object ids: every push was
refused, held as a sync issue on the device and as a failed write in a tab,
so a connector added anywhere stayed there (recorded in ADR-0107).

- **The object id is derived, the row id is kept.** A connector's object is
  `uuid5(NAMESPACE_URL, "subrosa:connector:<id>")`
  (`connectors::object_id`, `connectorObjectId` in the web client, the same
  vectors asserted on both sides). The row keeps the id its keychain slots,
  tool names (`<slug>__<tool>`), triggers, relays and errands are filed
  under, so nothing a person set up is renamed. Two devices that add the same
  catalog connector write one object.
- **The derivation is checked, not trusted.** A received connector applies
  only when its object is the one its row's id derives; the app keeps the
  object id in a local column (`connectors.object_id`, migration
  `075_connector_object_ids.sql`) that never travels, so no released app
  meets an unknown column. The sync engine reads the object from that column
  for this table alone (`sync_tables::object_column`), deletes a received
  tombstone by it, and keeps a local copy for review by it.
- **What was refused is sent again.** The migration drops the outbox rows
  and sync issues queued under the old ids; the app names its existing rows
  as it opens and queues those that never left. A tab re-keys a write it
  queued under an old id when it loads, dropping the refusal and the frozen
  bytes the service never accepted.
- **Changing the row id to a UUID was rejected**: it would have moved every
  keychain entry (a fresh sign-in on each device) and renamed every tool a
  skill pack, an assistant or an assignment names. Skill packs, connector
  relays, connector errands and daily brief cards already travel under UUIDs
  and are unchanged.
