# The Weathra design system

> Recorded in task 19.1 of the `weathra-mvp` change. Approved 2026-09-03.

The shared system every Weathra screen is built from. It was refined in **Visily.ai** and seeded
from the design direction carried forward from the earlier UXPilot exploration, which is recorded
with its origin in [`README.md`](README.md). Screens are implemented by hand in Next.js against
this record — an approved Visily screen is a visual reference, not a code source.

This record is the reference for tasks 20.3 (tokens and primitives), 20.12 (the shell), 20.15 (the
presentation primitives), and every screen in group 21.

## 1. Appearance and palette

**Midnight Intelligence**, with **cyan** as the single accent, for the product; the
authentication shell is **light**. Both come from one token set, and **neither is chosen by the
visitor's system**.

That last part is the correction. The appearance used to follow `prefers-color-scheme`, which meant
an operator whose machine reported light was served a *Dashboard* in a palette none of the seven
product artifacts depicts. The appearance now follows the screen, which is what the artifacts
specify: `:root` is Midnight Intelligence, and the `(auth)` route group sets
`data-appearance="light"` because `08-authentication.png` is drawn there.

Colour is carried entirely by semantic tokens. No screen picks a colour; it picks a role.

| Token role | What it carries |
|---|---|
| `surface-base` | The page ground — the darkest level in the dark appearance |
| `surface-raised` | Cards and panels sitting on the ground |
| `surface-overlay` | Drawers, dialogs, popovers, and the evidence overlay |
| `surface-inset` | Wells inside a card: code, evidence rows, chart plot areas |
| `border-subtle`, `border-strong` | Card and control edges; the strong variant for focus and selection |
| `text-primary`, `text-secondary`, `text-muted` | The three-level text hierarchy: value, label, provenance |
| `accent`, `accent-muted` | The cyan accent: primary action, active navigation, series emphasis |
| `class-observed`, `class-forecast`, `class-historical`, `class-analytics`, `class-interpretation` | The five data classes (§9) — the badge, the chart series, and the card edge all read from these |
| `status-error`, `status-warning`, `status-ok`, `status-quota` | Failure, caution, confirmation, and an exhausted allowance |
| `status-error-solid`, `status-error-on-solid` | The fill and label of an urgent destructive action, where `status-error` is a text colour and too light to fill a button |

The approved artifacts under [`screens/`](screens/) show the appearance these tokens produce: a
near-black ground, panels raised a step above it, a single cyan accent carrying the primary action
and the active navigation item, and five visually distinct badge treatments for the data classes.

**The exact values are not established here.** They are not sampled from the exports either — a
pixel read off a rendered mockup is not an approved token. Task 20.3 established them from this
recorded direction, verified against the contrast requirement below; they are recorded in
[`tokens.md`](tokens.md) and held in code by `frontend/lib/design/tokens.ts`, which the stylesheet
and the tests both read.

**Constraints on the values.** Body text meets 4.5:1 against its surface in *both* appearances;
the five data-class tokens are distinguishable from one another without relying on hue alone (each
pairs with a distinct badge label and, where it is a chart series, a distinct stroke treatment);
`status-quota` is not a shade of `status-error`, because an exhausted allowance is not a failure.

The accent is used sparingly — one primary action per view, the active navigation item, and
emphasis on the series a view is about. It is never the colour of a data class.

## 2. Typography

**Plus Jakarta Sans** for display and headings. **Inter** for body and UI. Both are loaded with a
real fallback stack; neither is used outside its role.

| Role | Face | Use |
|---|---|---|
| Display | Plus Jakarta Sans | The one screen-level title per view |
| Heading | Plus Jakarta Sans | Section and card titles |
| Body | Inter | Prose, answers, explanations |
| UI | Inter | Controls, inputs, table content, navigation |
| Label | Inter, uppercase, tracked | Data-class badges, field labels, axis labels |
| Meta | Inter, small | Attribution, timestamps, provenance, units |
| Numeric | Inter, tabular numerals | Every measured or computed figure |

