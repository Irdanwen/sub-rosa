---
status: accepted
date: 2026-09-19
---

# The surfaces share design primitives, not a stylesheet

## Context

Sub Rosa presents on three surfaces that had drifted into three visual
languages: the desktop and mobile app (warm oklch greys around a themeable
`#936862` rose, ABC Diatype / Martina Plantijn / Berkeley Mono, theme by
`data-theme`), the public website (ivory and bronze hex, Inter / Cormorant
Garamond, theme by `prefers-color-scheme`), and Carpe Diem itself, whose
"Roman Editorial Luxe" system the website was already derived from.

Aligning them meant deciding what "shared" means. Carpe Diem's own system is a
single `globals.css` with the palette, the semantics and the component classes
in one file. Copying that shape here would mean one stylesheet for all three.

That does not survive contact with what each surface actually is:

- The app's palette is a *derivation*. One custom property, `--brand`, is
  overridden at runtime by the Appearance wheel, and every surface, tint, hover
  and hairline falls out of it through `color-mix(in oklch, …)`. It is also
  read by four separate webviews (the main window and three HUDs), each of
  which redefines locally the tokens it needs.
- The website's palette is *flat*. It has no accent picker, no runtime theming,
  no `data-theme`, and 609 lines of CSS with three runtime dependencies. Giving
  it an oklch derivation chain would be machinery it has no use for.
- The app ships an offline binary; the website is prerendered static HTML on a
  VPS. They do not share a build, a Vite root, or a deploy.

The three licensed typefaces the app inherited from upstream (ABC Diatype,
Martina Plantijn, Berkeley Mono) were a second reason to move: they sat as
`.woff2` files in a public repository.

Measuring the source system also mattered. Its light theme fails contrast on its
own accent — `#c9973f` on `#f5f0e8` is 2.32:1, which is the colour of every link
and the primary button's label. Its own audit measured this and the redesign
that would have fixed it was abandoned. Adopting the palette unchanged would
have imported the defect into three more places.

## Decision

The surfaces share **primitives, not semantics**.

`packages/design/primitives.css` (`@subrosa/design`, a workspace package, one
file, no build step) carries the values: the two grounds, the two golds, the
text ramps, the state colours, the three typefaces, the tracking and leading
pairs, and the motion curves and durations. Every name says what a value *is*.
Nothing in it references a consumer's variable.

Each surface maps those into its own token names.
`src/styles/tokens.css` keeps its oklch derivation and its runtime accent;
`website/src/style.css` keeps its flat hex and its media query. Neither imports
the other, and neither is renamed.

Three corrections are made to the palette on the way in, rather than adopted as
found:

1. **The gold is split by role.** `--sr-gold-display` is ornament, rules, large
   display type and the whole dark theme; `--sr-gold-ink` is anything carrying
   text or acting as a fill. In the app, the ink tone is *derived* from the
   selected accent — `color-mix(in oklch, var(--brand) 62%, black)` on light,
   `58%, white` on dark — so the Appearance wheel cannot produce an unreadable
   accent.
2. **Imperial red is a fill on the dark ground, not text** (2.13:1); a lifted
   tone carries the words there.
3. **State gets tokens** — success, warning, danger, info, one per ground.

And the decision that holds the rest up: **`src/test/contrast.test.ts` is a
gate.** It computes the ratio of every named pair against the ground it sits on,
and runs the accent derivation over all seven presets in both themes. A colour
change that drops a pair below the floor fails the build.

## Consequences

- The three surfaces set type identically and read as one product, without
  sharing a stylesheet, a build, or a deploy.
- Changing a shared value is one edit in one file, and the gate says
  immediately whether it is allowed.
- Adding an accent preset is no longer a judgement call — the test covers the
  derivation, not a hand-checked value.
- The app's UI is unavoidably re-set in Inter and Cormorant Garamond. The metric
  change (Inter has a larger x-height; Cormorant is far lighter than the serif
  it replaced) needed a pass over `--fs-*`, `--fw-medium` and the tracking
  tokens, and `--fw-medium` moved from 600 to 500 because Inter is variable and
  500 is its real Medium.
- Three `.woff2` files under commercial licence leave the tree. They remain in
  git history; rewriting the history of a public repository with 107 releases is
  a separate operation and was not done.
- Two token vocabularies still exist, one per surface. That is the point, but it
  does mean a value has two names. The primitives file is the index between
  them, and the charter names both.
- Carpe Diem's own `globals.css` is not changed by this. The three corrections
  above apply to it unchanged, and it remains a 6/10 until they land there.

## Alternatives considered

**One stylesheet for all three surfaces.** What the source system does. It would
force the website to carry an accent-derivation chain it has no picker for, or
force the app to give up runtime theming — a feature with a settings panel, a
native dock-icon swap, and an event that syncs three HUD windows.

**A token build step (Style Dictionary or similar), emitting per-surface CSS.**
Correct at ten times the size. At 47 values across two consumers it would add a
generator, a lockfile and a CI step to avoid writing `var(--sr-gold-ink)` by
hand twice.

**Adopt Carpe Diem's palette unchanged, fix contrast later.** Rejected: "later"
is precisely what happened to the abandoned redesign the values came from, and
a charter with no gate is what produced the 2.32:1 button.
