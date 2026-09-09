# Runtime fidelity audit — the eight screens in the states people actually meet

**Date:** 2026-09-08 · **Auditor:** Claude Opus 5 · **Requested by:** the product owner, whose brief
was explicit: *audit all eight current screens including real runtime states — populated, empty,
loading, error, unauthenticated — and do not limit the audit to fixture or happy-path screenshots.*

Task 21.9's review ([`fidelity-review.md`](fidelity-review.md)) compared each screen's *source*
against its artifact, and recorded as its own first limitation that nobody had looked at the running
application. Its §6 fidelity-fixture pass then photographed all eight screens — but in fixture mode,
which draws the artifacts' own content. Neither exercise ever looked at what a signed-in person sees
when a provider reports nothing, when a call fails, when an account is new, or while a screen is
still loading.

This audit is that missing half. It is not a second opinion on the earlier ones; it looks at
different pictures.

---

## 1. Method

The **real production build** — `next build` then `next start`, fixtures **off** — driven by
Playwright against the two offline stubs the browser suite already uses
([`tests/e2e/README.md`](../../frontend/tests/e2e/README.md)). Every line of Weathra in the path is
the shipping one; only the identity provider and the FastAPI backend are stood in for.

Thirty-eight full-page screenshots at 1440×900, plus three at 390×844, plus a text dump of every
screen in three failure shapes:

| State | How it was produced |
|---|---|
| **populated** | The stubs' own fixture data |
| **empty** | `me/locations` → `{count: 0, locations: []}`, `me/preferences` → `default_location: null`, `threads` → `[]` — a new account |
| **loading** | Every `/api/v1/**` call held open for 30 s; photographed mid-flight |
| **error** | Every `/api/v1/**` call answered `503` in Weathra's error envelope |
| **raw failure** | Every call answered `500` with an HTML body and no envelope — the shape the frontend cannot parse |
| **unauthenticated** | `/sign-in`, `/create-account`, and a protected route requested while signed out |
| **answered / refused** | A real streamed run; then the agent endpoints answering `503`, which is the production Analyst blocker's own user-facing state |

Classification, as the brief set it:

- **A** — matches the artifact, or diverges for a reason already recorded.
- **B** — a mechanical drift or defect: fix it as it stands.
- **C** — the screen has drifted in *character*, not detail: redesign with progressive disclosure,
  losing no information.
- **D** — a deliberate divergence to record and keep.

---

## 2. Two findings that were the harness, not the product

Recorded first, because both looked exactly like defects and neither was.

**The whole application crashed in the empty state.** Every one of the seven signed-in screens
rendered `Application error: a client-side exception has occurred`. The cause was this audit's own
fixture: it answered `me/locations` with `{saved: []}` where the contract says `{locations: []}`, and
`data.locations.length` threw. Corrected in the fixture. It is worth saying plainly that the earlier
byte-identical file sizes across all seven screens are what exposed it — the pictures agreed too
well to be seven different screens.