Tabular numerals on every figure are not decoration: comparison tables, period deltas, and ranked
results are read down a column, and proportional digits make a column of numbers wobble.

## 3. Spacing and density

A 4-pixel base scale — 4, 8, 12, 16, 24, 32, 48 — with card padding at 16 and section separation
at 24. The intent is **compact and information-dense**: a card shows its figure, its class, its
provenance, and its supporting detail without a scroll, and a screen shows several cards without
the page becoming a list of tall boxes. Density is achieved by tightening space, never by removing
a data class, an attribution, or an uncertainty statement.

## 4. Component hierarchy

```
App shell  (persistent left navigation + page region)
└── Page header      title, location context, unit context, primary action
    └── Card         one subject: a measurement, a period, a comparison, a run
        ├── Card header      title + data-class badge
        ├── Card body        value readout, chart, table, or prose
        └── Attribution      provider, location, period, timestamps, uncertainty
```

The primitives every card is assembled from, and which task 20.15 implements:

- **Data-class badge** — one of the five labels of §9, with its token colour.
- **Value readout** — a figure with its unit, and its precision fixed by the source rather than by
  the component.
- **Attribution footer** — provider or source, location, period.
- **Timestamp pair** — when the data was retrieved, and the time it is valid for.
- **Uncertainty indicator** — the confidence or range, with its stated basis.
- **Interpretation panel** — the visually distinct treatment for AI-written text (§9).
- **Provenance line** — for a computed figure, the deterministic method that produced it.
- **State blocks** — the loading, empty, and error patterns of §11.
- **Chart frame** — the shared axis, legend, grid, and container treatment of §7.

A screen composes primitives. It does not restyle them.

## 5. Navigation — the Intelligent Command Center shell

A **persistent left navigation**, present on every protected screen, identifying the signed-in
person and carrying the sign-out control. The page region to its right holds one screen.

The navigation carries twelve entries, in this order:

| # | Entry | Status |
|---|---|---|
| 1 | Dashboard | MVP |
| 2 | AI Weather Analyst | MVP |
| 3 | Forecast Explorer | Post-MVP — marked not yet available |
| 4 | Historical Analytics | MVP |
| 5 | Compare Cities | MVP |
| 6 | Weather Intelligence Report | Post-MVP — marked not yet available |
| 7 | Weather Scenario Lab | Post-MVP — marked not yet available |
| 8 | Agent Evidence | MVP |
| 9 | Weather Watch | Post-MVP — marked not yet available |
| 10 | Travel Intelligence | Post-MVP — marked not yet available |
| 11 | Saved Locations | MVP |
| 12 | Settings | MVP |

This is the official navigation. Two corrections it embodies:

- **The mockups' sidebar labels are incomplete and are not the source.** Every artifact under
  [`screens/`](screens/) shows a four-item sidebar — Dashboard, Analytics, Historical Data,
  Settings. Where a mockup's sidebar omits an entry, abbreviates one, or names one differently,
  this table wins. A Dashboard section may not be titled *Forecast Explorer* either, however the
  mockups label theirs: that name belongs to a post-MVP screen.
- A post-MVP entry is **present and visibly marked as not yet available**, never hidden and never
  presented as working. `specs/web-ui` requires the routing structure to be real and the route to
  say plainly that the screen is not built; the navigation says the same thing in the same words.

The paths behind all twelve already exist in `frontend/lib/routes.ts` as `MVP_SCREENS` and
`POST_MVP_SCREENS`. Task 20.12 composes the single ordered navigation list above from those two
constants; the split in code is the authentication and status boundary, not the display order.

The **Admin Model & AI Usage** (`/admin/model-usage`) and **Plan & Usage** (`/plan`) screens are not
in the navigation in this change. They are recorded in [`roadmap.md`](roadmap.md) and reached only
by their routes, which state that they are not yet available and issue no request. They are
declared as `UNLISTED_SCREENS` rather than as `POST_MVP_SCREENS` for exactly that reason: the
navigation list above is composed from the other two constants and is asserted to cover them
completely, so a screen placed in either would appear in the sidebar. The difference between the
lists is *listed* against *reachable*, not built against unbuilt — all seven post-MVP screens are
equally unbuilt.

