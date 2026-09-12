# Product reconciliation — approved design against shipped product

> Step 1 of a two-step reconciliation, 2026-09-11. **Analysis only: no product code was changed by
> the pass that produced this document.** It is written to be used as the implementation contract
> for Step 2, so every row is meant to be actionable without re-deriving it.

## How this audit was made

Every one of the fifteen approved artifacts under [`screens/`](screens/) was opened and looked at,
and the shipped screens were photographed at 1440 with the Playwright capture harness
(`WEATHRA_CAPTURE=true npx playwright test tests/e2e/capture.spec.ts`) and looked at as pictures.
Source was read only to answer questions the pictures raised — what data exists, why a thing renders
as it does. A fidelity judgement made from source is a judgement about source.

**Baseline:** OpenSpec 289/292, `main` clean at `34d0896`. Remaining original tasks: 21.8, 34.5,
34.7 — none touched.

## The finding that changes the most

**Weather condition is not blocked, and the previous pass was wrong about why.**

The 2026-09-11 UX pass recorded "provider condition codes" as a genuine blocker on the grounds that
`weather_code` appears in `SEVERITY_FIELD_NAMES` in `backend/weathra/agents/safety.py`. Reading that
module's own docstring shows the opposite:

> *"a severity claim is permitted only where the retrieved data carries a field describing it […] The
> check is written against field names rather than removed, because `specs/safety-grounding` has a
> scenario for the supported case ("the answer may report it with the provider attributed and the
> fields named") and a provider that supplied an alerts block should light this up without anyone
> having to remember to re-add the guard."*

That list is an **enabling** list, not a prohibition. It names the fields that would *permit* a
severity statement, and it fires on every answer today only because no supported provider supplies
one. What the spec forbids is Weathra **inferring** severity from measurements — which is exactly
what the current derived `lib/weather/condition` does from cloud cover and precipitation, and which
a provider-reported WMO code would replace with something truthful.

Verified in `backend/weathra/providers/open_meteo.py`: `weather_code` is **not requested** from
Open-Meteo at all. `CURRENT_FIELDS`, `HOURLY_FIELDS` and `DAILY_FIELDS` list ten to twelve
measurements each and no code. So the backend is not withholding a field it has; it never asks.

**Classification: SMALL BACKEND ADDITION.** Add `weather_code` to `Measure`, to the three field
maps, and to the response schema. It is the provider's own semantics, attributed to the provider,
and it unlocks real weather iconography on four screens at once. It is the single highest-leverage
item in this document.

## 1. Data inventory — what Weathra actually has

Verified against `weathra/domain/weather.py` and `weathra/providers/open_meteo.py`.

| Series | Measures actually carried |
|---|---|
| **Current** | temperature, apparent_temperature, precipitation, wind_speed, wind_gust, wind_direction, relative_humidity, dew_point, surface_pressure, cloud_cover |
| **Hourly** (48 pts) | the above **plus precipitation_probability and uv_index** |
| **Daily** | temperature max/min/mean, apparent max/min, precipitation_sum, precipitation_hours, precipitation_probability max/mean, wind_speed_max, wind_gust_max, wind_direction_dominant, uv_index_max |
| **Archive daily** | temperature max/min/mean, apparent max/min, precipitation_sum, precipitation_hours, wind_speed_max, wind_gust_max, wind_direction_dominant |
| **Archive hourly** | temperature, apparent, precipitation, wind speed/gust/direction, humidity, dew point, pressure, cloud cover |
| **Absent everywhere** | weather_code / condition, alerts, warnings, severity, station identity, sensor health, model ensemble, second provider |

Notable asymmetries Step 2 must respect: **UV and precipitation_probability exist hourly and daily
but not in `current`**; **archive carries no humidity daily and no UV at all**; **cloud cover is
hourly and current but not daily**, which is why a derived daily sky state is not available even
though an hourly one is.

Analytics on top of these: mean/min/max/range/sum, Theil–Sen trend, MAD anomalies, multi-year
baseline with z-score and percentile, period-against-period comparison, correlation and data
density, forecast-against-forecast change detection, confidence from provider spread.

## 2. Plan contract — what actually differs between tiers

From `0008_seed_model_policy_data.py`. This matters because the previous pass concluded plans differ
only by allowance, and they do not.

| | Free | Pro | Premium |
|---|---|---|---|
| requests/day | 25 | 250 | 1,000 |
| requests/month | 300 | 4,000 | 20,000 |
| tokens/month | 500,000 | 8,000,000 | 40,000,000 |
| concurrent runs | 1 | 3 | 6 |
| **model policy** | `free_default` | `balanced` | `high_reasoning` |
| **model actually used** | economy free tier | standard (gpt-oss-120b) | frontier (nemotron-ultra-550b) |

**Which model answers your questions is a real, row-backed, customer-meaningful difference**, and
`PlanOfferView` does not expose it (`plan_code`, `display_name`, `rank`, `allowances` only). Exposing
the resolved tier per call role is a **small backend addition** and is what makes a plan comparison
say something other than "bigger numbers".

## 3. Capability gap register

| Item | Class | Evidence |
|---|---|---|
| Current / hourly / daily weather figures | **A — exists now** | verified in the provider client |
| Hourly precipitation probability, UV | **A** | 48-point hourly series carries both |
| Deterministic insights (warmer tomorrow, wettest day, baseline delta) | **B — derivable now** | shipped 2026-09-11 in `lib/dashboard/insights` |
| Sky state from cloud cover | **B** | shipped, but see next row |
| **Provider weather condition + icon** | **C — small backend change** | Open-Meteo returns `weather_code`; not requested. Safety guard *enables* it |
| **Plan model tier in `/plans`** | **C** | column exists in `subscription_plans`; not projected into the view |
| Per-day condition for daily cards | **C** | needs `weather_code` daily; cloud cover is not in the daily series |
| Station identity, sensor health, node counts, latency | **F — would be fictional** | no station concept anywhere in the model |
| Model convergence, ensemble agreement, second provider | **F** | one provider, one model per call |
| Evaluation history, watch scheduling, activity feed, "next refresh" countdown | **D — new infrastructure** | no scheduler; `/me/watches` has no evaluation loop |
| Notifications | **D** | no delivery channel |
| Billing, invoices, subscriptions, prices, payment method | **E — commercial dependency** | `self_service` is false; no price column exists |
| AI packing lists, flight stability, infrastructure sensitivity | **F** | not weather Weathra retrieves |

## 4. Screen-by-screen reconciliation

Geometry is stated as observed at 1440. "Column span" is of the content area right of the rail.

---

### 01 Dashboard — **NOT CLOSE** — P0

| Region | Visily position / size | Production position / size | Status |
|---|---|---|---|
| Hero | Full-width band, photographic, ~220px tall. Place bottom-left; **temperature dominant, right-of-centre, ~64px**; condition under it; 4 metric tiles in a 2×2 block far right; "Updated 2m ago" chip under the place | Full-width, image present. Temperature centred ~40px; **no condition at all**; metrics cramped in a 4-up box that wraps ("14.2 km/ h"); FEELS LIKE / PRECIPITATION on a *separate strip below the image* | **MATERIAL** |
| Hourly strip | — (not in artifact) | Full width, 24 columns, scrolls | **EXTRA — keep** |
| Forecast strip | 7 cards, equal width, full span. Each: day, icon, **big temp**, condition label, L/H pair | 7 cards ✓. Each: weekday, date, precip glyph, small precip, HIGH value, LOW value. **No condition; temperature not dominant** | **MATERIAL** |
| Intelligence row | Left ~66%: Weathra Intelligence with prose + confidence bars + 2 sub-cards (WHAT CHANGED?, WHY?). Right ~33%: Anomaly (tiny — one alert line + 2 figures) then Saved Snapshots | Left ~60%: AI panel + confidence matrix side by side; What Changed as its **own full band below**; Computed figures as another band. Right ~40%: Anomaly with **4 findings each carrying "Computed by Weathra / View analysis"**, then Saved snapshots | **MATERIAL** |
| Charts row | Left ~66% Climate Pulse (temp line + precip bars, dual axis, area fill). Right ~33% Precipitation Logic (icon, one big %, 2 figures) | Left/right at ~50/50. Temp chart is a bare line, no fill; precip chart is bars with a long caption. Both carry "Show the figures" | **SLIGHTLY OFF** |
| Baseline band | Full width: prose + one delta figure + CTA left, large chart right | Full width: prose + **3 stat rows** + years note. No chart | **MATERIAL** |

**First viewport.** Visily: hero, and the top of the intelligence row. Production: hero, hourly
strip, and the top of the forecast band — which is *better* than before the 2026-09-11 pass
(forecast used to be fifth) but still shows no weather condition anywhere above the fold.

**Step-2 target.** Hero: one band, image, place top-left, **temperature the largest element on the
screen**, condition beneath it from `weather_code`, feels-like + humidity + wind + pressure + UV as
one inline tile row *inside* the band, updated-chip under the place. Forecast card: day, condition
icon, **temperature dominant**, condition word, L/H. Anomaly card reduced to one status line plus
two figures with `View analysis`. What Changed and Computed figures move into the right rail as
compact cards. Baseline band gains the yearly-means chart it already has data for.

---

### 02 AI Weather Analyst — **CLOSE** — P1

Re-graded 2026-09-12 from `capture/02-analyst-1440.png` and `capture/02-analyst-clarify-1440.png`
beside the artifact, after tasks 34.32 (composition) and 34.33 (the conversation itself).

| Region | Visily | Production | Status |
|---|---|---|---|
| Layout | 72/28 two-column | ~70/30 ✓ | MATCH |
| Header | Title + session chip inline; History / New Analysis top-right | Mark + title + session line inline; New analysis top-right | MATCH — History recorded as an accepted divergence (§8) |
| Conversation | User bubble right-aligned with avatar; agent reply left with avatar | Right-aligned `YOU` bubble; agent reply with the intelligence mark | SLIGHTLY OFF — no portrait avatars |
| Answer body | Prose, then **two** compact metric cards, then one highlighted interpretation box, then a one-line source footer | Prose, then Observed / Forecast where the run produced each, then the computed figures as the highlighted box, then one provenance rule | MATCH |
| Hero image | Right rail, under "Active data sources" | Not drawn | SLIGHTLY OFF — the artifact's is generated source imagery (§5) |
| Run progress | — | While streaming, and under a failure that produced nothing | MATCH |
| Follow-ups | 2×2 chips directly above composer | 2×2 chips ✓ | MATCH |
| Composer FOCUS | `FOCUS: BERLIN, DE` on the composer row | The same row, as a control: saved places, a resolver, and the saved default named | MATCH |
| Rail | Agent status, data sources, analyst context, confidence meter, evidence CTA | same five ✓ | MATCH — confidence is a band and a count, not a percentage (§5) |
| Clarification | — | A conversation: the question, the saved places to press, a resolver, and the pending question resumed on choosing | EXTRA — the artifact draws no such state |

**Remaining divergences, all recorded.** No portrait avatars on the two speakers; no History
control (the threads endpoint exists, no screen lists them — §8); no generated source imagery in
the rail; the confidence slot is the backend's uncertainty band rather than the artifact's
"98.2%"; and the source names are whatever the deployment actually retrieved from. Each is either
a fabrication `screens.md` §5 refuses or a capability no endpoint supplies.

---

### 03 Historical Analytics — **ACCEPTABLE DIVERGENCE** — P1

Structurally the closest screen in the set: 6 KPI tiles, one chart card, then a two-column
baseline/anomaly row, all matching the artifact's order and proportions.

| Region | Visily | Production | Status |
|---|---|---|---|
| Header | One line: title + place chip + range picker + °C/°F + Export | Title/subtitle stacked; range inside a `▶` disclosure on a second row | SLIGHTLY OFF |
| KPI tiles | 6 across; each = icon, badge, value, **short delta line** ("+3.2°C vs Normal") | 6 across ✓; each carries **the method** ("arithmetic mean of usable points · 48 points") | MATERIAL (typography/density) |
| Main chart | Recorded line + dashed normal + **thin** precip bars, dual axis, area fill | **Two enormous solid bars** dominate; line barely visible | MATERIAL |
| Baseline vs anomaly row | 64/36 | ~70/30 ✓ | SLIGHTLY OFF |
| Deviation analysis | 3 bars inside the left card | 1 bar, in its own separate card | SLIGHTLY OFF |
| Period-against-period | — | Full band, 6 figures each with "Computed by Weathra / View analysis" | EXTRA — keep, demote |

**Step-2 target.** Consolidate the header to one row; tile subtitle becomes the delta against
baseline, method moves to `View analysis`; fix precipitation bar scaling so the line reads; fold
deviation bars into the baseline card.

---

### 04 Compare Cities — **NOT CLOSE** — P1

The largest compositional gap in the set.

| Region | Visily | Production | Status |
|---|---|---|---|
| Top | **Two hero cards side by side, each with city photography**, big temp, condition, humidity + wind | **One full-width bar chart with two giant blue bars** | **MATERIAL — wrong primitive entirely** |
| Ranked cards | Below, compact, with imagery | Present below the chart, with imagery ✓ | PARTIAL |
| Comparison intelligence | AI panel + correlation/data-density meters in one card | Correlation/density in a separate band titled "How the places moved, and how much was reported" | SLIGHTLY OFF |
| Forecast delta | 7 rows: day, **icon + temp per city** | 7 rows: day, plain numbers per city | MATERIAL |
| Differential chart | Left ~66%, two lines + bars | Left ~66% ✓ two lines | MATCH |
| Deterministic metrics | Right rail: 3 labelled deltas + anomaly note | — (figures are in a table lower down) | MISSING |
| Decadal baseline | Prose + 2 deltas + CTA, with a chart beside it | **An empty bordered box with an explanation inside it** | MATERIAL |

**Step-2 target.** Lead with two hero cards (imagery already available). Demote the ranking bar
chart or delete it — the artifact has no such element and it carries no information the hero cards
do not. Add condition icons to the delta rows once `weather_code` lands. Replace the empty baseline
box with a small truthful empty state, not a full-height container.

---

### 05 Agent Evidence — **UNASSESSED (production)** — P2

Visily: 3-region layout — left rail "Execution flow" as a **vertical timeline** of agent steps with
durations; centre "Grounded data sources" **table** (provider, resolved location, retrieval period,
data class) then deterministic analytics tiles then **RAG knowledge evidence** cards with similarity
scores; bottom "Context used (agent memory)". Production has all of these concepts
(`components/evidence/sections.tsx`, 965 lines) but its rendered geometry was not photographed in
this pass. This screen is *allowed* to be technical; the work is structural, not reductive.

---

### 06 Saved Locations — **ACCEPTABLE DIVERGENCE** — P2

**Settled, and worth recording because it was got wrong once.** `06-saved-locations.png` draws these
cards **without photography**: a freshness dot, place, country, dominant temperature, condition word,
H/L, and three metric tiles (PRECIP / HUMIDITY / WIND), four across, with an `ANALYTICS ›` link and
an OBSERVED chip. A city image was added on 2026-09-11 and reverted the same day when
`location-imagery.test.tsx` failed it; the test is right and the guard should stay.

| Region | Visily | Production | Status |
|---|---|---|---|
| Card grid | 4 across, equal height, dense | 2 across, tall, uneven | MATERIAL |
| Card content | dot + place + country + temp + condition + H/L + 3 tiles | place + temp + 3 stacked tiles + timezone | PARTIAL (no condition, no H/L) |
| Per-card action | `ANALYTICS ›` link | `Open` + `Remove` buttons | ACCEPTABLE — better |
| Coordinates | absent | behind a disclosure | ACCEPTABLE |
| Attention banner | ATMOSPHERIC ATTENTION REQUIRED (fictional) | "Room to save more" quota line | ACCEPTABLE |

---

### 07 Settings — **UNASSESSED (production)** — P2

Visily: **tabbed** (General / AI Intelligence / Account / Transparency), each row a
label + description on the left and a control on the right, with a sticky save bar showing
"CONFIGURATION SYNCED · LAST SAVE". Real preferences available: units, default location, forecast
horizon, plus memory/preferences. Time format and timezone are not backend-backed.

---

### 08 Authentication — **CLOSE** — P2

The one light-appearance screen. Centred card, brand above, Welcome back + subtitle, email,
password with reveal, remember-me + forgot link on one row, primary button, create-account footer.
Production matches this closely and is the only screen already at the artifact's composition.

---

### 09 Admin — **UNASSESSED (production)** — P2

**This is where cost belongs.** Visily 09 carries TOTAL TOKEN BURN, **ESTIMATED COST $482.50**,
failure rate, median latency, active calls, a token-and-cost chart, an estimated-cost breakdown by
model/policy/plan, a model registry table, plan usage by tier, and errors/reliability. The customer
Plan & Usage page has no cost element in the artifact at all.

---

### 10 Plan & Usage — **NOT CLOSE** — P0

| Region | Visily | Production | Status |
|---|---|---|---|
| Header band | Full-width, title + subtitle left, **two CTAs right** | Title + subtitle, no CTAs | SLIGHTLY OFF |
| Tier card | Left ~35%: shield icon, ACTIVE TIER, big tier name | Left ~33%: "Your plan" + 3 tier rows | PARTIAL |
| Subscription facts | Centre: id, interval, next billing, payment method | — | **MISSING — correctly, none exist** |
| Entitlements | Right ~30%: checkmark list + "Compare all tiers" | — | MISSING |
| Metric tiles | **4 across**, full width | 4 tiles in a 2×2 beside the tier card | SLIGHTLY OFF |
| Resource allocation | Left ~64%: 3 meters with used/remaining | Left ~64% ✓ 3 meters ✓ | MATCH |
| Recent activity | Right ~36%: sparkline + peak/delta | Right ✓ ✓ | MATCH |
| Reset windows | Bottom-left band, 4 rows with countdowns | Bottom-right card, 2 rows, absolute stamps | SLIGHTLY OFF |
| Compare / change / billing | "Compare all tiers" link only | Three full-width cards | EXTRA — keep |
| Large void | — | **~700px of empty left column below Allowances** | MATERIAL |

**Step-2 target.** Move the metric tiles to a 4-across full-width row under the header. Replace the
subscription-facts region with an **entitlements list built from the plan's real allowances plus its
model tier** (needs the `/plans` addition). Fill the left column void by moving Compare plans into
it. Keep Billing exactly as it is — it is the artifact's honest counterpart.

---

### 11 Forecast Explorer — **NOT CLOSE** — P1

| Region | Visily | Production | Status |
|---|---|---|---|
| Control bar | One row: search + **24H/3D/7D/14D toggle** + °C/°F + updated stamp | Horizon `<select>` top-right; place inside a `▶` disclosure | MATERIAL |
| Hero image | **none** | **full-width hero image** | EXTRA — remove |
| KPI tiles | 7 across, mixed OBSERVED/FORECAST/ANALYTICS badges | 6 across, all OBSERVED | SLIGHTLY OFF |
| Main chart | ~78%, temp line + dashed + precip bars, dual axis, area fill | ~66%, single line, no fill, no precip | MATERIAL |
| Rail | Intelligence layer + confidence + model reliability | Confidence + computed findings | PARTIAL |
| Forecast matrix | Table: TIME (`Mon 08:00`), TEMPERATURE, **CONDITIONS + icon**, PRECIPITATION, HUMIDITY, WIND VECTOR, **UV chip** | Table: raw ISO `2026-09-04T00:00:00+02:00`, temp, precip, humidity, wind | MATERIAL |

**Step-2 target.** This is the screen the `weather_code` addition pays for twice — the matrix's
CONDITIONS column and the hero. Horizon becomes a segmented control; hourly timestamps become
`Mon 08:00`; UV joins the table as a chip (data already exists hourly).

---

### 12 Weather Intelligence Report — **UNASSESSED (production)** — P2

Visily: report header with TODAY/3D/7D/14D + Export PDF; a large AI headline card with three figure
tiles (confidence, evidence nodes, drift variance) beside a **2×3 observed-metric grid**; then
"Forecast outlook (visual multi-day)" as 7 compact day cards with icon + temp + rain%; a
deterministic drift chart; and a right rail with What Changed, Historical context, and Anomaly
attention. Every deterministic half of this is available today; the "evidence nodes" and multi-model
figures are not.

---

### 13 Weather Scenario Lab — **UNASSESSED (production)** — P2

Visily: three-column top — user-defined assumptions as **five labelled sliders** with baseline
markers on the left ~32%; "Baseline weather data" centre; "Calculated analytical impact" right, with
the simulated result as the dominant number. Then a baseline-vs-scenario chart with **four delta
tiles** beneath, an AI interpretation panel, a historical correlation card, and an explicit
analytical disclaimer. The sliders, baseline, deltas and disclaimer are all truthful and buildable;
the "inference confidence" and "model matching %" are not.

---

### 14 Weather Watch — **UNASSESSED (production)** — P2

Visily: 4 metric tiles (active watches, locations monitored, changes detected, **next refresh
countdown**); "Watched locations" as **three photographic cards** with status chips
(ANOMALY / WATCH ACTIVE / STABLE), temp, condition, "4M AGO", precip% and wind; a temporal chart;
an AI watch-evidence card; and a right rail with active watches, What Changed, **Activity feed** and
quick-config. Also an explicit emergency-protocol notice, which matches `specs/safety-grounding`.

**Note the imagery asymmetry:** Watch uses city photography on its location cards, Saved Locations
does not. Both are deliberate; do not generalise either.

The countdown, the activity feed and the changes-detected count all need **D — scheduler**.

---

### 15 Travel Intelligence — **NOT CLOSE** — P1

| Region | Visily | Production | Status |
|---|---|---|---|
| Trip bar | Origin → destination + dates + Adjust/Export, one row | "Your trip" card with 3 fields + Rank button | SLIGHTLY OFF |
| Hero | Photographic "Weather Window Identified" + temp + humidity + wind, ~64% | Full-width image + place only | PARTIAL |
| Viability index | Right ~34%: **radial gauge** + 2 sub-meters | — | MISSING |
| KPI tiles | 4 across | — | MISSING |
| **Destination daily outlook** | 5 day cards: icon, temp, condition, rain% | — | **MISSING** |
| Intra-day chart | Under the day cards | — | MISSING |
| Temporal comparison matrix | Departure windows ranked by viability score | **This is what production ranks — but it ranks *places*, not windows** | PARTIAL |
| Packing strategy | AI gear list | — | **Correctly absent (fictional)** |

**Step-2 target.** Keep the ranking (it is the artifact's comparison matrix) but re-point it at
**departure windows for one destination** rather than at places. Add the day-by-day outlook — pure
forecast data, already available. The viability gauge is a rendering of the suitability score the
backend already computes.

## 5. Production features to preserve

Visily is the visual authority; it is not an inventory of what Weathra does. These are real, working
and must survive Step 2.

| Feature | Home | Level | How it survives |
|---|---|---|---|
| Hourly forecast strip | Dashboard | 1 | Not in the artifact; it is the band the artifact's hero implies and every weather product has. Keep above the daily strip |
| Deterministic insights | Dashboard | 1 | Fills the artifact's "Weathra Intelligence" region without an inference call |
| What Changed (forecast-vs-forecast) | Dashboard rail + Watch | 2 | Artifact has it as a sub-card; make it one |
| Anomaly detection (MAD), Theil–Sen trend | Dashboard rail, Historical | 2 → 3 | States on the card, methodology behind `View analysis` |
| Multi-year baseline, z-score, percentile | Historical, Dashboard | 2 | Artifact's "Selected period vs historical normal" |
| Period-against-period comparison | Historical | 2 | Extra band; keep, demote below the baseline row |
| Correlation + data density | Compare | 2 | Artifact's "synthesis confidence" meters — same shape, truthful figures |
| Confidence from provider spread | everywhere a forecast appears | 2 | Already matches the artifact's confidence meters |
| Evidence records, tool calls, provenance | Agent Evidence | 3 | The artifact's own execution-flow + grounded-sources composition |
| RAG knowledge evidence | Agent Evidence | 3 | Artifact has a dedicated region |
| Memory / preferences | Analyst rail, Settings | 2 | Artifact's "Analyst context / long-term memory" |
| Saved locations + quota | Saved Locations | 1 | Artifact's card grid |
| Scenario transformations | Scenario Lab | 1 | Artifact's sliders + delta tiles |
| Travel suitability ranking | Travel | 2 | Artifact's temporal comparison matrix |
| Plan allowances + usage meters | Plan & Usage | 1 | Artifact's resource allocation |
| Usage activity sparkline | Plan & Usage | 2 | Artifact's recent-usage panel |
| Truthful billing boundary | Plan & Usage | 1 | Has no artifact counterpart and must stay |
| `Open`/`Remove` on saved places | Saved Locations | 1 | Better than the artifact's single link |

## 6. Why alignment keeps drifting — root causes

Observed across the captures rather than inferred:

1. **No shared page container.** Each route sets its own heading block, so title/subtitle/controls
   land at different heights and controls sometimes wrap to a second row (Historical, Explorer)
   where the artifact keeps one.
2. **No shared KPI-tile primitive.** Dashboard, Historical, Explorer and Plan each draw their own;
   tile heights differ because some carry a method sentence and some a delta.
3. **Two-column proportions are ad hoc.** 66/33 in the artifact, but production uses 60/40, 70/30 and
   50/50 on different screens.
4. **Cards size to content.** Nothing establishes equal-height rows, so grids look ragged (Saved
   Locations, Compare ranked cards).
5. **Chart containers have no agreed aspect ratio or axis policy**, which is why a precipitation
   series renders as two page-wide bars on Historical and Compare.
6. **Provenance was per-card until 2026-09-11** and is now compact; the same fix has not been applied
   to per-figure "Computed by Weathra / View analysis", which repeats 4–6 times per card.
7. **Technical subtitle habit.** Tiles and figures carry their method as their subtitle rather than
   their comparison.

**Shared primitives Step 2 should introduce** (and only these): `PageHeader` (title, subtitle,
inline controls), `MetricTile`, `CardGrid` (equal-height, N-across, responsive), `TwoColumn` (66/33
by default), `ChartCard` (fixed aspect, agreed axis density), `InsightRail`. `CompactProvenance`,
`WeatherIcon`, `UsageMeter`, `EmptyState` already exist.

## 7. Step-2 implementation plan

| Phase | Scope | Backend? |
|---|---|---|
| **A** | Shared primitives above; apply to two screens as proof | none |
| **B** | `weather_code` through provider → domain → schema → openapi → `WeatherIcon`; plan model tier in `/plans` | **two small additions** |
| **C** | Dashboard (hero, forecast card, anomaly/What-Changed/computed to rail, baseline chart) | none |
| **D** | Plan & Usage (tile row, entitlements from real allowances + model tier, fill the void); plan selection unchanged | uses B |
| **E** | Compare (two hero cards, delta icons, kill the bars); Explorer (control bar, matrix conditions + UV, drop hero image); Historical (header, tile subtitles, chart scaling) | uses B |
| **F** | Analyst (collapse answer cards, move image to rail); Travel (day-by-day outlook, viability gauge, re-point ranking); Saved Locations (4-across dense card) | none |
| **G** | Evidence, Settings, Report, Scenario, Watch — structure to artifact; Watch keeps truthful empty states for scheduler-dependent regions | none |

**Deferred by infrastructure, not by choice:** watch scheduling, activity feeds, refresh countdowns,
notifications, evaluation history, billing, prices, invoices, station and sensor identity, model
convergence and any second-provider comparison.

## 8. Current status, for the record

| Screen | Status now | Priority |
|---|---|---|
| 01 Dashboard | NOT CLOSE | P0 |
| 10 Plan & Usage | NOT CLOSE | P0 |
| 04 Compare | NOT CLOSE | P1 |
| 11 Explorer | NOT CLOSE | P1 |
| 15 Travel | NOT CLOSE | P1 |
| 03 Historical | ACCEPTABLE DIVERGENCE | P1 |
| 06 Saved Locations | ACCEPTABLE DIVERGENCE | P2 |
| 02 Analyst | CLOSE | P1 |
| 08 Authentication | CLOSE | P2 |
| 05, 07, 09, 12, 13, 14 | UNASSESSED (production not photographed in this pass) | P2 |

**CLOSE 1 · ACCEPTABLE 2 · NOT CLOSE 6 · UNASSESSED 6.** No screen is graded on the strength of
this audit; these are the pre-Step-2 positions.

## Historical Analytics — 2026-09-12 (task 34.38)

**Visily target.** `03-historical-analytics.png`: one header row (mark, title, place, window pill,
unit toggle, EXPORT DATA), six equal metric cards, a dominant combined plot with a compact metadata
footer, then a two-column band — the baseline comparison on the left with three tiles over deviation
meters, an intelligence card on the right — and a provenance strip.

**Production before.** The band order was already right and almost nothing else was. The header was
a title, a sentence describing the screen, a full-width window disclosure, a labelled radio group
and a sentence about the toggle — five rows before the first figure. The metric row was six cards
captioned with their own formulas (`arithmetic mean of usable points · 48 points`) and drew the
extremes as two cards with no pressure card at all. The plot sat in a scroll container that
advertised itself as scrollable, so a grey edge fade ran down the right of the figure and the region
took a keyboard tab stop with nothing to reach; three days of precipitation drew three bars the
width of the plot and the temperature series vanished behind them. The left card ran nine lines of
method under two figures with a "View analysis" beside each; the deviation meters were a separate
card below it, a panel away from the z-score they are drawn from. Period-against-period took the
full content width under all of it.

**Production after.** One header row. Six cards, always six, each captioned with a fact — a spread,
a delta — and an unavailable one saying so compactly in the place the figure would have been. The
plot is the page's dominant figure at `clamp(260px, 34vw, 420px)`, with capped bars and no scroll
container. The left card is three tiles over the deviation meters with every figure and method one
press in; the right card is a status, a deterministic reading composed only from figures already on
the screen, and the distribution the percentile was taken against. Period-against-period is intact
behind `Compare with another period`.

**Verdict: PASS.**

**Truthful divergences.**

* **No 30-year normal.** The artifact compares against `WMO-1991-2020-NORMAL` for `STATION BER-09`.
  Weathra has a finite baseline of archive years and names it: *Selected period vs historical
  baseline*, *the 4-year baseline for this calendar period*. Calling five years a climate normal
  would be the fabrication this screen exists to avoid.
* **No confidence score and no node count.** The artifact's footer reads `CONFIDENCE SCORE 98.4%`
  and `SOURCE COUNT 14 Nodes`. Neither is a figure any endpoint produces, so neither is drawn; the
  coverage the archive actually reported is stated on the plot instead.
* **No ERA5, no station, no local observations.** One provider, named.
* **The anomaly card reads deterministically.** The artifact's is badged AI INTERPRETATION over a
  paragraph about the North Atlantic jet stream and a claim about 1995. Nothing here is written by a
  model: the status is the sign of a computed difference and the sentences are the z-score and the
  percentile in words. It is badged DETERMINISTIC, which is a different claim rather than a quieter
  one.
* **The capture's provider reads `stub-provider`.** The capture harness is a stub and says so;
  production reads Open-Meteo.
* **Pressure reads "not reported"** for this window, because the archive supplied none. The card
  stays so the row keeps its rhythm.
