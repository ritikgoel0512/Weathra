# Production fidelity review — the fifteen screens against their artifacts

**Date:** 2026-09-10, third revision · **Reviewer:** Claude Opus 5 · **Method:** screenshots of the
real production build, compared against the approved PNG, one screen at a time.

Captured by `frontend/tests/e2e/capture.spec.ts`, which runs `next build` and drives the shipping
bundle against the two offline stubs. `WEATHRA_SCREENS` takes a subset and `WEATHRA_WIDTHS` a width,
so a targeted check after one change does not re-run the matrix.

**This revision grades harder than the last two, and several rows went down.** The instruction it
was re-run under is the right one: a screen is not close because its sections have similar names,
because the ground is the right dark, or because the route works. It is close when a person looking
at the two images sees the same screen. Where production reads as text and the artifact reads as
graphics, the row says NOT CLOSE however good the reasons are.

**What changed the grades as much as the code did: photographing the screens with content in them.**
Three screens keep their content behind a control — Compare Cities, Travel Intelligence and the
Scenario Lab — and were being photographed in their empty state, which is a picture of nothing. The
harness now presses the control. The stub gained an hourly forecast series and a scenario fixture,
which turned four empty chart frames into charts. Those pictures were the evidence for two earlier
rounds of grading, and they were showing less than the product does.

| Column | Question it answers |
|---|---|
| **Fidelity** | *Visual.* Does the composition read as the artifact's — its regions, hierarchy, density and graphical weight? |
| **Functional** | *Correctness.* Does the screen read the right contract and render every state it can return? |
| **Live data** | *Availability.* Was it photographed with real content, or with what the stub happens to hold? |

CLOSE means a person would recognise the two as the same screen. ACCEPTABLE DIVERGENCE means the
composition matches where Weathra has the data and departs where the artifact draws something this
product does not own, per screen in `screens.md` §5. NOT CLOSE means the artifact is graphical and
production is not, or the composition has not been built.

---

## The table

Graded against the PNG, from the 1440 capture of this revision. A row whose verdict changed says so.