**Responsive behavior** of the shell is in §13.

## 6. Cards

A card has one subject. Its anatomy is fixed:

1. A title, and a **data-class badge** — no card mixes two classes in one body; a card that needs
   two shows two blocks, each badged.
2. The body: a value readout, a chart, a table, or prose.
3. The **attribution footer** — never optional, never collapsed behind a control, never replaced by
   a tooltip. Provider, location, period, retrieval time, validity time, and for a forecast its
   uncertainty.

Compact by default: a card is sized to its content, and a card with nothing to show renders its
empty state (§11) rather than an empty frame.

## 7. Charts

Recharts, inside the shared chart frame (design.md decision 18).

- **Series encode data class.** Observed, forecast, and historical series are distinguishable by
  stroke treatment as well as colour — a solid observed line, a distinct forecast stroke, a
  historical or baseline series treated as reference rather than as a peer.
- **Uncertainty is drawn, not implied.** A forecast series carries its range or band; a band with
  no stated basis is not drawn.
- **Baselines are labelled with the years they cover.** A multi-year baseline states its span.
- **No interpolation that invents data.** A gap in a series is a gap. Smoothing that would imply
  observations between measurements is not applied.
- **Axes are labelled with their units**, and units follow the signed-in person's preference (§10).
- **Wide charts scroll in their own container**, never the page (§13).
- A chart's figures are also available as text or a table, so a value is never only a pixel.

## 8. Weather visualization patterns

| Pattern | Treatment |
|---|---|
| Current conditions | A primary value readout with its condition, badged **Observed**, timestamped with its observation time |
| Forecast window | A per-period series or row set badged **Forecast**, each period carrying its uncertainty |
| Temperature range | High and low as a paired readout or range bar, never a single averaged figure |
| Wind | Speed in the person's chosen wind unit, with direction as a labelled bearing — the arrow is never the only carrier |
| Precipitation | Probability and amount shown as distinct quantities with distinct units; a probability is never rendered as an amount |
| Historical series | Badged **Historical**, with its period and its source archive stated |
| Baseline comparison | The subject period against the baseline, both labelled, the baseline naming its years |
| Anomaly | A departure from a stated baseline, badged **Analytics**, with the method and the baseline named |
| Threshold exceedance | The threshold, the count or dates, and the comparison operator, badged **Analytics** |
| *What Changed?* | The delta between the current forecast and the last captured snapshot, both timestamps shown; with no prior snapshot it renders its empty state saying so, never a zero delta |

## 9. Data classes, provenance, and the line the language model does not cross

Five classes. Each is a presentational primitive, not prose, and every figure on screen carries
exactly one:

| Badge | What it means | Where it comes from |
|---|---|---|
| **OBSERVED** | A measurement of what happened | A weather provider through the MCP layer |
| **FORECAST** | A modelled future value, with uncertainty | A weather provider's forecast model |
| **HISTORICAL** | A retrieved past value | A historical archive |
| **ANALYTICS** | A figure computed deterministically from retrieved values | Weathra's analytics engine |
| **AI INTERPRETATION** | Language written about the figures above | The language model |

The rules the design carries so no screen has to remember them:

- **Numerical analytics are deterministic.** Every figure badged **Analytics** was computed by
  Weathra's analytics engine, and the method that produced it is named in its provenance line.
- **The language model does not produce a numerical weather value, and nothing in the interface may
  suggest it does.** Interpretation is visually distinct — its own panel treatment and its own
  badge — and it sits beside the figures it discusses rather than presenting them.
- **Attribution, timestamps, and uncertainty are preserved.** Provider, location, and period on
  every weather-bearing surface; retrieval and validity times shown rather than implied; confidence
  presented with its basis, neither omitted nor overstated.
- **A source is a real source.** The provider, model, and source names on screen are the ones the
  backend actually reports for the configured provider and MCP tools. See §15.

## 10. Memory in the interface

