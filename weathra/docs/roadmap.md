# Roadmap

What Weathra does today, and what it deliberately does not. The list beyond the MVP is not a wish list: it
is the set of capabilities the architecture was shaped to accept later, and each entry names the seam
it arrives through.

This document and Part B of `openspec/changes/weathra-mvp/tasks.md` are the same list; a test
asserts they agree.

## In the MVP

**Identity.** Email-and-password accounts through Supabase Auth, with mandatory verification by code
or link, password reset, session persistence and transparent refresh, and one identity path into the
backend.

**Capabilities.** Current conditions; forecast windows with uncertainty; historical retrieval, period
comparison, and multi-year baselines; deterministic analytics — descriptive statistics, distribution,
rolling windows, trend, anomaly, thresholds; multi-location comparison with per-candidate evidence;
a knowledge corpus for weather concepts.

**The agent.** Four specialized agents behind a supervisor that routes, a graph that executes every
tool call, three grounding layers, a safety stance, and an evidence record for every run.

**Screens.** Dashboard briefing, AI Weather Analyst with streamed progress, Historical Analytics,
Compare Cities, Agent Evidence, Saved Locations, and Settings — plus the authentication screens.

**Evaluation.** Forty cases, ten metrics, seven acceptance thresholds, and an offline mode that runs
in CI with no credentials.

**The model layer.** A model catalog, declared model policies resolved per plan and call role, a
usage event with tokens, latency, status and an estimated cost for every language model call, and
per-plan allowances enforced on the agent paths — with an administrative role, held server-side,
that can read the aggregates and run a recorded model comparison. Plans are assigned
administratively; nothing here bills.

**One of each provider.** One weather provider, one geocoder, one inference gateway, one vector
store — each behind a contract, which is what makes the list below additions rather than rewrites.

## Beyond the MVP

> **Read this section with its dates (note added 2026-09-14).** It was written as the list of things
> Weathra deliberately did not do. **Several of them were subsequently built** — the Scenario Lab,
> Travel Intelligence, Weather Watch, the Weather Intelligence Report, Forecast Explorer, Plan &
> Usage, and the administrative model policy confirmation surface all ship today. Those entries are
> annotated **BUILT** below rather than deleted, because what a product chose not to do and then did
> is part of its record. Everything without that annotation remains genuinely unimplemented.
>
> Implementation is substantially complete. The open items in `openspec/changes/weathra-mvp/tasks.md`
> are operational acceptance/evidence tasks rather than missing product implementation.

### Identity and access

Beyond the MVP's email-and-password Supabase Auth:

- Enterprise single sign-on (SAML/OIDC).
- Additional OAuth identity providers.
- Multi-factor authentication.
- Organizations, teams, and role-based access control.
- Multi-tenancy, rate limiting, and API keys for third-party consumers.
- Rate limiting on the public weather endpoints, needed before wide public exposure.
- **Graded roles, scopes, and organization-level administration**, beyond the single
  administrative/internal flag this change introduces. One server-held flag answers "may this
  principal administer the model layer"; it does not answer "which organization's plans may they
  administer", and pretending otherwise would put an authorization model in a boolean.

*Arrives through:* the token-validation layer and the `Principal`, which already separate "who is
this" from "what may they do".

### Product capabilities

- **Historical forecast-accuracy and skill scoring** — compare stored forecast snapshots against
  the observations that followed. Needs a long snapshot history and scheduled capture.
- **Weather Scenario Lab** — explore hypothetical or alternative conditions and their implications.
- **Travel Intelligence** — weather intelligence along a route or across trip dates.
- **Weather Watch** — monitor a location against conditions and notify on change. Needs scheduling
  and notification infrastructure.
- **Weather Intelligence Report** — a composed, exportable report across capabilities.
- **Behavioral personalization** — intelligence shaped by usage history rather than only explicit
  preferences.
- **Multi-provider forecast consensus** and a confidence signal derived from provider disagreement.

*Arrives through:* the capability catalogue in `agents/plan.py`, the provider contract, and the
snapshot table that already exists.

### Screens — **all built**

Weather Intelligence Report, Forecast Explorer, Weather Scenario Lab, Weather Watch, and Travel
Intelligence were recorded here as designed but **not implemented**. **All five are now built**,
each against its approved Visily artifact, and each is in the navigation without a caveat.

**Plan & Usage** (`/plan`) is **built**, including self-service tier selection.

**Admin Model & AI Usage** (`/admin/model-usage`) is **built in part**: the model policy
confirmation surface is implemented (task 34.8) — each policy's ordered candidate list with the
evaluation recorded per candidate, and one audited write citing the runs relied upon. Its
model-status, token-usage, cost, latency, error and plan-usage panels are **not built**, the route
states so, and those panels fetch nothing for anyone. It is in the navigation for an administrator
and absent for everybody else.

