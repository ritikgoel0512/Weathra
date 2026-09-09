# Screen index and design-gate status

> The index required by tasks 19.5 and 24.9 of the `weathra-mvp` change. The design gate and
> every approval below were settled on 2026-09-03; the Implementation column tracks the build
> and was last confirmed on 2026-09-05 against the screens as they stand.

Every MVP screen, the approved artifact recorded for it, and the exceptions recorded against that
artifact. The gate `specs/web-ui` sets is that an approved artifact is **recorded in this
repository** before a screen's implementation is considered complete. That condition is now met:
the eight approved Visily exports are committed under [`screens/`](screens/).

## 1. The recorded artifacts

| File | Screen | Export |
|---|---|---|
| [`screens/01-dashboard.png`](screens/01-dashboard.png) | Dashboard | PNG, 1488 × 2429 |
| [`screens/02-ai-weather-analyst.png`](screens/02-ai-weather-analyst.png) | AI Weather Analyst | PNG, 1488 × 1272 |
| [`screens/03-historical-analytics.png`](screens/03-historical-analytics.png) | Historical Analytics | PNG, 1488 × 1898 |
| [`screens/04-compare-cities.png`](screens/04-compare-cities.png) | Compare Cities | PNG, 1488 × 3074 |
| [`screens/05-agent-evidence.png`](screens/05-agent-evidence.png) | Agent Evidence / Activity | PNG, 1488 × 2332 |
| [`screens/06-saved-locations.png`](screens/06-saved-locations.png) | Saved Locations | PNG, 1488 × 1567 |
| [`screens/07-settings.png`](screens/07-settings.png) | Settings | PNG, 1488 × 1150 |
| [`screens/08-authentication.png`](screens/08-authentication.png) | The shared authentication shell | PNG, 1488 × 988 |

Each carries Visily's "Made with Visily" export watermark, which is the visible evidence that the
gate was satisfied on Visily's freely available export — no paid export capability, no
design-to-code handoff, and no second design tool. The watermark is part of the export, not part of
the design, and is not implemented.

## 2. MVP product screens

| Screen | Artifact | Design status | Implementation |
|---|---|---|---|
| Dashboard — Weathra Intelligence briefing, *What Changed?*, *Why?* | `01-dashboard.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.1) |
| AI Weather Analyst | `02-ai-weather-analyst.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.2) |
| Historical Analytics | `03-historical-analytics.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.3) |
| Compare Cities | `04-compare-cities.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.4) |
| Agent Evidence / Activity | `05-agent-evidence.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.5) |
| Saved Locations | `06-saved-locations.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.6) |
| Settings | `07-settings.png` | Approved 2026-09-03, with the exceptions in §5 | Implemented (task 21.6) |

**What the artifacts establish**, and what implementation takes from them: the Intelligent Command
Center shell with its persistent left navigation and signed-in identity; the compact, data-dense
card language; the dark ground with a single cyan accent; the badge system carrying OBSERVED,
FORECAST, HISTORICAL, ANALYTICS and AI INTERPRETATION as distinct, consistently placed labels; the
attribution and timestamp line beneath data-bearing surfaces; the named *Weathra Intelligence*,
*What Changed?* and *Why?* surfaces on the Dashboard and Compare Cities; the deterministic-analytics
block presented separately from interpretation; and, on Agent Evidence, an execution flow listing
the supervisor and the Forecast, Historical, Analytics and RAG agents with per-step timings beside a
grounded-sources table, MCP evidence, RAG citations, and the context the run used from both memory
tiers.

Two of them are worth calling out because they carry recorded decisions rather than styling:

- **`02-ai-weather-analyst.png`** shows both memory tiers on screen: a thread with its identifier
  and a "using context from this conversation and your preferences" line for short-term
  conversational continuity, and a long-term memory panel for durable preferences. This is the
  presentation of `specs/memory`'s two tiers, and neither is dropped.
- **`05-agent-evidence.png`** shows the run record structure `specs/agent-orchestration` requires:
  every agent that ran, each tool call with its timing, the analytics methods, the cited knowledge,
  and the resolved sources with their data class.

## 3. MVP authentication screens

`08-authentication.png` is the approved **reusable authentication shell** — the mark, title, one
line of context, the form, one primary action in the accent, and the secondary route out. All eight
screens reuse it; separate artifacts per screen are not required, because the screens differ in
their copy, their action and their disclosure rules, all of which `specs/authentication` fixes
precisely and none of which is a visual question.

| Screen / state | Artifact of record | What the spec adds to the shell |
|---|---|---|
| Sign In | `08-authentication.png` | Non-disclosing failure; an unverified account routed to verification |
| Create Account | `08-authentication.png` | Password rules stated before submission; non-disclosing already-registered response |
| Verify Email / Enter Verification Code | `08-authentication.png` | Code entry; the returning-link path completing without further entry |
| Verification Successful | `08-authentication.png` | Confirmation, then continue into the product |
| Verification Failed / Expired Code | `08-authentication.png` | Distinct incorrect-code and expired-code states |
| Resend Verification Code | `08-authentication.png` | In-progress, confirmed and rate-limited states |
| Forgot Password | `08-authentication.png` | Identical response for a known and an unknown address |
| Reset Password | `08-authentication.png` | Rules stated; the expired-reset state |

The shell's loading, error and success treatments are the shared patterns of
[`design-system.md`](design-system.md) §11 and §12, which is where the state coverage lives rather
than in eight near-identical images.

## 4. Post-MVP screens

Not MVP artifacts. Recorded as design-roadmap entries in [`roadmap.md`](roadmap.md).

Seven screens sit here, and they are in two groups that differ in one respect only — whether the
navigation offers them:

| Screen | Route | In the navigation | Artifact |
|---|---|---|---|
| Weather Intelligence Report | `/report` | Yes, marked not yet available | None — roadmap entry (task 19.4) |
| Forecast Explorer | `/explorer` | Yes, marked not yet available | None — roadmap entry (task 19.4) |
| Weather Scenario Lab | `/scenarios` | Yes, marked not yet available | None — roadmap entry (task 19.4) |
| Weather Watch | `/watch` | Yes, marked not yet available | None — roadmap entry (task 19.4) |
| Travel Intelligence | `/travel` | Yes, marked not yet available | None — roadmap entry (task 19.4) |
| Admin Model & AI Usage | `/admin/model-usage` | No — reachable by route only | **Outstanding**, task 33.1 (§7) |
| Plan & Usage | `/plan` | No — reachable by route only | **Outstanding**, task 33.2 (§7) |

