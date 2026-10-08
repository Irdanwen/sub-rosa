# ADR-0096: A browser is a device

Date: 2026-10-08. Status: accepted. Supersedes exactly two clauses, quoted
below: one of ADR-0069 and one consequence of ADR-0053. Everything else in
both stands.

## Context

The web client (parity work packages WP19 and WP20) has to talk to a model.
Two accepted decisions stood in its way, deliberately:

- ADR-0069, decision 2: "Only a recent app session on a live device may ask.
  **Browsers have no device to bind a key to.**"
- ADR-0053, consequences: "The web reader is **read only**, and not as a
  limitation to lift. Writing from a browser would put a second author on the
  journal with none of the app's conflict handling, on the surface
  `docs/threat-model.md` already names as outside its boundary."

Both were right about the browser they described: a cookie session that any
script on the page can ride, with nothing the service can tell apart from the
next tab. What changed is that a browser can hold a key no script can copy.
WebCrypto generates P-256 keys with `extractable: false` and keeps them in
IndexedDB as opaque `CryptoKey` objects: the page can ask the key to sign, it
can never read it, export it or send it anywhere. That is the property a
"device" had in ADR-0069 (the app's ephemeral key never leaves its memory, its
device secret never leaves the keyring), translated to the web.

## Decision

**A browser becomes a device of its account on explicit request, after the same
out-of-band admission a new device needs for the vault, and obtains its own
Carpe Diem key through the ADR-0069 path with a bound Carpe Diem holds in its
TEE.**

1. **Becoming a device.** A signed-in tab, with a sign-in less than five
   minutes old (the bar for approving a native device-login today), generates
   a non-extractable P-256 device key and asks
   `POST /api/v1/browser-devices`, signing the request with that key. The
   service requires one of two admissions, both server-checked:
   - **another device approved it**: a pairing request this browser session
     created ([ADR-0050](0050-vault-admission-uses-an-out-of-band-secret.md),
     [ADR-0057](0057-pairing-is-offered-before-the-recovery-key.md)) that a
     *live app* of the account approved within five minutes. The service now
     records which device approved a pairing; a browser tab cannot admit
     another browser. The approval is consumed.
   - **the recovery key**: the browser derives
     `HKDF-SHA256(recovery secret, info = "subrosa:admission:v1:{account}")`
     and sends it once; the vault holds its SHA-256 as `admission_verifier`.
     The value is one-way, so it opens nothing, and it is bound to the
     account. The verifier is written with the envelope by whoever just made
     the recovery key, cleared by an envelope written without one, and
     replacing it later asks for a recent sign-in. Vaults created before this
     change, and vaults the app creates until it sends a verifier, have none:
     they admit a browser through the app.

   The device row has `kind = 'browser'`, the public key and its RFC 7638
   thumbprint, a name like "Browser - Firefox", and shows in the device list
   like an app. At most ten live browser devices per account.

2. **Acting as the device.** A browser device has no bearer session and no
   device secret. Every call that acts as the device adds a
   `subrosa-device-proof` header to the ordinary browser session: an ES256 JWS
   (`typ: subrosa-device+jwt`, `kid` = device id) over the method, the exact
   URL, a single-use identifier, an issue time within a minute and, where the
   call authorizes something, a hash of it. A stolen session cookie without the
   browser holding the key is not a device; a stolen key is not possible.

3. **Key birth.** ADR-0069 exactly: an ephemeral P-256 key per attempt (also
   non-extractable, in memory), a 120 second ES256 assertion from the service
   bound to its thumbprint, a DPoP proof to Carpe Diem, which mints the `cdm_`
   key and returns it to the browser over TLS. The service asks the device
   proof to be bound to that thumbprint. Two things differ:
   - the assertion says `kind: "browser"` and asks for a bound,
     `{daily_cap_credits, valid_seconds}` (defaults 200 credits, two dollars,
     and seven days, configurable down, never above 5000 credits and 7 days);
   - the browser's session **need not be recent**. The key is short-lived on
     purpose and renewed while the device is live; asking for a fresh sign-in
     every week would make the bound a chore instead of a defence.
4. **Carpe Diem holds the bound.** Inside the operator, a browser key expires,
   stops serving once its spend over the last 24 hours reaches its cap, is
   refused on `/router` and every x402 path, and reaches only the inference
   routes the web client needs. A partner can ask for less than the
   operator's ceilings, never more. CORS admits the Sub Rosa site origins on
   those routes and on the partner key routes, and nowhere else.
5. **At rest in the browser.** The minted key is sealed with AES-GCM under a
   second non-extractable key, with the account and device in the
   authenticated data, and stored in IndexedDB. Never in `localStorage`.
6. **Revocation follows the device** (ADR-0069 decision 3, unchanged): revoking
   the browser from any device, or the browser signing itself out with its
   proof (`POST /api/v1/browser-devices/renounce`, no step-up), writes the
   Carpe Diem revocation into the outbox in the same transaction. A browser
   leaving also asks Carpe Diem to revoke its key directly, and deletes both
   keys locally.

