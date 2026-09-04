# Visual-fidelity review — task 21.9

The formal review task 21.9 requires: every implemented MVP screen compared against its approved
Visily artifact, every deliberate divergence recorded with its reason, and the review recorded under
`docs/design/`.

**Date:** 2026-09-04 · **Reviewer:** Claude Opus 5, by source and artifact inspection · **Method:**
each of the eight approved PNG artifacts under [`screens/`](screens/) was opened and read, then
compared against the implemented markup and stylesheets for that screen. No artifact was modified.

**What this review is, and is not.** It is a comparison of implemented structure against approved
artifacts, carried out by reading both. It is **not** a human visual walkthrough of the running
application: no person has sat in front of these twelve screens and compared them to the artifacts
side by side. Where that matters — the subjective "does it feel like the design" judgement — it is
recorded as a limitation in §8 rather than claimed. The related manual accessibility pass is
separately incomplete and is recorded in
[`accessibility-manual-pass.md`](accessibility-manual-pass.md); task 21.8 remains open.

---

## 1. The eight approved artifacts, all reviewed

| Artifact | Screen | Read | Notes taken in |
|---|---|---|---|
| `screens/01-dashboard.png` | Dashboard | yes | §3.1 |
| `screens/02-ai-weather-analyst.png` | AI Weather Analyst | yes | §3.2 |
| `screens/03-historical-analytics.png` | Historical Analytics | yes | §3.3 |
| `screens/04-compare-cities.png` | Compare Cities | yes | §3.4 |
| `screens/05-agent-evidence.png` | Agent Evidence / Activity | yes | §3.5 |
| `screens/06-saved-locations.png` | Saved Locations | yes | §3.6 |
| `screens/07-settings.png` | Settings | yes | §3.7 |
| `screens/08-authentication.png` | The shared authentication shell | yes | §4 |

All eight were included. None was altered.

## 2. Artifact-to-screen mapping, and the fifteen MVP screens/states

Seven product screens have their own artifact. The eight authentication screens share
`08-authentication.png` as the approved shell, which [`screens.md`](screens.md) §3 records as
sufficient: those screens differ in copy, action and disclosure rules, all fixed by
`specs/authentication` and none of them a visual question.

| # | Screen / state | Artifact of record | Fidelity result |
|---|---|---|---|
| 1 | Dashboard | `01-dashboard.png` | Faithful, with recorded divergences |
| 2 | AI Weather Analyst | `02-ai-weather-analyst.png` | Faithful, with recorded divergences |
| 3 | Historical Analytics | `03-historical-analytics.png` | Faithful, with recorded divergences |
| 4 | Compare Cities | `04-compare-cities.png` | Faithful, with recorded divergences |
| 5 | Agent Evidence / Activity | `05-agent-evidence.png` | Faithful, with recorded divergences |
| 6 | Saved Locations | `06-saved-locations.png` | Faithful, with recorded divergences |
| 7 | Settings | `07-settings.png` | Faithful, with recorded divergences |
| 8 | Sign In | `08-authentication.png` (shell) | Faithful; one correction, §6 |
| 9 | Create Account | `08-authentication.png` (shell) | Faithful |
| 10 | Verify Email / Enter Verification Code | `08-authentication.png` (shell) | Faithful |
| 11 | Verification Successful | `08-authentication.png` (shell) | Faithful — shell success treatment |
| 12 | Verification Failed / Expired Code | `08-authentication.png` (shell) | Faithful — shell error treatment, two distinct states |
| 13 | Resend Verification Code | `08-authentication.png` (shell) | Faithful — three states in the shell |
| 14 | Forgot Password | `08-authentication.png` (shell) | Faithful |
| 15 | Reset Password | `08-authentication.png` (shell) | Faithful |

Fifteen screens/states, each mapped to an approved artifact. States 11–13 are states of the
verification screens rather than separate routes, which is how `specs/authentication` and
[`design-system.md`](design-system.md) §12 define them.

## 3. Product screens, artifact by artifact

Each section records what the artifact establishes, what the implementation does, and any divergence
**not already recorded** in [`screens.md`](screens.md) §5 (set-wide exceptions) or §8 (the
implementation divergence log). Those two records were read first, as
[`design-system.md`](design-system.md) §15 directs; this review does not restate their entries.

### 3.1 Dashboard — `01-dashboard.png`

**Reproduced:** the command-centre shell with persistent left navigation; the compact,
information-dense card language; the dark ground with a single cyan accent; the badge system across
five data classes with consistent placement; the attribution line beneath data-bearing surfaces; the
named *Weathra Intelligence*, *What Changed?* and *Why?* surfaces; the deterministic-analytics block
presented separately from interpretation; the seven-day forecast strip as a row of per-day cards.

