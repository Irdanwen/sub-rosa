# ADR-0097: A publication is plaintext the service renders on an origin of its own

Date: 2026-10-08. Status: accepted. Leaves ADR-0053 (shares) untouched.

## Context

The parity matrix (ADR-0078) left three public things open: a note or a canvas
as a page anybody can read (and several pages as a small site), an opt-in
profile page, and a catalog of assistants other people can add. Everything the
account service held so far was ciphertext for one reader (ADR-0049), or for
the holder of a fragment key until a deadline (ADR-0053). A page is the
opposite on every axis: it is meant for strangers, it has no end date, and a
search engine should be able to read it. There is no key to keep from the
service, because there is no reader the service could be kept from.

So the question was not whether the service sees the text (it must), but who
renders it, where it is served, and what stops a published page from becoming
a way to run script against the people who read it or the account it came from.

Three shapes were on the table:

1. **Static files.** On publish, the service (or the app through it) writes
   HTML files into a directory nginx serves.
2. **A website page.** The React site fetches the page as JSON and renders it,
   like the share reader does.
3. **The service renders.** The service keeps the sanitized HTML in PostgreSQL
   and answers `GET /p/{slug}` itself, behind the proxy.

## Decision

**A publication is plaintext sent by an explicit publish; the service renders
it, once, to an allowlisted fragment, keeps only that fragment, and serves it
as script-free HTML from a publication origin apart from the account origin.**

- **Explicit, and the device's own text.** Nothing is published except by a
  tap in the app (the note's share dialog, the canvas header, an assistant's
  options). What leaves is the note as it is on that device, never anything
  read from the encrypted library. Unpublishing deletes the row: the stored
  text is gone at once. "Publish changes" replaces it. There is no expiry.
- **The service renders, at publish time.** `subrosa-cloud` turns markdown into
  HTML with `pulldown-cmark` and passes it through an `ammonia` allowlist
  (`services/src/publication/render.rs`). Two walls, so one mistake is not
  enough: raw HTML in the source becomes visible text before the sanitizer
  sees anything; images keep only their description (a reader's browser must
  not fetch an address the author chose); links keep only `http`, `https` and
  `mailto` and carry `rel="nofollow noopener noreferrer ugc"`. The service
  stores the fragment and a SHA-256 of `title || 0x00 || markdown`, never the
  source, so the app can tell whether its note changed since it was published.
- **Served by the service, on its own origin.** `GET /p/{slug}`, `/u/{handle}`,
  `/u/{handle}/avatar`, `/_pub/style.css` and `POST /_pub/report` answer only
  when the `Host` is the configured `[publication] url`, which outside
  development must be a different host from `public_url`. The page carries its
  own policy: `default-src 'none'; style-src 'self'; img-src 'self';
  form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. No script, not
  even ours: the report button is a `<details>` with a plain form.
- **A site is a set of pages, not a new address space.** A site has a title, an
  ordered list of the owner's pages and a home page; its address is the home
  page's. Every page of a site shows the site's navigation. Deleting a site
  leaves its pages published on their own.
- **The profile is opt-in and lists, it does not attribute.** `/u/{handle}`
  exists only once created and lists the owner's sites, loose pages and
  catalog listings. A page does not name its author; a catalog listing names
  the author's handle only when that author has a profile.
- **The catalog is JSON on the account origin.** Listings are public JSON
  routes on the account service (`/api/v1/catalog/assistants`, search by text
  and category, one import count), read by the website's `/assistants` pages,
  which render every field as text. A listing carries instructions, the opening
  message, the permissions as requests (tool keys, `notes`, `memory`; never a
  connector) and only the references the publisher ticked, as text.
- **"Add to Sub Rosa" carries an id, nothing else.** The link is
  `subrosa://assistant/import?id=<uuid>`. The app reads the listing from its own
  account site, never from an address the link could carry, shows all of it,
  offers each permission as a choice with reading notes and memory unticked,
  and creates an ordinary assistant only on a tap. It counts one import.
- **Rules, reports and takedowns, without a model.** A documented rule set
  (`docs/public-content-rules.md`) refuses oversize content, control
  characters, link farms, pasted credentials and operator-blocked terms, and
  names the rule in the refusal. Every public page and listing has a report
  form; reports are kept with a keyed hash of the reporting address so one
  address counts once. The operator's tool (`subrosa-cloud takedown`, wrapped
  by `subrosa-cloud/scripts/takedown.sh`) hides content at once, refuses an
  identical copy from then on, and suspends publishing after three takedowns.
  There is no HTTP route that takes anything down.

## Consequences

- Unpublishing is immediate on the service. It cannot reach a copy a reader, a
  cache or a crawler already has, and the dialog says so before the button.
- The publication origin needs its own DNS name, certificate and vhost
  (`deploy/nginx-pages.conf.example`), and `[publication]` in the service
  configuration. Without it every publishing route answers 404 and the app
  says the service does not publish pages.
- Pages are plaintext at rest in PostgreSQL and in its backups. That is what
  publishing means, and the only plaintext the service holds that a person
  wrote. A restored backup can bring back a page unpublished since the backup;
  the deletion ledger replays account deletions, not unpublishes.
- Images in a note are not published. A canvas of code is published as its
  fenced block.
- A published page is the note at the moment of the tap. Editing the note
  changes nothing public until "Publish changes".

## Alternatives rejected

- **Static files written to disk.** They survive the service (a page stays up
  through a database outage), but publish and unpublish become two-phase
  writes across a container boundary, the service needs a writable volume the
  proxy also reads, a takedown has to find and delete files, and a partial
  write is a half-published page. The rendering cost they save is one
  sanitizer pass at publish time, which the service already pays.
- **Rendering in the website.** The React site would have to put
  author-controlled HTML into a page on the account origin, the one that holds
  the session cookie and the browser vault, and under a policy that requires
  Trusted Types. One sanitizer bug would then reach the vault. Serving from
  another origin with a policy that runs no script makes a sanitizer bug cost
  a defaced page, not an account.
- **Serving pages from the account origin with a stricter path policy.** Same
  origin means same cookies and same storage; a path-scoped policy does not
  separate them.
- **A server-side moderation model.** Out of scope for a service that runs no
  inference (ADR-0049), and a model's refusal cannot name the rule a person
  should fix.
- **Ratings and comments.** The catalog keeps a count of imports and nothing
  else about its readers.
