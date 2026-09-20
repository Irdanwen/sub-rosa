# ADR 0056: An authorised device renews without a browser

- Status: accepted
- Date: 2026-09-20

## Context

A device that has been signed in, has its vault open and has synchronised for
weeks is still sent back to a browser on a schedule. Refresh families expire
absolutely after thirty days and "rotation does not extend that deadline"
([the wire contract](../accounts-sync-contract.md)), so a device in daily use
repeats the whole sign-in every month. A refresh whose response was lost does
the same thing immediately, because replaying a consumed refresh token revokes
the family and the client cannot tell a lost response from a consumed one.

Three defects made this feel worse than it was.

- Every exchange inserted a **new** `devices` row, so one machine appeared
  several times in the person's device list and errands addressed to the
  previous `device_id` became undeliverable.
- `account_status` built its whole answer from the session slot, so a device
  whose access token had simply lapsed read as signed out, vault included. It
  conflated three independent facts — is there an identity, is there a way to
  reach the service, is the vault open — and only the first two ever move
  together.
- `account_logout` revoked the device by bearer through
  `DELETE /api/v1/devices/{id}`, which requires an authentication under five
  minutes old, and swallowed the failure. Signing out later in the day left the
  device listed as live and said nothing.

## Decision

**A device authorisation outlives its token families. The exchange hands back a
256-bit device secret, stored in the OS keyring and held as a hash by the
service, and `POST /api/v1/session/renew` mints a new family from it for as
long as `revoked_at IS NULL`.**

The properties that make this safe are each a specific choice:

- **A renewal can never make an authentication recent.** The new family
  inherits `devices.authenticated_at`, the instant of the device's original
  admission, and never `now()`. `Service::recent` reads that value, so
  revoking a device, deleting an account and approving a device-login still
  require a real browser and a real authentication. A session that was just
  earned in a browser is recent, as it should be; a renewal never renews that.
- **The device secret is not rotated.** Rotation would recreate the very trap
  `refresh_in_flight` exists to avoid: a lost rotation response leaves the
  device holding a secret the service has replaced, locked out permanently.
  Rotation stays where it works, on the refresh family, which still revokes
  every generation on replay.
- **Detection is by visibility, not by rotation.** One live family per device
  means a cloned secret shows up as each copy cutting the other off, and
  `renewed_at` / `renew_count` put that in the device list in plain words.
- **Revocation destroys the way back**, not only the tokens in flight:
  `revoke_device` and the post-restore `invalidate_restored_sessions` both
  clear `secret_hash`. Without that second one, restoring a database backup
  would have let every device readmit itself, which is the opposite of what the
  runbook promises.
- **`POST /api/v1/session/renounce`** lets a device sign itself out with its own
  secret and no step-up, because it only takes access away.
- **An exchange may reuse a named device row**, proven by the same secret at
  start, so signing in again on one machine is not a second device.

## Consequences

- An authorised device is authorised until it is revoked. That is a deliberate
  widening: an authorisation forgotten on a lost machine stays valid until
  somebody revokes it, and the five minute step-up is what still stands between
  a stolen unlocked device and account deletion.
- The thirty day absolute expiry on refresh families does not move. It is now a
  ceiling on one family's life, not on a device's.
- A lost refresh response no longer requires a browser. It requires a renewal.
- Rows created before this change have no `secret_hash` and behave exactly as
  they did.
- `account_status` answers three states — `none`, `connected`, `renewable` —
  computed from the keyring and the clock, with no network. `renewable` is the
  one that did not exist: a device whose session lapsed used to read as signed
  out and be sent to a browser, and now keeps its panel and renews itself.
  `none` still means "show the sign-in card", including after signing out,
  because the library keeps its account binding on purpose and a binding is not
  a credential.

## Alternatives rejected

- **A sliding refresh window.** Renewing the family on use would keep a device
  alive without a new concept, but it cannot help a device that was offline
  past the deadline, and it silently makes the deadline mean nothing rather
  than saying so.
- **Rotating the device secret on every renewal.** See above: one lost response
  and the device is finished. A one-generation grace window would work and buys
  a detection `renew_count` gives almost for free.
- **Per-device public keys with epoch rotation.** The protocol
  [ADR-0050](0050-vault-admission-uses-an-out-of-band-secret.md) already
  rejected for the vault, for the same reason: an incomplete trust graph offers
  a guarantee it cannot keep.
