# Weathra design artifacts

The approved design system and the per-screen design record, with an index mapping each MVP screen
to its artifact status and each post-MVP screen to its roadmap entry.

| Document | What it holds |
|---|---|
| [`design-system.md`](design-system.md) | The shared Weathra design system — palette, typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, data classes and provenance, both memory tiers, the state patterns, the authentication shell, responsive behavior, accessibility |
| [`screens.md`](screens.md) | Every MVP screen with its design status and artifact reference, the approval record, what is still outstanding, and the divergence log |
| [`roadmap.md`](roadmap.md) | The post-MVP screens as design-roadmap entries |
| [`tokens.md`](tokens.md) | The literal implementation token values, and why each was chosen |
| [`runtime-fidelity-audit.md`](runtime-fidelity-audit.md) | The eight screens photographed in the states people actually meet — populated, empty, loading, error, unauthenticated — every drift classified, what was fixed, and what was left |
| [`fidelity-review.md`](fidelity-review.md) | Task 21.9's formal visual-fidelity review — the fifteen MVP screens/states against the eight approved artifacts, the divergences and their reasons, the one defect corrected, and the review's own limitations |
| [`accessibility.md`](accessibility.md) | Task 21.8's accessibility and responsiveness record — the instruments, what each verified, the defects found and corrected, and the limitations |
| [`accessibility-manual-pass.md`](accessibility-manual-pass.md) | The worksheet and findings for 21.8's manual pass, which remains incomplete |
| [`screens/`](screens/) | The eight approved Visily exports themselves |

The design phase completed on **2026-09-03**. The eight approved artifacts are committed under
[`screens/`](screens/) — seven MVP product screens and the shared authentication shell — and
[`screens.md`](screens.md) maps each screen to its file, records the approval, and records the
exceptions taken against each artifact. The literal design tokens were established in task 20.3 and
are recorded in [`tokens.md`](tokens.md) — chosen from the recorded direction and verified against
the contrast requirement, never sampled off a rendered mockup.

## Design workflow

Screen design and design-system refinement are done in **Visily.ai**, ahead of substantial frontend
implementation: `OpenSpec → Visily → approved UI/UX artifacts → React/Next.js → FastAPI → LangGraph
→ MCP → weather providers`. An approved Visily screen is a visual reference implemented by hand in
Next.js against the recorded design system — no paid Visily export capability, no design-to-code
handoff, and no second design tool is required. Figma is deliberately not mandatory.

An approved artifact is a reference for **layout, hierarchy, and finish only**. Its sample content
is not carried into the implementation: the mock providers, fake station identifiers, fake agent
version strings, crypto and audit wording, model-recalibration controls, invented meteorological
source names, incomplete sidebar labels, and sample copy are all superseded by the real Weathra
architecture and the actually configured providers and MCP tools. The list is in
[`design-system.md`](design-system.md) §15, and the official navigation that replaces the mockups'
sidebar is in §5.

## Design direction carried forward

An earlier **UXPilot** exploration settled the design direction. That work is preserved here as
prior design exploration, and its decisions enter Visily as approved inputs rather than being
rediscovered:

- The **Midnight Intelligence** palette — dark-first, with the light appearance derived from it.
- **Plus Jakarta Sans** for display and heading type, **Inter** for body and UI type.
- The **Intelligent Command Center** shell with persistent left navigation.
- A location-focused **Dashboard**.
- A premium modern SaaS visual direction.
- The named **Weathra Intelligence**, **What Changed?**, **Why?**, and **Agent Evidence** surfaces.
- A visible distinction between **Observed**, **Forecast**, **Historical**, **Deterministic
  Analytics**, and **AI Interpretation** content, with source attribution, timestamps, and
  uncertainty or confidence shown rather than implied.
- Nothing in the visual or copy direction may imply that the language model itself predicts
  numerical weather values.

Each is accounted for in [`design-system.md`](design-system.md) §16, which is also where a
deliberate departure from one is recorded with its reason — in the same way a screen-level
divergence from an approved artifact is recorded in [`screens.md`](screens.md) §6.

## Two things the design carries that are easy to lose

**Numerical analytics stay deterministic.** Every figure the interface shows was retrieved from a
provider or computed by Weathra's analytics engine, and says which. The language model writes
interpretation beside those figures and never produces one.
[`design-system.md`](design-system.md) §9.

**Both memory tiers stay.** Short-term LangGraph thread-scoped conversational continuity, and
long-term durable user preferences — temperature unit, wind-speed unit, default location, saved
locations, default forecast range, and the display preferences a person explicitly sets. Neither
tier is simplified away or folded into the other.
[`design-system.md`](design-system.md) §10.
