# Production fidelity review — the fifteen screens against their artifacts

**Date:** 2026-09-11, fifth revision · **Reviewer:** Claude Opus 5 · **Method:** screenshots of the
real production build, compared against the approved PNG, one screen at a time.

Captured by `frontend/tests/e2e/capture.spec.ts`, which runs `next build` and drives the shipping
bundle against the two offline stubs. `WEATHRA_SCREENS` takes a subset and `WEATHRA_WIDTHS` a width,
so a targeted check after one change does not re-run the matrix.

**The fifth revision asks a different question of every remaining divergence.** The fourth reached
zero NOT CLOSE and left seven ACCEPTABLE DIVERGENCE rows, each with a reason. This revision tests
those reasons: *can the difference be closed with real data — obtained, aggregated, derived,
cached or exposed through the architecture this product already has?* Where the answer was yes, the
data path was built and the row re-graded. Where it is no, the row now records the exact missing
data and what would have to exist to get it, rather than "refused (§5)".

**Five reasons turned out to be wrong**, and the pattern in all five is the same: the figure was
already in the database or already returned by the provider, and nothing had aggregated or exposed
it. Those are in *What the parity pass built* below. **Eight kinds of data are genuinely
unobtainable** and are now documented as such — one row each, naming the provider or the
infrastructure it would take, rather than the "refused (§5)" that stood there before.

