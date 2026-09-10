# Production fidelity review — the fifteen screens against their artifacts

**Date:** 2026-09-10 (revised the same day) · **Reviewer:** Claude Opus 5 · **Method:** screenshots
of the real production build, not source reading.

**All fifteen screens are photographed, at four widths each** — 1440, 1024, 768 and 375 — by
`frontend/tests/e2e/capture.spec.ts`, which runs `next build` and drives the shipping bundle against
the two offline stubs the browser suite already uses. Every line of Weathra in the path is the one
that deploys; only Supabase Auth and the FastAPI backend are stood in for. Run it with
`WEATHRA_CAPTURE=true npx playwright test capture.spec.ts --project=chromium`, or one width with
`WEATHRA_WIDTHS=1440`.

The first revision of this review judged two screens from source rather than a photograph. Both are
now photographed: the administrative screen, once the stub modelled the administrative reads, and
Authentication, which every other capture signs *through* and which is therefore taken before the
session exists.

**The classification is about composition, not existence.** A route that resolves is not CLOSE. A
screen is CLOSE when its regions, hierarchy and graphical weight read as the artifact's; ACCEPTABLE
DIVERGENCE when it differs for a recorded reason — almost always because the artifact draws
something Weathra does not have; NOT CLOSE when the artifact's own composition has not been built;
NOT REVIEWED when no photograph of it has been looked at.

**Three questions, kept apart.** A screen can be a faithful rendering of its artifact, be wired to
the right endpoint, and still be photographed with nothing in it — and calling that one verdict
hides which of the three is the problem. So the table's `Fidelity` column answers only the first,
and two further columns answer the others:

| Column | Question it answers |
|---|---|
| **Fidelity** | *Visual.* Does the composition read as the artifact's — its regions, hierarchy and graphical weight? |
| **Functional** | *Correctness.* Does the screen read the right contract and render every state it can return, refusals and empty states included? |
| **Live data** | *Availability.* Was it photographed with real content, or with what the offline stub happens to hold? |

A screen marked CLOSE / correct / stub-thin is finished work whose picture understates it. One
marked CLOSE / correct / full needs nothing.

---

## The table

