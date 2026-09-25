# ADR-0062: passkeys belong to the account origin

Date: 2026-09-25. Status: accepted for implementation, pending production platform verification.

## Context

The external identity provider can authenticate a browser, but its passkeys
belong to that provider's origin. The native app cannot present those passkeys
for `subrosa.furetier.com`. Repeated browser handoffs make an otherwise local
app feel disconnected, especially when adding a second device.

## Decision

`subrosa-cloud` is the WebAuthn relying party for `subrosa.furetier.com`.
The website publishes Apple and Android association files at their exact
well-known paths. The installed apps declare that domain, and the service
allows the Android signing certificate's `android:apk-key-hash` origin.

A person first authenticates through the existing OIDC route and adds a
discoverable, user-verified passkey to that account's immutable UUID during a
recent browser session. The credential never selects or merges an account by
email. Subsequent website sign-ins create ordinary browser sessions. Native
assertions approve an already-created PKCE-bound device request; the existing
one-use exchange admits or rebinds the device. Native proofs never produce a
browser cookie. Challenges are short-lived, single-use server rows.

OIDC remains available for first enrolment and recovery. A passkey from the
identity provider is distinct from a Sub Rosa passkey and is not silently
imported. The passkey authenticates identity only: the vault still needs an
approved pairing or the recovery secret. The local sidecar and Carpe Diem key
never move to the account service.

## Trade-offs and release boundary

Running the relying party here adds credential state, native bridge code and
domain/certificate coordination. It avoids coupling native authentication to
the identity provider's domain or to an embedded browser. The direct Android
release certificate is pinned in the association document; a Play App Signing
certificate must be added separately if that distribution channel uses one.

Serve the association documents as JSON at the exact paths, enable Apple's
associated-domain capability in provisioning, verify Android signing on the
artifact users install, and exercise both native platform pickers on hardware
before release. The server and simulated authenticator tests cannot verify OS
association caches or platform credential UI. No account sync or vault-access
guarantee changes here; ADR-0050 remains in force.