**Already recorded elsewhere:** the breadcrumb and header search replaced by a heading and subtitle
(§8, task 21.8); the location entry the artifact does not depict (§8, task 21.7); the candidate
chooser (§8, task 21.7); the hero city photograph, station identifier, confidence matrix, "Compare
Models", the candlestick baseline panel, the invented "42% Integrated Risk" and the footer's system
hash and version string (§5).

**Newly recorded here** — three divergences the log did not carry:

| Divergence | Class | Reason |
|---|---|---|
| The Dashboard renders **no chart**, where the artifact has two chart panels ("Climate Pulse Analytics", "Climate Baseline Comparison") | B — deliberate | The candlestick panel is already refused in §5. The remaining one is a 24-hour intra-day dual-axis plot, and both halves fail: a second y-axis makes any relationship between the two curves an artifact of where the axes were placed, which is the reason already recorded for `03` and `04`; and no endpoint behind this screen returns an hourly series — `/weather/current`, `/weather/forecast`, `/weather/analysis` and `/weather/changes` return current conditions, daily periods, statistics and deltas. Drawing it would mean an extra retrieval this screen's question does not ask for. The figures it would have plotted are present as badged, attributed readouts. |
| No "Saved snapshots" panel listing other locations with their temperatures | B — deliberate | It is a conditions readout per saved location, which §8 already refuses on Saved Locations itself for the same reason: one weather request per location, each with its own loading and failure state, for data the Dashboard already presents properly for the one place the person chose. The saved list is reachable from the navigation. |
| No notification bell and no user avatar in a top bar | B — deliberate | A notification indicator is condition monitoring, which is Weather Watch — post-MVP — and §5 already refuses the artifact's alerting copy on `06`. The signed-in identity and the sign-out control are in the left navigation, where [`design-system.md`](design-system.md) §5 puts them, and §5 replaces the artifact's "Dr. Aris Thorne" persona with the session's own identity. |

### 3.2 AI Weather Analyst — `02-ai-weather-analyst.png`

**Reproduced:** the thread as a thread, with earlier turns and their data-class labels intact; the
"using context from this conversation and your preferences" line, which is both memory tiers on
screen as [`screens.md`](screens.md) §2 requires; the AI INTERPRETATION badge on the answer and its
visually distinct panel; the observed/forecast figure blocks badged separately from the
interpretation; the composer with its starter prompts.

**Already recorded elsewhere:** the right-hand rail not reproduced as a rail, with the real
provenance rendered inline (§8); the evidence link (§8, closed by task 21.5); generic starter prompts
naming no place (§8); the agent version string, compute load, "Active Data Sources" imagery with its
invented sources, synthesis-confidence figure, and the `AGENT INTERPRETATION` second label (§5).

**Newly recorded here:**

| Divergence | Class | Reason |
|---|---|---|
| No "History" or "New Analysis" control in the screen header, and no FOCUS/DEPTH selectors above the composer | B — deliberate | `specs/http-api` exposes threads but no endpoint enumerating a person's runs for a history browser, and the MVP criteria for task 21.2 are question entry, streamed progress, the labelled answer, thread continuity and the unavailable case. A FOCUS selector duplicates the location the thread already resolved, and a DEPTH selector implies a caller-selectable model or effort setting, which `specs/model-policy` places on the server and not with the caller. |

### 3.3 Historical Analytics — `03-historical-analytics.png`

**Reproduced:** the screen title with its location context; the row of ANALYTICS metric tiles, each
with its badge, value, unit and supporting note; the chart panel with HISTORICAL and ANALYTICS
badges and a legend distinguishing recorded from baseline; the period-against-baseline panel with its
delta, z-score and percentile figures; the deterministic-analytics framing throughout.

**Already recorded elsewhere:** two single-axis charts rather than one dual-axis chart (§8); the
data-class series colours (§8); no °C/°F toggle (§8); the "Anomaly Intelligence" panel not
implemented (§8); the station identifier, invented source names, "Recalibrate Baseline Models",
"Export Data", the 98.4% confidence score and "14 Nodes" source count (§5).

**Newly recorded here:**