Weathra has **two** memory tiers, and both surface in the UI. Neither may be simplified away or
folded into the other.

**Short-term memory — LangGraph thread-scoped conversational continuity.** It is what makes a
follow-up question mean something. In the interface:

- The **AI Weather Analyst** holds a thread. A follow-up resolves against the preceding turns —
  the location, units, window, criterion, and data class already established — without restating
  them.
- The thread is visible as a thread: earlier turns remain on screen with their answers and their
  data-class labels intact.
- When the memory store is unavailable, the Analyst says that conversation context is unavailable
  rather than silently answering a follow-up without it; the stateless screens stay usable.
- **Settings** carries the session-memory deletion control, with a confirmation step.

**Long-term memory — durable user preferences only.** Explicitly chosen, non-sensitive
preferences, owned by the signed-in person. In the interface:

| Preference | Surfaces on |
|---|---|
| Temperature unit | Settings; applied on every screen showing a temperature |
| Wind-speed unit | Settings; applied on every screen showing wind |
| Default location | Settings; the Dashboard opens on it |
| Saved locations | Saved Locations — list, add, remove; offered as choices on every location entry |
| Default forecast range | Settings; the opening horizon on the Dashboard and Forecast surfaces |
| Display preferences the person explicitly sets | Settings, alongside the above |

Nothing is inferred into long-term memory from behavior. A location a person merely looked at is
not saved. Preferences persist across sessions and devices, and Settings can read, change, and
delete them.

## 11. Loading, empty, error, and the other honest states

Every view has four resolutions — `loading | empty | error | ready` — and they are visually
distinct from one another:

- **Loading** — distinct from empty, and the submit control is disabled while a request is in
  flight so the same request is not issued twice.
- **Empty** — says what to enter or what is not yet there. An empty result is never dressed as a
  successful answer.
- **Error** — shows the backend's message, and offers a retry that needs no page reload.
- **Ready** — the populated state.

Beyond the four:

| State | Treatment |
|---|---|
| Stream interrupted | Shows what was received, states plainly that the run did not complete, offers a retry |
| Agent unavailable | The Analyst states it is unavailable and names the missing configuration; every non-agent screen stays fully usable |
| Allowance exhausted | A distinct state naming the limit and when it resets — visually and textually separate from a weather error and from an expired session, with the person's thread, saved locations, and preferences left intact |
| Expired session | Returns the person to sign-in with an expired-session message, never surfaced as a data error |
| Ambiguous location | Presents the candidate places and shows no weather data until one is chosen |
| Not yet available | The post-MVP treatment: the screen says plainly it is not built, and renders nothing broken or empty |
| Not permitted | The administrative treatment: a not-available state that fetches no administrative content |

## 12. The authentication shell

**One shell, one design system.** All eight authentication screens share a single centred shell on
the Midnight Intelligence ground: the Weathra mark, a title, one short line of context, the form,
one primary action in the accent, and the secondary route out (to sign-in, to create an account, to
resend). The Visily authentication screen is the visual reference for this shell; the screens
themselves are the full set `specs/authentication` requires:

Sign In · Create Account · Verify Email / Enter Verification Code · Verification Successful ·
Verification Failed / Expired Code · Resend Verification Code · Forgot Password · Reset Password.

The artifact of record is [`screens/08-authentication.png`](screens/08-authentication.png),
approved as the shell for all eight screens. It is rendered in a **light** appearance, which the
implementation does not reproduce: §1 records that Weathra ships Midnight Intelligence only, and the
artifact is the reference for this shell's structure, spacing and control treatment. Everything the
artifact fixes about the shell — the centred card, the mark and wordmark above it, the display title
with one line of context, the labelled fields, the trailing visibility control, the secondary route
beside the field group, the single full-width primary action in the accent, and the route out
beneath the card — is reproduced from the product's own tokens.

Shell rules:

- Password rules are stated **before** submission, not revealed by a rejection.
- A failure is **non-disclosing**: an unknown email and a wrong password produce the same message,
  and a reset request answers identically for a known and an unknown address.
