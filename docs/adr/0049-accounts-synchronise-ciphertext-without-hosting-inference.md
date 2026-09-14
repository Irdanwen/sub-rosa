# ADR-0049: accounts synchronise ciphertext without hosting inference

Date: 2026-09-14. Status: accepted for this implementation, not a production launch approval.

## Context

The product owner requested one account across the website, desktop and iPhone,
one Carpe Diem configuration, usage history and continuity of work. A local
archive cannot provide ongoing synchronisation. This explicitly changes the
local-only product scope recorded in ADR-0017 and ADR-0042.

## Decision

Add the independent `subrosa-cloud` Rust service. It owns OIDC identity bindings,
revocable sessions, device authorisations, an ordered opaque revision journal,
encrypted recovery envelopes and encrypted object storage. Its PostgreSQL data
does not contain the content encryption key or the Carpe Diem key.

Keep SQLite as the working database. Transactional triggers create the outbox
alongside edits; native workers encrypt, upload and transactionally apply incoming
revisions. Revision ancestry, not device clocks, decides conflicts. A resolution
names every acknowledged sibling. Unseen edits remain conflicts. Immutable
encrypted file chunks are verified before a confined local path is exposed.

The optional account does not replace the local sidecar or introduce hosted
inference. Carpe Diem receives model requests through the existing native routes.
The cloud service does not execute tasks, hold tools, or acquire provider spending
authority. Incoming task history is inert. Continuing a conversation on another
device requires a new user message and that device's own runtime and permissions.

The website shares the service's origin for browser cookies and API calls. Public
pages contain no third-party executable scripts or analytics. Deployments should
use a dedicated account origin if marketing later acquires third-party scripts;
this version uses one strict origin to avoid cross-origin credential plumbing.

## Trade-offs and compatibility

- Existing installations remain local until explicit account and sync setup.
- Identity uses an external OIDC issuer with verified email and `(issuer, subject)`
  binding. Passkeys and email delivery are deployment responsibilities, not a
  password database implemented in this application.
- The device flow uses a browser approval plus PKCE-bound one-use exchange.
  It avoids depending on a registered universal-link domain before one exists.
- A persistent local account binding rejects switching to another identity on the
  same corpus. This prevents cross-account disclosure but is less convenient than
  separate switchable profiles. Full profile switching is not implemented.
- The server sees account identity, object identifiers, kinds, sizes, transport
  times and connection metadata. Client encryption does not hide traffic shape.
- This supersedes only the absence of an optional Sub Rosa account service in
  ADR-0017/0042. Product autonomy, local inference, secure process boundaries and
  archive export remain intact. No OS Accounts dependency is restored.

## Verification and release boundary

The [contract](../accounts-sync-contract.md), cloud integration suites, native
crypto/outbox tests and browser/native shared fixture define interoperability.
Actual deployment, issuer registration, protected storage, restore drills and an
independent security review remain release gates. A successful local test is not
evidence of those external properties.
