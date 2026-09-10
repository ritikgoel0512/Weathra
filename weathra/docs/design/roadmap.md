# Design roadmap — the post-MVP screens

> Recorded in task 19.4 of the `weathra-mvp` change.

These screens are **design-roadmap entries, not MVP artifacts**. They are not designed in the
2026-09-03 Visily phase, not implemented in this change, and not advertised as working. Their
routes exist so the navigation structure is real, and each states plainly that the screen is not
yet available ([`design-system.md`](design-system.md) §5 and §11).

This classification is the same one [`../roadmap.md`](../roadmap.md) records; the two agree by
design, and `docs/roadmap.md` plus Part B of the change's `tasks.md` are checked against each other
by a test.

## Reserved in the navigation

| Screen | Route | Design status | Roadmap entry |
|---|---|---|---|
| Forecast Explorer | `/explorer` | Roadmap entry — **visual reference only**, [`screens/11-forecast-explorer.png`](screens/11-forecast-explorer.png) | [`../roadmap.md`](../roadmap.md), *Screens* |
| Weather Intelligence Report | `/report` | Roadmap entry — **visual reference only**, [`screens/12-weather-intelligence-report.png`](screens/12-weather-intelligence-report.png) | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Weather Scenario Lab | `/scenarios` | Roadmap entry — **visual reference only**, [`screens/13-weather-scenario-lab.png`](screens/13-weather-scenario-lab.png) | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Weather Watch | `/watch` | Roadmap entry — **visual reference only**, [`screens/14-weather-watch.png`](screens/14-weather-watch.png) | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Travel Intelligence | `/travel` | Roadmap entry — **visual reference only**, [`screens/15-travel-intelligence.png`](screens/15-travel-intelligence.png) | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |

Routes are the ones already declared as `POST_MVP_SCREENS` in `frontend/lib/routes.ts`.

**A visual reference is not an approval, and it is not a requirement.** The five images arrived on
2026-09-09 and were recorded so a later implementation starts from a drawn composition. They are
explicitly *not* approved implementation references ([`screens.md`](screens.md) §1 and §6), because
the screens they draw have no specification to be implemented against: sensor and node networks, a
neural agent version, a simulation engine, model recalibration, convergence and grounding
percentages, encryption and compliance banners, and several exports Weathra has no endpoint for are
all drawn, and none of it is a requirement. Every one of these five routes still states that its
screen is not yet available, and the capability behind each would have to be specified before
anything could be built. Task 19.4 classified these screens as roadmap entries rather than MVP
artifacts, and an image does not reclassify them.

**Forecast Explorer belongs to this list, not to the Dashboard.** The approved Dashboard and
Compare Cities artifacts title their forecast strips *Forecast Explorer* and *Forecast Delta
Explorer*; those are mockup section headings, and reusing the name on an MVP screen would advertise
a post-MVP screen as built. See [`screens.md`](screens.md) §5.

## Not in the navigation

| Screen | Route | Design status | Roadmap entry |
|---|---|---|---|
| Admin Model & AI Usage | `/admin/model-usage` | Roadmap entry — **designed and approved 2026-09-09** (task 33.1), [`screens/09-admin-model-ai-usage.png`](screens/09-admin-model-ai-usage.png). Implemented post-MVP, except the model policy confirmation panel built in task 34.8 (2026-09-10) | Part B of the change's `tasks.md`, *Screens* |
| Plan & Usage | `/plan` | Roadmap entry — **designed and approved 2026-09-09** (task 33.2), [`screens/10-plan-usage.png`](screens/10-plan-usage.png). Implemented post-MVP | Part B of the change's `tasks.md`, *Screens* |

Both routes exist as of task 33.4 and are declared as `UNLISTED_SCREENS` in
`frontend/lib/routes.ts` — a list of their own rather than `POST_MVP_SCREENS`, because the
navigation model is asserted to cover that list exactly and putting either screen in it would put
it in the sidebar. **Why they are absent from the sidebar while the other five are present:** one is
administrative and would advertise a surface most people may not open, and the other would offer a
plan view that cannot yet be shown. Both are protected by the same default as every other route.

Each route states that its screen is not yet available and **issues no request at all** — for any
visitor, not only for a person without the administrative role. `specs/web-ui` asks for exactly
that: "no catalog, usage, cost, or lab request is issued". The guarantee is a property of the two
page modules, which hold no API client, no session read and no administrative import, rather than a
condition inside them; `frontend/app/(app)/unlisted-routes.test.tsx` asserts it from both
directions.

Their designs had to cover the populated, loading, empty, error and not-permitted states, follow
[`design-system.md`](design-system.md) rather than a generic styling, and be approved before
implementation begins. That gate is now satisfied: both artifacts are recorded in
[`screens.md`](screens.md) §1, their approval in §6, and the state coverage rests on
[`design-system.md`](design-system.md) §11's approved patterns — the same basis on which one
authentication export serves eight screens and their states.

**Approved, and still not built.** Neither screen is implemented, and the approval does not
authorize implementing one; it settles what implementation would look like when it happens.
[`screens.md`](screens.md) §5 records what each artifact draws that Weathra refuses — the whole
billing block on `10`, an enterprise tier, vector-storage-node quotas, and a per-user usage export
that would contradict the one requirement that screen exists to satisfy — and §7 records the two
elements `09` under-draws that the spec still fixes.

## When a roadmap entry becomes an artifact

A screen leaves this document when it is designed, approved, recorded **and built**: it gains a row
in [`screens.md`](screens.md) §2 with its artifact reference, and its navigation entry loses the
not-yet-available marking. Having an artifact is not enough — every screen in both tables above now
has an image, and all seven are still unbuilt, which is exactly why they are all still here. Until then it stays here, which is what keeps the navigation honest
about what Weathra can actually do.