The last two carry a design obligation the first five do not: `specs/web-ui` requires an artifact
per screen covering the populated, loading, empty, error and **not-permitted** states, and a
recorded approval, before implementation begins. Their routes exist (task 33.4) and issue no
request; their screens are not designed. [`roadmap.md`](roadmap.md) holds the classification and the
route behaviour.

## 5. Recorded exceptions to the artifacts

The artifacts are approved as visual references. Their sample content is illustrative and is
**not** an implementation requirement. The general rule is in
[`design-system.md`](design-system.md) §15; the specific items below are recorded per screen so
nothing carries forward by accident, and so that a reviewer comparing an implemented screen against
its artifact in task 21.9 knows which differences are intended.

**Everywhere in the set**

| In the artifact | What is implemented instead |
|---|---|
| The four-item sidebar — Dashboard, Analytics, Historical Data, Settings | The official twelve-entry navigation of [`design-system.md`](design-system.md) §5. The mockup sidebar is incomplete, and this is the correction it makes concrete. |
| "Neural Agent v4.2 / v4.8", `v4.8.2-STABLE`, `WEATHRA V4.8.2-PRO`, `STABLE_REL_4.8` | Nothing. The four agents are named as `docs/agents.md` names them; no version string the backend does not report is displayed. |
| Station identifiers — `BER-CENTRAL-09`, `STATION BER-09`, `MUC-SOUTH-21`, `NODE-WX-ALPHA-09` | The resolved location and period actually queried. Weathra has no station concept. |
| Invented sources — GlobalWeatherOS, ECMWF Core / Reanalysis, WMO Historical, Local Hydro-Met, NASA POWER, Weathra MCP Core, ERA5, "Internal PDF Lib", `GLOBAL_SAT`, `L_RADAR` | The actually configured providers as the backend reports them, reached through the MCP weather server. The knowledge corpus is the Markdown corpus under `rag/corpus/`. |
| Workspace, audit, hash and node identifiers — `WX-CMP-9021`, `WX-LOC-772`, `AUDIT ID: WX-EVD-992-ALPHA`, `SYSTEM HASH`, `SIGNATURE HASH`, `NODE HASH`, `LINUX-MET-NODE-772` | Nothing, except the request identifier the backend already returns where one is useful. |
| Fabricated telemetry — "Compute Load 14.2%", "Node Health Index", "Telemetry Sync", "Sensor Calibration", "Grounding Precision", "System Latency 42 ms", "Grounding Nodes 124 Active", "Sources: 124 Nodes" | Nothing. Weathra reports the timings and tool calls it actually recorded, in the evidence record. |
| Invented confidence figures — "Confidence Matrix", "Model Convergence 94%", "Synthesis Confidence 98.2%", "Confidence Score 98.4%", "Correlation Score 96.4%", "Data Density 88.1%" | Uncertainty and confidence as the backend states it, with its basis, per `specs/safety-grounding`. A confidence bar with no computed basis behind it is not drawn. |
| The persona "Dr. Aris Thorne" and the role label "Lead Meteorologist" | The signed-in person's own identity from their session. Weathra has no roles in the MVP beyond the server-held administrative flag. |
| Financial-style candlestick charts in the historical panels of `01` and `04` | Weather series in the shared chart frame of [`design-system.md`](design-system.md) §7. The candlestick treatment is mockup filler and encodes nothing Weathra computes. |
| Decorative photography and generated imagery — city photos, the "Active Data Sources" panel | Not implemented. A location is identified by its resolved name, not by stock photography of it. |
| `AGENT INTERPRETATION` used alongside `AI INTERPRETATION` | One badge label, `AI INTERPRETATION`, everywhere. Two names for one data class defeats the point of a badge. |

**Controls and copy that are refused, not restyled**

| In the artifact | Why it is not implemented |
|---|---|
| "Compare Models" (`01`), "Recalibrate Baseline Models" (`03`), "Recalibrate Models" (`04`) | Model-recalibration controls. Weathra retrieves from providers and computes deterministically; it does not train, tune or recalibrate a weather model, and offering the control would claim otherwise. |
| "Validate Conclusion", "Export Trace", "Inspect Payloads", "View Chain of Custody" (`05`) | The audit-chain framing below. |
| "This execution log is cryptographically signed and immutable for compliance auditing", "Audit Stability Index", `AUDIT_LOCK`, `COMPLIANCE_LOCK`, `ISO-MET-COMPLIANT`, "Audit Stream: Persisted" (`05`, `06`) | The evidence record is a run record — agents, tool calls, results, analytics methods, cited knowledge, timings. It is not signed, not immutable, and not a compliance artifact, and saying so would be a false claim about a security property. |
| "Atmospheric Attention Required … Intelligence triggered", "Analyze Anomaly" (`06`) | Condition monitoring and alerting is Weather Watch — post-MVP — and severe-weather messaging is bound by the official-warnings stance in `specs/safety-grounding`. |
| "Model Consensus … both nodes confirm" (`06`) | Multi-provider forecast consensus is post-MVP. One provider's output presented as consensus is exactly the claim `docs/privacy-ethics.md` exists to prevent. |
| "Export Data (CSV)", "Export PDF" (`01`, `03`, `04`) | Export is the post-MVP Weather Intelligence Report. |
| "Recommendations for city planners include heightened monitoring of drainage infrastructure…" (`04`) | Operational advice Weathra is not positioned to give. |
| "Enterprise License", "Service Status", "Legal & Compliance", "API Docs" (`07`) | Nothing behind them exists. |
| "Remember me" (`08`) | Session persistence is the Supabase SSR cookie session, which persists without a checkbox. A control implying a second session mode would misdescribe the architecture. |
| Suggested prompt "Predict thermal drift for Tokyo next week" (`02`) | See the language-model line below. |