**"Berlin, Germany, Berlin, DE"** appeared as a saved-location card title and in the Settings
default-location list, and read as a name being concatenated with itself. The API stub set
`display_name: "Berlin, Germany"` — a name already carrying its country — which every
display-name + region + country composition then qualified a second time. The geocoder returns the
bare settlement name. Fixed in `tests/e2e/weathra-api-stub.mjs`, together with two other
already-qualified stand-ins (`"Hamburg, Hamburg, DE"`, and the resolver's `` `${query}, ${query}, DE` ``),
with a comment recording why: a stand-in that misreports the shape of the thing it stands in for
costs more than it saves.

---

## 3. Per-screen findings

### 01 · Dashboard — `01-dashboard.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 1.1 | Loading and error states render **no page heading** — an unnamed page with six grey lines, or one red box | B | fixed |
| 1.2 | The loading placeholder is six text lines; the screen that arrives is a hero band over a two-column grid | B | fixed |
| 1.3 | The provenance line under each computed figure is a three-line paragraph, repeated down the column | C | fixed (§4.1) |
| 1.4 | Empty state (no default location) is correct: heading, plain sentence, one primary action | A | — |
| 1.5 | The error state names no configuration and offers a retry | A | — |
| 1.6 | The hero is far less dominant than the artifact's: the temperature is not the largest thing on the screen, and there is no metric cluster | C | fixed (§8.1) |
| 1.7 | "Brief me on a place" is a form above the fold; the artifact has only the top-bar search | C | fixed (§8.1) |
| 1.8 | Day cards carry no condition glyph; the artifact's carry one each | B | fixed (§8.1) |
| 1.9 | No closing status rule | D | recorded — the artifact's carries a fabricated system hash and version string |

### 02 · AI Weather Analyst — `02-ai-weather-analyst.png`

The screen the owner named. The artifact's right rail — AGENT STATUS, ACTIVE DATA SOURCES, ANALYST
CONTEXT, SYNTHESIS CONFIDENCE, "View Full Agent Evidence" — is **in the approved design**, beside a
dominant conversation column. The drift was never the rail's existence; it was everything about
which parts of the reply the composition made loud.

| # | Finding | Class | Status |
|---|---|---|---|
| 2.1 | The answer is set at the same size as the caveat above it and the provenance below it | C | fixed (§4.2) |
| 2.2 | Six lines of orchestration under every answer — routing, agents and statuses, tools, knowledge cited, request and evidence ids | C | fixed (§4.3) |
| 2.3 | "What this answer resolved to" repeats the rail's Analyst context verbatim, on the same screen | C | fixed — now a disclosure on the answer; the rail keeps the plain copy |
| 2.4 | "RUN PROGRESS — 8 steps" sits **above** every answer | B | fixed — it follows the answer, and leads only while streaming |
| 2.5 | A failed run renders "RUN PROGRESS — no steps": a heading for an empty log, over a failure notice | B | fixed — a settled run with nothing to report renders nothing |
| 2.6 | After a failed first question the header still reads "No conversation open yet. The first question starts one." | B | fixed — three states, the middle one true |
| 2.7 | Idle and failed states render four rail panels, each a paragraph explaining what it will eventually contain | C | fixed — one line before the first run; short factual lines after one |
| 2.8 | The observed card shows three "Not reported" rows *and* a sentence saying the run retrieved no observation | B | fixed — the sentence, or the rows, never both |
| 2.9 | The failure state names no environment variable, no secret, no provider credential and no configuration instruction | A | verified, all three failure shapes |
| 2.10 | No "History" control, which the artifact carries | D | recorded in `screens.md` §8: the threads endpoint exists, no screen lists them, and a control with nowhere to go is worse than none |
| 2.11 | The interpretation footer prints "Location: not reported · Period: not reported" for a language-model call, where neither field applies | B | **not done** — see §6 |

### 03 · Historical Analytics — `03-historical-analytics.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 3.1 | The baseline column carried **eight** stacked three-line provenance paragraphs, the tallest content on the screen | C | fixed (§4.1) |
| 3.2 | `temperature_mean: mean` — an API measure key — printed in a sentence addressed to a person | B | fixed → "Mean temperature (mean)" |
| 3.3 | Six bare `<input type="date">`, a `<select>` and a number field open the screen; the artifact has one date-range control, a °C/°F toggle and an Export action | C | fixed (§8.2) |
| 3.4 | Metric tiles carry no icon and no delta caption; five of seven wrap awkwardly | B | fixed (§8.2) |
| 3.5 | The left column ends well above the right, leaving a tall void | B | fixed (§8.4) |
| 3.6 | No unit toggle and no export control | B | fixed (§8.2) |
| 3.7 | The artifact's "Anomaly Intelligence" narrative and KEY INSIGHTS are not reproduced | D | recorded — they are model-written claims about invented figures |

### 04 · Compare Cities — `04-compare-cities.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 4.1 | **`location_not_found` printed to the person who typed the name**, beneath the sentence that already explained it | B | fixed — the code is now `data-failure-code` on the row; the reason stays |
| 4.2 | Per-candidate provenance repeated the three-line paragraph inside every card | C | fixed (§4.1) |
| 4.3 | Ranking cards state the same figure twice — once as the headline, once as a "mean · Temperature" row | B | fixed (§8.3) |
| 4.4 | The comparison chart draws flat full-height bars in the ANALYTICS violet, used as a series colour | B | fixed (§8.3) |
| 4.5 | The query form stays at full height above the results; the artifact replaces it with a compact toolbar | C | fixed (§8.3) |
| 4.6 | "How this comparison was made" is a table of machinery, partly "Not reported" | C | fixed (§8.3) |
| 4.7 | No "Comparison Synthesis Summary", no EXPORT PDF, no synthesis-confidence meters | D | recorded — narrative and a run-level confidence score Weathra does not compute |

### 05 · Agent Evidence — `05-agent-evidence.png`

This is the screen where machinery belongs, and the populated record is the closest of the eight to
its artifact.

| # | Finding | Class | Status |
|---|---|---|---|
| 5.1 | `/evidence` with no run selected renders seven empty panels that read as seven sections which failed to load | C | fixed — one line names them as the sections a run's record fills |
| 5.2 | The grounded-sources table is cut mid-word at the panel edge with nothing indicating the rest is one swipe away | B | fixed — an inset shadow at the trailing edge of any scrollable region (an inset shadow rather than a mask, which would clip the focus ring on the same element) |
| 5.3 | The record is keyboard-reachable, the table is a named focusable group exactly when it overflows | A | verified — `ScrollRegion` |
| 5.4 | No "Audit Stability Index", no signature hash, no chain of custody | D | recorded — the record says plainly it is kept for observability, not as a compliance artifact |
| 5.5 | Left column ends well above the right | B | fixed (§8.4) |

### 06 · Saved Locations — `06-saved-locations.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 6.1 | Three panels — "Node health index", "Workspace summary", "Live metadata" — each counting the same list, over a status strip counting it a fourth time | C | fixed — one "What you have saved" panel, with the allowance meter |
| 6.2 | "Telemetry sync — Not measured" and "Latency — Not reported": rows that will say that on every account forever | C | fixed — removed. They held the artifact's shape where Weathra has no measurement; a row about no figure is not provenance |
| 6.3 | Every card's largest element is a red `Remove Berlin, Germany` button, wrapping to two lines | B | fixed — a small `Remove` with the place name kept as its accessible name |
| 6.4 | "ALL NODES NOMINAL" — invented telemetry language for "nothing is wrong" | B | fixed → "Room to save more" |
| 6.5 | The empty state says "save a place above", pointing at a collapsed disclosure | B | fixed — the add form opens when the list is empty |
| 6.6 | Cards lead with coordinates and time zone where the artifact leads with current conditions | D | recorded — conditions per card would be one provider call per saved place on every page load |

### 07 · Settings — `07-settings.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 7.1 | Structure, tab set and control grouping match the artifact | A | — |
| 7.2 | Native `<select>` chrome against the artifact's styled controls | B | fixed (§8.2) |
| 7.3 | "Your choice." repeated under each control | B | fixed (§8.5) |
| 7.4 | Tabs carry no icons | B | fixed (§8.5) |
| 7.5 | No Time Format or Primary Timezone control | D | recorded — neither is an MVP preference |

### 08 · Authentication — `08-authentication.png`

| # | Finding | Class | Status |
|---|---|---|---|
| 8.1 | A protected route requested while signed out lands on sign-in, having rendered nothing | A | verified byte-identically |
| 8.2 | The primary action is dark teal where the artifact's is bright cyan | A | **not drift** — `accent` is `#22d3ee` dark / `#0b6a83` light, and this is the one light screen. The artifact's cyan-on-white would fail contrast; [`tokens.md`](tokens.md) records the decision |
| 8.3 | The decorative particle ground is a plain gradient in production | D | recorded — drawn in fixture mode |
| 8.4 | No "Remember me" | D | recorded — Supabase sessions persist |
| 8.5 | A refused-credential state was **not** photographed | — | the auth stub accepts any password, so this audit could not produce it. Component tests cover it; a browser photograph of it does not exist. Stated rather than claimed |

### Responsive

1440, and 390 for the Dashboard, Analyst and Historical Analytics. All three reflow to a single
column with no horizontal page scroll. The Dashboard at 390 is 5 323 px tall, which is a consequence
of the density findings above rather than a separate defect.

---

## 4. The four redesigns, and what each preserved

### 4.1 The analytics provenance line

`MethodNote` rendered `Computed by Weathra, deterministically, from retrieved values. Method: …
48 points used. Unit: °C.` as one paragraph, with the first sentence emphasised in the ANALYTICS
violet, beneath every computed figure. Historical Analytics stacked eight of them.

Now: **`Computed by Weathra · Method: <method>`** on the face of the line, with the full
deterministic sentence, the points used, the points excluded and the unit inside a `<details>` on the
same line. `reason` never moves — a figure that could not be computed says so where the figure would
have been.

Nothing was removed. `design-system.md` §9 requires the method that produced a computed figure to be
named in its provenance line, and it is named, unopened.

### 4.2 The answer is the largest thing in the reply

A new `lead` type role — Inter, 1.0625 rem/1.6, weight 400 — one step above `body`, recorded in
[`tokens.md`](tokens.md) and `lib/design/tokens.ts`, applied through a `prominence` option on
`InterpretationPanel` and used by the Analyst's answer and nowhere else. The badge, the boundary
sentence, the model attribution and the region are unchanged: the caveat still sits above the prose,
it simply no longer competes with it.

### 4.3 "How this answer was produced"

Routing, the agents and their statuses, the tools, the knowledge cited and the two identifiers now
sit inside one disclosure under that summary. Two things deliberately stay outside it: whether the
answer is **partial**, which is a fact about the answer rather than about how it was made, and the
**View full agent evidence** link, which is the artifact's own affordance and the route to the whole
record.

### 4.4 A rail that does not explain itself

Before the first question the Analyst rail is one card — *ask a question and this fills in with the
agents that ran, the providers they read, what the answer resolved to, and the evidence record behind
it.* The artifact's four panels, in the artifact's order, appear as soon as there is a run to
describe. Their per-panel fallbacks are now short statements about that run ("This run named no
agents") rather than paragraphs about the panel.

---

## 5. One more defect, found in the text dumps rather than the pictures

A `500` with an HTML body — a proxy, a gateway, a crash before the middleware — reached the reader as
its own `statusText`: **"Internal Server Error"**, under Weathra's heading, in Weathra's voice. The
client now composes its own sentence and keeps the status number, which is the part worth quoting;
the upstream's wording is kept in `details.status_text` for whoever debugs it.

The same dumps confirm what is *not* leaking: across seven screens in three failure shapes, no
`SCREAMING_SNAKE_CASE` identifier of any kind appears in rendered text, and the only snake-case token
anywhere was `temperature_mean`, now relabelled.

---

## 6. What this audit did not fix

Named plainly, because the brief asked for category B fixed and category C redesigned, and the two
items below are neither done nor abandoned. Neither is a regression.

The other eight entries this section carried on 2026-09-08 were closed in the pass of 2026-09-09,
recorded in §8. Their per-screen rows above now read `fixed`, each pointing at the subsection that
says what changed and what it preserved.

1. **The interpretation footer's inapplicable fields** (2.11). Left deliberately, and still:
   `AttributionFooter` renders provider, location, period and retrieval on every surface because
   `specs/web-ui` requires it on every weather-bearing surface, and narrowing that primitive on this
   audit's own judgement is a change to a guarantee rather than to a layout. **It wants a decision,
   not a patch**, and it is the one open item that cannot be closed by editing a screen.
2. **A photographed refused-credential sign-in** (8.5) — the auth stub accepts any password, so this
   state has no browser photograph. Component tests cover it. Stated rather than claimed.

## 7. Verification of the changes of 2026-09-08

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm test` — 1 141 passed, 60 files.
- `npx playwright test` — 128 passed, Chromium and Firefox, including the axe and manual
  accessibility suites.
- `npm run build` — clean production build.
- Every screen re-photographed in all five states after the changes, and compared again.

Six existing assertions changed, none weakened; each now checks the same fact at its new location and,
where a disclosure was introduced, checks **both** halves — that the summary carries the claim, and
that opening it still yields every word that used to be on the page.

---

## 8. The second pass — 2026-09-09

The eight items §6 carried, closed. The brief was the same one: category B fixed as it stands,
category C redesigned with progressive disclosure, **losing no information**. Every subsection below
says what moved and what stayed, because "folded away" and "removed" look identical in a screenshot
and are not the same thing.

### 8.1 The Dashboard hero, its briefing form, and the day glyphs (1.6, 1.7, 1.8)

A `readout` type role — 3.25rem, one step above `display` — recorded in [`tokens.md`](tokens.md) and
`lib/design/tokens.ts`, taken by the observed temperature and by nothing else on the screen. The
place name beside it drops to `heading`, so the band has exactly one thing at its own size, which is
what `01-dashboard.png` builds around. The four secondary measures take the artifact's inset ground
and read as one cluster rather than four labels floating in the band.

The place entry folds into a disclosure — *Brief on another place* — and stays open in the three
states where naming a place is the thing to do: no default location, an unsettled entry, or a
briefing about a place that was named rather than the default, because the way back to the default
lives inside the form. Collapsing over an empty state that points into the form is finding 6.5's
mistake on Saved Locations, and it is not repeated.

Day cards carry a precipitation glyph with its figure, accented when the day is wet.

### 8.2 The two query forms, and the platform's own chrome (3.3, 3.4, 3.6, 7.2)

Historical Analytics opens on the artifact's header row: the selection stated in one line —
place, window, baseline window, baseline length — with the whole form behind it, a °C/°F toggle, and
an Export control. **The toggle changes the reading only**, and says so: `specs/memory` is explicit
that a preference is never inferred from behaviour, and switching a screen to Fahrenheit to look at
one window is not a decision to store. The export writes what the response returned, in the units it
returned, with an empty cell wherever the archive reported nothing — never a zero
(`lib/historical/export.ts`, with the honesty properties under test).

Metric tiles gained a glyph and a delta caption, both optional and neither computed here: the glyph
is decorative and `aria-hidden`, and the caption is a figure the backend produced, formatted by the
caller like `value` itself.

The `<select>` chevron and the `<input type="date">` calendar button are drawn in the palette's own
colour, with the platform's returned under forced colours. The elements and their behaviour are
untouched — the native picker is what makes them keyboard-operable everywhere, for free.

### 8.3 Compare Cities (4.3, 4.4, 4.5, 4.6)

**Each figure once.** `comparableFigure` promotes the first supporting statistic to the headline, and
the list beneath drew it again — 23.7 °C above "mean · Temperature 23.7 °C". The headline now carries
the statistic's own name and its method note, and the list holds the statistics the headline is not.
A card whose only statistic *is* the headline renders no list rather than an empty one.

**The bars wear the class of the figures they are.** They were the ANALYTICS violet on every
comparison — the colour of the ranking, which is a computation, on marks that are deliberately not
the score. They now take the result's own `data_class`, exactly as the two Historical Analytics
charts colour their observed and computed series, and `SharedBasis` badges that same class in words
beside the chart, so the colour repeats a stated fact rather than carrying one alone. Every class
colour is held to 3:1 against `surface-raised` by `lib/design/tokens.test.ts`, whose stated reason is
that a class colour is also a chart series.

**The query folds** once there is a ranking, summarised as *N places · ranked by … · N days ahead*,
and stays open before anything has been compared, while a row blocks the comparison, and while an
ambiguous name waits on a candidate.

**"How this comparison was made"** is one sentence on the face — how many candidates, ranked by what,
over which window — with its fields behind a disclosure and its two raw enums said in words. The
three rows `SharedBasis` states verbatim a few centimetres above (statistics applied, tie tolerance,
local-time basis) are dropped from here rather than folded: the same fact twice on one screen is
finding 2.3's mistake, and the screen loses nothing by not saying them twice. The composite
criterion's weighting statement is the one duplicate kept — whose heuristic the weights are is a
disclosure obligation, not something to state once and hope the reader was looking.

### 8.4 Column height (3.5, 5.5)

Both two-column rows stretched rather than started, with the last panel in each column taking the
slack, so a row closes level instead of leaving a column-tall void beside the taller side.

### 8.5 The small text items (7.3, 7.4)

"Your choice." appeared under every Settings control. The rule is now stated once at the top of the
form — *each control below holds your own choice unless it says otherwise* — and only the exceptions
are marked. The distinction that note carried is the guarantee, and it is asserted at both of its new
locations: a default still says plainly that it is not a decision the person made.

The four Settings tabs carry the artifact's glyphs, `aria-hidden`, so nothing a screen reader hears
changed.

### 8.6 One regression this pass introduced and closed

The metric tile's new glyph made its header a three-element row that did not fit: at 900 pixels the
class badge left the tile by exactly the glyph's width, and the page scrolled sideways. The header
wraps now, and the badge drops under the label. Caught by `accessibility.spec.ts`'s own
overflow sweep rather than by looking, which is the point of having it.

### 8.7 Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm test` — 1 162 passed, 61 files.
- `npx playwright test` — 128 passed, Chromium and Firefox, including the axe and manual
  accessibility suites.
- `npm run build` — clean production build.

Twenty-one tests were added — seven on Compare Cities, four on the Historical toolbar, two on the
Dashboard entry, and eight on the CSV export, which had none. One was changed: the browser check of
the candidate chooser's heading now opens the Dashboard's disclosure first, the way a person does.

Every added test for a fold checks **both halves** — that the screen no longer says the thing twice
or above the fold, *and* that the field or the figure behind the summary is the same one it was — so
a fold that quietly became a deletion would fail rather than pass more quietly than before.