Both were designed and approved on 2026-09-09, which closes the design half of the gate and
settles nothing about the implementation half. `docs/design/screens.md` §5 records what each
artifact draws that Weathra refuses — a subscription id, a billing interval, a payment method,
invoices, a *paid* upgrade, an enterprise tier, vector-storage-node quotas, and a per-user
usage export — because those are the inventions a plan screen attracts, and this change bills
nobody. Changing tier is a different thing and is real: since 2026-09-13 a person moves their own
account between Free, Pro and Premium in one press, which charges nothing because nothing bills. When built, the plan-and-usage view shows the signed-in person their own plan, consumption
and reset times and nobody else's, and the administrative screen the aggregates that
`/api/v1/admin/usage` already reports.

### Commercial and model governance

The model layer of this change measures, resolves, and bounds; it does not bill, and it does not
route itself.

- **Payment processing** — checkout, card handling, invoicing, dunning, proration, and a
  billing-provider integration. Since 2026-09-13 a person selects their own tier and is charged nothing for it; administrative assignment still governs another principal's tier and every allowance. Either way no money moves, and
  `subscription_plans` carries a stable plan code and an unused external subscription reference so
  the integration has somewhere to land.
- **Enforced estimated-cost budgets** per plan and window against paid models. The allowance model
  can express one; none is enabled, because an estimate is the wrong thing to refuse a request on.
- **Reconciliation of estimated cost** against a gateway invoice. Cost stays an operational
  estimate here, labelled as one wherever it is shown.
- **Self-service plan upgrade and downgrade**, which needs payment processing first.
- **Automatic or adaptive model routing** — bandits, per-question difficulty routing, or cost-aware
  fallback chosen at runtime. Policies stay declared candidate lists in a fixed order, promoted by
  a recorded human decision against recorded evidence.
- **Scheduled model health probing** and automatic disabling of a failing catalog entry. Disabling
  is an administrative action in this change, and the catalog's staleness window means it is not
  instant.
- **Per-model prompt variants**, so a policy could carry a prompt tuned to its model rather than
  sharing one — which is also what makes a model comparison in this change a comparison of models
  rather than of prompts.

*Arrives through:* the plan, policy, catalog, usage-event, and allowance tables, which are database
rows rather than environment variables, and the recorded resolution on every run.

### Platform and architecture

- **Scheduled forecast snapshot capture**, improving *What Changed?* coverage beyond
  request-driven snapshots.
- **Additional weather providers** behind the existing provider contract.
- **Additional LLM adapters** behind the existing client contract, including a native tool-calling
  route for models that support it reliably.
- **A shared cache** replacing the process-local one, behind the existing `CachedProvider` seam.
- **Promoting the MCP server to its own deployed service.**
- **ChromaDB** as an alternative vector store behind the existing retrieval interface.
- **Push notifications and severe-weather alerting**, subject to the official-warnings stance in
  [`privacy-ethics.md`](privacy-ethics.md).
- **Infrastructure-as-code** for the deployment topology.

## Why the remaining entries are deferred rather than missing

Each one costs something the MVP could not pay:

**Scheduling infrastructure** (watch, scheduled snapshots, alerting) needs a durable scheduler and a
notification path — a second operational surface with its own failure modes.

**Multi-provider consensus** needs a second provider's coverage, units, and quirks normalized to the
same model, and a defensible way to combine disagreeing forecasts. Presenting one provider's output
as consensus would be exactly the kind of claim
[`privacy-ethics.md`](privacy-ethics.md) exists to prevent, which is why the uncertainty statement
discloses its single-provider basis today.

**Forecast-accuracy scoring** needs a history of snapshots to score against. The snapshot table and
the capture path exist; the history does not yet.

**Billing** needs a payment provider, a webhook path, and reconciliation against someone else's
invoice — and it needs cost to be an amount owed rather than an estimate. Estimating cost from
token counts and catalog pricing is honest and cheap; presenting that estimate as a bill would not
be either, which is why a tier is selected rather than bought and the estimate is labelled.

**Adaptive model routing** needs evidence that a runtime choice beats a declared order, and the
recorded comparison runs are how that evidence would be gathered. Routing before measuring would
make the model that served an answer something nobody could predict or explain.

**Organizations and roles** change the authorization model from "your own rows" to "rows your role
may reach", which is a different shape of policy — and Row Level Security is where it belongs, not a
layer of application checks.

The seams are the point. Adding a provider is a module and a registry entry; adding a model is an
environment variable; replacing the cache is a wrapper that already implements the provider
Protocol; moving the MCP server out is a transport setting. None of them is a rewrite, and that is
what "deliberately not in the MVP" is supposed to mean.