| Divergence | Class | Reason |
|---|---|---|
| The single date-range control is implemented as two explicit periods — "Selected period, from/to" and "Compare with, from/to" — plus a "Baseline years" field | B — deliberate | The screen answers three questions the artifact shows the results of but not the inputs to: retrieval over a period, a period-against-period comparison, and a period-against-baseline comparison. Two periods and a baseline span are what those require, and task 21.3's criteria name all three. A single range could not express the comparison the artifact's own lower panel displays. |
| The "Deviation Analysis" progress bars (temperature drift +24%, precipitation lag −12%, atmospheric instability +18%) are not implemented | B — deliberate | Three figures with no computed basis behind them, of the same class §5 already refuses as fabricated telemetry and invented confidence. `specs/analytics` computes a delta, a z-score, a percentile and threshold counts; "precipitation lag" and "atmospheric instability" are not among them, and a bar with an invented percentage is the presentation §5 exists to stop. |
| No decorative thumbnail beside the screen title | B — deliberate | Generated decorative imagery, refused set-wide in §5. |

### 3.4 Compare Cities — `04-compare-cities.png`

**Reproduced:** the two-place comparison as the screen's subject; the per-place cards with their
measured figures; the deterministic-metrics panel; the ranked outcome; the shared window stated in
each place's own local time.

**Already recorded elsewhere:** the "Comparison Intelligence" panel not implemented and no
AI-interpretation region at all (§8); one bar chart replacing the dual-axis and candlestick panels
(§8); no per-day "Forecast Delta Explorer" matrix (§8); place cards with no photography, condition
icon or current-conditions readout (§8); one ambiguous row stopping the comparison (§8); criterion
selection, excluded candidates, more than two locations and the below-two block as per-screen gaps
(§5); "Recalibrate Models", "Export PDF", the city-planner advice, the synthesis-confidence and
correlation figures, and the workspace identifier (§5).

**Newly recorded here:** none. Every difference found is covered by an existing entry.

### 3.5 Agent Evidence / Activity — `05-agent-evidence.png`

**Reproduced:** the two-column record; the execution flow as a per-agent timeline with each step's
tool and timing; the grounded-sources table with provider, resolved location, retrieval period and
data class; the deterministic-analytics block with its method note; the cited-knowledge region; the
final synthesis in its AI INTERPRETATION treatment; the resolved-context panel; the run header with
its status and timings.

**Already recorded elsewhere:** the context panel showing what the run resolved to rather than a
transcript (§8); "Graph steps" and "Agents involved" replacing the header confidence cell, with
uncertainty lower down (§8); tool results inline rather than behind "Inspect Payloads", described by
size (§8); retrieved knowledge carrying no data-class badge and no fragment-count control (§8);
`/evidence` explaining rather than listing (§8); the audit identifier, cryptographic and
compliance wording, "Validate Conclusion", "Export Trace", "View Chain of Custody", the audit
stability index, the invented sources and station identifiers, and the agent version strings (§5).

**Newly recorded here:**

| Divergence | Class | Reason |
|---|---|---|
| The artifact's "MCP Evidence" panel is implemented as "Tool activity" | B — deliberate | The panel's real content is the tool calls the run made, which is what the implemented region shows, with each result beside its call. The artifact's version describes a transport — protocol version, connection state, latency, "full-duplex telemetry" — which is fabricated telemetry of the kind §5 refuses, and naming a region after the transport rather than the evidence would leave the record's most substantive panel titled after plumbing. |

### 3.6 Saved Locations — `06-saved-locations.png`

**Reproduced:** the card grid, its density and its hierarchy; the screen title with its subtitle; the
add control; the filter field; the per-card identity of a saved place.

**Already recorded elsewhere:** cards carrying no conditions readout (§8); no overflow menu and no
"Analytics ›" link (§8); "Quick search nodes" implemented and labelled as a filter over the saved
list (§8); saving by the resolved candidate's coordinates (§8); the candidate chooser (§8); the
remove action and the empty state as per-screen gaps (§5); "Atmospheric Attention Required" and
"Analyze Anomaly", "Model Consensus", the node health index, the workspace identifier, the live
metadata panel and the synthesis panel (§5).

**Newly recorded here:** none.

### 3.7 Settings — `07-settings.png`

**Reproduced:** the tabbed layout; the two-column section pattern with a section title and
description on the left and labelled rows with their controls on the right; the section separation;
the footer with its state line and its actions.

**Already recorded elsewhere:** two of four tabs not implemented (§8); time format, primary time
zone and a separate wind-speed unit not implemented, with the backend-contract reason (§8); the
default location chosen from saved locations (§8); the footer's synced badge and last-save timestamp
replaced by a real state line (§8); the Account tab's three sections (§8); the enterprise-license,
service-status, legal and API-docs links (§5).

**Newly recorded here:**

