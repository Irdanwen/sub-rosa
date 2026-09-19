# Use design tokens

**Rule.** Reach for the CSS variables in `src/styles/tokens.css` before
hand-coding sizes, colors, radii, or motion values. The values those tokens are
built from live in `packages/design/primitives.css`, and the reasoning is
[docs/design/charte.md](../docs/design/charte.md) — read it before changing a
colour.

**Why.** Tokens keep spacing, color, and motion consistent and themeable;
hand-coded values drift and break theming / dark mode.

**How to apply.** Use `var(--token)` for spacing, color, radius, and
timing/easing. If a needed value has no token, add a token rather than a magic
number.

**Colour is gated, not reviewed.** A pair that carries text has a floor, and
`src/test/contrast.test.ts` enforces it; `src/test/motion-tokens.test.ts` keeps
`src/lib/motion.ts` locked to the CSS curves. If you need a new colour that
carries text, add it to the primitives and add its pair to the test.

**Exceptions.** A genuine one-off value outside the design system (rare) — call
it out in review.