| # | Screen | Route | Artifact | Fidelity | Functional | Live data | Real data | Graphical components | Deliberate divergence | Remaining |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | Dashboard | `/` | `01-dashboard.png` | **ACCEPTABLE DIVERGENCE** | correct | stub-thin — no hourly series, so two panels photograph as empty frames | current, forecast, changes, analysis, baseline, saved locations | Photographic hero, metric cluster, confidence meters, day strip, intra-day chart, baseline chart | Station id, neural agent version, model-convergence and data-reliability bars, integrated-risk index, system hash, version string — none exist, and as of this revision the two invented confidence bars are **absent rather than drawn empty** | Column heights differ where one column's content outruns the other's. With the stub's thin forecast that reads as a void; the panels involved are the two that need an hourly series, so the imbalance is a property of the data in the photograph rather than of the layout |
| 02 | AI Weather Analyst | `/analyst` | `02-ai-weather-analyst.png` | **ACCEPTABLE DIVERGENCE** | correct | empty state only — a populated run needs a live model call | agent run, evidence, memory | Composer with focus/units/depth chips, suggested prompts, run-detail rail | No agent version string; no History control, since no screen lists threads | Populated state not photographed — it needs a live model call |
| 03 | Historical Analytics | `/historical` | `03-historical-analytics.png` | **CLOSE** | correct | stub-thin — some statistics report as not computable | archive observations, deterministic analytics, baseline, period comparison | Two Recharts charts (line + bars), KPI cards, z-score, deviation meter, CSV export | Two charts rather than one dual-axis; no WMO/ERA5 badge | "Not computable" cards are the stub's thin data, not a defect |
| 04 | Compare Cities | `/compare` | `04-compare-cities.png` | **ACCEPTABLE DIVERGENCE** | correct | empty state only — the ranking is requested on demand, and was not run | `/weather/comparison` ranking with supporting statistics | City cards, ranked bars, delta chart | Synthesis-confidence, correlation-score and data-density bars refused; candlestick panel refused | Historical comparison per city not surfaced |
| 05 | Agent Evidence | `/evidence` | `05-agent-evidence.png` | **ACCEPTABLE DIVERGENCE** | correct | empty state only — a populated trace needs a live run | stored agent run: steps, tools, citations, grounding | Execution timeline, source cards, grounding panel | No audit hash, no signature, no stability index, no invented station ids | Only the empty state photographed; a populated trace needs a live run |
| 06 | Saved Locations | `/locations` | `06-saved-locations.png` | **CLOSE** | correct | full — two saved places with live conditions | saved locations, `/weather/current` per card | Cards with live conditions, allowance meter, workspace summary | No map | — |
| 07 | Settings | `/settings` | `07-settings.png` | **CLOSE** | correct | full | preferences, saved locations | Tabs, segmented unit control, selects, save/discard/reset | Only supported preferences are offered | — |
| 08 | Authentication | `/sign-in` | `08-authentication.png` | **CLOSE** | correct | full — the form is the screen | Supabase Auth | Centred card on the light ground the artifact uses, mark in its accent tile, one primary action, reveal control on the password field, the way out beneath the card | No plan selection at signup: a plan is not an identity. No **Remember me**: the session's lifetime is Supabase's, and a checkbox that changed nothing would be a control that lies. No photographic backdrop | The card's own layout matches; the accent is the product's teal rather than the artifact's cyan, which is a brand question `fidelity-review.md` leaves to the owner |
| 09 | Admin Model & AI Usage | `/admin/model-usage` | `09-admin-model-ai-usage.png` | **CLOSE** | correct | full — stub fixtures shaped as `/admin/usage` returns, nulls included | `/admin/usage` aggregates, catalog with observations, comparison runs, policy audit | Five KPI cards, usage chart with a measure switch, full-width figures table, product/internal meter, failures panel, catalog table, policy confirmation | Fictional model rows, composite scores, per-tier headcounts, export and audit-report controls, operational-status footer — all refused. One chart rather than two, because the endpoint aggregates a period into groups and returns no time series | A time series would need a per-day aggregate the backend does not compute |
| 10 | Plan & Usage | `/plan` | `10-plan-usage.png` | **CLOSE** | correct | full | `/me/usage`: plan, per-dimension allowance, reset windows, recent activity | Metric tiles, allowance meters, tier list, reset schedule | The whole billing half refused — no subscription id, interval, payment method, invoice or upgrade; no per-day chart, because `recent` is a summary and not a series | — |
| 11 | Forecast Explorer | `/explorer` | `11-forecast-explorer.png` | **CLOSE** | correct | full | current, forecast, analysis | Metric row, horizon control, forecast chart, hourly matrix | ECMWF source line, neural agent, convergence/alignment/grounding scores, reliability card, sensor nodes, encryption banner — none exist | — |
| 12 | Weather Intelligence Report | `/report` | `12-weather-intelligence-report.png` | **ACCEPTABLE DIVERGENCE** | correct | full except the synthesis, which is a control and was not pressed | current, forecast, changes, analysis, baseline, agent | Sectioned report, metric grids, day cards | Synthesis is a control, not a page-load model call; no agent version, no evidence-node count, no PDF export | Fewer charts than the artifact |
| 13 | Weather Scenario Lab | `/scenarios` | `13-weather-scenario-lab.png` | **ACCEPTABLE DIVERGENCE** | correct | full | `/weather/scenario` over a real forecast | Assumption inputs, scenario chart, delta cards | Session id, DELTA-INFERENCE-V4, station id, stability index, inference confidence, simulation engine, what-if deltas, report export, correlation model, node counts — none exist | Inputs are numeric fields rather than the artifact's sliders |
| 14 | Weather Watch | `/watch` | `14-weather-watch.png` | **CLOSE** | correct | full — three watch states, including no-reading | `weather_watches` + forecast evaluation | Summary tiles, watch list with three distinct states, create form | Watch engine, monitoring nodes, recalibration, sensor telemetry, push alerts, live status light — Weathra has no scheduler and sends nothing | No graphical weather context beside the list |
| 15 | Travel Intelligence | `/travel` | `15-travel-intelligence.png` | **ACCEPTABLE DIVERGENCE** | correct | full | `/weather/comparison` day ranking with contributions | Ranked day cards, score meters, contribution disclosure | Flight stability, airline operations, departure boards, booking, sensor telemetry, model convergence — Weathra knows none of them | No destination hero imagery |

**Totals.** Visual fidelity: 8 CLOSE · 7 ACCEPTABLE DIVERGENCE · 0 NOT CLOSE · 0 NOT REVIEWED.
Functional correctness: 15 correct. Live data in the photographs: 9 full (06, 07, 08, 09, 10, 11,
13, 14, 15), 1 full but for one control nobody pressed (12), 2 thin (01, 03) and 3 photographed in
their empty state (02, 04, 05).

Every ACCEPTABLE DIVERGENCE is a refusal of content Weathra does not have, recorded per screen in
`screens.md` §5. None is an unbuilt composition.

---

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
