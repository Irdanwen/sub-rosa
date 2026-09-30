# ADR-0067: The website localizes public paths without changing account callbacks

Date: 2026-09-29. Status: accepted.

## Context

The public website now serves English and French. Public pages need stable,
indexable language URLs, but the account service allowlists exact sign-in return
paths and the native callback, share and pairing links carry protocol state.
Prefixing those paths with a locale would change a security boundary and strand
links already in use. Marketing may also live below a path prefix on an origin
separate from the account service.

## Decision

Keep the existing English public URLs and prerender French equivalents below
`/fr/`. Use the browser language on a first visit to the home page, then honor
an explicit EN/FR choice saved on that origin. Public pages declare their
language and alternate URLs in the prerendered HTML.

Keep `/account/*`, `/s/*`, `/auth/*` and the native return path unchanged.
Account links carry `lang=en|fr` on first arrival so a separate account origin
can remember the visitor's choice. Changing language on an account page updates
that query without disturbing its other parameters. The language is display
state only: strip it from OIDC `return_to` values, and never add it to a share
fragment or device callback. Account and share pages read the saved choice or
the browser language when no choice has been made.

## Consequences

- The account protocol and existing links remain compatible.
- A public French page has its own static HTML and can be linked directly.
- Language preference is per origin; the public-to-account link transfers it
  once without a cross-origin browser API call.
- A direct English public URL stays English, even in a French browser. The
  unqualified home page uses the browser choice on first visit.