| Divergence | Class | Reason |
|---|---|---|
| Measurement Units is a **radio group**, where the artifact shows a segmented METRIC/IMPERIAL toggle | B — deliberate | A native radio group is one tab stop with arrow-key movement between options, and carries its own roles and checked state without any ARIA. A segmented toggle would have to reconstruct all of that to be equivalent. The two options also carry their units in their own labels — "Metric: Celsius, km/h, mm" — where the artifact puts them in a description the control does not announce. The visual treatment stays within the design system's control language. |
| The screen heading is "Settings", not "Account Settings" | B — deliberate | The navigation entry is *Settings* ([`design-system.md`](design-system.md) §5), and a screen whose heading disagrees with the navigation entry that reached it is the sort of small dissonance a heading list makes obvious. Sample copy is superseded set-wide by §5. |
| No decorative gear glyph beside the heading | B — deliberate | Decorative imagery, refused set-wide in §5. |

## 4. The authentication shell — `08-authentication.png`

**Reproduced:** the centred card on the page ground; the mark and wordmark above the card; the
display title with one line of context beneath it; the labelled fields with their placeholders; the
password field's visibility control; the secondary route on the same row as the field group; the
single full-width primary action in the accent; the secondary route out beneath the card. All eight
authentication screens reuse this one shell, as [`design-system.md`](design-system.md) §12 requires.

**Already recorded elsewhere:** the primary action's label in `accent-contrast` rather than white,
for contrast (§8); "Remember me" refused (§5); the light appearance being the artifact's, with the
shell implemented from the same tokens in both (§5).

**Newly recorded here:**

| Divergence | Class | Reason |
|---|---|---|
| The password visibility control is a text button reading "Show"/"Hide", not an eye icon | B — deliberate | An icon-only control needs an accessible name supplied separately, and a name that is not visible is a name that cannot be checked by looking. The same decision was already taken for the navigation drawer's control, which carries a visible "Menu" label beside its icon ([`accessibility.md`](accessibility.md) §4). The control keeps the artifact's position inside the field's trailing edge. |
| No generated background imagery behind the card | B — deliberate | The artifact's particle-and-wireframe backdrop is generated decorative imagery, refused set-wide in §5. The shell uses the page ground token, which is what makes the same shell work in both appearances. |
| The mark is a weather glyph, where the artifact's tile encloses a letterform on `08` and a glyph on the other seven | B — deliberate, and noted for a decision | The glyph is consistent across all twelve implemented screens and matches seven of the eight artifacts. `08` alone appears to show a "W" letterform in the tile. No document specifies the mark, so this is recorded rather than corrected: choosing between a letterform and a glyph is a brand decision, not a fidelity defect, and it is not this task's to take. **Unresolved — flagged for the owner.** |

**Corrected, not documented away:** the tile itself. See §6.

## 5. Shared design-system fidelity

| Element | Result |
|---|---|
| Design tokens | Faithful. The palette, the three-level text hierarchy, the five data-class tokens and the four status tokens are all present as semantic tokens; no screen picks a colour. Values were established in task 20.3 from the recorded direction and verified for contrast, never sampled from an export ([`tokens.md`](tokens.md)). |
| Typography | Faithful. Plus Jakarta Sans for display and headings, Inter for body and UI, each used only in its role; tabular numerals on figures. |
| Spacing and density | Faithful. The 4-pixel scale, card padding and section separation of §3 are in the stylesheets, and the compact card language of the artifacts is reproduced. |
| Cards | Faithful. Title with data-class badge, body, and a non-optional attribution footer — never collapsed behind a control and never replaced by a tooltip. |
| Forms | Faithful, with the two control divergences in §3.7 and §4 recorded. Every input labelled; descriptions and errors wired to their field. |
| Buttons | Faithful. One primary action per view in the accent, with `accent-contrast` on it for the contrast reason recorded in §8. |
| Data-class badges | Faithful. Five labels — OBSERVED, FORECAST, HISTORICAL, ANALYTICS, AI INTERPRETATION — consistently placed, each with its token colour, and the class never carried by colour alone because the badge label carries it. One label per class, correcting the artifacts' second `AGENT INTERPRETATION` name (§5). |
| Attribution / provenance | Faithful. Provider, resolved location, period, retrieval and validity times on every data-bearing surface; the deterministic method named on computed figures. |
| AI-interpretation distinction | Faithful, and stronger than the artifacts. Interpretation has its own panel treatment and its own badge, sits beside the figures it discusses, and the four pieces of artifact copy that implied the model produced a numeric value are overridden (§5). Historical Analytics and Compare Cities carry no interpretation region at all, because their endpoints return no model prose (§8). |
| Uncertainty presentation | Faithful. Confidence and ranges appear with their stated basis, and are absent where the backend states none — replacing the artifacts' six invented confidence figures (§5). |
| Loading / empty / error states | Faithful. The four resolutions of §11 are visually distinct and implemented on every surface; the artifacts depict none of them, which §5 records as a per-screen gap the design system fills. |
| Location ambiguity chooser | **No approved artifact depicts it.** Recorded in [`screens.md`](screens.md) §8 and re-confirmed by this review: none of the eight artifacts contains a candidate chooser. Its design lineage is [`design-system.md`](design-system.md) §11, which governs it as one of the honest states, and it takes the caution tone rather than the error tone because an ambiguous name is a question and not a failure. Its absence from the artifacts is **not** a fidelity defect: `specs/web-ui` requires the behaviour, and task 21.7 built it. |