### What this supersedes

- ADR-0069's "Browsers have no device to bind a key to" becomes: **a browser
  admitted as a device has one**, and obtains a key bounded more tightly than
  an app's. A plain browser session still cannot ask (`403 device_required`).
  "Only a recent app session may ask" still holds for apps.
- ADR-0053's "the web reader is read only, and not as a limitation to lift"
  becomes: the web reader stays read only; **a browser device may write**, as
  the web client of WP19, through the same encrypted journal and revision
  rules as an app. The share viewer and the recovery-key library reader are
  unchanged.

## Threat analysis

The web delivery boundary does not move: the site's code is trusted the way
ADR-0050 says it is, and a compromised deployment can serve code that does
anything an open tab can. What changes is what an open tab can reach. Before,
cross-site scripting on the account site reached the unlocked vault key in
memory. Now it also reaches a spending key: script on the page can ask the
non-extractable keys to sign and can decrypt the minted `cdm_` key, so it can
spend, and it can exfiltrate that key.

What bounds it:

- **The cap.** At most the daily cap (two dollars by default) per 24 hours, per
  browser device, enforced by Carpe Diem in its TEE, not by the page.
- **The lifetime.** An exfiltrated key dies within seven days. Renewing it
  needs the device key, which cannot leave the browser, and a live device:
  script that is no longer running cannot renew anything.
- **Revocation.** Revoking the browser device from any other device kills its
  key through the outbox and stops its renewals at once. Carpe Diem's mail for
  the first key of each browser names it; renewals of an announced browser do
  not mail again.
- **The rails.** No `/router`, no x402, no key management: the key cannot be
  turned into something that spends faster or elsewhere.
- **Admission.** Becoming a device needs a sign-in minutes old and the vault's
  out-of-band secret, or another device's approval. That is already more than
  approving a native device-login asks today (a recent browser session), which
  under ADR-0069 also yields a key-minting device; script in a recently
  signed-in tab could do that already, with no cap.
- **CSP.** `script-src 'self'`, no inline script, no third-party origin, and
  `connect-src` names exactly one origin beyond the site: the Carpe Diem
  operator, so stolen material cannot be posted anywhere else by `fetch` (it
  can still leave through navigation, which CSP does not govern). The policy is
  one string in four files, held identical by `src/test/website-csp.test.ts`.
- **Trusted Types.** `require-trusted-types-for 'script'` with only a policy
  named `subrosa` allowed, and none created today: a string can no longer
  reach an HTML or script sink, so injected markup cannot become script in the
  browsers that enforce it. The built bundle was checked: React only reaches
  such a sink through `dangerouslySetInnerHTML`, which the site never uses.
- **Subresource Integrity.** The built page pins its entry script and
  stylesheet to their SHA-384 (`website/vite-sri.ts`), computed from the bytes
  on disk after the build, so a file altered in a cache or on the server is
  refused rather than run next to the keys. Chunks loaded later by `import()`
  cannot be pinned by a browser, and the site's own origin remains the trust
  anchor.

## Alternatives considered

- **No key in the browser: the web client calls inference through the account
  service.** Rejected: the service would hold or relay spending authority and
  see prompts, which ADR-0049 and ADR-0069 exist to forbid.
- **Paste a key into the website.** Rejected: an unbounded key, typed into the
  most exposed surface the product has.
- **The vault's pasted key, decrypted in the tab.** Rejected for the same
  reason: unbounded, unrevocable per browser, and ADR-0050 says it comes down
  only after admission, not that it should be used from a page.
- **Recent sign-in for every renewal.** Rejected: a weekly forced sign-in
  shortens nothing an attacker in the page cannot also do while the person is
  signed in, and makes the short lifetime unbearable.
- **Admission by the recovery secret itself, sent to the service.** Rejected:
  "the service receives neither recovery nor vault keys" (accounts contract).
  The derived value is sent instead.

## Consequences

- The web client (WP19) has a key and a device identity to sync as.
- `subrosa-cloud`: migration `0011_browser_devices.sql` (device kind and public
  key, pairing approver, vault verifier, single-use proof table), the
  `kind` field in the device list, two routes, and the browser branch of the
  assertion route.
- Carpe Diem: the `browser` bound, CORS for the site origins and the bound
  checks ship in the operator; until Geolours deploys them, the web client
  cannot obtain a key in production
  ([deployment gates](../browser-device-deployment.md)).
- The native app does not yet write an admission verifier when it creates or
  replaces a recovery key. Until it does, vaults born in the app admit browsers
  only through pairing. Follow-up.
- An operator that predates the bound would mint an unbounded key from a
  browser assertion. The site refuses any key whose answer lacks `bound` and
  `expiresAt`, revoking it at once; the deployment order (operator first) is
  what protects against script on the page.
- A browser device is per browser profile: clearing site data deletes its keys,
  and the person admits it again; the old row stays in the list until revoked.