**The language-model line.** `specs/web-ui` requires that no screen's design imply the language
model produced a numerical weather value. The badge system, the separation of the interpretation
panel from the data cards, and the deterministic-analytics block all carry that distinction
correctly in the artifacts. Four pieces of sample copy do not, and they are recorded here as
overridden:

- `01` — "suggests rain will persist until 18:45 CEST" inside the interpretation panel.
- `02` — the suggested prompt "Predict thermal drift for Tokyo next week".
- `03` — "Persistence of high-pressure blocking suggests the anomaly will carry into early
  November", and the causal claim about the North Atlantic Jet Stream.
- `04` / `06` — "Synoptic monitoring indicates a decoupling of the North Atlantic corridor" and the
  forward-looking narrative built on it.

Interpretation text explains figures that were retrieved or computed, cites them, and does not
extend them into a prediction of its own. Where a forecast value is stated, it is a provider
forecast, badged FORECAST and attributed. This is a copy rule, and it is why the interpretation
panel's content is generated under the grounding verification of `specs/safety-grounding` rather
than trusted because it looks plausible.

**Per-screen gaps the specs fill.** The artifacts do not depict every required element. Where they
are silent, the specs govern and the artifact's own card language is extended:

| Screen | Not depicted | Governed by |
|---|---|---|
| Compare Cities | Criterion selection, the ranked result with each candidate's score, excluded candidates with their reasons, more than two locations, and the client-side block below two | `specs/comparison`, `specs/web-ui`; task 21.4 |
| Saved Locations | The remove action, the empty state, and ambiguous-location candidate selection | `specs/web-ui`; tasks 21.6 and 21.7 |
| Settings | Sign-out within the screen, session-memory deletion with confirmation, account-data deletion with an explicit confirmation step, and a wind-speed unit distinct from the unit-system toggle | `specs/memory`, `specs/authentication`, `specs/web-ui`; task 21.6 |
| Historical Analytics | A range rejected as outside coverage, and baselines stating the years actually used rather than citing a published climate normal | `specs/analytics`, `specs/historical`; task 21.3 |
| Every screen | The loading, empty, error, interrupted-stream, agent-unavailable and quota states | [`design-system.md`](design-system.md) §11 |
| Authentication | The seven states beyond sign-in | §3 above and `specs/authentication` |

Two of the artifacts' own additions are kept, because `specs/memory` allows a preference the person
explicitly sets: the **time format** and **primary time zone** controls in `07`. They are display
preferences, they are optional, and no spec scenario depends on them.

**The authentication shell's appearance.** `08-authentication.png` shows the shell in a **light**
appearance. Nothing else in the set is light, and the artifact is the reference for its structure,
spacing and control treatment rather than for an appearance — so the shell is implemented in
Midnight Intelligence, from the same tokens as every other screen.

This paragraph used to end differently. It said the shell was implemented "in both appearances",
because a light appearance was derived from the same token set and served under
`prefers-color-scheme`. That is no longer true and should not have survived as long as it did: the
override meant an operator on a light system saw the *whole product* — Dashboard included — in a
palette no product artifact depicts. It was removed in the visual correction pass and is recorded in
§8. The reading of `08` is unchanged; only the conclusion drawn from it is.

**A naming collision to avoid.** `01` and `04` label their forecast strips "Forecast Explorer" and
"Forecast Delta Explorer". **Forecast Explorer** is the name of a post-MVP screen
([`roadmap.md`](roadmap.md)); a Dashboard section may not carry it, or the navigation would
advertise as built something that is not.

## 6. Approval record

| Date | What was reviewed and approved | Approved as |
|---|---|---|
| 2026-09-03 | The shared design system — palette, typography, spacing and density, component hierarchy, navigation, cards, charts, weather visualization patterns, the data-class and provenance treatment, both memory tiers, the state patterns, responsive behavior, accessibility | The implementation reference, recorded in [`design-system.md`](design-system.md) |
| 2026-09-03 | The official twelve-entry navigation, superseding the incomplete sidebar in every artifact | The implementation reference ([`design-system.md`](design-system.md) §5) |
| 2026-09-03 | The seven MVP product screens | Approved visual references, recorded as `screens/01`–`screens/07`, with the exceptions in §5 |
| 2026-09-03 | The authentication screen as the shared authentication-shell reference for all eight authentication screens | Approved visual reference, recorded as `screens/08-authentication.png`, with the exceptions in §5 |
| 2026-09-03 | The corrections carried out of the mockups — invented sources and station identifiers, fabricated telemetry and confidence figures, agent version strings, audit and cryptographic framing, model-recalibration controls, sample copy | Recorded as binding on implementation (§5 and [`design-system.md`](design-system.md) §15) |

The gate was satisfied with Visily's freely available capabilities: no paid export capability, no
design-to-code handoff, and no second design tool — Figma included. Every approved screen is a
visual reference implemented by hand in Next.js against
[`design-system.md`](design-system.md).

## 7. Outstanding

The design gate is closed. The **fidelity review** required by task 21.9 — comparing each
implemented screen against its approved artifact — is recorded in
[`fidelity-review.md`](fidelity-review.md), including the one implementation defect it found and
corrected, and the one brand question it left unresolved for the owner.

The accessibility and responsiveness pass required by task 21.8 is recorded separately in
[`accessibility.md`](accessibility.md) — every MVP screen, what was verified with which instrument,
the three defects it found, the five corrections, and the limitations of the pass.

The one item that stood open here — the literal token values — was established in task 20.3 and is
recorded in [`tokens.md`](tokens.md), with the contrast of every declared pair verified in both
appearances. No value was sampled from an export.

### Still open: the two model-policy screen designs

The gate closed on the MVP set. Two screens are still owed an artifact, and neither exists:

| Task | Screen | Reserved filename | State |
|---|---|---|---|
| 33.1 | Admin Model & AI Usage | `screens/09-admin-model-ai-usage.png` | **Not produced.** No file, in this repository or its history. |
| 33.2 | Plan & Usage | `screens/10-plan-usage.png` | **Not produced.** No file, in this repository or its history. |

