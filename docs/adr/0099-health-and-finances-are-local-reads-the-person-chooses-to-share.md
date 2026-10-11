# ADR-0099: Health and finances are local reads the person chooses to share

Date: 2026-10-08. Status: accepted. Deviates, for bank statements only, from
the rule "an import is a note" (ADR-0026 to ADR-0028, CONTEXT.md); everything
else in those decisions stands.

## Context

Parity work package WP24 asks for two kinds of personal data the assistant
can talk about: health (steps, sleep, heart rate, workouts, weight) and
finances (what was spent, where, and how the balance moves).

The product owner fixed the boundary before any design: **health and
finances use local data only.** Health comes from the phone's own store
(HealthKit on the iPhone, Health Connect on Android). Finances come from
statements the person exports from their bank and imports by hand. No bank
aggregator, and no third party that sees the accounts.

Three facts shaped the rest:

- Both stores hold far more than a summary needs: a watch writes a heart rate
  sample every few minutes, a phone a step count every few seconds. The
  person asks "how did I sleep this week", never for a sample.
- The desktop has no health store at all, and the person often wants to ask
  the computer about data that lives on the phone.
- The repository already decided that an imported file becomes a note
  (`ingests`, ADR-0026 to ADR-0028). A bank statement read as a note would be
  a wall of numbers no summary, chart or search could use.

## Decision

1. **Health is read, never written, and only for the measures the person
   picks.** The app asks HealthKit or Health Connect for read access to
   exactly the picked measures, at the moment they are picked. A refused
   measure reads as no data (neither store says whether a read was refused).
   The iPhone half is a small Objective-C file compiled by `build.rs` and
   linked with HealthKit (`native/health-kit/HealthBridge.m`), the shape the
   document scanner and the passkey bridge already use; the Android half is
   `HealthConnect.kt` in the existing plugin, with only `READ_*` permissions
   and the permission rationale Health Connect requires.

2. **The app keeps one row per measure and per day, not samples**
   (`health_days`, migration 068): a step total, minutes asleep counted on the
   morning the night ended with overlapping sources merged, an average heart
   rate with its range, minutes of exercise and the number of workouts, the
   day's weight. Its id is a name-based UUID of measure and day, so reading a
   day twice is one row and, synchronised, one object.

3. **Reading is quick and idempotent, so it is not a durable job.** The view
   refreshes when it opens and the assistant's tool refreshes before it
   answers. ADR-0018 asks for durable rows for work that can outlast a
   foreground session and cannot be recreated; a read lost to a locked phone
   is simply the next read's work.

4. **A bank statement becomes transactions, never a note** (`transactions`,
   migration 069). CSV with a column mapping the person checks (a detected
   preset for UBS, PostFinance, Raiffeisen, BCV, Crédit Agricole and BNP
   Paribas, a generic reading otherwise), OFX or QFX, and camt.053, all read
   on the device by `crate::finance`. A transaction is recognised again by
   the bank's own reference (with its day and amount, because some banks
   reuse a payment reference) or, without one, by a digest of account, day,
   amount, currency and description numbered by its occurrence in the file:
   reading the same or an overlapping statement adds only what is new, and
   two identical coffees on one day stay two. Its id is a name-based UUID of
   that key, so two devices importing one statement make one object.

5. **Categories are filed by rules and by suggestions the person confirms.**
   The person's rules come first in their order, then a short list of
   merchants matched by whole word. A category the person chose by hand is
   never overwritten by a rule. The model may propose categories for what no
   rule filed, only when the person asks; the request carries descriptions
   only, never an amount, a balance or an account, and a proposal is stored
   apart (`suggestion`, never synchronised) until the person accepts or
   declines it.

6. **Nothing leaves the device unless the person opts in, and then through
   the existing outbox.** Health sync is per measure (`health_metrics.sync`),
   finance sync is one switch (`finance_settings.sync`); both are read by the
   sync triggers' `stays_local` gate, so a row that may not travel queues
   nothing, not even its deletion. Switching sync on sends what is already
   stored. Received rows are applied like any other, so a computer shows what
   a phone sent. The choices themselves stay on the device.

