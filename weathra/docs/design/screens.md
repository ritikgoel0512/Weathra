# Screen index and design-gate status

> The index required by tasks 19.5 and 24.9 of the `weathra-mvp` change. Status as of 2026-09-03.

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
| Dashboard — Weathra Intelligence briefing, *What Changed?*, *Why?* | `01-dashboard.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.1) |
| AI Weather Analyst | `02-ai-weather-analyst.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.2) |
| Historical Analytics | `03-historical-analytics.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.3) |
| Compare Cities | `04-compare-cities.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.4) |
| Agent Evidence / Activity | `05-agent-evidence.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.5) |
| Saved Locations | `06-saved-locations.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.6) |
| Settings | `07-settings.png` | Approved 2026-09-03, with the exceptions in §5 | Not started (task 21.6) |

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

**The authentication shell's appearance.** `08-authentication.png` shows the shell in the **light**
appearance. This is not a departure from the Midnight Intelligence direction: the light appearance
is derived from the same token set and selected by `prefers-color-scheme`
([`design-system.md`](design-system.md) §1). The shell is implemented in both appearances from
those tokens, and the artifact is the reference for its structure, spacing and control treatment
rather than for a single appearance. Nothing else in the set is light.

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

Nothing. The design gate is closed.

The one item that stood open here — the literal token values — was established in task 20.3 and is
recorded in [`tokens.md`](tokens.md), with the contrast of every declared pair verified in both
appearances. No value was sampled from an export.

## 8. Divergence log

Deliberate divergences between an implemented screen and its approved artifact, with the reason for
each. The exceptions in §5 are already approved and need no further entry; this log records what
implementation decides beyond them. Written during implementation and reviewed in task 21.9.

| Date | Artifact | Divergence | Reason |
|---|---|---|---|
| 2026-09-03 | `08-authentication.png` | The primary action's label is near-black on the cyan accent, not white | White on the artifact's cyan measures about 1.9:1. `specs/web-ui` requires 4.5:1 for text, so the implementation uses `accent-contrast`, which measures about 12:1. Recorded in task 20.3. |
| 2026-09-03 | All eight | AI INTERPRETATION is fuchsia rather than the artifacts' cyan | Cyan is the accent — the primary action and the active navigation item. A data class coloured like a button reads as a control, and [`design-system.md`](design-system.md) §1 reserves the accent for action. Recorded in task 20.3. |

No screen-level divergence yet: no MVP screen has been implemented. The two entries above are
design-system divergences found while implementing the tokens.