The filenames continue the approved sequence and are reserved so an artifact lands where §1 already
looks for one; recording a reserved name is not an approval, and neither row may move into §1 or
§6 until the file exists and has been reviewed. What each must cover is in `specs/web-ui`
("Administrative and plan screens remain subject to the Visily design gate") and is repeated in
[`roadmap.md`](roadmap.md): every element the screen names, the populated, loading, empty, error and
not-permitted states, conformance to [`design-system.md`](design-system.md) rather than generic
generated styling, and a recorded approval before implementation.

**Task 33.3 depends on both and is therefore also open.** Its criterion is that the two screens are
recorded as post-MVP entries *and their approval recorded* before implementation begins; the
classification half is done — [`roadmap.md`](roadmap.md) and [`../roadmap.md`](../roadmap.md) agree,
and no route advertises either screen as working — and the approval half cannot be satisfied by a
document, because there is nothing to approve.

The five roadmap screens of task 19.4 remain deliberately **artifact-free**: they were classified as
roadmap entries rather than designed, which is what 19.4 asked for and what §4 records. Numbering
past 10 is reserved for them in the same way, should any of them be designed later:
`11-forecast-explorer`, `12-weather-intelligence-report`, `13-weather-scenario-lab`,
`14-weather-watch`, `15-travel-intelligence`. No such file exists, and none is required by this
change.

## 8. Divergence log

Deliberate divergences between an implemented screen and its approved artifact, with the reason for
each. The exceptions in §5 are already approved and need no further entry; this log records what
implementation decides beyond them. Written during implementation and reviewed in task 21.9.

| Date | Artifact | Divergence | Reason |
|---|---|---|---|
| 2026-09-03 | `08-authentication.png` | The primary action's label is near-black on the cyan accent, not white | White on the artifact's cyan measures about 1.9:1. `specs/web-ui` requires 4.5:1 for text, so the implementation uses `accent-contrast`, which measures about 12:1. Recorded in task 20.3. |
| 2026-09-03 | All eight | AI INTERPRETATION is fuchsia rather than the artifacts' cyan | Cyan is the accent — the primary action and the active navigation item. A data class coloured like a button reads as a control, and [`design-system.md`](design-system.md) §1 reserves the accent for action. Recorded in task 20.3. |
| 2026-09-04 | `02-ai-weather-analyst.png` | The right-hand rail is not reproduced as a rail. Its real content — the run's progress, what the answer resolved to, and the run record — is rendered inline with the answer it belongs to | Three of the rail's four panels are content §5 already refuses: the agent version and compute-load telemetry, the generated "Active Data Sources" imagery with its invented sources, and the synthesis-confidence figure. What remains is provenance *about one answer*, and provenance belongs beside the figures it describes rather than in a column that outlives them. Task 21.2. |
| 2026-09-04 | `02-ai-weather-analyst.png` | ~~"View Full Agent Evidence" is not implemented as a link.~~ **Closed by task 21.5.** The answer now links to `/evidence/{id}` using the `evidence_id` the backend returned with the run, and still shows the request and evidence identifiers and the run summary the envelope carries. When the backend could not store the record it sends no identifier and no link is offered | The deferral was until the Agent Evidence screen and its route contract existed. They do. The identifier is always the backend's; nothing constructs one. Tasks 21.2 and 21.5. |
| 2026-09-04 | `02-ai-weather-analyst.png` | The starter-prompt chips carry generic questions naming no place | §5 already overrides one of the artifact's four suggestions for asking the model to predict a value. The other three name specific cities, which would presume a location the person has not chosen and put a place name on screen that came from a mockup rather than from their preferences. Task 21.2. |

| 2026-09-04 | `03-historical-analytics.png` | Temperature and precipitation are two charts with one y-axis each, not one chart with a left and a right scale | A second y-axis makes any relationship between the two curves an artifact of where the axes were placed: the same data reads as correlated or uncorrelated depending on a choice nobody declared. One measure, one scale, each axis labelled with its own unit. Task 21.3. |
| 2026-09-04 | `03-historical-analytics.png` | The chart's two series keep the data-class token colours — `class-historical` for the recorded line, `class-analytics` for the baseline — although the pair sits outside a single lightness band | A series' colour is its data class, the same colour as the badge beside it; repainting one to even the pair would let the chart and its labels disagree about what a line is. The pair separates well under every colour-vision simulation and against both surfaces, and the baseline carries a dashed stroke, its own legend entry and a direct label, so identity never rests on hue alone. Task 21.3. |
| 2026-09-04 | `03-historical-analytics.png` | No °C/°F toggle in the header | The unit system is a saved preference and Settings owns it (task 21.6). A second control setting the same thing is a second place for the two to disagree. The screen renders in the person's saved units and the axes state them. Task 21.3. |
| 2026-09-04 | `03-historical-analytics.png` | The "Anomaly Intelligence" panel is not implemented | Its content is a language model's narrative about historical figures, and every sentence in the artifact's example is a forward-looking claim §5 already overrides. Nothing on this screen is model-written, so the screen carries no interpretation region at all rather than an empty one. Task 21.3. |

| 2026-09-04 | `04-compare-cities.png` | The "Comparison Intelligence" panel is not implemented, and the screen carries no AI-interpretation region at all | `POST /weather/comparison` is deterministic and returns no model prose. Its synthesis-confidence, correlation-score and data-density bars are figures §5 already refuses, and its "What Changed?"/"Why?" cards belong to surfaces the comparison endpoint does not produce. An empty interpretation panel would imply a model had been consulted. Task 21.4. |
| 2026-09-04 | `04-compare-cities.png` | One chart — a bar per place of the figure the ranking turns on — replaces the "Climate Pulse Differential" dual-axis chart and the "Decadal Climate Baseline" candlestick panel | §5 already refuses the candlestick treatment, and a second y-axis makes any relationship between two curves an artifact of where the axes were placed. The bar carries the supporting statistic's own value, not the score: the backend negates a score when lower is better, so plotting it would show a negative rainfall. Task 21.4. |
| 2026-09-04 | `04-compare-cities.png` | No per-day two-column "Forecast Delta Explorer" matrix | `ComparisonResult` carries each candidate's statistics over the shared window, not a per-day series per place; building one would mean extra retrievals this screen's question does not need. The name is also reserved: **Forecast Explorer** is a post-MVP screen (§5). Day-level comparison is a supported backend mode and is reachable through the Analyst; it is not part of task 21.4's criteria. Task 21.4. |
| 2026-09-04 | `04-compare-cities.png` | The place cards carry no photography, condition icon or current-conditions readout | Decorative photography is refused set-wide in §5, and a current-conditions readout is the Dashboard's surface. A comparison card shows what the comparison is made of: the rank, the measured figure, the window in that place's own local time, and the analytics behind the score. Task 21.4. |