**The standard is unchanged:** a screen is not close because its
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
| 01 | Dashboard | **CLOSE** — was ACCEPTABLE DIVERGENCE | correct | full | Photographic hero with the readout over it and its four secondary measures, the interpretation panel with its confidence matrix, What Changed?, the computed figures as their own panel in the wide column, the anomaly rail with the historical average and spread beneath it, saved snapshots, the seven-day strip, the temperature line, the precipitation bars, forecast movement and the closing baseline band | Nothing structural. The artifact's station id, neural agent version, model-convergence and provider-reliability figures are unobtainable — see *What cannot be closed* |
| 02 | AI Weather Analyst | **ACCEPTABLE DIVERGENCE** | correct | full | Photographed with an answer in it: the place's imagery with its readout and context row, the question, the agent's interpretation with its model line, observed/forecast/computed figure cards each carrying its own provenance, the banded confidence statement, and the rail live — agent status over its four stages, the sources the run read, the resolved context and the grounding result | The artifact's rail lists named third-party feeds with per-feed latencies and an agent version string. Weathra reads one provider and versions no agent, so the rail lists the provider that answered — see *What cannot be closed* |
| 03 | Historical Analytics | **CLOSE** — was ACCEPTABLE DIVERGENCE | correct | full | Six metric cards in one row as the artifact draws them, each with its delta against the earlier period; the combined plot at full content width; the baseline panel with the deviation bars under it; and the anomaly panel now carrying a real **percentile** with the distribution it was ranked against drawn as a number line | Nothing structural. The artifact's station id and its model-written anomaly narrative are refused (§5, §8) |
| 04 | Compare Cities | **ACCEPTABLE DIVERGENCE** | correct | full | City cards with imagery, ranked bars, the delta chart, the figures matrix | The artifact's synthesis-confidence bar needs a confidence a model does not report. Its correlation score and data-density bar **are** derivable and are not built — see *What was not reached* |
| 05 | Agent Evidence | **ACCEPTABLE DIVERGENCE** | correct | full | Photographed as a run record: the summary strip, the six-step execution flow with each agent's timing and one skipped with its reason, the grounded-sources table, three MCP tool calls with their arguments and returns, the deterministic analytics tiles with their methods, the retrieved passage, and the final synthesis with its grounding verdict. The empty workspace is photographed separately and is a compact field grid rather than seven empty cards | The artifact's station identifiers and sensor-node counts describe hardware Weathra does not read — see *What cannot be closed*. The grounded-sources table scrolls in its own container at 1440, so the capture shows it mid-column |
| 06 | Saved Locations | **CLOSE** | correct | full | Cards with the live reading, and — new this revision — the artifact's three labelled chips for precipitation, humidity and wind, allowance meter, workspace summary | No map. The artifact's node-health, telemetry-sync and model-consensus panels are refused (§5) |
| 07 | Settings | **CLOSE** | correct | full | Tabs, segmented unit control, selects, save/discard/reset | Only supported preferences are offered |
| 08 | Authentication | **CLOSE** | correct | full | The centred card on the light ground the artifact uses, mark in its accent tile, one primary action, reveal control, the way out beneath | No photographic backdrop; the accent is the product's teal rather than the artifact's cyan |
| 09 | Admin Model & AI Usage | **CLOSE** | correct | full | Five KPIs; **the token-and-cost trend over time the artifact leads with**, dual-axis with a product/internal toggle and its totals strip; the grouped chart with its measure switch and period; the full-width figures table; the product/internal meter; failures, now groupable by failure class; the catalog; the routing panel; and the principals-and-plans table | The artifact's composite reasoning and cost-efficiency scores, per-tier user headcounts, export and audit controls and status footer are refused (§5) — a headcount against a user cap is a quantity Weathra neither stores nor limits |
| 10 | Plan & Usage | **CLOSE** | correct | full | The tier card with the three canonical plans, four metric tiles, the allowance rows at the artifact's own density — consumed figure at metric size, its allowance and unit, the share, the bar, and consumed/remaining beneath — **the recent-activity area chart** over the thirty-day series with a peak-day and a week-on-week tile, and the reset windows | The whole billing half is refused — no subscription id, interval, payment method, invoice or upgrade, because Weathra bills nobody. Its vector-storage-node quota and usage export are refused with it (§5) |
| 11 | Forecast Explorer | **CLOSE** | correct | full | Location band, observed metric row, the temperature chart with its gap drawn as a gap, confidence, computed findings, the full hour-by-hour matrix, and a place control of its own — the screen no longer needs a default location configured elsewhere before it will show anything | The artifact's second named forecast model is unobtainable from one provider — see *What cannot be closed*. Its neural agent, convergence and grounding scores, sensor nodes and encryption banner are refused (§5) |
| 12 | Weather Intelligence Report | **CLOSE** — was ACCEPTABLE DIVERGENCE | correct | full but for the synthesis | A report with charts through it: photographic hero carrying the reading and its three computed figures, the outlook as day cards with their own range bars, the forecast window plotted with the archive baseline drawn through it as a reference line, the entries that stood out as a deviation plot against their threshold, the confidence bands as a meter, the sources as a footer, and a place control under the heading | The synthesis is a control rather than something spent on opening the page, which is a deliberate difference and not a shortfall: the artifact's is free, Weathra's costs a real model call. Its agent version, PDF export, narrative confidence percentage, stability index and alignment score are refused (§5) |
| 13 | Weather Scenario Lab | **CLOSE** | correct | full | New this revision, once the stub modelled the endpoint: the assumption panel, the scenario-against-forecast line chart with the forecast mean as a reference, and the delta cards with the arithmetic named | Inputs are numeric fields rather than the artifact's sliders. Its session id, engine version, station id, stability index and node counts are refused (§5) |
| 14 | Weather Watch | **ACCEPTABLE DIVERGENCE** | correct | full | Summary tiles, **the forecast the watches are checked against with the threshold drawn through it**, the watch list with its three distinct states, the create form, a place control and the disclaimer | No evaluation history. It is the one row on this screen that needs infrastructure rather than a query — see *What cannot be closed* |
| 15 | Travel Intelligence | **CLOSE** | correct | full | New this revision: the destination photographed, the trip controls, and the ranked day cards with score meters and their contributions | The artifact's flight stability, airline operations, departure boards and booking are refused — Weathra knows none of them |

