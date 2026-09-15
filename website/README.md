# Sub Rosa website

The public pages and account UI share the repository's React/Vite toolchain and
single pnpm lockfile. Public pages are prerendered in English at build time.
The website remains English regardless of browser locale or a previously saved
French preference. The native apps keep their own language settings.
No external font requests, analytics, browser session recording or third-party
executable scripts.

## Visual identity

The website follows CarpeDiem's Roman Editorial Luxe system from
`frontend/app/globals.css`, `frontend/tailwind.config.js` and `app/layout.tsx`:
ivory/paper surfaces, bronze accents, fine borders, Cormorant Garamond headings
and Inter body text. The midnight ink/aged gold palette follows the system's
dark preference. The website owns its tokens in `src/style.css`; this does not
change the native apps' theme or Sub Rosa's name and mark.

Latin font subsets were copied from the CarpeDiem build and are served locally
from `public/fonts/`, with their SIL Open Font License notices. The former
French-language Studio screenshot is no longer rendered on the English site.

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

The default build serves the complete website at the root of its dedicated
account origin. For a temporary marketing subpage on an existing domain:

```sh
VITE_SITE_BASE=/subrosa/ VITE_ACCOUNTS_UNAVAILABLE=1 pnpm build:website
```

Mount `website/dist/` at `/subrosa/`, redirect `/subrosa` to `/subrosa/`, and
resolve public routes to their prerendered `index.html`. Account routes beneath
the prefix may fall back to the main `index.html`; they show the availability
page and never mount the account UI or call the shared host's API. Other
unmatched routes should return 404. Fonts, scripts, styles and navigation all
honor the prefix. Configure the web server's response headers explicitly; the
root-oriented `_headers` and `_redirects` files are examples for root hosting,
not configuration consumed by a VPS web server.

Once the dedicated HTTPS account website and its service are ready, build the
marketing site with `VITE_SITE_BASE=/subrosa/` and
`VITE_ACCOUNT_ORIGIN=https://your-account-domain` instead. This origin accepts
no path, credentials or query string. Account links navigate to that separate
origin; browser API calls remain same-origin, never cross-origin. Build the
dedicated account website with neither of these variables. Do not set the
account origin on its own root deployment. `VITE_ACCOUNTS_UNAVAILABLE=1` is for
a publicly available website awaiting account setup; `VITE_PREVIEW_ONLY=1`
continues to disable account access for the private preview.

Serve `dist/` over HTTPS and route `/auth/*` and `/api/*` to `subrosa-cloud` on the
same origin. Use the cloud Caddy example and configure the exact OIDC redirect
URI. Apply `public/_headers` on the chosen hosting platform; that file is a
hosting configuration, not an HTML substitute for HTTP security headers.

Only the optional public account website origin is compiled into browser assets;
no secret or token is compiled into them.
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