7. **The assistant reads, it never writes.** Three tools, `health_summary`,
   `spending_summary` and `transactions_search`, answer from pure summary
   functions. Agent-lite offers them in a general conversation when there is
   data behind them, never to a custom assistant, and only within a
   scheduled run's scope. The desktop's context MCP asks the app over its
   local proxy rather than reading SQLite itself, so the computer and the
   phones describe the same figures with one implementation.

8. **The household budget engine is reached by files, never a call.** Its
   `rules.json` (ordered regular expressions, `user` before `rules`) can be
   imported as rules, the app's rules exported in that shape to merge by
   hand, and transactions exported as a CSV in the column names of its
   `v_tx` view.

## Consequences

- The iPhone app carries the HealthKit entitlement. The App ID needs the
  HealthKit capability and the App Store profile must include it; until it
  does, the release lane removes the entitlement before the archive and the
  app says Health is unavailable rather than failing the export.
- Health Connect without the history permission answers the thirty days
  before the first grant; older history on Android is out of reach.
- A statement is never searchable as a note and never feeds memory
  extraction. The tools are how the assistant reaches it.
- A CSV preset is a guess the person corrects, not a contract: banks change
  their exports, and the mapping sheet is where that is absorbed.
- Switching sync off stops sending; what was sent stays in the account until
  the person deletes it on a device that still sends deletions (the ADR-0050
  limits apply).

## Alternatives rejected

- **A bank aggregator or open banking connection.** Excluded by the product
  owner: a third party would see the accounts.
- **Keeping raw samples.** Thousands of rows a day for answers that need one,
  and a much larger object to synchronise.
- **A statement as a note** (the ingest rail as it is). Unusable for charts,
  sums and filters; the note rail's value (transcript, summary, memory) does
  not apply to a ledger.
- **A Swift HealthKit bridge in the Xcode target.** It would only compile in a
  full Xcode build; the Objective-C file is type-checked by every iOS
  `cargo check`, like the scanner.
- **Reimplementing the summaries in the Python MCP.** Two implementations of
  one arithmetic drift; the proxy already carries the calendar this way.
- **Applying model categories directly.** A wrong category silently changes
  every total; a proposal costs one tap.

## Addendum 2026-10-08: a scheduled run reads them only when it says so

Point 7 held on the phone, where a run's scope is a list of agent-lite tool
names and the "notes" group never named these three. On the desktop it did
not: the tools rode the `june_context` MCP, and a run's tools are chosen by
Hermes toolset, that is by server, so an assignment or a scheduled task that
ticked "Your notes" (`mcp-june_context`) read the health and the money too,
and so did every sandboxed routine (the cron platform takes every enabled MCP
server when its list names none).

- The three tools are a **server of their own**, `june_personal`: the same
  script registered a second time with `--scope=personal-data`, which serves
  them and nothing else. The context server never serves them, listed or
  called. One script keeps one copy of the proxy contract; the separate
  registration is what makes them selectable apart.
- Assignments and scheduled tasks gain a **"Health and finances" group**
  (`personal`) on every shell: `mcp-june_personal` on the desktop, the three
  agent-lite tools on the phone and in the web client. It reads and changes
  nothing outside the device, so "ask first" keeps it.
- A sandboxed routine's `platform_toolsets.cron` now names the built-in
  servers it keeps, every one but `june_personal`, which turns Hermes's MCP
  default into an allowlist. A routine's definition that wants the personal
  data names the toolset in its own `enabled_toolsets`.
- A conversation is unchanged: it takes every server, as a general
  conversation on the phone is offered the tools.

Rejected: gating the tool list in the one context server by an argv flag.
The flag is read once by a process every session of the gateway shares, so
it can switch the tools off for everyone but not for a run.