| 2026-09-04 | `05-agent-evidence.png` | The "Context Used (Agent Memory)" panel does not show a conversation excerpt or a preference profile. It shows what the run *resolved to* — the location, the analysis period and the unit system, each with where it came from: the request, the conversation, or the person's saved preferences | The stored record carries `ResolvedContext`, not a transcript. Putting somebody's earlier questions on a page addressed by an identifier that can end up in a shared link would widen what a record discloses well beyond the run it describes, and `specs/memory` keeps conversation content in bounded backend memory. What the panel replaces it with is the thing the artifact's panel was gesturing at: whether Weathra used your default or guessed. Task 21.5. |
| 2026-09-04 | `05-agent-evidence.png` | The header's "Confidence" cell is replaced by "Graph steps" and "Agents involved", and uncertainty appears lower down as a band with its basis, only when the run recorded one | §5 already refuses the artifact's 98.4% figure. A single number in the header would also be a claim about the *run*, where the backend states confidence about a *forecast figure* — a different thing, and the only one it has a basis for. Task 21.5. |
| 2026-09-04 | `05-agent-evidence.png` | Tool results are shown inline beneath each call rather than behind the artifact's "Inspect Payloads" control, and a result's collections are described by size — "3 entries", "1 field" — rather than reproduced | The control is refused in §5 with the rest of the audit-chain framing, but the *results* are required evidence and belong beside the call they answer. A normalized hourly payload printed in full would bury the run record in numbers no reader can check anything against; the shape of what came back, with its data class and attribution, is what makes the call verifiable. Task 21.5. |
| 2026-09-04 | `05-agent-evidence.png` | Retrieved knowledge carries no data-class badge, and the RAG panel has no "Explore All Knowledge Fragments (12)" control | A corpus passage is explanatory documentation, not a measurement, and badging it as one of the five classes would be exactly the conflation `specs/safety-grounding` forbids — so the region says in words what it is instead. The record holds the chunks that were *cited*; no endpoint enumerates the corpus, so a fragment count and a link into it would both be invented. Task 21.5. |
| 2026-09-04 | `05-agent-evidence.png` | `/evidence` — the navigation destination — is not a list of runs. It explains that a record is opened from the answer that produced it, and links to the Analyst. One run lives at `/evidence/{id}` | `specs/http-api` exposes one evidence endpoint, a record by its identifier, and no endpoint enumerating a person's runs. A listing screen would have to invent the listing. Task 21.5. |

| 2026-09-04 | `06-saved-locations.png` | The place cards carry no current-conditions readout — no temperature, condition, high/low, precipitation, humidity or wind. Each card shows what a saved location *is*: the person's label, the canonical resolved name, the coordinates and the time zone | The card grid, its density and its hierarchy are reproduced; the readout is not. A conditions readout would mean one weather request per saved location, each with its own loading and failure state, for data the Dashboard already presents properly for the place a person has chosen. Task 21.6's criteria are list, add and remove, and the honest content of a saved-location card is the canonical location the backend stored. Task 21.6. |
| 2026-09-04 | `06-saved-locations.png` | The per-card overflow menu and the "Analytics ›" link are not implemented; the card carries one control, Remove | The artifact's link goes to a per-node analytics view that does not exist, and no MVP screen accepts a location in its URL — Historical Analytics and Compare Cities choose from this same saved list. A link with no destination is worse than no link. Task 21.6. |
| 2026-09-04 | `06-saved-locations.png` | "Quick search nodes…" is implemented as a filter over the saved list and labelled as one | It searches nothing new and issues no request, and saying so in the field's own description is what stops it reading as a place search that failed to find anywhere. Task 21.6. |
| 2026-09-04 | `07-settings.png` | Two of the four tabs — "AI Intelligence" and "Transparency" — are not implemented. The tab row carries General and Account | Model selection is not caller-selectable on product endpoints (`specs/model-policy`), so there is no AI parameter a person may set; transparency is not a settings page but the data-class labelling, attribution and uncertainty on every screen and the Agent Evidence record behind every answer. An empty tab would advertise a section that has nothing in it. Task 21.6. |
| 2026-09-04 | `07-settings.png` | The "Time Format" and "Primary Timezone" controls are not implemented, and neither is a wind-speed unit distinct from the unit system | §5 records the first two as kept because `specs/memory` allows a preference the person explicitly sets, and [`design-system.md`](design-system.md) §10 lists a wind-speed unit. None of the three has a field in the durable preference store: the backend's `PreferenceUpdate` carries the unit system, the forecast horizon and the default location and nothing else. Adding them is a backend contract change, and it is not part of task 21.6's criteria. Implementing them in the browser instead would mean a second preference store that did not follow the person to another device — which is the one thing `specs/memory` requires of a preference. They return with the field that backs them. Task 21.6. |
| 2026-09-04 | `07-settings.png` | The default location is chosen from the person's saved locations rather than typed, and the value sent is that location's canonical name | The artifact's control is a dropdown too, and this is what makes it honest: a saved location was already resolved by the backend, so choosing one can never be ambiguous where re-typing a name could be. Someone with nothing saved is pointed at Saved Locations rather than given a free-text field that could resolve to somewhere they did not mean. Task 21.6. |
| 2026-09-04 | `07-settings.png` | The footer's "Configuration synced · Last save 14:32:01 UTC" is replaced by a state line that says what is actually true — no unsaved changes, unsaved changes, saving, or saved — and "Reset to defaults" joins "Discard changes" and "Save preferences" | A last-save timestamp is not something the preferences endpoint returns, and a permanent "synced" badge would be a claim about a moment rather than about now. `specs/memory` requires preferences to be deletable by their owner, which is a separate operation from discarding an unsaved edit, so both are offered and worded differently. Task 21.6. |
| 2026-09-04 | `07-settings.png` | The Account tab carries three sections the artifact does not depict — the account and its sign-out, conversation memory with a per-conversation confirmation, and Weathra-data deletion behind a typed confirmation | §5 already records these as per-screen gaps the specs fill. Account-data deletion requires the person to type `DELETE` because `specs/web-ui` asks for an *explicit* confirmation step for it, where session-memory deletion asks for a confirmation step; the difference in wording is a difference in what the action costs. The Supabase Auth subject is not shown: it identifies the account to the system, not to the person. Task 21.6. |