## 6. Shell and navigation fidelity, and the one correction made

| Element | Result |
|---|---|
| Persistent left navigation | Faithful in structure. The artifacts' four-item sidebar is superseded by the official twelve-entry navigation of [`design-system.md`](design-system.md) §5, which §5 of [`screens.md`](screens.md) records as a correction the artifacts do not carry. Post-MVP entries are present and visibly marked not yet available. |
| Signed-in identity and sign-out | Faithful in placement — in the navigation, as §5 puts them — with the artifacts' persona replaced by the session's own identity (§5). |
| Page region | Faithful. One screen to the right of the navigation. |
| Responsive intent | Faithful to the three recorded tiers of §13, verified in two engines. The artifacts depict the desktop tier only. |
| Brand treatment | **One implementation defect, corrected.** |

**The defect.** All eight artifacts show the mark as a glyph inside a **filled accent tile** beside
the wordmark. The implementation drew the glyph alone, tinted with the accent and with no container,
in both the authentication shell and the application shell — a visible divergence on every screen in
the product, with no recorded reason anywhere. Classified **A**, an implementation defect.

**The correction.** A `.brandMark` tile in each shell's stylesheet: the accent ground,
`accent-contrast` for the glyph on it, and `radius-md`. Tokens only, no one-off values, no new
component, and the glyph unchanged. The pairing matters more than the tile — a glyph left at
`accent` on an `accent` ground would be invisible — so `tests/design-rules.test.ts` now asserts that
pairing wherever `.brandMark` is declared, and `tests/e2e/accessibility.spec.ts` asserts the tile is
**painted** in a real browser on both shells, since a structural test would pass on a tile with no
ground. The mark is `aria-hidden`, so no text-contrast requirement applies to it.

**What was deliberately not corrected:** the letterform-versus-glyph question in §4, which is a brand
decision rather than a fidelity defect and is flagged unresolved for the owner.

## 7. What the artifacts were not allowed to override

Recorded because the review turned on it repeatedly. In every case the artifact lost, and the reason
is in §3 or in [`screens.md`](screens.md) §5:

- **Locked architecture** — no station concept, no per-node analytics view, no model recalibration.
- **Functional requirements** — criterion selection, excluded candidates, more than two locations,
  the remove action, session-memory and account-data deletion, the eight authentication states.
- **Accessibility** — the primary action's label colour, heading levels, the visible-label controls
  in §3.7 and §4.
- **Provenance and data-class rules** — one badge label per class; interpretation never presenting
  figures; no confidence figure without a basis.
- **Deterministic analytics** — no invented percentage, no fabricated telemetry, no dual-axis chart
  whose correlation is an artifact of axis placement.
- **Security** — no cryptographic or compliance claim about the evidence record; no "Remember me"
  implying a second session mode.
- **Backend contracts** — no control for a preference the store has no field for; no listing where
  no endpoint enumerates; no chart where no endpoint returns a series.

Nothing was removed from the implementation to resemble an artifact, and no data or UI was fabricated
to fill one.

## 8. Limitations of this review

- **No human visual walkthrough.** The comparison was made by reading the artifacts and the
  implementation. Nobody has viewed the running screens beside the artifacts, so a subjective
  "does the finish match" judgement is not part of this record. What is asserted is structural and
  checkable: which regions, controls, badges, headings and attributions exist, and how they are
  composed.
- **No pixel comparison.** Deliberately, and for the same reason
  [`accessibility.md`](accessibility.md) §1 gives: a pixel diff fails on a font hint and passes on a
  missing attribution. The artifacts are approved for layout, hierarchy and finish, not as a bitmap
  target, and [`README.md`](README.md) says so.
- **The light appearance is reviewed against one artifact.** Only `08` is light. The other seven are
  dark, and the light appearance of the seven product screens is derived from the same tokens rather
  than separately approved — so this review checks it against the token set, not against an artifact.
- **One unresolved item**, in §4: the mark's letterform-versus-glyph question.
