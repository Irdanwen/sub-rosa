# Sub Rosa website

The public pages and account UI share the repository's React/Vite toolchain and
single pnpm lockfile. Public pages are prerendered at build time. No external
fonts, analytics, browser session recording or third-party executable scripts.

## Local development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:website
```

Vite serves `http://127.0.0.1:1430` and proxies `/api` and `/auth` to the independent
account service at `127.0.0.1:8088`, preserving Origin for CSRF. See
[`subrosa-cloud/README.md`](../subrosa-cloud/README.md) for the real PostgreSQL /
signed local OIDC fixture and production configuration. The fixture identity is
test-only; it is never part of the production binary.

```sh
pnpm build:website
pnpm vitest run src/test/website-vault.test.ts src/test/website-api.test.ts
pnpm website:releases
```

The release updater reads the public GitHub release API and verifies official
asset paths, sizes and digests. It does not invent an iPhone download URL. Update
the manifest when publishing a release; publishing a website does not release
new desktop/iOS binaries.

## Deployment

Serve `dist/` over HTTPS and route `/auth/*` and `/api/*` to `subrosa-cloud` on the
same origin. Use the cloud Caddy example and configure the exact OIDC redirect
URI. Apply `public/_headers` on the chosen hosting platform; that file is a
hosting configuration, not an HTML substitute for HTTP security headers.

No account service URL, secret or token is compiled into browser assets.
Cookies must remain HttpOnly/Secure in production, with exact-Origin CSRF.
An arbitrary static hosting service cannot run the Rust service. The Sites
owner-only preview uses `pnpm --filter @subrosa/website build:preview`, which
shows an explicit unavailable-account page and accepts no recovery/provider key.
The full deployment uses the normal build after the API/issuer are configured.

Before opening registration: supply the real domain, operator/contact details,
identity provider configuration (verified email/passkeys/recovery), hosting and
retention policy; exercise the cloud restore/deletion and storage checks. The
informational privacy page does not invent those legal or operational facts.

## Secrets and account UI

Vault keys stay in memory; inactivity locks the tab. Native and WebCrypto share
an authenticated envelope fixture. Pairing QR secrets stay in the URL fragment
and are stripped before any account navigation; the service receives only an
encrypted transfer envelope. Provider settings are encrypted in the browser;
the app validates the key against an authenticated free endpoint before use.

The app reports request attempts and transferred bytes, plus dated provider
balance snapshots. Missing data is not zero consumption. Financial values are
shown only when the native collector reports them, never inferred from bytes.
See [ADR-0050](../docs/adr/0050-vault-admission-uses-an-out-of-band-secret.md) for
the exact revocation and web delivery trust limits.