| 2026-09-04 | `01-dashboard.png` | The Dashboard gains a location entry the artifact does not depict — "Brief me on a place", with a control returning to the person's default | `specs/web-ui` describes the Dashboard as briefing on "a chosen or default location" and task 21.1 built only the default half; task 21.7 requires ambiguous-location handling on this surface, which presupposes an entry to be ambiguous. The artifact's own header search ("Search locations or data…") is a global control over content that does not exist; this is the narrower, real version of it. Task 21.7. |
| 2026-09-04 | `01-dashboard.png`, `04-compare-cities.png`, `06-saved-locations.png` | Every location entry is followed by a shared candidate chooser, which no artifact depicts, and the briefing or ranking is withdrawn while a name has not settled on one place | §5 records the ambiguous-location interaction among the per-screen gaps the specs fill, and `docs/design/design-system.md` §11 governs its appearance as one of the honest states. It uses the caution tone rather than the error tone: an ambiguous name is not a failure, it is a question. It is one component for all three surfaces because `specs/web-ui` requires the same behaviour wherever a location is entered, and three implementations would be three places for it to drift. Task 21.7. |
| 2026-09-04 | `04-compare-cities.png` | One ambiguous row stops the whole comparison rather than the ranking proceeding without that place | `specs/location-comparison` already forbids a ranking quietly shorter than its question. Ranking the rows that did resolve would answer a different question from the one asked, and the row that was dropped is the one the person was least sure about. Task 21.7. |
| 2026-09-04 | `06-saved-locations.png` | A place is saved by the chosen candidate's **coordinates**, not by the name that was typed | `specs/memory` requires a saved location to hold the canonical resolved place rather than the query text. Sending the name back for a second resolution is the step where an ambiguity could reappear, so the coordinates the geocoder already returned are what the save carries. Task 21.7. |

| 2026-09-04 | `01-dashboard.png` | The Dashboard carries its own heading and subtitle, which the artifact renders as a breadcrumb above a search field | Task 21.8's audit found the screen had no `h1` at all: its sections carried headings and the page they belong to did not, so a heading-list navigation described the parts without naming the whole. The artifact's "Dashboard › Meteorology Analytics" breadcrumb is not the navigation Weathra has, and its header search is a global control over content that does not exist (§5). A heading is the honest version of both. Task 21.8. |
| 2026-09-04 | All eight | Section titles inside the provenance primitives are `h2` where they sit under a screen's `h1`, and `h3` only where they nest inside a screen's own `h2` panels | The primitives rendered `h3` unconditionally, which skipped a level on five screens. A heading level is a fact about where a region sits rather than about what it is, so it became a parameter. Recorded in [`accessibility.md`](accessibility.md) §9. Task 21.8. |
| 2026-09-04 | All eight | The page no longer clamps its own horizontal overflow | `html { overflow-x: hidden }` made content that overflowed unreachable rather than scrollable — the "hide it to make it fit" that `specs/web-ui` rules out — and made the 360-pixel requirement unverifiable, since a clamped page reports no overflow whether or not it fits. Removed, and all twelve screens are now asserted to fit unclamped in a real browser at 360, 900 and 1440 pixels. Task 21.8. |

| 2026-09-04 | All eight | ~~The brand mark is drawn as a bare glyph, without the filled accent tile every artifact shows.~~ **Corrected in task 21.9.** The mark now sits in an accent tile with `accent-contrast` on it, in both shells | This was a fidelity defect rather than a decision — a visible divergence on every screen with no reason recorded anywhere. Tokens only, glyph unchanged; the accent/`accent-contrast` pairing is asserted statically and the tile is asserted as painted in both engines. Task 21.9. |
| 2026-09-04 | `08-authentication.png` | The mark is a weather glyph where this one artifact's tile appears to enclose a "W" letterform. **Unresolved — flagged for the owner** | The glyph matches the other seven artifacts and is consistent across all twelve implemented screens, and no document specifies the mark. Choosing between a letterform and a glyph is a brand decision rather than a fidelity defect, so task 21.9 recorded it instead of taking it. Task 21.9. |

