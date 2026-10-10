# Browser devices: what must be deployed before they work

[ADR-0096](adr/0096-a-browser-is-a-device.md) lets a browser become a device
and obtain a bounded Carpe Diem key. The code is in three places, and the web
client cannot obtain a key in production until all three are live. Order
matters: Carpe Diem first, then the account service, then the site.

## 1. Carpe Diem operator (external gate: Geolours)

Branch `feat/subrosa-browser-devices` in the Carpe Diem repository, committed
locally, **not pushed**. It must be reviewed, merged and deployed to the Phala
CVM by the operator's owner. What it changes, all inside the operator:

- `operator/src/services/browserKeys.ts`: the bound checked on every request
  carrying a browser key (expiry, 24 hour spending cap from the usage ledger,
  `/router` and x402 refused, inference routes only), and the Sub Rosa origins.
- `operator/src/app.ts`: CORS decided per path. `https://subrosa.furetier.com`
  and `https://furetier.com` are allowed on `/partner/keys`,
  `/partner/keys/poll`, `/partner/capabilities` and the inference routes listed
  in the contract (section 7); every other origin rule is unchanged.
  The Office add-ins' origin, `https://office.subrosa.furetier.com`, has to
  join that list (`SUBROSA_SITE_ORIGINS`) before a pane can obtain or use a
  key ([office-addins.md](office-addins.md#deployment), step 0).
- `operator/src/services/partners.ts`, `operator/src/routes/partnerRoute.ts`,
  `operator/src/services/db.ts`: the `kind`/`bound` assertion claims, the
  bounded key columns (`api_keys.bound_*`, added at boot by `ensureColumn`),
  the bound kept on a link request, `expiresAt` and `bound` in the `201` body,
  and no repeat notice mail for a browser renewal.
- Tests: `operator/test/routes/partner-browser-keys.test.ts`.
- Docs: `docs/partner-integration.md` section 7 (the copy of this repository's
  [contract](carpe-diem-partner-contract.md)).

No new environment variable. `PARTNERS_JSON` is unchanged (same partner key,
same `kid`). The operator's ceilings (5000 credits a day, 7 days) are
constants in `browserKeys.ts`.

To check after deploying, from any machine:

```sh
curl -si -X OPTIONS https://carpe-diem.xyz/api/operator/partner/keys \
  -H 'Origin: https://subrosa.furetier.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,dpop,content-type' \
  | grep -i '^access-control-allow-origin: https://subrosa.furetier.com'
```

The Vercel frontend proxies `/api/operator/*` to the operator, including
`OPTIONS`; nothing changes there.

## 2. Account service (`subrosa-cloud`)

- Migration `0011_browser_devices.sql` runs at start, like the others.
- Optional `[carpe_diem]` settings, with these defaults:
  `browser_daily_cap_credits = 200`, `browser_key_days = 7`.
- New routes `POST /api/v1/browser-devices` and
  `POST /api/v1/browser-devices/renounce`; the assertion route accepts a browser
  device's proof. The nginx account vhost already proxies `/api/`.
- Deploy only after the operator: before it, a browser's assertion carries a
  `kind` the old operator ignores, so the old operator would mint an
  **unbounded** key. The site refuses such a key (no `bound` or `expiresAt` in
  the answer): it revokes it at once and stores nothing. That protects an
  honest browser, not the account against script on the page, so the order
  still matters. If the service has to go out first, keep the website build
  without the browser device card until the operator is live.

## 3. Website and its headers

- Rebuild and publish the site (`pnpm build:website`), which now pins its entry
  script and stylesheet with Subresource Integrity.
- Install the new Content-Security-Policy in every place that serves it: the
  VPS vhosts (`subrosa-cloud/deploy/nginx-account.conf.example` and
  `nginx-marketing.conf`, copied into `/etc/nginx/sites-available/`, then
  `nginx -t && systemctl reload nginx`) and `website/public/_headers` for a
  static host. The policy adds `connect-src https://carpe-diem.xyz` and Trusted
  Types; `src/test/website-csp.test.ts` keeps the four copies identical.
- The web client's own blocks (ADR-0104): `/app` (its policy adds
  WebAssembly, a blob worker, the connector view frame, the probed connector
  origins, and the microphone, camera and screen), `/connector-view.html`
  (its own policy, framed only by the site) and `/pyodide/` (module types for
  `.mjs`, `application/wasm`). The site build now carries Pyodide under
  `/pyodide/` (about 20 MB; `SUBROSA_PYODIDE=0` builds without it, and Python
  is then unavailable in the tab). Check `/app` in Chrome as below, plus one
  Python run and one voice turn.
- After publishing, open `/account/devices` in Chrome with the developer tools
  console open and check there is no CSP or Trusted Types violation.

## Still open after deployment

- The native app sends an admission verifier when it creates a vault (since
  WP19), so a vault born in an up-to-date app admits a browser with the
  recovery key. Vaults created before that admit a browser only by approval
  from the app; the app does not yet rewrite an existing vault to add one
  (that needs a recent sign-in and a compare-and-swap of the envelope).
- The web client (`/app`, ADR-0101) is what uses the key. Until the operator
  ships the browser bound, a browser has no key and `/app` sends the person to
  the devices page.
