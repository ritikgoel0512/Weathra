# Production fidelity review — the fifteen screens against their artifacts

**Date:** 2026-09-11, fourth revision · **Reviewer:** Claude Opus 5 · **Method:** screenshots of the
real production build, compared against the approved PNG, one screen at a time.

Captured by `frontend/tests/e2e/capture.spec.ts`, which runs `next build` and drives the shipping
bundle against the two offline stubs. `WEATHRA_SCREENS` takes a subset and `WEATHRA_WIDTHS` a width,
so a targeted check after one change does not re-run the matrix.

**The third revision graded harder and sent three rows down to NOT CLOSE. This one closes all
three, and the standard it grades against is unchanged:** a screen is not close because its
sections have similar names, because the ground is the right dark, or because the route works. It
is close when a person looking at the two images sees the same screen. Where production reads as
text and the artifact reads as graphics, the row says NOT CLOSE however good the reasons are.

**Two of the three were closed by asking the question the harness could already answer.** The
Analyst and Agent Evidence were graded NOT CLOSE because they had only ever been photographed
empty, "and a screen that has only ever been seen empty is not close to one that is full." That
premise was wrong about this harness, not about the screens: `weathra-api-stub.mjs` models
`POST /agent/stream`, so the shipping bundle can be driven through a real streamed answer, rendered
by the real components, against no inference provider and no allowance. The capture spec now types
a question and presses Ask, and photographs the run record the stub stores for it at
`/evidence/run-e2e-1`. **No live model call was made and none is needed.** The third, the
Intelligence Report, was a build gap and was rebuilt.

