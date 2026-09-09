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
| Forecast Explorer | `/explorer` | Roadmap entry — not designed | [`../roadmap.md`](../roadmap.md), *Screens* |
| Weather Intelligence Report | `/report` | Roadmap entry — not designed | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Weather Scenario Lab | `/scenarios` | Roadmap entry — not designed | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Weather Watch | `/watch` | Roadmap entry — not designed | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |
| Travel Intelligence | `/travel` | Roadmap entry — not designed | [`../roadmap.md`](../roadmap.md), *Screens* and *Product capabilities* |

Routes are the ones already declared as `POST_MVP_SCREENS` in `frontend/lib/routes.ts`.

**Forecast Explorer belongs to this list, not to the Dashboard.** The approved Dashboard and
Compare Cities artifacts title their forecast strips *Forecast Explorer* and *Forecast Delta
Explorer*; those are mockup section headings, and reusing the name on an MVP screen would advertise
a post-MVP screen as built. See [`screens.md`](screens.md) §5.

## Not in the navigation

| Screen | Route | Design status | Roadmap entry |
|---|---|---|---|
| Admin Model & AI Usage | `/admin/model-usage` | Roadmap entry — subject to the same design gate, designed in task 33.1, **not yet designed or approved** | Part B of the change's `tasks.md`, *Screens* |
| Plan & Usage | `/plan` | Roadmap entry — subject to the same design gate, designed in task 33.2, **not yet designed or approved** | Part B of the change's `tasks.md`, *Screens* |

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

Their designs must cover the populated, loading, empty, error, and not-permitted states and must
follow [`design-system.md`](design-system.md) rather than a generic styling, and their approval must
be recorded before implementation begins. **Neither has been designed**, so tasks 33.1–33.3 remain
open — see [`screens.md`](screens.md) §7 for what is outstanding and the filenames reserved for the
artifacts when they arrive.

## When a roadmap entry becomes an artifact

A screen leaves this document when it is designed, approved, and recorded: it gains a row in
[`screens.md`](screens.md) with its artifact reference, and its navigation entry loses the
not-yet-available marking. Until then it stays here, which is what keeps the navigation honest
about what Weathra can actually do.