| 2026-09-06 | All eight | **Correction, not a divergence.** The appearance is chosen by screen, not by the visitor's system. `prefers-color-scheme` is gone; `:root` is Midnight Intelligence and the `(auth)` group takes `data-appearance="light"` | The seven product artifacts are Midnight Intelligence and `08-authentication.png` is light. The old override handed that choice to the operating system instead, so an operator whose machine reported light was served a *Dashboard* matching none of the seven — found by looking at a rendered screen, because every suite passed against it. Both halves of the set are now reproduced as drawn. |
| 2026-09-06 | All seven product artifacts | The top bar is implemented: breadcrumb, search field, and the signed-in person. Its **notification bell is not** | The strip was absent entirely, which was a large part of why a rendered screen and its artifact did not read as the same product. The bell is the one element with no truthful form — Weathra has no notifications, Weather Watch is post-MVP, and the artifacts draw it carrying an unread dot. The breadcrumb shows the real path rather than the artifacts' fixed `Dashboard › Meteorology Analytics`, and the search is a location search — the resolver Weathra actually has — rather than the artifacts' "locations or data". |
| 2026-09-06 | `01-dashboard.png` | The hero band is reproduced in geometry and tonality, without the photograph, the station identifier or the "Agent Ready" line. Its four secondary measures are kept as slots, and one the provider did not report reads "Not reported" | §5 refuses generated decorative imagery set-wide and there is no approved asset, so the band keeps its height and gets an atmospheric wash from the surface tokens. Keeping the four slots and naming the absent ones is what preserves the composition without inventing a wind speed; dropping them would lose the hero, and filling them would lose the product. |
| 2026-09-06 | `01-dashboard.png` | The day strip draws the days the backend returned, without a condition glyph or caption, and is not called "Forecast Explorer" | The horizon is the person's saved preference and the provider answers with what it has; drawing the artifact's seven would mean drawing days nobody forecast. The forecast carries a high and a low and no condition field, so there is no icon rather than a guessed one. The name is reserved for a post-MVP screen (§5). |
| 2026-09-06 | `01-dashboard.png` | The closing status rule carries the provider, the place and the units, not "DATA FLOW: ACTIVE · SYSTEM HASH: B882-X90A-BERL · v4.8.2-STABLE" | Same rule, same position; a hash and a version string are invented values, and the facts put in their place are ones the screen already holds. |
| 2026-09-06 | `08-authentication.png` | The password visibility control is now the artifact's eye glyph rather than the words "Show"/"Hide" | The earlier decision was that an icon-only control needs a name supplied separately and an invisible name is an unchecked one. The name is `aria-label`, and every test for these three forms queries the button *by* that name — so it is asserted on every run rather than merely present, which meets the original concern without keeping the words. |
| 2026-09-06 | `08-authentication.png` | "Remember me" is still not implemented | Supabase persists the session either way; a checkbox that changed nothing would be exactly the fabrication this pass exists to remove. Implementing it truthfully means session-scoped rather than persistent auth cookies, which is an authentication-behaviour change rather than a visual one. |
| 2026-09-06 | `07-settings.png` | Measurement units are now the artifact's segmented control | It was a row of separate chips. The control is still two real radio inputs in a real fieldset, positioned out of sight rather than removed, so the group semantics and arrow-key selection a segmented control usually loses are kept. |
| 2026-09-06 | `03-historical-analytics.png` | The metric row is framed as cards and the archive chart moved into a wide left column with the baseline comparison beside it | The figures were already the artifact's; the frame and the arrangement were not, so the screen read as a form above a stack rather than as the artifact's control strip, metric row and main row. The right-hand slot holds the deterministic baseline comparison, which is what Weathra computes, where the artifact's "Anomaly Intelligence" is a model narrative this screen does not produce. |

| 2026-09-06 | All seven product artifacts | The rail's SAVED LOCATIONS section is implemented, without a temperature beside each place | The places are the person's own. A temperature per row means one weather request per saved place on every screen, each with its own loading and failure state, for figures the briefing already presents properly for the place they chose — the same trade §8 already records for the Saved Locations cards. The shell moved inside the session boundary (`components/shell/protected-frame.tsx`) so the rail can ask for the list at all; the expired-session state still replaces only the screen, so a lapsed session does not take the navigation with it. |
| 2026-09-06 | `01-dashboard.png` | "Saved Snapshots", "Climate Pulse Analytics" and "Precipitation Logic" are implemented; none carries the artifact's figures | Snapshots list the saved places without per-place temperatures, for the reason above. The pulse chart draws the forecast's **hourly** series and says so when the provider supplies none — a real state, not an error. The precipitation panel carries what the forecast reported for precipitation and the backend's own uncertainty statement, in place of the artifact's "42% Integrated Risk", a convective type and a mm/h load: no endpoint produces any of the three, and an integrated-risk percentage is the invented confidence §5 refuses set-wide. |
| 2026-09-06 | `02-ai-weather-analyst.png` | The right rail is implemented — Agent Status, Active Data Sources, Analyst Context, confidence and grounding, and the evidence action — filled from the run rather than from the artifact | This reverses the 2026-09-04 entry that declined to reproduce the rail. What made it unreproducible was its *content*: an agent version, a compute-load figure, generated source imagery, and "Synthesis Confidence 98.2%". The panels have real content behind them — the stream's own status and agents, the answer's attribution, `ResolvedContext` with where each value came from, and the backend's `UncertaintyStatement` and `GroundingReport` — so the composition is reproduced and the fabrications are not. Where a run has not happened yet each panel says what it is waiting for. |
| 2026-09-06 | `02-ai-weather-analyst.png` | "New Analysis" is implemented; "History" is not | Starting over is real: it drops the transcript and the thread, so the next question opens a new one. A thread-listing endpoint exists but no screen lists them, and a control with nowhere to go is worse than none. |
| 2026-09-06 | `04-compare-cities.png` | "Forecast Delta Explorer" is implemented as a place × statistic matrix, not the artifact's per-day grid; "Comparison Synthesis Summary" is an account of how the comparison was made | This reverses the 2026-09-04 entry that declined the matrix. The refusal was of the artifact's *axis*: `ComparisonResult` carries each candidate's statistics over the shared window, not a per-day series per place, and the artifact's seven columns would mean a retrieval per place per day for a question this screen does not ask. The same idea over the axis the data has — every figure behind the ranking, readable across places — needs no extra request and no invention. The summary carries the criterion, mode, statistics, local-time basis and tie tolerance, because the endpoint is deterministic and there is no model prose to show and no confidence anybody computed. |
| 2026-09-06 | `06-saved-locations.png` | "Workspace Intelligence Synthesis" and "Node Comparison" are implemented as a counted summary and a route to Compare Cities | The artifact's "Global Vector Analysis" and grounding-health percentages are figures no endpoint produces, and a health score over a list of place names would be a claim about nothing. What the panel carries is arithmetic over the records themselves — places, distinct time zones, countries, remaining allowance — which is deterministic and checkable. Comparison is a real screen that already seeds itself from this list, so the panel is a route to it rather than a summary of it. |

The first two entries are design-system divergences found while implementing the tokens; the rest
are screen-level and are recorded as their screens are built.

**Task 21.9's formal review** — every screen against its artifact, the fifteen screens/states, all
eight artifacts, and the divergences this log did not already carry — is
[`fidelity-review.md`](fidelity-review.md). Nine further deliberate divergences were recorded there
rather than duplicated into this log: three on the Dashboard, one on the Analyst, three on Historical
Analytics, one on Agent Evidence, three on Settings and two on the authentication shell.

