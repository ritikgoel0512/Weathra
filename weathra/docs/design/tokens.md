# The implementation tokens

> Established in task 20.3 of the `weathra-mvp` change. 2026-09-03.

The literal values behind the design system. [`design-system.md`](design-system.md) fixes the
*roles* — what a token is for, and what it must satisfy; this document records the values chosen for
them and why, and `frontend/lib/design/tokens.ts` holds those values as the single source of truth
the stylesheet and the tests both read.

## Where these values came from

The approved artifacts under [`screens/`](screens/) are rendered PNG exports. A pixel sampled from
one is a compression artefact of a mockup, not an approved token, so **no value below was sampled
from an image**. Each is an implementation decision made from the recorded direction — dark-first
Midnight Intelligence, a single cyan accent, five distinguishable data classes, premium analytical
finish — and constrained by the contrast obligation the specs set. Where a value had to move to
meet that obligation, it moved.

Two decisions are therefore recorded as decisions rather than as observations:

1. **The palette is a coherent set that satisfies 4.5:1, not a match of the mockup's pixels.** The
   artifacts establish the *relationships* — a near-black ground, panels a step above it, cyan for
   the one primary action, and five badge hues — and the values below realise those relationships.
2. **Where the mockup and accessibility disagreed, accessibility won**, and the divergence is
   recorded in [`screens.md`](screens.md) §8.

## Colour

Every colour is a semantic token. No component names a colour; it names a role. The dark appearance
is the default (`:root`); the light appearance is the same roles under a
`prefers-color-scheme: light` override, derived rather than designed separately.

| Token | Dark | Light | Role |
|---|---|---|---|
| `surface-base` | `#05080c` | `#f4f7fa` | The page ground |
| `surface-raised` | `#0b121b` | `#ffffff` | Cards and panels |
| `surface-overlay` | `#121b26` | `#ffffff` | Drawers, dialogs, the evidence overlay |
| `surface-inset` | `#070c12` | `#eef2f7` | Wells inside a card: inputs, chart plots, evidence rows |
| `border-subtle` | `#1b2634` | `#dbe2ea` | Card and control edges |
| `border-strong` | `#4e6a86` | `#7d8ea0` | Focus and selection boundary |
| `text-primary` | `#e9eff6` | `#0b141d` | Values and prose |
| `text-secondary` | `#aebccb` | `#3c4c5c` | Labels and secondary text |
| `text-muted` | `#93a3b3` | `#546678` | Attribution, timestamps, provenance |
| `accent` | `#22d3ee` | `#0b6a83` | The one primary action, the active navigation item |
| `accent-strong` | `#67e8f9` | `#08505f` | Its hover |
| `accent-muted` | `#0e7490` | `#0891b2` | De-emphasised accent; never body text |
| `accent-contrast` | `#04121a` | `#ffffff` | The label on the accent |
| `class-observed` | `#34d399` | `#046c4e` | OBSERVED |
| `class-observed-surface` | `#0a2a22` | `#e6f6ef` | its badge ground |
| `class-forecast` | `#7cb2ff` | `#1d4ed8` | FORECAST |
| `class-forecast-surface` | `#0d1c33` | `#e8eefc` | its badge ground |
| `class-historical` | `#fbbf24` | `#8a4b04` | HISTORICAL |
| `class-historical-surface` | `#2b2008` | `#fdf2e0` | its badge ground |
| `class-analytics` | `#a78bfa` | `#6d28d9` | ANALYTICS |
| `class-analytics-surface` | `#1c1633` | `#f0eafd` | its badge ground |
| `class-interpretation` | `#e879f9` | `#a21caf` | AI INTERPRETATION |
| `class-interpretation-surface` | `#2a1030` | `#fbeaf9` | its badge ground |
| `status-error` | `#f87171` | `#b42318` | A failure |
| `status-warning` | `#fb923c` | `#b54708` | Caution |
| `status-ok` | `#4ade80` | `#136f35` | Confirmation |
| `status-quota` | `#c4b5fd` | `#5b21b6` | An exhausted allowance |

Each status also has a `-surface` token, on the same pattern as the data classes.

**The accent is not a data class.** Cyan means "you can act here" — the primary button, the active
navigation item, a link. No data class borrows it, which is why AI INTERPRETATION is fuchsia here
although the mockups render it in cyan: a badge coloured like a button reads as a control.

**The five data classes are separated by hue, and never by hue alone.** Their hues sit at roughly
43°, 160°, 217°, 256° and 292° in the dark appearance, with a minimum separation of about 30°; a
test asserts a 25° floor. On top of that, every badge states its class in words, and the AI
INTERPRETATION badge takes a heavier leading edge — so the closest pair in the set is also the pair
that differs in treatment.