- **Incorrect** and **expired** are different states with different wording and different actions.
- A resend has three states: in progress, confirmed, and rate-limited.
- Verification has two entry paths and one concept: a code entered in the shell, or a returning
  link handled by a route handler that lands on the same success state.
- Every screen renders in the shell's loading, error, and success states rather than in a bespoke
  one.

## 13. Responsive behavior

| Width | Shell |
|---|---|
| ≥ 1280px | Full left navigation at 272px, every entry's complete name on one line; multi-column card grid |
| 768–1279px | Left navigation collapsed to 64px of icons, the complete name as the hover and focus label; two-column grid |
| < 768px | Navigation in a drawer behind a labelled control, at the full 272px; single column |

**A destination is never abbreviated to fit.** §5 is the official navigation precisely because the
mockups' sidebars omit, abbreviate or rename entries, so the rail is sized to the longest real name
— `Weather Intelligence Report`, about 197px of label — rather than the name being clipped to the
rail. It shipped ellipsis-clipped until the 1440 capture of 2026-09-10 showed
`Weather Intelligence Re…`; `tests/design-rules.test.ts` now refuses both the ellipsis and a rail
narrower than the name needs.

The floor is a **360-pixel** viewport, usable, with **no horizontal page scroll**. Wide content —
comparison tables, historical charts, evidence rows — scrolls **inside its own container**. Cards
reflow rather than shrinking their type below the body size, and an attribution footer wraps rather
than truncating: provenance is not the thing that gets dropped when space runs out.

**Two rules make "inside its own container" actually hold**, and the responsive pass of 2026-09-10
found a screen breaking both while every `min-width: 0` in its stylesheet was correct.

1. **`ScrollRegion` supplies no box.** It measures its container and adds the keyboard tab stop when
   there is something to reach; the *screen* supplies the `overflow-x: auto` container. A caller
   that passes no `className` gets a plain `div`, and its table widens the page.
2. **A single-column grid needs `grid-template-columns: minmax(0, 1fr)` written out.** The implicit
   track a bare `display: grid` creates is sized `auto`, which means max-content — so the band grows
   to the widest thing inside it and overflows its own container. No amount of `min-width: 0` on the
   items corrects this, because each item is already exactly the size the track told it to be. The
   track is what has to be capped.

The capture harness logs any screen whose document is wider than its viewport, at each of the four
widths, which is how both were found and how a third would be.

A container that scrolls is **reachable from the keyboard while it has something to scroll**, and
not otherwise. `ScrollRegion` is the primitive: it measures its own overflow and becomes a named,
focusable group only when there is content past an edge. Both halves of that are the requirement.
An `overflow-x: auto` div that is never focusable satisfies "scrolls in its own container" and
leaves everything past the right edge unavailable to anybody without a pointer; one that is
*always* focusable puts an empty stop in the tab order of every screen that happens to fit. Note
that `overflow-x: auto` computes the **other** axis from `visible` to `auto`, so such a container
scrolls vertically too the moment its content is a few pixels too tall — which is a scrollable
region on a screen nobody thought had one. Task 21.8 found exactly that, twice.

## 14. Accessibility

Keyboard operation of every action on every screen, authentication and product alike. Every input
labelled; every interactive control carrying an accessible name. A visible focus indicator using
`border-strong`, never `outline: none`. Body text at 4.5:1, verified against these tokens rather
than per component. Data class is never carried by colour alone — the badge
label carries it. Charts do not rely on hover to disclose a value. A scrollable container is a tab
stop while it scrolls, per §13.

Verified on **two engines** — Blink and Gecko — by rule (axe-core, WCAG 2.0/2.1 A and AA plus 2.2
AA) and by hand-written assertion, because neither instrument subsumes the other: a rule engine
cannot know that Weathra must not preselect a location candidate, and a hand-written assertion only
checks what somebody thought to check. The record is
[`accessibility.md`](accessibility.md).

## 15. Corrections carried out of the Visily mockups

