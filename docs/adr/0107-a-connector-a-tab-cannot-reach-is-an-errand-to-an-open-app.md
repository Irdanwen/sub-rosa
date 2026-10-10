# ADR-0107: A connector a tab cannot reach is an errand to an open app

Date: 2026-10-08. Status: accepted. Builds on
[ADR-0054](0054-an-errand-runs-on-the-device-that-has-the-means.md) (an errand
runs on the device that has the means),
[ADR-0092](0092-connectors-are-definitions-that-travel-and-access-that-stays.md)
(connectors) and
[ADR-0104](0104-the-web-clients-features-run-in-the-tab-under-a-policy-of-their-own.md)
(the web client's features), and amends decision 6 of ADR-0104 ("connectors
from a tab, or not at all").

## Context

Three gaps were left open by the web client:

1. **Connectors a tab cannot reach.** Sentry, Stripe, Zapier, monday.com and
   Cloudflare's documentation server refuse a web page's origin; a custom
   server's origin is usually not one `/app`'s policy names; Google,
   Microsoft and GitHub sign in with the app's own client ids. ADR-0104
   showed them as "use it in the app".
2. **The daily brief's agenda.** The calendar is read where it lives,
   EventKit on the phone and the Mac (ADR-0025), so the brief composed in a
   tab had no agenda line.
3. **Shared projects' membership** (inviting, admitting, removing) stayed in
   the app (ADR-0098).

The product owner's rules bound every answer: an agent runs only while an app
is open (a tab counts), nothing executes on the account service (ADR-0049),
and a paired device doing work for another is an errand (ADR-0054).

A finding shaped the first answer: a connector's definition row is keyed by
its catalog id (`sentry`, `google`), and the service accepts only UUID object
ids (`docs/accounts-sync-contract.md`), so a tab cannot count on the
`connectors` row of an app-only connector having reached it.

## Decision

1. **An app offers, a tab asks, the same row answers.**
   - An app whose owner switched on **"Run connectors for my browser"**
     (Settings, Connectors; off by default, as errands are) files one
     `connector_relays` row per connector it holds a credential for: the
     connector's id and name, and the tools it listed, **each with the rule
     this device applies** (a denied tool is not offered). The row's id is a
     UUID derived from the device and the connector, it is rewritten only
     when it changes, and it is withdrawn when the switch, the sign-in or the
     connector goes. The offer is everything a tab needs, so the definition
     row is not.
   - The tab offers those tools in its turns, deep research and the brief,
     and sends each call as a `connector_errands` row (kind `errand`)
     addressed to that device: tool, arguments (32 KB at most), and whether
     the person already approved it in the tab.
   - The device picks it up after its next synchronisation (every five
     seconds while the app is open, and from the sweep), applies **its own**
     rules again (switch, a two-minute lifetime, size, connector, sign-in,
     the person's rule for the tool), writes a local single-use ledger
     (`connector_errand_runs`, never synchronised) before the call leaves,
     makes the call, and writes the bounded result (text, links, small
     structured content) into the same row, then synchronises at once.
2. **"Ask" is answered where the person is.** A tool that asks is shown in
   the tab as the usual approval card; approving it sends a call that says
   so. If the device's rule asks for a call the tab sent unapproved (the rule
   changed since the offer), the row comes back as `ask` and the tab shows
   the card. A deny on the device always wins.
3. **The tab waits honestly.** A turn waits up to sixty seconds, polling only
   the errand kind, then tells the model, in Rust's words, that the computer
   or phone has to be open with Sub Rosa running. A late answer still reaches
   the call's card on the next minute tick, and the tab removes the calls it
   asked once they are settled. A phone answers only in the foreground; a
   computer is preferred when both offer.
4. **The brief travels.** Each app files the card it composed
   (`daily_brief_cards`, one object per device and day, UUID from both,
   history wherever it lands, pruned by its device after fourteen days),
   agenda line included. The tab shows today's card from another device when
   it wrote none; when it composes its own, it asks a relayed Google or
   Microsoft `calendar_list` for today's events and computes the line with a
   port of `daily::agenda_of` checked on Rust's vectors, else takes the line
   from today's device card, else says which device would add it. The tab
   files its own card too.
5. **Membership from the tab.** The web client invites, shows the safety
   number, admits, withdraws and removes with the protocol of ADR-0098; the
   invitation's secret stays sealed in the browser that made the link, and
   the cross-implementation vectors (`spaces-v1.json`) now cover the
   invitation, an admission, a removal and a rotation after a leave (see the
   ADR-0098 addendum).

## Alternatives considered

- **Relaying through the account service.** It would see tokens and results
  and act for a closed tab. Refused again (ADR-0049, ADR-0104).
- **Widening `/app`'s `connect-src`.** Does nothing for a server that refuses
  the origin, and `https:` would undo ADR-0096's bound.
- **Adding columns to `account_errands`.** Released apps check every received
  column against their allowlist and stop synchronising on an unknown one;
  new tables are the path every parity table has taken.
- **Deciding the rule in the tab from the synchronised policy.** The policy
  row may not reach the tab (non-UUID ids), and the device enforces its own
  rule anyway; the offer carries it.
- **The device showing its own approval card.** The person is at the tab,
  not at the computer; ADR-0054 already rejected approving on the executing
  machine for the same reason.

## Consequences

- An app-only connector works from a tab exactly while one of the person's
  apps with the switch on is open; the tab says so in those words.
- An interactive view (MCP Apps) is not relayed: a relayed call returns text,
  links and small structured content only.
- Released apps that receive a revision of the new tables stop synchronising
  until updated, as with every table added since ADR-0091; the migration is
  `074_connector_relays.sql`.
- The connector row's non-UUID object id remains a defect of ADR-0092's
  synchronisation; this design does not depend on it, and fixing it is
  separate work.

## Addendum 2026-10-08: the definition row travels under a UUID

The definition row's non-UUID object id is fixed by the ADR-0092 addendum of
the same date: a connector now travels under a UUID derived from its id. The
relay still carries everything a tab needs, so this design is unchanged.

## Addendum (2026-10-10): an approval is bound to the browser that gave it

The post-release audit of 1.89.0 found that a tab marking `approved: 1`
itself was enough for a device to run a tool that asks, and that the threat
model did not say so. Three changes:

- **A signed approval.** An approved call now carries a compact JWS
  (`ES256`, type `subrosa-approval+jwt`, `kid` the browser device's id)
  signed with the browser's non-extractable device key (ADR-0096). Its
  claims name the call (`eid`, the row id), what it does (`dig`, SHA-256 over
  the tool's name, a NUL byte and the arguments exactly as the row carries
  them, which the tab writes with sorted keys) and when (`iat`). The device
  runs a tool whose rule here is "ask" only when that signature verifies
  against the public key the account service lists for that browser, the
  browser is a live device of this account (the list is this account's, a
  revoked browser is not in it), the row says that browser asked, and the
  time fits the call's lifetime (`connectors/relay_approval.rs`). Anything
  less counts as unapproved: the row comes back as `ask`. The service now
  lists a browser device's public key (`Device.public_key`, additive; the
  service needs that deploy before a tab's approvals can verify, and until
  then an approved call comes back as `ask`).
- **Carried in `message`.** A new column or table would make every released
  app stop synchronising on the first such row (the unknown-column rule
  above), so the JWS travels in the row's `message` while it is
  `requested`; the answering device overwrites it with its reason, as it
  always did. A shared vector (`packages/chat-core/web/connectors.json`,
  `relay.approval`) holds the digest equal on both sides.
- **The clock and the arguments.** A call dated more than a minute ahead of
  the device's clock is declined (it would otherwise stay fresh past its
  lifetime), and arguments that are not a JSON object are declined instead of
  being run as `{}`.

"Approved on the device itself" is not offered: the device showing its own
approval card was rejected above for the reason it still has (the person is
at the tab). What this does not close is written in docs/threat-model.md: a
compromised tab can still ask its own device key to sign, and a tool set to
"allow" runs on any call a tab of the account files. Tests:
`connectors::relay::tests` (signature, replay, other arguments, other tool,
unknown or revoked browser, stale and early approvals, skew, non-object
arguments) and `src/test/website-connector-relay.test.ts`.
