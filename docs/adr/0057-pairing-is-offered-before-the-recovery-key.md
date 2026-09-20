# ADR 0057: Pairing is offered before the recovery key

- Status: accepted
- Date: 2026-09-20

## Context

On a newly signed-in device the account panel asked for the recovery key: a
43 character random string, in a password field, under the heading "Your
encrypted vault". The other way in — approving from a device that is already
open, which types nothing at all — lived in a separate card further down the
panel, titled "Connect your devices", and on a phone it was below the fold.

Both are admissions under
[ADR-0050](0050-vault-admission-uses-an-out-of-band-secret.md) and both are
implemented. Only the order of the screen decided which one people used.

## Decision

**On a device whose vault is locked, the panel offers the device you already
have first, and the recovery key second, in the same card. The half that grants
access stays where it was, on the device that is already open.**

`AccountPairingSection` already renders exactly the requesting half when it is
told the vault is locked, so this is placement, not new protocol: the requester
panel moves inside the vault card above the recovery key form, and the separate
card renders only for the granting side.

A pending request also survives the screen that started it. The pairing secret
was already written to the keyring before the first network call, precisely so
that it could — but nothing ever read that slot back, so reloading the window
stranded the request until it expired five minutes later.
`account_pairing_resume` rebuilds the same transfer code locally, with no
network call.

## Why this is a security choice, not a layout one

A recovery key is 256 bits of entropy that exist to be stored and not used. The
moment it is most likely to leak is the moment it is pulled out of a password
manager and pasted: into the wrong window, a screen share, a clipboard another
application reads. Pairing never takes it out of its hiding place.

Nothing about the guarantees changes. The transfer code still travels between
the person's own devices and never through the relay, the granting device still
shows an explicit confirmation naming what it is handing over, and the service
still sees one opaque envelope.

## Consequences

- The guided sequence keeps its four steps: pairing and the recovery key are
  two routes to the same step, not two steps. Only the wording of step two
  changes, to name the device you already have before the key.
- A device with no other device available loses nothing: the recovery key form
  is in the same card, one heading down.
- `account_pairing_resume` is a shared command and is registered in both
  `generate_handler!` lists.

## Alternatives rejected

- **A fifth guided step for pairing.** It would turn one decision into two, and
  imply that a person who used their recovery key still had something to do.
- **Hiding the recovery key behind a disclosure.** The key is the only way in
  when no other device is reachable, and a person who has theirs ready should
  not have to go looking for the field.