The approved artifacts under [`screens/`](screens/) are visual references. Their sample content is
not. The general rule is below; the specific item-by-item record, per screen, is
[`screens.md`](screens.md) §5, and a reviewer comparing an implemented screen against its artifact
in task 21.9 reads that record first.

The following came from mockup filler and is **not** implemented:

- **Mock provider names** and **invented meteorological source names** — attribution shows the
  actually configured weather and geocoding providers, as the backend reports them.
- **Fake station identifiers** — Weathra shows the location and period it actually queried.
- **Fake neural-agent version strings** — the four agents are named as `docs/agents.md` names them;
  no version string is displayed that the backend does not report.
- **Crypto, audit-chain, and tamper-proof wording** on Agent Evidence — the evidence record is a
  run record: agents, tool calls and results, analytics methods, cited knowledge, and timings. It
  is not presented as an audit chain or a cryptographic proof.
- **Model-recalibration controls** — no screen offers to retrain, recalibrate, or tune a weather
  model. Weathra retrieves from providers and computes deterministically.
- **Sample copy** — replaced with grounded, user-facing language that says what the screen actually
  does.

The two model-policy artifacts of 2026-09-09 added a class of invention the MVP eight did not, and
it is the one to watch hardest, because it describes a commercial relationship rather than the
weather:

- **Billing, payment and subscription content** — a subscription identifier, a billing interval, a
  next billing date, a payment method, an invoice download, "Manage Payment Information" and
  "Upgrade Plan". None is implemented. This change assigns plans administratively and bills nobody;
  `subscription_plans` carries an unused external reference so a payment integration has somewhere
  to land later, and drawing a card on a screen would invent the relationship it implies.
- **An enterprise tier** — the canonical plans are FREE, PRO and PREMIUM, and there is no fourth.
- **Infrastructure presented as a person's quota** — vector-storage nodes with a limit, a node
  cache to clear, API rate limiters. The vector store is one retrieval index behind an interface;
  it is not a per-person allowance and is not administered from a plan screen.
- **Cross-user usage** — a per-user token-consumption export "for departmental cost attribution".
  A person's own usage view shows their own usage: no other person's, no internal usage, no
  aggregate cost across users.
- **Invented model names, scores and audits** — "WEATHRA-CORE-V5.0-BETA", a "reasoning score", a
  "cost efficiency" percentage, "Full Reliability Audit". Model selection is made on the five
  recorded criteria of `docs/evaluation.md`; Weathra trains no model and versions none.
- **Fabricated operational banners** — "All services operational", "Estimated cost synced",
  "Encryption: 256-AES", "Telemetry sync: stable", `LOCKED`. A screen that did not check may not
  report.

Where a mockup implies the language model produced a measurement, the implementation does not
follow it (§9).

## 16. Departures from the carried-forward direction

None. Every decision carried forward from the UXPilot exploration and recorded in
[`README.md`](README.md) is present in this system:

| Carried-forward decision | Where it lives here |
|---|---|
| Midnight Intelligence palette | §1 |
| Plus Jakarta Sans + Inter, with their roles | §2 |
| Intelligent Command Center shell, persistent left navigation | §5 |
| Location-focused Dashboard | §5, and [`screens.md`](screens.md) |
| Premium modern SaaS finish | §1, §3, §6, §7 |
| Weathra Intelligence, What Changed?, Why?, Agent Evidence | §8, [`screens.md`](screens.md) |
| The five-way data-class distinction | §9 |
| Source attribution | §6, §9 |
| Timestamps | §6, §8, §9 |
| Uncertainty and confidence presentation | §7, §8, §9 |
| No implication that the model predicts numerical weather | §9, §15 |

A later departure from any of them is recorded in this section with its reason, in the same way a
screen-level divergence is recorded in [`screens.md`](screens.md).

## 17. What this system deliberately does not decide

The backend is the sole authority on plan, entitlement, model resolution, and allowance. Hiding or
disabling a control is a presentation convenience; it is never the gate. Where an answer reports
the provider, model, and policy that served it, the interface shows what was reported rather than
what it assumed.