**Totals.** Visual: **11 CLOSE · 4 ACCEPTABLE DIVERGENCE · 0 NOT CLOSE** · 0 NOT REVIEWED.
Functional: 15 correct. Live data: 14 full, 1 full but for one control, 0 thin, 0 empty-state only.

Three rows moved up this revision — 01, 03 and 12, all AD to CLOSE — and 03 moved from thin to full
live data. The four that remain ACCEPTABLE DIVERGENCE are **02, 04, 05 and 14**. Nine screens were
re-photographed: 01, 03, 09, 10, 11, 12, 13, 14 and 15. The other six carry their previous verdicts
from the captures those revisions took; they are not re-assertions made here.

> **Correction: the totals line was wrong in the third and fourth revisions, and this one counted
> its own table before trusting itself.** The third revision reported "6 CLOSE · 6 ACCEPTABLE
> DIVERGENCE · 3 NOT CLOSE" against a table that actually held 8, 4 and 3. The fourth moved the
> three NOT CLOSE rows to ACCEPTABLE DIVERGENCE and did the arithmetic on the stated figures rather
> than on the table, carrying the error forward as "6 CLOSE · 9 ACCEPTABLE DIVERGENCE" when its
> table held 8 and 7. Both totals summed to fifteen, which is exactly why neither was caught. The
> verdicts in the tables were right throughout — every row is a screen and a picture — and only the
> tally was wrong, but a tally is the one line a reviewer reads first, and this document is about
> not overstating. The figures above were counted from the rows.

**Every remaining divergence names its missing data.** That is what distinguishes this revision from
its predecessors: "refused (§5)" is a pointer to a policy, and what a reviewer needs is the sentence
that policy produces for that screen — which datum is absent, and what would have to exist to
supply it. *What cannot be closed, and what it would take* is that, one row per kind of data.

## What the parity pass built

Five divergences were recorded as refusals and were not. In each, the figure was already in the
database or already returned by the provider, and nothing had aggregated or exposed it. Each row
below is *element → data → source → what was missing → what was built*.