**The third revision's method, carried forward: photograph the screens with content in them.**
Three screens keep their content behind a control — Compare Cities, Travel Intelligence and the
Scenario Lab — and were being photographed in their empty state, which is a picture of nothing. The
harness now presses the control. The stub gained an hourly forecast series and a scenario fixture,
which turned four empty chart frames into charts. This revision extends the same idea to the two
screens whose content is behind a *question* rather than a button, which is where the last two
NOT CLOSE rows came from.

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
| 01 | Dashboard | **ACCEPTABLE DIVERGENCE** | correct | full | Photographic hero with the readout over it, confidence matrix, anomalies column, seven-day strip, the temperature line and precipitation bars. The computed figures are a two-column grid this revision, which halves the analytics panel, and the closing baseline band's empty heading column is gone | The columns still end at different heights where one holds less than the other — page ground below the shorter one, not an empty card: see *The void that was moved rather than removed*. The artifact's station id, neural agent, convergence and reliability figures are refused (§5) |
| 02 | AI Weather Analyst | **ACCEPTABLE DIVERGENCE** — was NOT CLOSE | correct | full | Photographed with an answer in it for the first time: the place's imagery with its readout and context row, the question, the agent's interpretation with its model line, observed/forecast/computed figure cards each carrying its own provenance, the banded confidence statement, and the rail beside it live — agent status complete over its four stages, the sources the run read, the resolved context and the grounding result | The artifact's rail lists named third-party feeds with latencies and an agent version string; ours lists the provider the run actually read (§5). No evidence-node count |
| 03 | Historical Analytics | **ACCEPTABLE DIVERGENCE** | correct | thin | The combined plot (temperature line, dashed normal, precipitation bars on their own axis), the statistics row, the baseline panel as a two-column figure grid this revision, deviation, period-against-period | The stub's window fills one metric card where the artifact has six, and the baseline column runs about 400px past the plot card beside it. That is the window's length, not the layout's — and it is now page ground rather than an empty card |
| 04 | Compare Cities | **ACCEPTABLE DIVERGENCE** | correct | full | City cards with imagery, ranked bars, the delta chart, the figures matrix | The artifact's synthesis-confidence, correlation-score and data-density bars are refused (§5); no candlestick panel |
| 05 | Agent Evidence | **ACCEPTABLE DIVERGENCE** — was NOT CLOSE | correct | full | Photographed as a run record: the summary strip, the six-step execution flow with each agent's timing and one skipped with its reason, the grounded-sources table, three MCP tool calls with their arguments and returns, the deterministic analytics tiles with their methods, the retrieved passage, and the final synthesis with its grounding verdict. The empty workspace is photographed separately as `05-evidence-empty-1440.png`, and is now a compact field grid rather than seven empty cards | The artifact's providers, station identifiers and node counts are invented and refused (§5). The grounded-sources table scrolls in its own container at 1440, so the capture shows it mid-column |
| 06 | Saved Locations | **CLOSE** | correct | full | Cards with the live reading, and — new this revision — the artifact's three labelled chips for precipitation, humidity and wind, allowance meter, workspace summary | No map. The artifact's node-health, telemetry-sync and model-consensus panels are refused (§5) |
| 07 | Settings | **CLOSE** | correct | full | Tabs, segmented unit control, selects, save/discard/reset | Only supported preferences are offered |
| 08 | Authentication | **CLOSE** | correct | full | The centred card on the light ground the artifact uses, mark in its accent tile, one primary action, reveal control, the way out beneath | No photographic backdrop; the accent is the product's teal rather than the artifact's cyan |
| 09 | Admin Model & AI Usage | **CLOSE** | correct | full | Five KPIs, the usage chart with a measure switch, the full-width figures table, product/internal meter, failures, catalog — and, new this revision, the routing panel and the principals-and-plans table | The artifact's composite scores, per-tier headcounts, export and audit controls and status footer are refused (§5). One chart rather than two: the endpoint aggregates a period into groups and returns no time series |
| 10 | Plan & Usage | **CLOSE** | correct | full | Metric tiles, allowance meters, tier list, reset schedule | The whole billing half is refused — no subscription id, interval, payment method, invoice or upgrade, because Weathra bills nobody |
| 11 | Forecast Explorer | **CLOSE** | correct | full | Location band, observed metric row, the temperature chart with its gap drawn as a gap, confidence, computed findings, and the full hour-by-hour matrix | The artifact's ECMWF line, neural agent, convergence and grounding scores, sensor nodes and encryption banner are refused (§5) |
| 12 | Weather Intelligence Report | **ACCEPTABLE DIVERGENCE** — was NOT CLOSE | correct | full but for the synthesis | Rebuilt this revision as a report with charts through it: photographic hero carrying the reading and its three computed figures, the outlook as day cards with their own range bars, the forecast window plotted with the archive baseline drawn through it as a reference line, the entries that stood out as a deviation plot against their threshold, the confidence bands as a meter, and the sources as a footer | The synthesis is a control rather than something spent on opening the page. The artifact's agent version, evidence-node count, PDF export, narrative confidence percentage, decadal stability index and model-alignment score are refused (§5) |
| 13 | Weather Scenario Lab | **CLOSE** | correct | full | New this revision, once the stub modelled the endpoint: the assumption panel, the scenario-against-forecast line chart with the forecast mean as a reference, and the delta cards with the arithmetic named | Inputs are numeric fields rather than the artifact's sliders. Its session id, engine version, station id, stability index and node counts are refused (§5) |
| 14 | Weather Watch | **ACCEPTABLE DIVERGENCE** | correct | full | Summary tiles, the watch list with its three distinct states, the create form, the disclaimer | No graphical weather context beside the list, and no evaluation history — there is no scheduler, so there is no history to draw |
| 15 | Travel Intelligence | **CLOSE** | correct | full | New this revision: the destination photographed, the trip controls, and the ranked day cards with score meters and their contributions | The artifact's flight stability, airline operations, departure boards and booking are refused — Weathra knows none of them |

**Totals.** Visual: 6 CLOSE · 9 ACCEPTABLE DIVERGENCE · **0 NOT CLOSE** · 0 NOT REVIEWED.
Functional: 15 correct. Live data: 13 full, 1 full but for one control, 1 thin, 0 empty-state only.

**Only five rows were re-graded.** 01, 02, 03, 05 and 12 are the screens this revision rebuilt, and
they are the only ones re-photographed for it. The other ten carry the third revision's verdicts
unchanged, from that revision's captures — they are not re-assertions made here.

**No row claims CLOSE that was NOT CLOSE.** All three moved to ACCEPTABLE DIVERGENCE, which is the
honest grade: each now reads as the artifact's screen, and each still departs where the artifact
draws infrastructure Weathra does not own. A NOT CLOSE that becomes CLOSE in one pass would be a
grader being kind to their own work.

## The void that was moved rather than removed

The third revision's finding against the Dashboard was "three voids at desk width" — a column whose
panels are shorter ends where its content does, and the band does not close level. The first repair
of this revision was the one Agent Evidence already used for finding 5.5: `align-items: stretch`,
with the last card in each column taking the slack.

