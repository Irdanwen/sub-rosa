# ADR 0017: Product autonomy from June, technical identifiers kept

- **Status**: Accepted
- **Date**: 2026-07-25
- **Supersedes**: nothing. Adds an addendum to
  [ADR-0003](0003-release-candidate-channel-and-promotion.md).

## Context

Sub Rosa forked June (`open-software-network/os-june`, MIT) and rewired it onto
Carpe Diem: a local `june-api` sidecar on loopback, a user-supplied `cdm_` key,
no hosted API, no OS Accounts. The architecture had been autonomous since the
fork. The **product** had not. An audit found three classes of residue, all
reachable in release builds:

1. **Identity.** `hermes_bridge.rs` injected `You are June, ... made by Open
   Software` into every desktop Hermes session, followed by four privacy claims
   describing June's hosted backend (a TEE-attested service, "Open Software
   never trains on your data"). The desktop agent introduced itself as another
   product and vouched for guarantees this fork does not provide. The mobile
   prompt already said "Sub Rosa's assistant", so the two shells disagreed.
2. **Accounts.** Seven `os_accounts_*` commands and six React surfaces shipped
   in the binary. `App.tsx` skipped the account gates only when
   `import.meta.env.DEV`, so any startup where `os_accounts_status` answered
   before the sidecar published `OS_JUNE_LOCAL_DEV` landed the user on
   "Continue with OpenSoftware". The onboarding wizard opened on that screen
   every first run and linked to `accounts.opensoftware.co`.
3. **Coordinates.** `june_api_url()` fell back to
   `https://june-api.opensoftware.co` whenever `JUNE_API_URL` was unset, which
   is every boot until the sidecar spawns and forever if it fails. The Settings
   "Verify server" button opened that host in the user's browser. The `/verify`
   page served by the local sidecar displayed June's attestation facts.

The obvious way to finish the fork is to rename everything: the `june-api`
crate, the `JUNE_*` env vars, the `june://` events, the `os-june:*` storage
keys. That is ~2000 occurrences across 233 files.

## Decision

**Cut the product dependency completely. Keep upstream's technical
identifiers.**

Autonomy is defined as: nothing the user sees names June or Open Software,
and nothing the binary contacts belongs to them. Under that definition the
fork removes OS Accounts entirely, rewrites the agent's identity and privacy
claims, fails closed instead of falling back to a remote host, rewrites
`/verify` to describe the local sidecar, and drops the CI that published to
upstream's release repo.

Internal names stay exactly as upstream has them:

- the Cargo package `os-june` and the `june-*` crates;
- `JUNE_API_URL`, `OS_JUNE_LOCAL_DEV*`, `JUNE__*`;
- `june://` Tauri events and `os-june:*` localStorage keys;
- the module path `src-tauri/src/os_accounts.rs` and its public function names,
  even though its contents are now a local-session shim;
- MCP tool names `june_context`, `june_web`, `june_media`, `june_films`.

## Consequences

- The fork keeps cherry-picking upstream fixes. That flow is real and active
  (#853, #767, #805, #643, #780, #827, #867 among others), and it is worth more
  than internal name purity. Renaming would have turned every future
  cherry-pick into a manual port.
- Anyone reading the code meets `os_accounts` and `JUNE_*` and has to know they
  are historical. The module docs and this ADR are the answer; `CONTEXT.md`
  marks the upstream-only terms.
- Gutted-but-kept modules mean upstream diffs land in a file that still exists,
  so conflicts are content conflicts, not add/delete conflicts.
- **The cleanup is not self-sustaining.** Any cherry-pick can reintroduce a
  June coordinate, and nothing about a green test suite would notice. So the
  invariant is enforced mechanically: `repository-hygiene.yml` fails the build
  when `opensoftware.co`, `os-june-releases`, `You are June`, or `made by Open
  Software` appears outside an explicit allowlist, and a unit test asserts the
  injected SOUL contains the product name and neither "June" nor "Open
  Software". Without those two, this ADR describes a state the repo would drift
  out of within a few merges.

## Alternatives rejected

**Rename everything (hard fork).** Removes the historical names, at the cost of
the upstream cherry-pick flow, a ~2000-occurrence diff, and a localStorage
migration for `os-june:*` keys. Rejected: the cost is paid by the maintainer
forever, the benefit is cosmetic and invisible to users.

**Leave OS Accounts dormant and only fix the visible leaks.** Smallest diff.
Rejected: ~1550 lines of unreachable OAuth stay compiled into the binary, the
gates stay one state-ordering bug away from appearing, and every future upstream
change to that module has to be reviewed for a feature the fork does not have.

**Keep the remote URL as a fallback.** Rejected outright. A fail-open default
means the failure mode of "sidecar down" is "send the user's audio and prompts
to a third party", which inverts the property the fork exists to provide.

## Notes

`image_repo` in the attestation config is now blank rather than removed: a fork
that does publish a container still gets the row, and keeping the field keeps
the config shape upstream-compatible.

The dictation wake name changed with the identity, from "hey June" to "hey
Rosa" / "hey Sub Rosa" (`dictation.rs`). It was undocumented in the UI, so no
user was told about the old one, but anyone who found it loses it.
