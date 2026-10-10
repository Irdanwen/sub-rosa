# ADR-0069: The account gives birth to a Carpe Diem device key

Date: 2026-09-30. Status: accepted. Supersedes one clause each of ADR-0049 and
ADR-0050 (quoted below); everything else in them stands.

## Context

Using Sub Rosa meant holding a wallet, buying USDC on Base, creating a `cdm_`
key on carpe-diem.xyz and pasting it into the app. That is the steepest step
of the whole product, and it has nothing to do with notes. The product owner
asked that an email be enough: create a Sub Rosa account, get a Carpe Diem key
with it, and later buy credits by card and have Carpe Diem put them on that key.

Carpe Diem already has accounts without a wallet: an address derived from the
email, with no private key, so its credits can be spent and never withdrawn or
converted. What was missing was a way for a Sub Rosa account to obtain a key on
such an account without a second sign-up, and a boundary that says what the
Sub Rosa service may do in that exchange.

Two accepted decisions stood in the way, deliberately:

- ADR-0049: "The cloud service does not execute tasks, hold tools, or acquire
  provider spending authority."
- ADR-0050: "Account login must not automatically grant access to the Carpe Diem
  key or notes", and "A lost Carpe Diem key must also be replaced at Carpe Diem;
  revoking a Sub Rosa session does not revoke provider spending credentials."

## Decision

The account service becomes an **identity partner** of Carpe Diem. It vouches;
it never holds, sees or spends a key.

1. **One key per device, created at Carpe Diem and delivered to the device.**
   The app generates an ephemeral P-256 key in memory and asks the service for
   a 120 second ES256 assertion naming the verified account, the device and the
   key's RFC 7638 thumbprint. The app carries that assertion to Carpe Diem's
   operator itself, with a DPoP-style proof signed by the ephemeral key. Carpe
   Diem mints the `cdm_` key inside its TEE and returns it to the app over that
   same TLS connection. A copy of the assertion is worthless without the
   ephemeral private key, which never leaves the app's memory, and the key it
   buys never crosses this service. The wire formats are in
   [`carpe-diem-partner-contract.md`](../carpe-diem-partner-contract.md).
2. **Only a recent app session on a live device may ask.** Browsers have no
   device to bind a key to. A session renewed by the device secret inherits the
   device's admission time (ADR-0056) and is never recent, so a stolen device
   secret can keep a device signed in but cannot mint it a key.

   *Superseded in part by [ADR-0096](0096-a-browser-is-a-device.md)
   (2026-10-08): "Browsers have no device to bind a key to" no longer holds
   for a browser admitted as a device, which obtains a key bounded more
   tightly than an app's. "Only a recent app session may ask" still holds for
   apps.*
3. **Revocation follows the device.** Revoking a device, signing it out, or
   deleting the account writes a revocation into a durable outbox in the same
   transaction, and the maintenance loop delivers it to Carpe Diem until Carpe
   Diem acknowledges. Account deletion also asks Carpe Diem to forget the link.
   Sanitising a restored database, which marks every device revoked, writes a
   revocation for each device that was live before it, and an explicit
   revocation is written every time, even for a device already marked
   revoked. Otherwise a restore would leave keys nobody can revoke any more: a
   device stolen before it would keep its key for good, and every device
   signing in again would get a new id and a new key while the old ones stayed
   active, until the account reached Carpe Diem's cap on active keys and could
   obtain none. Carpe Diem treats a repeated revocation as a no-op, so asking
   twice is always safe.
4. **Carpe Diem draws the bound, and holds it in its TEE.** It pins this
   service's public keys (never fetched), refuses to link an email account that
   already existed there without a confirmation the person gives at Carpe Diem
   with a code shown in the app, caps issuances per link and per partner, and
   sends the account an email for every new key, with a way to revoke them all.

### What this supersedes

- ADR-0049's "does not … acquire provider spending authority" becomes: the
  service can cause a device of a verified account to obtain its own spending
  credential at Carpe Diem. It still cannot spend, read a key, read a balance,
  or run anything, and it gains an outbound call to Carpe Diem for revocation
  only.
- ADR-0050's "Account login must not automatically grant access to the Carpe
  Diem key" stays true of the **vault**: the key a person pasted and shared
  into their vault still comes down only after the out-of-band admission. It no
  longer describes a Sub Rosa-born key, which a signed-in device obtains for
  itself. And "revoking a Sub Rosa session does not revoke provider spending
  credentials" no longer holds for device keys: revoking the device revokes
  its key. It still holds for a key the person pasted.

### The bound, stated once

A fully compromised account service (database and partner key) can obtain
device keys for accounts that were **created by it or linked to it** at Carpe
Diem, and burn their credits. It cannot withdraw them (the derived address has
no private key and Carpe Diem credits are closed), cannot touch a Carpe Diem
account that was never linked to Sub Rosa, cannot exceed the per-link and
per-partner issuance limits without tripping Carpe Diem's breaker, and cannot
do it silently: Carpe Diem announces every new key by email to the account's
address there. That is the spending authority this ADR accepts, and no more.

## Alternatives considered

- **The service creates the key and stores it in the vault.** Rejected: the
  service would see the key in the clear at least once, and one key shared by
  every device cannot be revoked per device.
- **Paste-only, as before.** Rejected by the product owner: it keeps the wallet
  and the dashboard as the price of entry.
- **Carpe Diem trusts the identity provider directly** (the app runs its own
  PKCE flow against a public Keycloak client with `nonce = sha256(jkt)`, and
  Carpe Diem verifies the ID token against a pinned Keycloak JWKS). This takes
  this service out of issuance entirely and is the stronger design. Deferred,
  not rejected: first-party passkey sign-in (ADR-0062) never reaches Keycloak
  and so cannot produce that token, the service must stay the only OIDC client
  (ADR-0055), and trust would move to the identity provider's administrators.
  Revisit if passkeys move into the identity provider.
- **Carpe Diem sends a magic link for every new device.** Rejected as the
  default: the person just proved their address to sign in. It is kept for the
  one case where it earns its friction, linking an account that already existed
  at Carpe Diem.

## Consequences

- A second device needs only a sign-in: no vault to open for the key, no key to
  copy. The vault path stays for keys people pasted themselves.
- All device keys of an account draw on one Carpe Diem balance, because Carpe
  Diem keeps balances per account, not per key.
- The service has a new outbound dependency. A Carpe Diem outage delays
  revocations (they wait in the outbox, in order, with backoff) and never
  blocks sign-in, deletion replay or boot.
- The partner key is new key material with a rotation procedure
  (`docs/vps-account-stack.md`): Carpe Diem pins both `kid`s during a rotation.
- Losing an email account at Carpe Diem after deleting the Sub Rosa account is
  not a loss of credits: the Carpe Diem account and its balance remain,
  reachable with a Carpe Diem magic link.