| # | Screen | Fidelity | Functional | Live data | What the capture shows | What is still short of the artifact |
|---|---|---|---|---|---|---|
| 01 | Dashboard | **ACCEPTABLE DIVERGENCE** | correct | full | Photographic hero with the readout over it, confidence matrix with two real bars, anomalies column, seven-day strip, and — new this revision — a populated temperature line and precipitation bars | Column heights differ where one column outruns the other; three voids at desk width. The artifact's station id, neural agent, convergence and reliability figures are refused (§5) |
| 02 | AI Weather Analyst | **NOT CLOSE** | correct | empty state only | Composer, focus/units/depth chips, suggested prompts, run-detail rail — all correct, all empty | The artifact is a populated conversation with an evidence rail beside it. Ours cannot be photographed populated without a live model call, and a screen that has only ever been seen empty is not close to one that is full |
| 03 | Historical Analytics | **ACCEPTABLE DIVERGENCE** | correct | thin | Rebuilt this revision: one combined plot (temperature line, dashed normal, precipitation bars on their own axis), the statistics row, the baseline panel, deviation, period-against-period | The stub's two-day window fills one metric card where the artifact has six, and the left column is short against the baseline column. Both are data, not layout — but the picture is still less dense than the PNG |
| 04 | Compare Cities | **ACCEPTABLE DIVERGENCE** | correct | full | City cards with imagery, ranked bars, the delta chart, the figures matrix | The artifact's synthesis-confidence, correlation-score and data-density bars are refused (§5); no candlestick panel |
| 05 | Agent Evidence | **NOT CLOSE** | correct | empty state only | The seven sections a run's record fills, each an empty card that names what will go in it | The artifact is a populated execution trace with source cards and a grounding panel. Seven empty cards down a page is the right *structure* and nothing like the same screen |
| 06 | Saved Locations | **CLOSE** | correct | full | Cards with the live reading, and — new this revision — the artifact's three labelled chips for precipitation, humidity and wind, allowance meter, workspace summary | No map. The artifact's node-health, telemetry-sync and model-consensus panels are refused (§5) |
| 07 | Settings | **CLOSE** | correct | full | Tabs, segmented unit control, selects, save/discard/reset | Only supported preferences are offered |
| 08 | Authentication | **CLOSE** | correct | full | The centred card on the light ground the artifact uses, mark in its accent tile, one primary action, reveal control, the way out beneath | No photographic backdrop; the accent is the product's teal rather than the artifact's cyan |
| 09 | Admin Model & AI Usage | **CLOSE** | correct | full | Five KPIs, the usage chart with a measure switch, the full-width figures table, product/internal meter, failures, catalog — and, new this revision, the routing panel and the principals-and-plans table | The artifact's composite scores, per-tier headcounts, export and audit controls and status footer are refused (§5). One chart rather than two: the endpoint aggregates a period into groups and returns no time series |
| 10 | Plan & Usage | **CLOSE** | correct | full | Metric tiles, allowance meters, tier list, reset schedule | The whole billing half is refused — no subscription id, interval, payment method, invoice or upgrade, because Weathra bills nobody |
| 11 | Forecast Explorer | **CLOSE** | correct | full | Location band, observed metric row, the temperature chart with its gap drawn as a gap, confidence, computed findings, and the full hour-by-hour matrix | The artifact's ECMWF line, neural agent, convergence and grounding scores, sensor nodes and encryption banner are refused (§5) |
| 12 | Weather Intelligence Report | **NOT CLOSE** | correct | full but for the synthesis | Sectioned report with metric grids and day cards | The artifact is a report with charts through it; ours is mostly figures and prose in cards. The sections are right and the graphical weight is not |
| 13 | Weather Scenario Lab | **CLOSE** | correct | full | New this revision, once the stub modelled the endpoint: the assumption panel, the scenario-against-forecast line chart with the forecast mean as a reference, and the delta cards with the arithmetic named | Inputs are numeric fields rather than the artifact's sliders. Its session id, engine version, station id, stability index and node counts are refused (§5) |
| 14 | Weather Watch | **ACCEPTABLE DIVERGENCE** | correct | full | Summary tiles, the watch list with its three distinct states, the create form, the disclaimer | No graphical weather context beside the list, and no evaluation history — there is no scheduler, so there is no history to draw |
| 15 | Travel Intelligence | **CLOSE** | correct | full | New this revision: the destination photographed, the trip controls, and the ranked day cards with score meters and their contributions | The artifact's flight stability, airline operations, departure boards and booking are refused — Weathra knows none of them |

**Totals.** Visual: 6 CLOSE · 6 ACCEPTABLE DIVERGENCE · **3 NOT CLOSE** · 0 NOT REVIEWED.
Functional: 15 correct. Live data: 11 full, 1 full but for one control, 1 thin, 2 empty-state only.

**The three NOT CLOSE rows are the honest result of grading harder.** Two of them — the Analyst and
Agent Evidence — are screens whose artifact is a populated trace and whose production version has
only ever been photographed empty, because populating either needs a live model call. The third,
the Intelligence Report, has the artifact's sections and not its graphics, and that is a build gap
rather than a data one.

## What the review changed

Photographing the build rather than reading it overturned the first diagnosis. The Dashboard was
assumed to be missing the artifact's composition; it already had every band. What it had instead was
**eight provenance blocks down one page**, each two wrapped lines of bold terms at body size, taking
more vertical space than the figures they described. `specs/web-ui` requires the provider, location,
period and retrieval time wherever weather is shown, so all four stayed — at label weight, as one
middot-separated footnote. That single change in the primitive shortened the page and applied to
every screen at once.

The same method found that Saved Locations displayed `Berlin, Berlin, DE` — the geocoder's
round-trip form, never meant to be read — and carried no weather at all.

**The second revision found three more, and none of them was visible in a component test.**

* The Dashboard's forecast-movement band sat in a two-column grid with nothing beside it, leaving a
  third of the row empty at every desk width. An empty column reads as a panel that failed to load,
  which is worse than a panel that was never there.
* The administrative screen pushed the whole document sideways — 112 pixels at 1440, 925 at 375.
  Two causes, and the second is the one worth writing down: `ScrollRegion` supplies no box of its
  own, so a caller that passes no container gets a table that widens the page; and a bare
  `display: grid` creates an implicit `auto` track, which is sized to *max-content*, so the band grew
  to the widest cell inside it and overflowed its own container. Every `min-width: 0` in that
  stylesheet was already correct and none of them could have helped, because each item was exactly
  the size its track told it to be. `design-system.md` §13 now states both rules.