**`status-quota` is deliberately not a shade of red.** An exhausted allowance is not a failure, and
`specs/web-ui` requires it to read as visually and textually distinct from a weather error and from
an expired session.

## Contrast, and how it is verified

`frontend/lib/design/tokens.ts` declares the contrast obligations as data — a foreground, a
background, a minimum, and the reason the pair exists — and `tokens.test.ts` walks all of them in
**both** appearances. WCAG's minima apply as written: 4.5:1 for text, 3:1 for the boundary of a
user-interface component.

The pairs checked: each of the three text levels against all four surfaces; the accent as text on
the ground and on a card; the primary action's label on the accent; the focus boundary against the
ground; each data class on its own badge ground at 4.5:1 and on a card at 3:1, since a class colour
is also a chart series; and each status on its own ground and on a card.

Two values moved to satisfy this, and are recorded because the next person to adjust them should
know they are not arbitrary:

- The dark `border-strong` was lightened to `#4e6a86`; the first choice measured 2.42:1 against the
  ground, below the 3:1 a focus boundary needs.
- The light `status-ok` was darkened to `#136f35`; the first choice measured 4.49:1 on its own
  surface, which is not 4.5:1.

## Typography

Plus Jakarta Sans for display and heading type, Inter for body and UI, loaded through `next/font`
so both are self-hosted — a person opening Weathra makes no request to a font CDN.

| Role | Face | Size | Line height | Weight |
|---|---|---|---|---|
| `display` | Plus Jakarta Sans | 2rem | 1.15 | 600 |
| `heading` | Plus Jakarta Sans | 1.5rem | 1.2 | 600 |
| `section` | Plus Jakarta Sans | 1.125rem | 1.3 | 600 |
| `card` | Plus Jakarta Sans | 0.9375rem | 1.35 | 600 |
| `body` | Inter | 0.9375rem | 1.55 | 400 |
| `ui` | Inter | 0.875rem | 1.4 | 500 |
| `label` | Inter | 0.6875rem | 1.2 | 600, uppercase, 0.08em tracking |
| `meta` | Inter | 0.75rem | 1.45 | 400 |

The record's **Numeric** role is not a size: it is `font-variant-numeric: tabular-nums`, applied
wherever a figure is shown, so a column of values in a comparison table or a period delta does not
wobble as digits change. `heading`, `section` and `card` are the three sizes of the record's single
Heading role.

## Spacing, radius, elevation, motion, layout

| Group | Values |
|---|---|
| Spacing | `--space-1` … `--space-7` = 4, 8, 12, 16, 24, 32, 48 px — the recorded scale, in order |
| Radius | `sm` 4px (badge), `md` 8px (control), `lg` 12px (card), `xl` 16px (overlay), `pill` 999px |
| Elevation | `raised` a 1px hairline shadow, `overlay` a deep one, `focus` a two-layer ring in the accent |
| Motion | 120ms and 200ms on a single easing curve, removed entirely under `prefers-reduced-motion` |
| Layout | 360px floor, 768px compact breakpoint, 1280px wide breakpoint, 248px navigation (64px collapsed), 1440px content maximum |

Elevation is restrained on purpose: a premium analytical surface reads as flat panels separated by a
step of lightness, not as a stack of drop shadows. The dark and light appearances carry different
shadow values — a dark shadow under a white card is a smudge — and those are the only non-colour
tokens the light override redeclares.

## Accessibility, as implemented

- **One focus treatment**, on `:focus-visible` so a pointer click leaves no ring behind: a 2px
  accent outline with a 2px offset. Nothing in the system sets `outline: none`, and a test asserts
  it — over the CSS with its comments stripped, so the rule is checked against declarations rather
  than against prose about the rule.
- **Reduced motion** removes the skeleton shimmer and every transition rather than shortening them.
- **The 360px floor** is held by `overflow-x: hidden` on `html` plus a `weathra-scroll-x` utility,
  so wide content scrolls inside its own container and the page never scrolls sideways.
- **Semantic controls only.** The select is a native `<select>`; tabs are a real tablist with a
  roving tab index and arrow-key selection; every input is label-associated with its description
  and error wired through `aria-describedby`; a loading state announces itself once through a live
  region and its placeholders are hidden from assistive technology.

## What this task did not build

The attribution footer, the uncertainty indicator and the AI-interpretation panel treatment are
task 20.15. The application shell and its navigation are task 20.12. Screen-specific composition is
task group 21. The primitive layer holds `Button`, `Surface`/`Card`, `Badge`/`DataClassBadge`,
`Input`, `Select`, `Tabs`, `Metric`, `Skeleton`, and the loading, empty and error states — and
nothing that belongs to one screen.
