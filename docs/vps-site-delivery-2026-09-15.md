# Public website deployment, 15 September 2026

The English website is live at **https://furetier.com/subrosa/** on the existing
Hetzner VPS. It follows the Carpe Diem visual identity and links to the published
Sub Rosa 1.63.0 desktop artifacts. **Public account registration is still closed.**
This delivery must not be described as a completed account-service launch.

## What is live

- A separate nginx virtual host, `subrosa-marketing`, serves only `/subrosa/`.
  Existing application virtual hosts and containers were not replaced.
- A valid Let's Encrypt certificate for `furetier.com` was issued on 15 September
  2026 and expires on 14 December 2026. The existing Certbot timer renews it; a
  deploy hook validates nginx configuration before reloading renewed certificates.
  A Certbot staging renewal rehearsal completed successfully on the live host.
- HTTP redirects to HTTPS, with HSTS, CSP, anti-framing, content-type and referrer
  protection headers. Marketing access logging is disabled. No account API,
  credential form, analytics or external font request runs on this deployment.
- Build configuration: `VITE_SITE_BASE=/subrosa/ VITE_ACCOUNTS_UNAVAILABLE=1`.
  `VITE_ACCOUNT_ORIGIN` is deliberately absent until a working account origin
  exists. Registration links lead to an honest unavailable page.
- The first deployment is `/srv/subrosa/releases/20260915T122209Z-d2e1bd16`.
  `/srv/subrosa/www/subrosa` points to the active release. That identifier records
  the base commit; the deployed website includes this branch's subpath changes.

## Publish and roll back

Build the website from the repository root, then publish public output only:

```sh
VITE_SITE_BASE=/subrosa/ VITE_ACCOUNTS_UNAVAILABLE=1 pnpm build:website
bash scripts/deploy-website-vps.sh
```

The script uploads into a new directory and atomically switches the symlink.
It verifies HTTPS against local nginx and restores the previous symlink when that
check fails. Prior releases remain on disk. For manual rollback, create a sibling
symlink to the chosen prior release and use `mv -Tf` to replace
`/srv/subrosa/www/subrosa`; then verify the public URL. Never overwrite unrelated
nginx configuration or remove another application's containers.

The initial HTTP-only virtual host, final TLS virtual host and certificate reload
hook are versioned under `subrosa-cloud/deploy/nginx-marketing*` and
`renew-certificate.sh`. The active nginx file is
`/etc/nginx/sites-available/subrosa-marketing` with a sites-enabled symlink.

## Verified on the public URL

Real Chromium checks ran against the deployed HTTPS website at 1440×1000 and
390×844, in light and dark appearances and with a French browser locale. The
website remained English. Home, download navigation, three official desktop
artifact links, account-unavailable navigation and direct page reload passed.
There were no page/console errors, failing resource requests, account API calls,
credential inputs or horizontal overflow. CSP allowed the local fonts and assets.

Public screenshots: [desktop](qa/vps-site-2026-09-15-desktop.png) and
[mobile downloads](qa/vps-site-2026-09-15-mobile.png). Detailed local report and
videos are in `.tmp/public-website-qa/`. The app's separate mock-IPC browser
walkthrough is in `.tmp/public-app-signup-qa/`; it is UI evidence, not evidence of
production account login or physical-device synchronization.

## Work prepared for opening registration

The app draft provides one-button sign-in/account creation, with a provisional
`https://subrosa.furetier.com` default and custom service settings under Advanced
settings. Local-only startup does not contact it. The new host is declared in the
privacy inventory. The draft is not released: shipping a default pointing to an
unavailable service would not make registration work.

The website supports a dedicated root account origin and a separate marketing
subpath without cross-origin cookie/API calls. Production service configuration
remains subject to `subrosa-cloud/README.md` and the VPS stack runbook.

## Actual outstanding dependencies

1. **DNS access:** `furetier.com` points to the VPS; `subrosa.furetier.com` has no
   DNS record. No Cloudflare API credential or authenticated browser session was
   available. The requested DNS record is A `subrosa` → `178.104.103.33`.
2. **Identity email:** no configured SMTP or transactional email credentials were
   found in the deployment environment. Verification and recovery must work with
   the real sender before enabling public registration. Do not mark arbitrary
   email addresses verified or deploy the local test issuer.
3. **Storage and recovery:** no production S3 credentials, independent deletion
   ledger or off-server backup destination were available. The service's existing
   production requirements were not weakened to replace these with local test
   storage. Run real storage, restore and deletion checks before activation.
4. **Capacity:** the shared VPS has 8 GiB RAM, approximately 2 GiB available,
   fully used 4 GiB swap and 41 GiB free disk at inspection. Additional identity,
   database and API services require a measured resource budget or more capacity;
   the website itself needs no new long-running application process.
5. **Operator details:** the public account operator/contact and retention details
   have been requested and cannot be invented from a repository username.

After these dependencies are supplied: deploy the real identity/database/storage
service, configure exact HTTPS callbacks, verify signup/recovery/pairing/restore,
enable registration, rebuild the marketing handoff and release the app default.
The separate TestFlight encryption-declaration blocker documented in
`testflight-encryption-1.63.0.md` is unchanged.