* The nine-column usage table lived inside a card two thirds of a row wide, so it scrolled at the
  width the artifact is drawn at. It has the full width the artifact gives it.

The overflow check now runs on every capture, at every width, and prints the screen and the number
of pixels. It is what found the second of those and what would find a fourth.

**The rail was clipping a product name, and that was not acceptable.** At 1280 and above it
rendered `Weather Intelligence Re…`. The first response was to reconcile the two contradictory
comments in the stylesheet and record the truncation as deliberate; that was the wrong call, and
the fix is the rail rather than the label. `--layout-navigation-width` is 272px, which leaves about
210px of label room against the 197px the longest entry needs, so every destination now states its
own full name on one line at every desk width — Forecast Explorer, Weather Intelligence Report,
Weather Scenario Lab, Weather Watch, Travel Intelligence, Plan & Usage, Model & AI Usage. Nothing is
ellipsis-clipped at any tier: between 768 and 1279 the same element is the hover and focus tooltip
carrying the full name, and below 768 the drawer is the full width. `design-system.md` §5's rule
against omitting, abbreviating or renaming an entry now holds visually as well as semantically.

**Two panels lost rows.** The Dashboard's confidence matrix and Historical's deviation analysis each
carried bars for metrics Weathra does not compute — model convergence, provider reliability,
precipitation lag, atmospheric instability — drawn empty with the reason stated. Kept, they named a
capability in order to deny it, which is internal reasoning on a customer's screen. Each panel now
carries only the rows that carry figures, and `lib/design/product-copy.test.ts` refuses the names.

## The standing rule about the artifacts

Every screen's divergences are refusals of content Weathra does not have, and they are recorded per
screen in `screens.md` §5 and §8 rather than discovered per reviewer. The pattern across all
fifteen is one thing: the artifacts draw an infrastructure — sensor networks, named forecast models,
neural agents, convergence percentages, encryption banners, node counts — that this product does not
own. Weathra reads one weather provider and one model gateway. Where a panel's slot is real and its
content is not, the slot is filled with what Weathra actually knows; where the whole panel is
invented, it is absent rather than styled out of sight.

## What this revision did not reach

Named so the next pass starts from a list rather than from a re-read:

* **The Analyst and Agent Evidence populated states.** Both need a live model call. Until one is
  made and photographed, neither can be graded above NOT CLOSE, and neither should be.
* **The Intelligence Report's graphics.** It has the artifact's sections and the artifact's figures;
  what it does not have is the artifact's charts through them.
* **Column balance on the Dashboard and Historical.** Both draw a two-column band where one column
  outruns the other, and at desk width that reads as a void. Rebalancing against the stub's thin
  window would misplace the panels against a real one, so it wants a populated capture first.
* **A responsive re-run.** This revision graded at 1440. The four-width pass of the previous
  revision still stands for the screens it covered, but the screens rebuilt here have been
  photographed at one width only.

## Known limits of this review

* **Populated states for the Analyst and Agent Evidence need a live model run** and were not
  captured. Both screens are photographed in the state a person sees before they ask anything.
* **The stub's data is thinner than production's**, so empty states appear more often here than a
  person with real saved places would see. Two of them are worth naming, because they change what a
  reader should conclude from the pictures: the stub's forecast carries no hourly series, so the
  Dashboard's Climate pulse and Precipitation outlook both photograph as empty chart frames rather
  than as plots. The frames are the point — the geometry is preserved and the reason is stated —
  but the populated version of those two panels is not evidenced here.
* **Chromium only.** The suite runs Firefox too; the captures are one engine.
* **The 375 captures are a phone width, not a phone.** No touch target was measured, and no gesture
  was tested.
* **The navigation drawer is not in any photograph.** Below 768 the rail only exists once its Menu
  control is pressed, and the captures are taken unopened. That the drawer carries each entry's
  complete name follows from its width — the full 272px — and from the rule that labels wrap rather
  than clip, which `tests/design-rules.test.ts` holds; it is not evidenced by an image here.
