# Sub Rosa website

The public pages and account UI share the repository's React/Vite toolchain and
single pnpm lockfile. Public pages are prerendered in English at their existing
paths and below `/fr/`, `/de/`, `/it/`, `/es/` and `/pt-br/` in the five other
languages the app speaks. A first visit to the home page follows the first
browser language the site speaks; the language select remembers an explicit
choice. Account, share and native return URLs remain unprefixed (they take
`?lang=`) to preserve their protocols.
The native apps keep their own language settings.

Copy is written as English/French pairs (`t("Help", "Aide")`, `Copy` data).
German, Italian, Spanish and Brazilian Portuguese live in catalogs keyed by
the English under `src/locales/` (ADR-0047, website addendum). After adding
or changing a sentence, run `pnpm --filter @subrosa/website i18n:extract`,
translate the empty entries in every catalog (the app's glossaries in
`scripts/i18n/` apply), and `pnpm --filter @subrosa/website i18n:check`;
`src/test/website-i18n-catalog.test.tsx` is red until every catalog is complete.
No external font requests, analytics, browser session recording or third-party
executable scripts.

## User documentation

The public guide center lives at `/docs` and `/fr/docs`, with one prerendered
page per guide. `/help` and `/fr/help` remain working entry points. Article
copy and search data are kept together in `src/pages/docs-content.ts`; every
visible sentence is supplied in English and French. The search runs in the
browser without a network request. Add a guide to the registry and the build
creates both language URLs, alternate-language metadata, and prefixed asset
links automatically. Screenshots under `public/docs/` are QA fixture captures
without private user data; update them when the pictured controls change.

## Visual identity

The website follows CarpeDiem's Roman Editorial Luxe system from
`frontend/app/globals.css`, `frontend/tailwind.config.js` and `app/layout.tsx`:
ivory/paper surfaces, bronze accents, fine borders, Cormorant Garamond headings
and Inter body text. The midnight ink/aged gold palette follows the system's
dark preference. The website owns its tokens in `src/style.css`; this does not
change the native apps' theme or Sub Rosa's name and mark.

Latin font subsets were copied from the CarpeDiem build and are served locally
from `public/fonts/`, with their SIL Open Font License notices. The Studio
images are captures of the app in each language. The home-page note composition
is an illustration, not a claim that the app has that exact screen layout.

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
asset paths, sizes and digests. It also picks the newest Android prerelease
(`android-vX.Y.Z-<build>`) for the APK card, or none. It does not invent an
iPhone download URL. Update
the manifest when publishing a release; publishing a website does not release
new desktop/iOS binaries.

## Model catalog

`/models` (and `/fr/models`) explains every model a person can pick in the app,
grouped by family, with what each is good at, its limits, its privacy mode and a
price a reader can picture. The page never fetches anything: the security policy
only allows the site's own origin, so the catalog is frozen at build time.

- `src/models/snapshot.json` is the live catalog, written by
  `pnpm website:models` from Carpe Diem's public `/v1/models` and `/pricing`
  plus the provider's public model names. Video prices come from the free
  `/video/quote` endpoint and need `CARPE_DIEM_API_KEY` (nothing is charged);
  without it the previous video prices are kept.
- `src/models/families.json` is the written part: one entry per family, in
  English and French, with the sources each claim came from.
- `src/models/needs.ts` answers "what should I use for…" and lists the app's
  defaults.
- `src/models/details/<kind>.json` holds each family's depth: what sets it
  apart, its dated version history (what each version changed), specs per
  version, strengths and limits, use cases with prompts, rivals and sources.
  One chunk per kind of work, loaded only by the pages that need it
  (`src/models/details.ts`); `details/index.json` is the light release index
  the hub and kind pages read without a chunk.
- `src/models/benchmarks.json` registers each benchmark (what it measures,
  how to read it, its scale) and every score with its date, source and kind:
  `independent` (a third party testing every model the same way) or `vendor`
  (announced by the maker, shown apart). Elo ratings are drawn as dots on an
  axis, never as bars from zero.
- `src/models/guide.ts` is "Understanding models" (`/models/guide`), the
  vocabulary every page links to; `src/models/categories.ts` says what
  separates the models of each kind (`/models/<kind>`).

Pages: the hub, one page per kind (quality against price, leaderboards,
release timeline, sortable table), one page per family, the comparator
(`/models/compare?m=a,b,c`, the choice lives in the address) and the guide.
Charts are plain HTML and CSS in `src/models/charts.tsx`: they prerender,
work without JavaScript, keep their text legible on a phone, and every chart
has its numbers in a table under it.

Rules for adding depth: no source, no claim. A date that cannot be read at a
page is left out ("date not published"); a date deduced from a repository or
an API listing is kept to the month. Scores carry the date they were read.
`src/test/website-models-data.test.tsx` enforces it: every family has its
difference, history, use cases and rivals; every date is ISO and in order;
every score is sourced, dated, on its benchmark's scale and tied to a real
model; every page renders without NaN or undefined.

After refreshing the snapshot, run `pnpm vitest run src/test/website-models.test.tsx`:
it fails until every new model sits in a family and every retired one is gone,
so the page cannot quietly fall behind the app.

## Deployment

The default build serves the complete website at the root of its dedicated
account origin. For a temporary marketing subpage on an existing domain:

```sh
VITE_SITE_BASE=/subrosa/ VITE_ACCOUNTS_UNAVAILABLE=1 pnpm build:website
```

Mount `website/dist/` at `/subrosa/`, redirect `/subrosa` to `/subrosa/`, and
resolve English and `/fr/` public routes to their prerendered `index.html`. Account routes beneath
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