## 9. The fidelity-fixture review mode

The divergences above are all *production* decisions, and they stand. Every one of them exists
because the artifact draws a figure Weathra does not produce, and the product must not invent one.

That leaves a reviewing problem this section records the answer to. Comparing an implemented screen
against a populated mockup means comparing two pictures, and a screen showing "Unavailable" in the
slots the mockup fills with weather is not the same *layout* as the mockup — a card sized for two
forecast days is not a card sized for seven, and every fidelity pass before this one drifted for
exactly that reason. The reviewer could not tell a geometry error from an absent figure.

So there are now two things, and they are kept apart by a build-time flag:

* **Production** — everything above. No fabricated figure, no invented confidence, and every panel
  says what it is waiting for when it has nothing.
* **Fidelity fixtures** — the eight artifacts rendered as the real components, from content
  transcribed out of the pictures, reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`.

### What the flag is, and what keeps it out of production

`NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES` is read in exactly one place,
`lib/fixtures/visily.ts:usingVisilyFixtures()`, and its value is fixed when the bundle is built. It
is not a runtime toggle: there is no query parameter, no header and no cookie that turns it on in a
deployed build, because nothing a request can do changes what the bundle was built with.

**It is not stripped from the bundle, and this document previously claimed it was.** Checked against
the emitted chunks of a real `npm run build` with the flag unset: the flag compiles to a runtime
comparison against a baked environment object rather than to a folded constant, so the branches are
not eliminated and the fixture screens ship as unreachable code. The comparison is still always
false in that build. The guarantee is therefore *unreachability*, not absence —
[`lib/fixtures/visily.ts`](../../frontend/lib/fixtures/visily.ts) records the measurement and the
one-line change that would make it absence instead, should that ever be required.

The flag appears in no committed configuration — not `.env.example`, not `.env.local`, not CI. The
only place it is ever set is the review harness, `.manual-pass/codespaces-fidelity-serve.sh`, which
is gitignored. `lib/fixtures/fixtures.test.ts` asserts the real screen renders when it is unset.

Four further properties, because one flag would not be enough for content shaped like weather:

1. **It never reaches the network.** Fixtures are substituted where a *screen* asks for its data,
   not where the data is fetched. The API client, the Supabase clients and the backend are
   untouched, so no real endpoint ever returns a fixture value.
2. **It never reaches a database.** Nothing here is persisted, and fixture mode performs no writes.
3. **It says so on screen.** `components/ui/fixture-banner.tsx` renders a fixed, undismissable
   marker across the top of the viewport for as long as the mode is on. It is deliberately not
   subtle: its job is to survive being screenshotted, so that sample weather cannot later be
   mistaken for real output in a deck or a bug report.
4. **The controls are inert.** Every button and field the artifacts draw that Weathra has no
   counterpart for is rendered as a `type="button"` or a disabled input. Nothing in fixture mode
   navigates anywhere it could not honestly go.

### What fixture mode changes that production keeps

These are the differences between the two modes, and every one of them is a case where the artifact
shows something production has decided not to. They are listed so that nobody reads a fidelity
screenshot as a statement about what the product does.

| Element | Fixture mode | Production |
| --- | --- | --- |
| Every weather figure on all eight screens | Transcribed from the mockup | Retrieved, attributed, or absent |
| Rail navigation | The artifact's four entries under its labels | All seven MVP destinations under theirs, plus the roadmap |
| Breadcrumb second segment | `Meteorology Analytics`, the artifact's filler | The screen you are actually on |
| Search placeholder | "Search locations or data…" | "Search locations…" — there is no data search |
| Notification bell | Drawn, `aria-hidden`, not focusable, no control behind it | Absent; Weathra has no notifications |
| Top-bar avatar | A tonal disc with a presence dot | The person's monogram |
| Rail identity | The artifact's name and a person glyph | The signed-in person and their address |
| AI INTERPRETATION / ANALYTICS badges | Teal, as every artifact draws them | The data-class palette's magenta and violet |
| Settings controls | All five drawn; three have no backend field | Only what `PreferenceUpdate` carries |
| Authentication card | 352 wide, on drawn imagery, with a disabled "Remember me" | 448 wide, on two flat washes, no remember-me |
| Authentication action | The artifact's bright cyan fill | The light appearance's darkened accent |

Two of those deserve their reasoning stated rather than tabulated.

**The badge colours.** Production gives each data class its own hue, which is how a reader tells an
observation from an interpretation at a glance. The artifacts predate that and draw both teal. The
override is scoped to the fixture pages' own roots, so production's palette is untouched — but a
fidelity screenshot is *not* evidence about the data-class colours, and should not be read as any.

**The authentication action.** The artifact's fill is the product's bright cyan with white text,
which is about 1.9:1. Fixture mode takes the fill and keeps the dark label: the fill is what reads
at a glance, and an unreadable primary action is not a fidelity improvement. The label is one word
against the whole button, and it is the one place this mode knowingly departs from the picture.

### The imagery

`08-authentication.png` and the city heroes are generated imagery in the artifacts. §5 refuses to
invent that for the product and still does — but the ground is most of the authentication artifact's
pixels, and the hero is the largest element on the Dashboard, so a comparison that omitted them
compared very little.

Both are therefore **originated in this repository**: `frontend/scripts/generate-location-art.mjs`
draws the city artwork (sky gradient, cloud decks, a warm horizon, three skyline layers with aerial
perspective, one generic tower) and `components/auth/fixture-auth.tsx` draws the authentication
ground. No photograph, no third-party asset, nothing downloaded, and no licence question. Both are
deterministic — every value derives from a hash of the name or the index — so regenerating produces
no diff and a screenshot comparison is stable. Neither encodes a measurement: the skylines are
generic massing, and `LocationImage` describes them as generated artwork rather than as a scene.

### Where the review is done

`.manual-pass/codespaces-fidelity-serve.sh` builds and serves the fixture mode from a browser-based
Codespace on one private forwarded port, against the two local stubs, with the real Supabase
configuration overridden. `.manual-pass/capture.mjs` renders all eight screens at 1440, 1024, 768
and 360 and reports any horizontal overflow. Both are gitignored: they are review instruments, not
product code.
