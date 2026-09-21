---
status: accepted
date: 2026-09-21
---

# Assistants are portable definitions with native permissions

## Context

People want reusable specialised assistants with instructions, reference documents,
tools and an optional visual identity on desktop and mobile. Hermes profiles are
desktop runtime configuration, not a portable definition. Its current bridge
shares global identity and MCP configuration. Treating an instruction such as
"do not read my notes" as permission enforcement would leave those tools available.

## Decision

Keep assistant definitions in local SQLite and synchronise them and their reference
files through the optional encrypted account service. The existing `settings`,
`artifact` and `conversation` routing classes carry these versioned local tables.
References are copies: attaching a note snapshots it, and refreshing is explicit.

Use the constrained native agent-lite loop for custom assistants on both platforms.
Desktop's general assistant and advanced Hermes profiles continue to use Hermes.
This deliberately differs from adapting custom assistants into Hermes profiles:
a common native dispatcher can enforce permissions per conversation today without
global profile changes or a second subprocess isolation architecture.

At conversation creation, store an immutable snapshot of instructions, permissions
and reference text. Existing conversations do not silently adopt profile changes.
An explicit between-turn action can apply the current revision. A missing snapshot
for a custom conversation fails closed, including after synchronisation or a fork.

Only selected references are available by default. Reading the note corpus and
using/extracting personal memory are separate opt-ins. The global memory setting
still wins. Tool schemas and native dispatch both filter capabilities. Reference
content is untrusted evidence, never an instruction or executable attachment.

The model can propose multimedia generation. Only an explicit UI command consumes
the proposal and submits it. The native row is claimed before the network call;
double clicks cannot submit twice. Persisted queue IDs resume free polling through
the existing Studio jobs. Ambiguous submissions are marked uncertain, never retried
automatically. Execution capabilities are device-local and never imported by sync.

## Trade-offs

- Custom assistants share capabilities across desktop and mobile, but do not inherit
  unrestricted Hermes terminal, filesystem, MCP or sub-agent abilities.
- Conversation snapshots duplicate bounded reference text and retain the context
  after its library definition changes. Files remain identified by relative names.
- Custom conversations use the authenticated `assistant_conversations` wire codec,
  not an optional field on `agent_tasks`: older clients ignore extra fields and
  default unknown safety profiles to the general assistant. They reject this new
  codec before committing their cursor and require an update to continue sync.
  Archive format 2 similarly prevents an older importer from dropping restrictions;
  this client continues to import format 1 archives.
- Local PDF text and modern Office extraction avoids a new document upload service.
  Scanned PDF OCR and legacy binary Office formats are not offered in this version.
- A submission may have completed upstream before a lost response. Showing uncertainty
  is less convenient than retrying, but avoids a second unapproved charge.

## Verification

Native tests cover permission filtering, snapshot retention, revision conflicts,
document extraction and the single-use paid claim. Frontend tests cover creation
and consent-only execution. Visual checks cover desktop and phone layouts; actual
hardware and live paid provider checks must be reported separately from mocked QA.