| Visily element | Data it needs | Where that data was | What was missing | What was built |
|---|---|---|---|---|
| `09` "Token usage & estimated cost" over a clock | tokens and cost per time bucket | `llm_usage_events.created_at`, `total_tokens`, `estimated_cost` | `GET /admin/usage` groups a period by dimension and returns no time axis at all | `aggregate_usage_series` + `GET /admin/usage/series`, bucketed by `date_trunc`, product and internal split, gap-filled with zeros |
| `10` "Recent usage activity" area chart | the caller's own calls per day | the same table, scoped by Row Level Security | `GET /me/usage` returned the window's totals and no series | `recent.series` on the same route. Subject-free aggregation, so one function serves both screens and `/me/usage` gains no parameter that would need an authorization check |
| `10` "Peak volume" and "Weekly delta" | the daily series | as above | nothing to derive them from | `peakOf` and `deltaOf`, both over the new series. The delta is null against an empty earlier week rather than `+∞%` or a confident `+100%` |
| `09` "Errors & reliability" split by kind | failure counts per classification | `llm_usage_events.failure_class` | `status` separates success from failure only, so a rate could not distinguish a gateway rate limit from a schema validation | `failure_class` added to `GROUPINGS` |
| `03` "Percentile" beside the z-score | the distribution the baseline was drawn from | the archive years the baseline already fetched | `BaselineComparison` carried the mean, the spread and the extremes — no distribution | `Baseline.yearly_means` (each reference year's own mean for the window) + `percentile_rank`, mid-rank convention, with the distribution drawn as a number line beside the figure |

Two more were layout rather than data, and are in *The void that was moved rather than removed* and
*The row that should not have been a row* below.

**And one was neither.** `01`, `04`, `11`, `12` and `15` all lead with imagery of the place, and the
last tier of that chain was eight hand-drawn cities plus one shared `generic.svg`. Weathra resolves
any location Open-Meteo can geocode, so every customer city outside those eight got the same
picture. The fallback is now drawn from the place's own name — a graded sky, a horizon glow, two
rows of buildings, lit windows, a moon or stars, all seeded by the key so the same place draws the
same picture on every capture. `docs/city-imagery.md` has the chain and the four properties it is
held to.

## What cannot be closed, and what it would take

The eight kinds of data the artifacts draw that Weathra does not have. Each row was **investigated
for a free or low-cost source** during the sixth revision rather than assumed unavailable, and two
of the eight changed as a result — see the correction below the table.

| # | Desired Visily data | Why unavailable today | Derive internally? | External source required | Free / low-cost option | Future implementation |
|---|---|---|---|---|---|---|
| 1 | Station identifiers, sensor-node counts, node health (`01`, `05`, `11`, `14`) | Open-Meteo serves a reanalysis and model grid, not stations, and exposes no station identity at all | **No.** A grid cell has no identifier to report | A station-observation network | **Partly, and regionally.** NWS `api.weather.gov` is free and keyless with station ids and observations, **US only**; DWD Open Data is free and keyless, **Germany only**; Meteostat's bulk endpoints are free and global but a separate ingest. None is global *and* keyless *and* live | A second provider behind `WeatherProvider` plus a station table. **Held back deliberately:** a regional source gives Berlin a station id and Lisbon none, so the field would appear and vanish by country — worse than absent |
| 2 | Agent version strings, "MODEL ALIGNMENT SCORE" (`01`, `02`, `11`, `12`) | Weathra trains no model and versions no agent; it routes to third-party models through one gateway | **No** | None that exists | **None.** No API sells a version number for a model you did not train | Not a roadmap item. It is a different product |
| 3 | "MODEL CONVERGENCE 94%", a second named forecast line such as ECMWF (`01`, `11`) | One forecast model has no spread to measure. `/weather/forecast` requests the provider's default seamless model | **Yes, once two models are retrieved** — a spread across models is ordinary deterministic analytics | **None.** Corrected below | **Free, keyless, already-integrated provider.** Open-Meteo's `models=` parameter serves named models side by side — verified 2026-09-11 against `api.open-meteo.com` with `models=ecmwf_ifs04,gfs_seamless,icon_seamless`, which returned three separate hourly series | `docs/roadmap.md`'s multi-provider consensus, now cheaper than that entry assumes. See *The row that changed* |
| 4 | "DATA RELIABILITY (PROVIDER) 82%" (`01`) | No measured reliability history exists — nothing compares a past forecast against what happened | **Yes, entirely internally.** `forecast_snapshots` already exists; what is missing is scheduled capture and the scoring pass | **None** | **Free.** It is Weathra's own stored data against Weathra's own later retrievals | Forecast-accuracy scoring, post-MVP in `docs/roadmap.md`. Needs a scheduler, which is the same missing piece as row 6 |
| 5 | Named third-party feeds with per-feed millisecond latencies (`02`, `05`) | One weather provider and one model gateway, so there is one feed to name | **The latency half already is** — the run record carries per-agent and per-tool timings. The *several feeds* half is row 3 | None beyond row 3 | Same as row 3 | Falls out of row 3 at no extra cost: the timing side is already recorded |
| 6 | "ANOMALIES LOGGED 02", an activity feed of past breaches (`14`) | Nothing evaluates a watch except a person opening the screen or pressing refresh | **Yes** — an additive `watch_evaluations` table with the same owner-only RLS as `saved_locations` | **None** | **Free** | **The table is the easy part and must not land first.** Without a scheduler it would record *when somebody opened the screen*, and a chart of that looks like a record of the weather while being a record of visits. Weather Watch's scheduling and notification infrastructure is post-MVP; the table belongs with it |
| 7 | Subscription id, billing interval, payment method, invoices, upgrade (`10`) | Weathra bills nobody. `subscription_plans` carries an unused external reference so an integration has somewhere to land | **No.** There is no commercial relationship to describe | A payment provider | Stripe's API has no monthly fee, but a **real** account and real money movement are the point of it | Deliberately out of scope. Drawing any of it would be an invented commercial relationship, and `tests/test_no_payment_processing.py` fails the build if it appears |
| 8 | A map of the saved locations (`06`) | No tile renderer. Every saved place already has coordinates | The data is present; the *renderer* is absent | A map tile source | **Free and keyless.** MapLibre GL JS with OpenStreetMap raster tiles needs no account; a styled vector basemap does | **Not a gap against the artifact.** `06-saved-locations.png` draws no map — it draws typographic cards, which is what production draws. This row exists because earlier reviews listed a map as missing; it is missing from the *product idea*, not from the artifact |

### The row that changed, and the claim I had wrong

The fifth revision recorded row 3 as needing "a second forecast provider", and row 5 with it. **That
was wrong, and checking rather than repeating it is what this revision was for.** Open-Meteo — the
provider Weathra already integrates, free and without a credential — serves multiple named models
through one query parameter. Verified against the live API on 2026-09-11:

```
GET api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.405
    &hourly=temperature_2m&models=ecmwf_ifs04,gfs_seamless,icon_seamless
→ 200, hourly keys: temperature_2m_ecmwf_ifs04, temperature_2m_gfs_seamless,
                    temperature_2m_icon_seamless
```

Three named models, one request, one provider, no key. So "convergence" stops being a measure
Weathra cannot compute and becomes a measure Weathra has not yet retrieved the inputs for — and
`docs/roadmap.md`'s multi-provider consensus entry is cheaper than it assumes, because the second
model needs no second integration.

**It is still not built in this pass, and the brief's own rule is why.** The guard for adopting a
source during a fidelity pass is: no paid account, no substantial architecture change, genuinely
useful. The first and third hold; the second does not. `WeatherProvider.forecast` returns one
`Forecast`, and per-model series would change that return shape, the cache key, the validation
layer, the MCP tool contract and every caller, then need consensus analytics and UI on two screens.
That is a group of work with its own tasks, and half of it would leave the interface worse than
either end. What this pass owed was to find out whether the data exists. It does, it is free, and
the note above is what the next pass starts from instead of a re-read.

One incidental finding worth keeping: in that probe `ecmwf_ifs04` returned `null` for the first six
hours while the other two returned values. A consensus built without handling that would compute a
spread across two models and report it as three.

## What was not reached

* **`04`'s correlation score and data-density bar.** Both are genuinely derivable and neither is
  built. A correlation between two places' series over the compared window is the same class of
  deterministic statistic as the z-score and the Theil-Sen slope already in
  `weathra/analytics/`, and data density is `points_used / points_expected`, which every
  `StatisticResult` already carries half of. This is the clearest remaining *closeable* gap in the
  set, and it is named here rather than left for a reviewer to notice.
* **A four-width re-run.** This revision graded at 1440. Nothing built here is width-specific and
  `tests/design-rules.test.ts` plus the harness's per-width overflow log still cover the rules, but
  the nine re-photographed screens are photographed at one width.
* **Historical's remaining column difference**, now much smaller than it was, since the plot took
  the full width and the metric row filled.

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

## The row that should not have been a row

Historical Analytics' combined plot sat in the wide column of a two-column row with the baseline
panel beside it, and two revisions tried to close the void under it by adjusting alignment. Both
were treating a symptom. `03-historical-analytics.png` gives its plot the **full content width**,
with the metric row above it and the comparison band below — and the baseline panel is naturally
about twice the plot's height, so as a row it could never have been level. The band below now holds
the baseline and the deviation bars together, which is also where the artifact puts them; before,
the deviation was a screen away from the figures it is computed from.

The Dashboard had the same shape of error one level down. Its narrow column carried the anomaly
alert, the trend *and* six computed statistics with their methods and provenance, while the wide
column beside it held two short panels — so the rail ran twice the height of the column it was
beside. The artifact's rail is short: an alert, a historical average, a variance, three snapshots.
The figures were the wrong half to put there, and they are now their own panel in the wide column.

Neither was a data problem and neither was visible in a component test. Both were visible in the
first capture taken after the change, which is the argument for photographing a screen rather than
reading it.

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

## The finding that was not about pixels

All five Intelligence screens — Forecast Explorer, the Intelligence Report, the Scenario Lab,
Weather Watch and Travel Intelligence — read the default location from `/me/preferences` and offered
no way to look at anywhere else. **With no default set, each one rendered an empty state and a link
to Settings.** A customer who signed up and pressed *Forecast Explorer* got a sentence and a link
where the artifact has a screen: five of the fifteen screens were reachable only by first
configuring a preference somewhere else.

That is not a fidelity defect and a screenshot of the populated state would never have shown it. It
was found by asking what each screen does when it has nothing, which is the question the fourth
revision's "photograph the empty state too" discipline turns into a habit.

Each now carries the same place control, under its own heading, folded away once there is something
to read. Two more defects fell out of wiring it: Forecast Explorer and the Intelligence Report each
replaced their *whole screen* with one sentence while loading and on a provider error — so a
provider hiccup took the heading, the controls and the place chooser with it, and the chooser is the
one control that would let a person try somewhere else. Both keep their shell now, which is what
the Dashboard, Historical and Compare Cities already did.

## The standing rule about the artifacts

Every screen's divergences are refusals of content Weathra does not have, and they are recorded per
screen in `screens.md` §5 and §8 rather than discovered per reviewer. The pattern across all
fifteen is one thing: the artifacts draw an infrastructure — sensor networks, named forecast models,
neural agents, convergence percentages, encryption banners, node counts — that this product does not
own. Weathra reads one weather provider and one model gateway. Where a panel's slot is real and its
content is not, the slot is filled with what Weathra actually knows; where the whole panel is
invented, it is absent rather than styled out of sight.

## What each revision left, and what became of it

| Left by | Item | Now |
|---|---|---|
| 3rd | The Analyst and Agent Evidence populated states | **Done, and the premise was wrong.** The stub models the agent stream, so both were photographed populated with no model call and no allowance spent |
| 3rd | The Intelligence Report's graphics | **Done.** Rebuilt around the forecast-window plot, the deviation plot, the day cards and the hero |
| 3rd | Column balance on the Dashboard and Historical | **Done**, after one attempt was reversed and one row turned out not to be a row — see the two sections above. Both screens now close their bands |
| 4th | Historical's remaining column difference | **Mostly gone.** The plot took the full content width and the metric row filled to six, so the difference is now a fraction of the 400 pixels it was |
| 4th | A populated Analyst and Evidence against the real model | **Still open, and correctly so.** What is photographed is the real components rendering a real streamed run; the stream came from the stub. That is the right evidence for composition and is not evidence about a live provider's latency or prose |
| 4th, 5th | A four-width re-run | **Still open.** Both graded at 1440. The second revision's four-width pass stands for the screens it covered; the nine re-photographed here are photographed at one width, and the drawer at 375 |
| 5th | `04`'s correlation score and data-density bar | **Open and closeable** — see *What was not reached* |

## Known limits of this review

* **The Analyst and Agent Evidence captures are of a stubbed run**, not a live model's. Real
  components, real streaming, real grounding check — and a stub behind it, which is the right
  evidence for composition and none at all about a provider's latency or prose.
* **The stub's data was thinner than production's, and that mattered more than it looked.** Two
  rounds of grading were partly grading the fixture. The third revision's hourly series turned the
  Dashboard's two empty chart frames into plots; this one added the five daily aggregates
  Open-Meteo's archive actually returns, which turned Historical's metric row from one card and a
  five-measure "Not computed" footnote into the artifact's six — **the product computed all six all
  along**. The lesson is the general one: before recording "the backend computed nothing here",
  check whether the fixture asked it to. What remains is a short window, three days of archive and
  six of forecast, so some panels are less dense than a real account's.
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
