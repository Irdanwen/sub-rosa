# @subrosa/design

The values the Sub Rosa apps and the Sub Rosa website agree on: the palette, the
typefaces, the type rhythm, and the motion curves. One file, no build step.

**It carries values, not semantics.** The desktop and mobile app composes in
`oklch` + `color-mix` around a runtime-themeable accent
(`src/styles/tokens.css`); the website composes in flat hex with no theme
selector (`website/src/style.css`). Forcing one semantic layer on both would
break one of them, so each maps these primitives to its own token names.
See [ADR-0052](../../docs/adr/0052-the-surfaces-share-primitives-not-a-stylesheet.md).

The charter these values serve, and the reasoning behind each one, is
[docs/design/charte.md](../../docs/design/charte.md).

## Use

```css
@import "@subrosa/design/primitives.css"; /* must be the first rule in the file */

:root {
  --my-background: var(--sr-cream);
  --my-accent: var(--sr-gold-ink-light);
}
```

## Rules

- Every value here is named for **what it is**, never for where it is used. A
  token called `--sr-sidebar-gold` belongs in the consumer, not here.
- Nothing in this file may reference a variable a consumer defines. It has no
  dependencies, in either direction.
- A colour pair that carries text is covered by `src/test/contrast.test.ts`.
  Changing one of those values without re-running that test is how the charter
  rots — it is exactly what happened to the system this one is derived from.
