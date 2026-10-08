# Public content rules

The rules every published page, site, profile and catalog listing passes
before the account service stores it ([ADR-0097](adr/0097-a-publication-is-plaintext-the-service-renders-on-an-origin-of-its-own.md)).
There is no model and no judgement here: each rule is mechanical, and a refusal
names the rule (`422 content_policy`, `rule: …`) so the app can say what to
change. Code: `subrosa-cloud/crates/services/src/publication/policy.rs`.

## What is refused

| Rule (`rule`) | What it refuses |
| --- | --- |
| `too_large` | A page source over 256 KiB or a rendered page over 512 KiB; a title over 200 characters; an assistant's instructions over 32 KiB, opening message over 2 KiB, more than 10 references or 200 KiB of them; a display name over 80 or a bio over 500 characters; a profile picture over 256 KiB. |
| `empty` | A page without text, a listing without a name, description or instructions, a reference without text. |
| `control_characters` | Control characters other than line breaks and tabs. |
| `too_many_links` | More than 20 links in a field and more than one link per 80 characters: a link farm, not an article. A reading list with a sentence per link passes. |
| `credential` | Something that looks like a key or a password pasted by accident: a Carpe Diem key (`cdm_…`), a private key block, an AWS access key id, and common API token shapes. Publishing one is never what anybody meant, and it cannot be taken back once a crawler has it. |
| `blocked_term` | A term the operator lists in `[publication] blocked_terms`, matched as a lowercase substring of any field. Empty by default. |
| `shape` | An address (`slug`, `handle`) outside 3 to 64 (pages) or 3 to 32 (handles) lowercase letters, digits and single hyphens; a reserved handle (`subrosa`, `support`, `admin`, …); an unknown category; a permission other than the app's tool keys, `notes` and `memory` (connectors are never published); a profile picture that is not PNG, JPEG or WebP by its bytes. |
| `too_many` | More than 500 pages, 20 sites, 100 pages in a site or 50 catalog listings on one account. |

Two refusals are not rules but history:

- `taken_down` (403): content the operator took down, by its id, or an
  identical copy of it under any address or account (same title and text for
  a page, same instructions for a listing, same handle for a profile).
- `publishing_suspended` (403): an account with three takedowns can no longer
  publish. What it already published stays until it unpublishes it.

## What the renderer does to every page

- Raw HTML in the note is shown as text, never interpreted.
- Images keep their description; the image itself is not published.
- Links keep only `http`, `https` and `mailto`, and are marked
  `nofollow noopener noreferrer ugc`. Relative links and fragments are dropped.
- The allowed elements are headings, paragraphs, emphasis, strike, code,
  quotes, lists, tables, rules and links. Nothing else survives.
- The page is served with a policy that runs no script and loads nothing from
  elsewhere.

## Reports

Every public page, profile and catalog listing has a report form (no script:
a plain form on the page, a JSON call on the catalog). A report names the
target, one of five reasons (spam, abuse, illegal, privacy, other) and up to
500 characters of detail. The service keeps a keyed hash of the reporting
address so one address counts once per target, allows five reports a minute
per address, and deletes closed reports after 30 days and open ones after 180.

## Takedowns (operator)

Run on the VPS, from the repository checkout, with the stack's private
directory:

```sh
subrosa-cloud/scripts/takedown.sh --directory <private dir> reports
subrosa-cloud/scripts/takedown.sh --directory <private dir> page <slug> "<reason>"
subrosa-cloud/scripts/takedown.sh --directory <private dir> site <site id> "<reason>"
subrosa-cloud/scripts/takedown.sh --directory <private dir> profile <handle> "<reason>"
subrosa-cloud/scripts/takedown.sh --directory <private dir> assistant <listing id> "<reason>"
subrosa-cloud/scripts/takedown.sh --directory <private dir> dismiss <kind> <target id>
```

`reports` prints the open reports, oldest first, one JSON object per line
(kind, target id, count, reasons, details, a label). A takedown hides the
content at once, closes its reports, records the reason and the content's
digest, and counts one strike against the owner (a site counts once, not once
per page). The owner sees "taken down by the service" and can only unpublish
it. There is no HTTP route that takes anything down, and no appeal flow: a
mistaken takedown is undone by hand in PostgreSQL: clear `taken_down_at` on
the row and delete its line in `takedowns`.
