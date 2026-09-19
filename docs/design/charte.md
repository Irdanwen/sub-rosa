# The Sub Rosa charter

Sub Rosa is a Carpe Diem product and wears its face: warm paper or deep ink, a
gold that behaves like metal rather than yellow, a serif that only shows up when
something deserves the weight, and motion you notice only when it is missing.

This document is the charter. The values live in
[`packages/design/primitives.css`](../../packages/design/primitives.css); the
two surfaces map them into their own semantics
([`src/styles/tokens.css`](../../src/styles/tokens.css) for the apps,
[`website/src/style.css`](../../website/src/style.css) for the site) — see
[ADR-0052](../adr/0052-the-surfaces-share-primitives-not-a-stylesheet.md) for
why it is split that way.

Read [CONTEXT.md](../../CONTEXT.md) before naming anything, and the UI specs in
[spec/index.md](../../spec/index.md) before writing a label: sentence case, no
typographic dashes, one voice, icons from `central-icons`, every sentence
through `t()`.

## Where this came from, and what was wrong with it

The charter is derived from Carpe Diem's "Roman Editorial Luxe" system
(`CarpeDiem/frontend/app/globals.css`). That system has real taste — one source
file, two symmetric themes, a palette constraint it defends in its own comments
("the design system has no further hue, and inventing one for a debug page is
how a house style dies"), and an identity of its own in the sundial, the
engraved vine and the CD seal.

It also, measured rather than eyeballed, fails its own light theme:

| Pair | Ratio | |
| --- | --- | --- |
| gold `#c9973f` on cream `#f5f0e8` — links, doc headings | **2.32:1** | fails |
| the primary button: cream on gold | **2.32:1** | fails |
| gold hover `#b08535` on cream | **2.96:1** | fails |
| tertiary text `#9a9490` on cream | **2.64:1** | fails |
| imperial `#8b1a1a` on ink `#0a0a0a` — **error copy in dark** | **2.13:1** | fails |
| every border pair | 1.19-1.68:1 | fails (3:1 needed) |

Its dark theme is excellent (13.78 / 18.64 / 6.95:1). Its own audit measured
these same numbers, and the redesign that would have fixed them was abandoned
(`refonte-ui-abandonnee-2026-09-17`, a stash, not an ancestor of HEAD). So the
failures are live.

Alongside that: no state tokens at all (`green` and `emerald` both mean
success), two competing alias sets for one palette, a mono family declared and
never loaded across 172 usages, two `var()` references to variables that do not
exist, 29 hardcoded `#e8d5b5` that break in the light theme, no spacing, radius,
shadow or focus scale, and one easing curve — `cubic-bezier(.4, 0, .2, 1)`, the
Material default — doing every job.

**As a charter it is a 6 out of 10: real taste, no enforcement.** Everything
below is either taken from it unchanged or is one of the eight corrections that
close that gap. The last correction is the one that keeps the others true.

## 1. Two grounds

`--sr-cream` `#f5f0e8` and `--sr-ink` `#0a0a0a`, with `--sr-cream-raised` and
`--sr-ink-raised` one step up for cards and popovers.

The cream is **paper, not grey**: chroma 0.012 at hue 80. That warmth is the
brand, and it must survive the accent changing. In the apps the ground is the
cream with a 3% wash of the selected accent on top — two layers doing two jobs:
the paper is Carpe Diem, the wash is the user's choice.

## 2. One gold, two jobs

This is the charter's central correction, and everything else follows from it.

- **Display gold** — `--sr-gold-display` `#c9973f` (`#e8d5b5` on ink). The gold
  you recognise. It is a surface and a shape: washes, tints, rules, seals,
  ornament, the brand mark's gradient, very large display type, and the whole
  dark theme. It carries no body text on cream, where it measures 2.32:1.
- **Ink gold** — `--sr-gold-ink` `#6f471b` (`#e8d5b5` on ink). The same family
  pushed until it carries text: links, emphasised labels, button fills, the
  active tab. 7.14:1 on cream, 13.78:1 on ink.

Collapsing these back into one token is how the source system got a 2.32:1
primary button. `src/test/contrast.test.ts` asserts they stay apart, with the
number that separated them.

In the apps the accent is a runtime setting, so `--brand-ink` is **derived**
from whatever is selected rather than hardcoded:

```css
/* light */ --brand-ink: color-mix(in oklch, var(--brand) 62%, black);
/* dark  */ --brand-ink: color-mix(in oklch, var(--brand) 58%, white);
```

Black and white are achromatic, so their hue is powerless (CSS Color 4) and the
mix keeps the accent's own hue instead of dragging it toward red. The recipe is
checked over all seven presets in both themes; the worst pair lands at 6.78:1.
Adding a preset is therefore no longer a coin flip.

## 3. Imperial red is a fill, and sometimes a voice

`--sr-imperial` `#8b1a1a` reads at 8.19:1 on cream and is right there as text.
On ink it measures 2.13:1, so the dark theme keeps it as the surface and uses
`--sr-imperial-on-ink` `#f0a5a5` (10.02:1) for the words.

## 4. State has tokens

`--sr-success`, `--sr-warning`, `--sr-danger`, `--sr-info`, each with an
`-on-ink` counterpart. One value per state per ground. The system this came
from has none, which is how two different greens ended up meaning the same
thing — and how three warning surfaces in `app.css` referenced a `--warning`
that was never defined and quietly rendered as muted grey.

## 5. Type

| Role | Family | Where |
| --- | --- | --- |
| UI and body | **Inter** | everything by default |
| Display | **Cormorant Garamond** | the few moments that deserve weight: a greeting, a page title, a metric |
| Code and figures in tables | **JetBrains Mono** | transcripts, code, keys |

All three are open-licensed, self-hosted, latin-subset, and identical files on
both surfaces. Inter runs with `cv02 cv03 cv04 cv11` — single-storey `g`, tailed
`l`, dotted zero, single-storey `a`.

**Tracking is size-specific, never one blanket value.** Large type reads loose
as it grows and wants negative tracking; body wants none. Cormorant is a light
old-style face and drifts further than a grotesque, hence
`--sr-tracking-display: -0.02em`. Leading runs the other way: tight on display,
comfortable on body.

`--sr-tracking-roman` (0.08em / 0.12em) is for small capitals — the website's
eyebrows, a seal. It is the most identifying thing Carpe Diem does. **It is not
for app UI**: sentence case is the rule there
([spec/sentence-case.md](../../spec/sentence-case.md)).

Figures: anything that updates in place or lines up in a column declares
`tabular-nums`. Prose declares `proportional-nums`. Neither is inherited from
the typeface's default, which has changed once already.

## 6. Motion

```css
--sr-ease-out:     cubic-bezier(0.23, 1, 0.32, 1);     /* entering, leaving */
--sr-ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);    /* moving on screen */
--sr-ease-drawer:  cubic-bezier(0.32, 0.72, 0, 1);     /* sheets, drags */
```

Built-in CSS easings are too weak for UI, and `cubic-bezier(.4, 0, .2, 1)` — the
Material default the source system uses for everything — is the same problem in
a custom-curve costume.

**There is no ease-in.** It starts slow, delaying the exact instant the user is
watching; `ease-out` at 200ms feels faster than `ease-in` at 200ms. The one
exception is the "in" half of `--sr-ease-in-out`, which is for something already
on screen that moves.

Durations: `--sr-t-fast` 100ms (press), `--sr-t-med` 160ms (hover, small
popovers), `--sr-t-slow` 240ms (dropdowns, sheets, screen transitions).
**UI motion stays under 300ms.** A 180ms dropdown reads as more responsive than
a 400ms one.

Before adding motion, ask what it is for — feedback, spatial consistency, state
indication, preventing a jarring change. "It looks cool" on something seen fifty
times a day is a reason to stop. A keyboard-initiated action gets no animation
at all. Group entrances stagger by `--sr-stagger` (50ms) and never block
interaction while they play.

Animate `transform` and `opacity`. Never `transition: all`, never `scale(0)` for
an entrance (start at 0.95 with `opacity: 0` — nothing in the real world appears
from nothing), never a keyframe on something a user can fire twice in a second
(transitions retarget mid-flight; keyframes restart from zero).

Reduced motion means **fewer and gentler**, not zero: keep the opacity and
colour changes that aid comprehension, drop the movement. Hover motion is gated
behind `@media (hover: hover) and (pointer: fine)`, because touch fires a false
hover on tap and leaves it stuck.

Seven transitions in the app run longer than 300ms, and all seven stay: two are
pinned to a native Core Animation turn (`TURN_SECS` in `meeting_hud.rs`) and
would shear if they drifted, two are full icon rotations where a fast spin reads
as a twitch, one is a panel reveal in the drawer range, one is a highlight decay
that has to be seen, and one is a progress bar whose value updates once a second
— a snappier tween there would make an estimate look like a measurement. Each
carries its reason in a comment next to it. The rule is "no duration over 300ms
*without a reason*", not "no duration over 300ms".

## 7. Depth is a border and a surface, not a shadow

Hierarchy comes from the raised ground and a 1px rule. Shadows are for things
that genuinely float — a popover, a sheet, the composer card. Translucency is
for chrome that content scrolls under, and a light translucent surface never
stacks on another one; when a surface sits over something busy, it gets a scrim,
not more blur.

## 8. The gate

`src/test/contrast.test.ts` computes the ratio of every named pair and fails
under the floor — 4.5:1 for anything a person reads, 4:1 for the two tertiary
tones that carry counts and timestamps and nothing load-bearing.
`src/test/motion-tokens.test.ts` keeps the JS mirror in `src/lib/motion.ts`
locked to the CSS curves.

This section is the one that makes the other seven survive contact with a busy
month. The system this charter comes from had the taste and not the gate, and
the gap it opened is measurable in the table at the top of this file.