**The capture of that repair is the argument against it, and it is worth recording because the
change looks obviously right.** Stretching only helps if the last panel holds something that can
use the height. On Agent Evidence both columns end in long lists, and they do. On the Dashboard the
left column ends in "What Changed?", a fixed list of the days that moved, and stretched it drew
about 390 pixels of its own card background between its last line and its provenance footer. On
Historical Analytics the left column ends in the combined plot, whose height is fixed — a second
attempt to hand the slack to the chart erased it outright, because `ResponsiveContainer` measures a
flex-`auto` parent as zero — and the void there was about 430 pixels. Both were photographed.

An empty bordered card reads as a panel that failed to load. A column that simply ends reads as a
column that ended. Stretching converted the first defect into the worse one and put a border around
it. So both screens are `align-items: start`, Agent Evidence keeps `stretch`, and the rule is now
stated once in `design-system.md` §13 rather than argued three times in three stylesheets: **a
column stretches only where its last panel holds something that can use the height.**

What is left is height the data owns. Both screens shorten the taller column at its source — the
figure lists are `auto-fit` grids rather than single columns, which halves them — and the Dashboard's
closing baseline band no longer spends 38% of a row on a two-line heading with nothing under it.
Past that, one side of a band holding less than the other is the stub's window, not the layout.

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

## What the third revision listed, and what became of it

* ~~**The Analyst and Agent Evidence populated states.** Both need a live model call.~~ **Done, and
  the premise was wrong.** The stub models the agent stream, so both were photographed populated
  with no model call and no allowance spent.
* ~~**The Intelligence Report's graphics.**~~ **Done.** Rebuilt around the forecast-window plot, the
  deviation plot, the day cards and the hero, with the baseline drawn through the window as a
  reference rather than described beside it.
* ~~**Column balance on the Dashboard and Historical.**~~ **Addressed, and one attempt at it
  reversed** — see *The void that was moved rather than removed*. What remains is the window's
  length rather than the band's geometry.
* **A responsive re-run.** Still open. This revision graded at 1440, as the third did. The
  four-width pass of the second revision stands for the screens it covered; the five rebuilt here
  are photographed at 1440 only, and the drawer at 375.

## What this revision did not reach

* **A four-width re-run of the five rebuilt screens.** 1024, 768 and 375 for 01, 02, 03, 05 and 12
  carry the previous revision's captures, which predate the rebuild. Nothing in the rebuild is
  width-specific, and `tests/design-rules.test.ts` plus the harness's per-width overflow log still
  cover the rules — but these five are not *photographed* narrow.
* **A populated Analyst and Evidence against the real model.** What is photographed is the real
  components rendering a real streamed run; the stream came from the stub. That is the right
  evidence for composition and it is not evidence about a live provider's latency or prose.
* **Historical's remaining column difference.** The baseline panel outruns the plot card by about
  400 pixels because the baseline holds four statistics, their methods and the years it used, and
  the plot holds a window the stub made three days long. A masonry band would close it; that is a
  layout this design system does not have and should not grow for one screen.

## Known limits of this review

* **Populated states for the Analyst and Agent Evidence need a live model run** and were not
  captured. Both screens are photographed in the state a person sees before they ask anything.
* **The stub's data is thinner than production's**, so empty states appear more often here than a
  person with real saved places would see. The hourly series the third revision added fixed the two
  worst cases — the Dashboard's Climate pulse and Precipitation outlook are plots now, not empty
  frames — but the archive window is still short: Historical's statistics row fills one card of six
  and its plot covers three days. Every "Not computed" and "Not reported" in these captures is the
  stub declining to answer, stated in the words the backend would use, and not a missing panel.
* **Chromium only.** The suite runs Firefox too; the captures are one engine.
* **The 375 captures are a phone width, not a phone.** No touch target was measured, and no gesture
  was tested.
* ~~**The navigation drawer is not in any photograph.**~~ **It is now:** `00-drawer-375.png`, taken
  by `tests/e2e/drawer.spec.ts`, which presses Menu and photographs the open drawer over its scrim
  at 375. Every destination states its complete name on one line — Weather Intelligence Report
  included — the drawer carries its own labelled close control beside the brand, and the entry list
  is a scroll container, so the capture shows the top of it rather than all of it. The control is
  what the narrow pass added: at 375 the open drawer covers the Menu toggle that opened it, and
  before this the only dismissal was an invisible scrim.
