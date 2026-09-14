# Weathra

**An agentic weather intelligence and analytics platform.**

Weathra answers weather questions in prose and can show you where every figure in the answer came
from. Ask *"is next week warmer than last week in Berlin?"* and it plans the work, retrieves the
forecast and the archive through a tool boundary, computes the comparison with deterministic
statistics, writes the answer from those figures alone, and keeps a record of every tool call,
method and citation behind it.

It combines real weather data, deterministic analytics, grounded AI interpretation, per-run
evidence and provenance, conversational and preference memory, and administrative governance of the
models that do the interpreting.

Two properties shape the whole system:

- **The numbers are computed, not generated.** Every statistic comes from Python and numpy. The
  language model routes the question and writes the prose; it is given computed findings and is
  never the thing that calculates. A figure that does not trace back to retrieved or computed data
  is caught by a grounding audit and reported rather than shown.
- **Every value says what it is.** Observed conditions, forecast, historical observation, computed
  statistic and AI interpretation are five distinct data classes, and each is labelled wherever it
  appears — with its provider, location, period and retrieval time.

---

## 1. Overview

A conventional weather dashboard answers *what will the weather be*. Weathra answers questions
about weather — comparisons, anomalies, trends, hypotheticals, trip windows — and then shows its
working.

**The problem it addresses.** Weather data is abundant and weather *understanding* is not. Deciding
whether next week is unusual for the season, whether a city is a better bet than another for a
given criterion, or whether a trip window is viable, means retrieving several series, computing
statistics over them, and interpreting the result. Doing that by hand across a forecast API and an
archive API is work. Asking a language model to do it produces fluent numbers that nothing
computed.

**Who it is for.** People who need weather reasoning rather than a reading — planning trips,
comparing locations, watching conditions at a place, or asking analytical questions and needing to
trust the answer enough to act on it.

**Why it goes beyond a dashboard.** A dashboard renders a provider's payload. Weathra plans a run
over six capabilities, retrieves through a tool boundary, computes deterministically, synthesises
prose constrained to the computed findings, audits that prose for ungrounded figures, and persists
the whole run as evidence you can open.

**The five data classes, and why the distinction is load-bearing:**

| Class | What it is | Where it comes from |
|---|---|---|
| **Observed** | What the weather is doing now at a place | The provider's reading of the present |
| **Forecast** | A projection of the days ahead | The provider's model output, with its own confidence and horizon |
| **Historical** | Archive observations for a past date range | The provider's archive |
| **Analytics** | A computed statistic — anomaly, comparison, baseline, trend, rank | Weathra's own Python and numpy, deterministic and repeatable |
| **AI interpretation** | Prose written *about* the above | The language model, from findings it was handed |

A forecast is not an observation, a computed mean is not a measurement, and an interpretation is
neither. Conflating them is how a weather product becomes confidently wrong, so Weathra labels each
one at the point it is displayed.

Weathra is not a forecaster and issues no warnings: for severe weather it refers you to your
official national meteorological service.

---

## 2. Shipped product surfaces

Fourteen screens, all built and deployed.

| Screen | What it is for |
|---|---|
| **Dashboard** | The briefing: current conditions, forecast movement, anomalies, historical baseline context, and what changed since last time |
| **AI Weather Analyst** | Ask anything in free text and watch the agents, tool calls and findings stream as they happen |
| **Historical Analytics** | Archive retrieval, period-over-period comparison, and comparison against a multi-year baseline |
| **Compare Cities** | Several locations ranked on a criterion you choose, with the values behind each rank and the reason any candidate was excluded |
| **Agent Evidence** | Your runs, and for each one: which agents ran, which tools were called with what arguments, what came back, which analytics methods were used, which knowledge was cited, and how long each step took |
| **Forecast Explorer** | Deep hourly and per-measure exploration beyond the Dashboard, with a selectable horizon and the provider's own confidence basis |
| **Weather Intelligence Report** | A composed report over a location and window |
| **Weather Scenario Lab** | Hypothetical conditions explored deterministically, with the unmodified baseline stated beside every adjusted figure |
| **Weather Watch** | A condition you ask Weathra to check at a place, evaluated on a schedule, with each reading and outcome recorded on a dashboard |
| **Travel Intelligence** | A trip — origin, destination, departure, return — answered as a destination hero, a viability index, a daily outlook, a packing rationale, a temporal comparison and a historical band, from a single forecast retrieval |
| **Saved Locations** | Your places, resolved once and reused, with a weather overview across them |
| **Settings** | Unit system, default horizon, memory controls, and deletion of your data |
| **Plan & Usage** | Your tier, your allowances, what you have consumed, when each window resets, and self-service tier selection |
| **Admin Model & AI Usage** | Aggregate model usage, cost and latency; the model catalog; plan-to-policy routing; principal plan administration; and the audited model policy confirmation surface |

---

## 3. Key capabilities

- **Natural-language weather analysis** — free-text questions answered in prose, with routing,
  agents and tool calls streaming over SSE as they happen.
- **Forecast exploration** — current conditions, forecast movement, anomalies, a selectable
  horizon, every hourly entry the provider returned, and the confidence the forecast itself carries
  with its stated basis.
- **Historical analytics** — archive retrieval, period-over-period comparison, and comparison
  against a multi-year baseline that names the years it actually got.
- **Deterministic derived metrics** — descriptive statistics, percentiles, rolling windows, trend,
  distribution, anomaly detection and threshold evaluation, all computed rather than generated.
- **Multi-location comparison** — candidates ranked on a criterion, with the values behind each
  rank and an explicit reason for any exclusion.
- **Weather intelligence reports** — a composed report over a location and window.
- **Scenario exploration** — deterministic adjustment of conditions, with the unmodified baseline
  stated beside every adjusted figure.
- **Travel intelligence** — trip-window intelligence for a destination, composed server-side from
  one forecast retrieval.
- **Saved places** — places resolved once and reused, with an overview across them.
- **Weather watch rules** — conditions monitored at a place on a schedule, with every reading and
  outcome recorded.
- **Provenance and evidence** — a persisted record per run, readable only by the account that
  produced it.
- **Memory** — thread-scoped conversational context and durable user preferences.
- **Plans and usage** — three tiers, self-service selection, account-scoped consumption against
  allowances with reset windows.
- **Administrative model governance** — catalog, policies, candidate ordering, plan-to-policy
  mapping and a bounded override, every write audited.
- **Model comparison and evaluation** — a lab that scores candidates over a pinned dataset against
  five criteria, with two of them gating.
- **Usage analytics** — aggregate model usage, tokens, estimated cost, latency and failures, with
  internal usage reported separately from every product plan.

---

## 4. Architecture

One repository, two applications, built and deployed separately. The backend never serves the
frontend's pages; the frontend talks to the backend only through its documented versioned API.

```
                       ┌──────────────────────────────┐
   browser ───────────▶│  frontend/  Next.js 15       │
                       │  App Router, React 19, TS    │
                       └───────┬──────────────┬───────┘
                     bearer token         email + password
                               │              │
                               ▼              ▼
                    ┌──────────────────┐  ┌─────────────────┐
                    │ backend/ FastAPI │  │  Supabase Auth  │
                    │  REST + SSE      │◀─┤  (credentials,  │
                    └────────┬─────────┘  │   verification) │
                             │            └─────────────────┘
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────────────┐
     │ LangGraph      │ │ MCP      │ │ Supabase Postgres  │
     │ orchestration  │▶│ weather  │ │ + pgvector, RLS on │
     │ 6 capabilities │ │ server   │ │ every owned table  │
     └───────┬────────┘ └────┬─────┘ └────────────────────┘
             │               │
             ▼               ▼
    ┌─────────────────┐  ┌────────────┐
    │ OpenRouter      │  │ Open-Meteo │
    │ (routing/prose) │  │ (weather)  │
    └─────────────────┘  └────────────┘
```

**The tool boundary is a real MCP server.** `backend/weathra/mcp/` implements a Model Context
Protocol server exposing eight tools — `geocode_location`, `weather_current`, `weather_forecast`,
`weather_history`, `weather_compare`, `weather_statistics`, `weather_anomaly` and
`weather_satellite` — with a closed error vocabulary. It runs in-process by default and can be
addressed over a transport; the client is `backend/weathra/mcp/client.py`. Every retrieval and
every analytics call the graph makes goes through it, which is what makes the evidence record a
byproduct of how a run works rather than something the model can forget to produce.

**LangGraph is used for what it is good at here** — the Postgres checkpointer that persists
conversational state across turns. The run itself is an explicit ordered sequence rather than a
node graph with conditional edges, because the only branching is *stop early*.

Component documentation:

- [`weathra/docs/architecture.md`](weathra/docs/architecture.md) — component boundaries, the dependency rule, and the requirement-to-test traceability table
- [`weathra/docs/agents.md`](weathra/docs/agents.md) — the run, the six capabilities, and why the graph executes tools
- [`weathra/docs/authentication.md`](weathra/docs/authentication.md) — identity, ownership, RLS, and the secret split
- [`weathra/docs/api.md`](weathra/docs/api.md) — every endpoint, its classification, and the SSE event catalogue
- [`weathra/docs/mcp.md`](weathra/docs/mcp.md) — the tool catalogue and its error semantics
- [`weathra/docs/rag.md`](weathra/docs/rag.md) — the knowledge corpus, embeddings, and retrieval
- [`weathra/docs/model-policy.md`](weathra/docs/model-policy.md) — resolution order, policies, entitlement, override and fallback
- [`weathra/docs/evaluation.md`](weathra/docs/evaluation.md) — the dataset, the metrics, the gates, and the recorded comparison runs
- [`weathra/docs/configuration.md`](weathra/docs/configuration.md) — every environment variable for both applications
- [`weathra/docs/privacy-ethics.md`](weathra/docs/privacy-ethics.md) — data classes, grounding limits, retention, deletion
- [`weathra/docs/deployment.md`](weathra/docs/deployment.md) — topology, environments, acceptance records, and rollback

---

## 5. Agentic workflow

A question runs through five stages:

```
  question, principal, thread
            │
            ▼
   ┌──────────────────┐
   │ route            │  supervisor: the model proposes a plan as JSON validated
   │ (supervisor)     │  against a closed schema → capabilities, order, reason
   └────────┬─────────┘  out of scope? → decline, retrieve nothing
            ▼
   ┌──────────────────┐
   │ resolve          │  location, window, units, thread references
   └────────┬─────────┘  ambiguous? → ask, retrieve nothing
            ▼
   ┌──────────────────┐
   │ execute          │  the plan's steps, in dependency-ordered groups;
   │ (capability      │  independent steps run concurrently, through MCP
   │  nodes)          │  budget exhausted? → partial, and say so
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ synthesize       │  the model writes prose from the computed findings
   │ (+ safety)       │  and from nothing else
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │ finish           │  grounding audit, uncertainty, envelope, evidence record
   └──────────────────┘
```

**The six capabilities are a closed enum** — `current`, `satellite`, `forecast`, `historical`,
`analytics`, `rag`. A routing plan naming anything else fails schema validation and nothing
executes; a capability cannot be requested into existence by a persuasively worded plan. Two more
agents frame the run and are not capabilities: the **supervisor** routes and **synthesis** writes.
All eight appear in the evidence record with their status and timing.

**Not every request runs every capability.** The supervisor plans only what the question needs, so
a simple forecast question makes one retrieval and a comparative question makes several. The
deterministic screens — Historical Analytics, Compare Cities, Forecast Explorer, the Scenario Lab,
Travel Intelligence — do not run the graph at all; they call the REST endpoints directly and involve
no model.

**Deterministic computation versus model interpretation.** The analytics tools take a *series* as
an argument and have no provider and no way to fetch one, so analytics can only run over points a
retrieval step already placed in the state. That makes "the model interprets but never calculates"
structural rather than a promise: there is no path by which the analytics capability could obtain a
number nobody retrieved.

**When routing fails**, three outcomes in order of preference: a valid plan (recorded as
`routing_source = "model"`); an invalid plan corrected on retry, bounded by `LLM_JSON_MAX_ATTEMPTS`;
or a deterministic keyword router, recorded as `deterministic_fallback`. The person still gets an
answer and the reader is told how it was routed.

---

## 6. Data sources, grounding and provenance

**Weather and geocoding come from [Open-Meteo](https://open-meteo.com)** — current conditions,
forecasts, the historical archive, and the geocoder that resolves place names. No credential is
required, and every figure Weathra reports names the provider that supplied it. Satellite imagery
comes from NASA GIBS and is carried as observational evidence: nothing in this pipeline looks at
the image, and the image is never given to the language model.

**Grounding.** Synthesis is confined to the computed findings. After it, a grounding audit extracts
every numerical figure from the prose and requires each to trace back to a retrieved value or a
computed finding. An ungrounded figure is reported rather than shown.

**Provenance labels.** Each of the five classes is labelled wherever it appears, with its provider,
location, period and retrieval time:

| Label | Means |
|---|---|
| **OBSERVED** | A provider's reading of current conditions at that place and time |
| **FORECAST** | A provider's projection, carrying its own horizon and confidence basis |
| **HISTORICAL** | Archive observations for a stated past range |
| **ANALYTICS** | A statistic Weathra computed from retrieved data, deterministically and repeatably |
| **AI INTERPRETATION** | Prose written about the above by the language model |

**AI interpretation is never presented as observed data.** It is labelled as interpretation at the
point of display, so a reader can tell a measurement from a description of one.

**Evidence records.** Every agent run persists which agents ran, which tools were called with what
arguments, what came back, which analytics methods were used, which knowledge was cited, and how
long each step took. A record is readable only by the account that produced it, and Agent Evidence
lists your own runs and opens any of them.

**The Dashboard's historical baseline is optional, by design.** It is composed from a separate
archive retrieval, and if that provider call fails the baseline section is **omitted** rather than
announced or filled in. The forecast, current-conditions and analytics cards still render. No
substitute, estimated or fabricated weather data is ever shown in its place — an absent baseline,
never a partial one.

---

## 7. Memory

Two tiers, deliberately separate:

- **Short-term conversational memory** — thread-scoped state held by LangGraph's Postgres
  checkpointer, so a follow-up question means something. Scoped to the pair of the authenticated
  user and the thread, and it survives a restart.
- **Long-term preference memory** — unit system, default forecast horizon, and saved locations.
  Durable, owner-scoped, and what makes a briefing yours rather than generic.

Together they provide continuity within a conversation and personalisation across sessions: a
second question can refer to the first's place and window, and a returning person gets their own
units and horizon without restating them.

Both tiers are yours. Settings exposes them, deleting your data removes them, and a retention
routine clears thread state on its own schedule. Usage records hold no conversation content at all.

---

## 8. Model governance and evaluation

Models are **data, not configuration**. The catalog, the policies, the plan-to-policy mapping and
the allowances are database rows, so changing which model answers a tier needs no redeployment.

- **Model catalog** — the entries that exist, each enabled or disabled, with pricing used for cost
  estimation and the latest recorded evaluation.
- **Policies and candidate ordering** — a policy is an *ordered candidate list* of catalog keys.
  The resolver walks it and takes the first entry that is enabled and that the caller's plan is
  entitled to, with a fallback policy behind it. A plan names a policy per call role; it never names
  a model.
- **Comparison runs** — the lab scores candidates over a pinned dataset in live mode and persists
  the result, with five criteria recorded per candidate.
- **Quality gates** — two criteria gate a promotion: structured-JSON reliability and groundedness.
  Reliability and groundedness cannot be traded away for cost or latency, and a candidate that
  scored nothing is recorded as *unevidenced* rather than as failed.
- **Latency evidence** — median and p95 per candidate, recorded but explicitly not a gate.
- **Administrator confirmation** — reordering or confirming a candidate list is a separate,
  separately authorised write that cites the run relied upon.
- **Audit evidence** — every administrative write records a row naming the acting principal, the
  change, and the comparison runs cited as its basis.

**A real example — the decision of 2026-09-14.** Comparison run `c1e8768f` scored both seeded
economy candidates over five cases of dataset `1.0.0`. Both scored 5/5 and **both passed both
gating criteria**; latency separated them (medians of roughly 9.2 s and 7.6 s) and latency is not a
gate. An administrator reviewed the evidence on the confirmation surface and **kept the current
order**, submitting it through the same audited write a reorder would have used, citing that run.
The candidate list is unchanged by it; the record of *why it stands* is not. An unchanged list with
a cited decision behind it and an unchanged list nobody has examined are indistinguishable in the
policy row and distinguishable in the audit trail, which is what the trail is for.

---

## 9. Admin analytics and administration

The administrative surface is a single screen over endpoints the backend authorises independently:

- **Usage by model** — calls, tokens, estimated cost, latency and failures, grouped, from
  `GET /admin/usage`.
- **Usage trends** — the same measures over a period, from `GET /admin/usage/series`.
- **Product and internal split** — lab and evaluation usage reported separately from every product
  plan, so internal spend never reads as customer traffic.
- **Model catalog** — whatever `model_catalog` holds, with enable and disable actions. No model
  name is written anywhere in the frontend.
- **Model routing** — which policy a plan's call role resolves to, and which policy a policy falls
  back to, both editable and both audited.
- **Principal and plan administration** — who is on which tier, and assignment of another
  principal's tier.
- **Model policy visibility** — each policy's ordered candidate list with the evaluation recorded
  per candidate.
- **Comparison evidence and candidate-order confirmation** — the runs available as evidence, and
  one audited write that submits the candidate list citing the runs relied upon, with the result
  read back from the audit trail rather than assumed.

**Normal users are rejected server-side.** The administrative role is backend state — a row in
`admin_roles` keyed by the validated token subject — and is never granted by a client-supplied
field, header, claim or address. Every administrative endpoint refuses a caller without it; the
navigation's hiding of the administrative group is a convenience, not the control. A refusal
discloses no model identifier, so an unentitled caller learns nothing about which models exist.

**Administrators do not get access to private user content.** Cross-person reads go through
`SECURITY DEFINER` functions that return **aggregate measures and listed columns rather than rows**,
because granting an administrative read policy on a user-owned table would hand an administrator
another person's data — which `specs/authentication` forbids and a test refuses outright. No prompt,
completion or conversation content is stored in usage records at all.

**Estimated cost is labelled an estimate** wherever it appears — priced from what the catalog said
at the time of each call, never a billed amount.

---

## 10. Plans and usage

Three tiers — **Free**, **Pro** and **Premium** — and, since the product decision of 2026-09-13,
**you choose your own**. Selecting a tier is one press in Plan & Usage, takes effect immediately,
and is reversible in either direction.

| Allowance | Free | Pro | Premium |
|---|---|---|---|
| Requests per day | 25 | 250 | 1,000 |
| Requests per month | 300 | 4,000 | 20,000 |
| Token budget per month | 500,000 | 8,000,000 | 40,000,000 |
| Concurrent AI tasks | 1 | 3 | 6 |

A tier also controls which **class** of model answers — Economy, Standard or Frontier — resolved
from the catalog by the backend, plan to policy to catalog entry, three rows deep. No gateway model
identifier is exposed to the frontend.

**How it behaves:**

- **Self-service selection** through `PUT /me/plan`, which takes no subject and writes the validated
  token's own row.
- **Persistence** across sessions; the signup-time choice has no session yet, so it is held and
  applied at first sign-in, and the card says so rather than implying it already applies.
- **Account-scoped usage** — every language model call records a usage event against the calling
  account, with tokens, latency and a labelled estimated cost.
- **Allowance tracking** with a reset window per dimension. An exhausted allowance returns 429
  naming its basis, while forecast, history, analysis and comparison keep serving.
- **Concurrent AI tasks** is a concurrency dimension and is given no fabricated reset window.
- **Administrative plan assignment** governs *another* principal's tier and every allowance; a
  person may change only their own.
- **Counters and history survive a plan change.** Consumption already counted in a window stays
  counted, nothing is reset or deleted, and a caller left over a smaller tier's allowance is told
  they are over it rather than quietly forgiven. This was verified in production, in both
  directions, during deployed acceptance.

**Actual payment processing and billing collection are not implemented.** There is no checkout, no
card handling, no invoice, no subscription record and no published price. Nothing is charged. A
tier controls what you are allowed and which class of model answers you — selectable is not
purchasable, and a test asserts no payment-processing integration exists.

---

## 11. Security and multi-tenancy

- **Authentication is Supabase Auth** — email and password, with mandatory email verification by
  code or link. The frontend holds a cookie session and forwards the access token to FastAPI as a
  bearer token; the backend validates it against the issuer's published signing keys.
- **Every protected route is owner-scoped by construction.** Routes serving your own data take *no
  subject parameter* — the subject comes from the validated token. A caller supplying somebody
  else's identifier in a query string, body or header is answered about themselves, because the
  identifier was never read. There is nothing to spoof.
- **Row Level Security is the second gate, in the database.** User-owned tables carry owner policies
  tested against the same `weathra_current_user_id()` accessor, and the request-serving role
  connects as a restricted login that RLS applies to. A query asking for another person's rows
  returns none regardless of what the endpoint intended.
- **Writes are refused by the database, not only by Python.** Choosing your own plan is granted to
  the request role with `WITH CHECK (user_id = weathra_current_user_id())` on both INSERT and
  UPDATE, so a request shaped to name somebody else writes nothing rather than writing their row.
- **Cross-account isolation is asserted, not assumed.** A parameterised boundary suite runs every
  protected route three ways — no token, a valid token, and acting as its subject — and a coverage
  test fails if a protected route is added without being added to it. In deployed acceptance,
  User A → User B and User B → User A isolation were both verified against production.
- **Anonymous callers get 401** on every protected route; this is verified against the live backend
  for the whole protected surface, with the check list driven off `openapi.json` so a new route
  cannot be missed.
- **Ordinary authenticated users get 403** on every administrative operation, refused server-side.
- **Administrative access is request-scoped and narrow.** The role is backend state, never a claim.
  Cross-person reads go through administrator-gated `SECURITY DEFINER` functions returning measures
  and listed columns; no user-owned table carries an administrative read policy.
- **The serving container holds no privileged database credential.** Migrations run from GitHub
  Actions precisely so the browser-facing container never holds a connection that bypasses RLS, and
  a test asserts the Render service never receives `DATABASE_URL_PRIVILEGED`.
- **Secrets stay server-side.** The browser receives only the Supabase URL, the publishable key and
  the backend base URL. A containment test asserts no service-role key, database URL or gateway
  credential reaches the environment files, the source, or the built bundle.

**Not claimed:** Weathra holds no SOC 2, GDPR or ISO certification, and has had no external
penetration test. The guarantees above are the ones this repository tests, and nothing more.

---

## 12. Accessibility and responsive design

Acceptance rests on **reproducible engineering validation**, recorded in
[`weathra/docs/design/accessibility.md`](weathra/docs/design/accessibility.md):

- **Automated accessibility assertions** — axe-core over every screen at multiple widths in both
  appearances, on two browser engines.
- **Semantic DOM and ARIA verification** — correct form, dialog, tab and table semantics, and
  heading levels that reflect where a region sits.
- **Automated keyboard traversal** of every interactive control, checked by identity rather than by
  count.
- **Visible keyboard focus**, and **no keyboard traps**.
- **An accessible name on every actionable control**, unique wherever one screen offers several of
  the same kind.
- **Accessible destructive-action behaviour** — a confirmation step before any irreversible write,
  cancellable by control and by Escape, with focus moved into the confirmation and restored on
  dismissal.
- **Responsive browser verification** at 1440, 1024, 768 and 375 pixels, with usable dialogs and
  navigation at every supported width.
- **No unintended page-level horizontal overflow** at any of those widths. The page does not clamp
  its own overflow — hiding content to make it fit would make the requirement unverifiable.
- **A text or semantic equivalent** for provenance and for every data visualisation that carries
  meaning.

All of it runs in CI on every push.

**Physical assistive-technology and physical-device testing may be performed as additional QA, but
were not blocking MVP acceptance criteria.** No Narrator, NVDA, JAWS or VoiceOver session was
performed, and no physical-handset pass was performed. Neither is claimed. The optional worksheet
for anyone who chooses to do one is
[`accessibility-manual-pass.md`](weathra/docs/design/accessibility-manual-pass.md).

---

## 13. Tech stack

Read from the project manifests and configuration; nothing here is listed because it appeared
during planning.

| Area | What is actually used |
|---|---|
| **Frontend** | Next.js 15 (App Router), React 19, TypeScript 5.7, TanStack Query, Recharts |
| **Backend** | FastAPI, Python 3.12, Uvicorn, Pydantic v2 + pydantic-settings, sse-starlette, httpx |
| **Agent orchestration** | LangGraph, with `langgraph-checkpoint-postgres` for conversational state |
| **Tool boundary** | Model Context Protocol (`mcp`), server and client both in-repo |
| **Database / auth** | PostgreSQL via Supabase, `pgvector`, SQLAlchemy 2 (async) + asyncpg, Alembic |
| **AI / model gateway** | OpenRouter, behind a provider-agnostic `LLMClient` protocol |
| **Knowledge** | fastembed embeddings over a Markdown corpus, pgvector retrieval |
| **Analytics** | numpy |
| **Weather** | Open-Meteo (forecast, archive, geocoding); NASA GIBS (satellite imagery) |
| **Deployment** | Vercel (frontend), Render (backend), Supabase (database and auth) |
| **CI/CD** | GitHub Actions — nine workflows |
| **Specification** | OpenSpec |
| **Testing** | pytest (+ pytest-asyncio, respx), Vitest, Playwright (+ `@axe-core/playwright`), axe-core, Testing Library |
| **Types and lint** | mypy, ruff, ESLint (typescript-eslint), `tsc --noEmit` |

The backend contains **no vendor SDK and no model name** outside a single configuration default —
an architecture rule with its own test.

---

## 14. Repository structure

The application lives in one top-level project directory. Only what belongs to the repository
itself sits above it — the CI workflows GitHub Actions can discover nowhere else, the licence, the
README you are reading, `render.yaml`, and `.gitignore`.

```
.github/workflows/       CI and release, at the root because Actions looks only here
render.yaml              The backend service definition, auto-deploy off
weathra/                 The application
  backend/
    weathra/
      api/               FastAPI app, routers (incl. admin/), errors, middleware, SSE, OpenAPI
      agents/            Supervisor, graph, capability nodes, budget, grounding, safety, evidence
      analytics/         Deterministic statistics — anomaly, trend, rolling, distribution, scenario…
      mcp/               The MCP weather server, its client, schemas and error vocabulary
      providers/         Open-Meteo, GIBS, HTTP, caching, registry, validation
      rag/               Corpus, ingestion, embeddings, retrieval
      memory/            Conversational checkpointing, preferences, retention
      entitlements/      Plans, policies, allowances, quota
      lab/               Model comparison and its criteria
      evaluation/        Dataset, runner, metrics, gates, model-compare CLI
      db/                Models, sessions, RLS helpers, Alembic migrations (0001–0019)
      auth/ domain/ geocoding/ telemetry/ weather/
    tests/               unit/, integration/, deployed/, plus repository-level gates
  frontend/
    app/                 App Router — (app)/ product screens, (auth)/ flows, api/ route handlers
    components/          Screen compositions and the shared UI primitives
    lib/                 API client, schema types, per-domain view logic
    hooks/ tests/ scripts/
  docs/                  Architecture, API, agents, config, evaluation, privacy, deployment, design
  openspec/              The specification-driven change this system was built from
.gitignore
LICENSE
README.md
```

Paths inside `weathra/docs/` and `weathra/openspec/` are relative to `weathra/`, since those
documents sit beside the applications they describe.

**The important directories:**

- **`backend/weathra/agents/`** — the orchestration. Read `graph.py` and `supervisor.py` first.
- **`backend/weathra/analytics/`** — every deterministic figure the product reports.
- **`backend/weathra/mcp/`** — the tool boundary that makes evidence a byproduct of a run.
- **`backend/weathra/db/migrations/`** — the schema, the roles, and every RLS policy.
- **`frontend/lib/api/`** — the single client and the generated schema types; nothing else talks to
  the backend.
- **`openspec/changes/archive/`** — the completed change: proposal, design, specs and tasks.

---

## 15. Development setup

Everything below runs in a cloud environment or a container. **Nothing needs a particular local
machine** — setup, sign-up, test and deploy have all been carried out from a browser, in GitHub
Codespaces. The same commands work in any container; the instructions are not local-only.

### What you need first

| | Why |
|---|---|
| **A Supabase project** (free tier is enough) | Accounts, email verification, password reset, and the Postgres database with `pgvector` |
| **Python 3.12** | The backend pins `>=3.12,<3.13` |
| **Node 20 or newer** | The frontend targets Node 20+; CI uses 22 |
| **An OpenRouter API key** (optional) | Only the AI Weather Analyst needs it. Everything else works without one |

### Configure Supabase

1. **Authentication → Providers → Email** — enable email, and require email confirmation.
2. **Authentication → Email Templates** — add the one-time token (`{{ .Token }}`) to *Confirm
   signup* and *Reset password* so Weathra can offer in-app code entry. Keep the link too; both
   paths complete the same verification.
3. **Authentication → URL Configuration** — add `http://localhost:3000` and your deployed frontend
   origin as redirect URLs.
4. **Database → Roles** — the migrations create the restricted `weathra_request` role the API runs
   as. Note the connection strings for both the pooled request connection and the direct privileged
   one.

### Backend

```bash
cd weathra/backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env          # then fill in SUPABASE_URL and the two database URLs
```

Apply the schema with the **privileged** connection — migrations create tables, roles and RLS
policies, which the restricted request role deliberately cannot do:

```bash
WEATHRA_RUNTIME_MODE=privileged alembic upgrade head
WEATHRA_RUNTIME_MODE=privileged weathra-ingest-corpus
```

Then serve it:

```bash
uvicorn weathra.api.app:create_app --factory --reload
```

- `http://localhost:8000/api/v1/health` — answers immediately
- `http://localhost:8000/api/v1/ready` — each dependency's configuration and reachability
- `http://localhost:8000/api/v1/docs` — the interactive API reference

### Frontend

```bash
cd weathra/frontend
npm ci
cp .env.example .env.local     # the Supabase URL, its public key, and the backend base URL
npm run dev
```

Open `http://localhost:3000`, create an account, and enter the code from the verification email.

Everything in `frontend/.env.local` is public by design and ships in the browser bundle. The
service-role key, the database URLs and the inference key are backend secrets and must never appear
there under any name — `npm run check:secrets` asserts exactly that against the environment files,
the source and the built bundle, and CI runs it on every pull request.

### Running the checks

```bash
# backend — no network, no database, no credentials needed
cd weathra/backend && pytest

# backend — against a real Postgres with pgvector
WEATHRA_TEST_DATABASE_URL=postgresql://... pytest -m db

# the offline acceptance run over the evaluation dataset
weathra-evaluate

# frontend
cd ../frontend && npm run lint && npm run typecheck && npm test && npm run build

# frontend browser suites
npx playwright test
```

The default backend suite reaches nothing external: weather payloads are replayed from recorded
Open-Meteo responses, tokens are minted locally against a test key pair, embeddings come from a
deterministic hashing model, and the MCP server runs in-process. That is why it can gate every pull
request.

**A note for cloud shells:** if your environment exports `DATABASE_URL`, `SUPABASE_URL` or the other
backend settings ambiently, the offline suite will pick them up and fail spuriously. Run it with
those unset (`env -u DATABASE_URL -u SUPABASE_URL … pytest`).

### Other entry points

```bash
weathra-compare      # run a model comparison over the pinned dataset
weathra-retention    # clear expired thread state and snapshots
weathra-watch-evaluate   # evaluate scheduled weather watches
```

---

## 16. Environment variables

**Names only. No value belongs in this file, in the repository, or in a commit.** Both applications
ship a `.env.example` listing every setting with its default;
[`weathra/docs/configuration.md`](weathra/docs/configuration.md) documents each one with its
classification, and a test asserts the two stay in step.

### Frontend — public by definition, since the browser receives them

**Required:**

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_BASE_URL
```

City imagery is optional and its provider credential is a **secret**, so it is configured
server-side and deliberately documented in [`docs/city-imagery.md`](weathra/docs/city-imagery.md)
rather than here.

### Backend

**Required — runtime and deployment:**

```
WEATHRA_ENVIRONMENT
WEATHRA_RUNTIME_MODE
CORS_ALLOWED_ORIGINS
```

**Required — authentication:**

```
SUPABASE_URL
SUPABASE_JWT_ISSUER
SUPABASE_JWT_AUDIENCE
SUPABASE_JWKS_URL
SUPABASE_SERVICE_ROLE_KEY        secret
```

**Required — database:**

```
DATABASE_URL                     secret
DATABASE_URL_PRIVILEGED          secret   (migrations only; never on the serving container)
```

**Required for the AI paths only — model gateway:**

```
OPENROUTER_API_KEY               secret
```

**Optional, with working defaults** — around sixty further settings, grouped as they appear in
`.env.example`:

| Group | Settings |
|---|---|
| Runtime and API | `LOG_LEVEL`, `API_VERSION_PREFIX` |
| Authentication tuning | `SUPABASE_JWKS_CACHE_TTL`, `SUPABASE_JWT_LEEWAY_SECONDS` |
| Database tuning | `DATABASE_POOL_SIZE`, `DATABASE_POOL_MAX_OVERFLOW`, `DATABASE_RESTRICTED_ROLE` |
| Model gateway | `LLM_PROVIDER`, `LLM_MODEL`, `OPENROUTER_BASE_URL`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_RETRIES`, `LLM_JSON_MAX_ATTEMPTS`, `LLM_RATE_LIMIT_MAX_WAIT_SECONDS`, `LLM_SINGLE_MODEL_MODE`, `LLM_FAILOVER_MAX_MODELS`, `MODEL_CATALOG_CACHE_TTL_SECONDS` |
| Telemetry, quota and lab | `LLM_USAGE_RETENTION_DAYS`, `QUOTA_ENABLED`, `QUOTA_WINDOW_TIMEZONE`, `MODEL_LAB_MAX_MODELS`, `MODEL_LAB_MAX_CASES`, `MODEL_LAB_TIME_BUDGET_SECONDS` |
| Weather providers | `DEFAULT_WEATHER_PROVIDER`, `DEFAULT_GEOCODER`, `OPEN_METEO_API_KEY`, `DEFAULT_UNIT_SYSTEM`, `DEFAULT_FORECAST_DAYS`, `MINIMUM_HOURLY_HOURS` |
| HTTP and caching | `HTTP_TIMEOUT_SECONDS`, `HTTP_CONNECT_TIMEOUT_SECONDS`, `HTTP_MAX_RETRIES`, `HTTP_BACKOFF_SECONDS`, `CACHE_*_TTL_SECONDS`, `CACHE_MAX_ENTRIES` |
| Agents and comparison | `AGENT_MAX_STEPS`, `AGENT_WALL_CLOCK_BUDGET_SECONDS`, `COMPARISON_MAX_LOCATIONS` |
| MCP | `MCP_TRANSPORT`, `MCP_SERVER_ADDRESS`, `MCP_TIMEOUT_SECONDS`, `MCP_ENABLED_TOOLS` |
| RAG | `EMBEDDING_MODEL_ID`, `EMBEDDING_DIMENSION`, `RAG_TOP_K`, `RAG_RELEVANCE_THRESHOLD`, `RAG_CHUNK_MAX_TOKENS`, `RAG_CHUNK_OVERLAP_TOKENS`, `VECTOR_STORE` |
| Watches and retention | `WATCH_CADENCE_MINUTES`, `WATCH_EVALUATION_RETENTION_DAYS`, `THREAD_RETENTION_DAYS`, `SNAPSHOT_RETENTION_DAYS`, `SAVED_LOCATIONS_LIMIT` |
| Evaluation | `EVALUATION_MIN_SERVED_RATE`, `EVALUATION_LLM_MIN_INTERVAL_SECONDS` |

The backend must start and serve every public capability with `OPENROUTER_API_KEY` absent,
degrading only the agent paths. **Model selection is deliberately not configuration** beyond
`LLM_MODEL` as a development and administrative fallback: policies, plan mappings and the catalog
live in the database, so a model or tier change needs no redeployment.

The deployed acceptance suites read a separate `WEATHRA_LIVE_*` group for live-session checks.
Those are operator-supplied credentials for dedicated test accounts; with them unset the checks
skip, naming the variable they need rather than passing vacuously.

---

## 17. Testing and quality

Validation is layered, and each layer answers a different question.

| Layer | What it establishes |
|---|---|
| **Backend unit tests** | Every analytics function, provider adapter, resolver, entitlement rule and agent node in isolation, with no network, no database and no credentials |
| **Integration tests** | The graph end to end over recorded provider payloads, the MCP server in-process, RAG retrieval against a deterministic embedding model |
| **Database-backed tests** (`-m db`) | Migrations, schema, grants and behaviour against a real Postgres with `pgvector` |
| **RLS and security tests** | Every user-owned table's owner policy, the restricted role's inability to bypass it, claims not surviving into the next session, and the cross-person administrative functions returning measures rather than rows |
| **Auth boundary tests** | Every protected route run three ways — no token, an invalid token, a valid token acting as its subject — with a coverage test that fails if a route is added without being added to the suite |
| **Architecture tests** | No vendor SDK or model name in the backend outside one configuration default; the dependency rule between layers; no payment-processing integration |
| **Frontend component tests** (Vitest) | Screen compositions, view logic, the API client, error handling, and that a failed read is never drawn as an answer |
| **Accessibility tests** | axe-core and design-rule suites in Vitest, plus Playwright accessibility and focus suites across two browser engines |
| **OpenAPI drift** | A snapshot test over `openapi.json`, and generated frontend schema types checked against it, so the contract cannot drift silently |
| **Secret containment** | No service-role key, database URL or gateway credential in the frontend environment, source or built bundle |
| **Documentation and traceability** | Every requirement maps to at least one test, every route is documented with its access classification, every setting appears in `.env.example`, and a status cannot disagree with its checkbox |
| **Deployed acceptance** | The live pair checked from outside — pages, redirects, readiness, public weather surfaces and their attribution, CORS, and every protected endpoint refusing every shape of invalid token; plus the credentialed session tiers |

**Numerical totals are deliberately not quoted here.** The counts in the final verified run belong
to the commit that produced them, and repeating them from memory at a later commit is how a README
starts asserting things nobody measured. Run the suites above — each is one command — and they will
tell you what they find today.

**CI.** Nine GitHub Actions workflows gate the repository: `backend.yml`, `frontend.yml`, the two
release pipelines (`release.yml`, `frontend-release.yml`), `backend-allowed-origin.yml`,
`db-identity.yml`, `database-retention.yml`, `weather-watch.yml` and `live-acceptance.yml`. The
backend workflow runs lint, types, the offline suite, migrations against an ephemeral pgvector
service, the database-backed suite, a migration downgrade-and-replay check, and the offline
acceptance run, in that order.

---

## 18. Production acceptance

The three operational acceptance tasks are complete.

| Task | Scope | Status |
|---|---|---|
| **21.8** | Accessibility and responsiveness across every screen | **Complete** |
| **34.5** | Model comparison and the audited administrative decision | **Complete** |
| **34.7** | Deployed SaaS-layer acceptance | **Complete** |

**21.8** closed against an acceptance contract deliberately amended so that blocking MVP acceptance
rests on reproducible engineering validation — twelve clauses, all running in CI — rather than on
mandatory physical-device or real assistive-technology field testing. No screen-reader or handset
pass is claimed. §12 lists what was verified.

**34.5** closed when an administrator reviewed comparison run `c1e8768f` in production and recorded
the audited candidate-order decision. §8 describes it.

**34.7** ran end to end against the deployed pair and validated:

- **Two ordinary users**, both signing in against production.
- **Bidirectional account isolation** — A sees none of B's data, and B sees none of A's. Asked in
  both directions, because a single-direction check passes on a system that leaks one way.
- **Normal-user admin rejection**, confirmed server-side rather than by the navigation hiding a
  link.
- **Administrator sign-in and role**, reported from backend state.
- **Admin analytics** answering with real aggregate measures.
- **Admin plan assignment**, with the assigned plan **read back from User B's own account** rather
  than inferred from the write's response.
- **Usage counters and history preserved** through the plan change, and the original plan restored
  afterwards.
- **Anonymous protected-route behaviour** — every protected route refuses a caller with no token,
  with the check list driven off `openapi.json`.

Every criterion passed and no blocker remained. No password, token or session value is recorded in
this repository. One non-blocking observation is carried into §21 as a limitation rather than a
defect.

---

## 19. Deployment

Five hosted services, each doing one thing, and no step that needs a particular computer.

| | What it holds | How it is reached |
|---|---|---|
| **GitHub Codespaces** | the development environment | Both applications run inside it; nothing needs installing on a laptop |
| **GitHub Actions** | every production credential | The only route to production |
| **Vercel** | the Next.js frontend | Built *on the runner* and promoted with `--prebuilt`, so what is live is what the commit built. The three `NEXT_PUBLIC_` values are the only configuration it holds |
| **Render** | the FastAPI backend, as a container | Deployed with the request-serving database connection only. The privileged connection never reaches it |
| **Supabase** | accounts and Postgres with `pgvector` | Auth, the user-owned tables under Row Level Security, and the vector index |
| **Open-Meteo** | weather and geocoding | No credential. Every figure Weathra reports names it |
| **OpenRouter** | the language model | Optional. Without it every deterministic capability still works and the Analyst says why it cannot answer |

**Migrations and the deployment flow.** Auto-deploy is **off** on both platforms —
`autoDeployTrigger: "off"` in `render.yaml`, `git.deploymentEnabled.main: false` in
`frontend/vercel.json` — so a push to `main` never releases anything by itself. The release
workflows are the only route:

1. `release.yml` applies Alembic migrations with the **privileged** connection from the runner, then
   releases the backend container. Migrations land before the new revision serves traffic, which is
   a property of the pipeline rather than of timing.
2. `frontend-release.yml` builds the Next.js application on the runner and promotes the prebuilt
   output to Vercel.
3. `database-retention.yml` removes expired data on a schedule; `weather-watch.yml` evaluates
   scheduled watches.

The privileged credential exists only in Actions. The serving container never holds it, which is
why administrative cross-person reads had to be built as administrator-gated `SECURITY DEFINER`
functions rather than by handing the container a connection that bypasses RLS.

**Rollback** is redeploying the previous container revision on either platform. Migrations in this
change are additive, so a rolled-back revision runs against the newer schema without loss.

**Verifying a deployment** — three commands, none of which need a credential:

```bash
curl https://<backend>/api/v1/health
curl https://<backend>/api/v1/ready
curl -i https://<frontend>/sign-in          # redirects an unauthenticated visitor
```

For the whole deployed pair at once, the credential-free acceptance suite checks it from outside
and writes nothing — its client refuses any method but `GET`, `HEAD` and `OPTIONS`:

```bash
cd weathra/backend
SUPABASE_URL=https://placeholder.supabase.co pytest -m deployed
```

[`weathra/docs/deployment.md`](weathra/docs/deployment.md) is the operational reference: what each
secret is for, what each workflow may and may not do, and how each environment was verified.

---

## 20. OpenSpec development process

Weathra was built specification-first. Every artifact of the change lives in
[`weathra/openspec/`](weathra/openspec/):

- **Proposal** (`proposal.md`) — what is being built and why, with explicit non-goals.
- **Design** (`design.md`) — the architectural decisions and their trade-offs, each recorded with
  the alternative it was chosen over.
- **Capability specifications** (`specs/`) — twenty-one capabilities written as testable scenarios:
  agent orchestration, authentication, deterministic analytics, evaluation, forecast analysis,
  historical weather, the HTTP API, LLM telemetry, location comparison, location resolution, the
  MCP weather server, memory, model catalog, model lab, model policy, RAG knowledge, safety and
  grounding, satellite observation, usage limits, weather providers, and the web UI.
- **Task tracking** (`tasks.md`) — 308 numbered tasks, ordered by dependency, each checked only
  when its stated requirement is genuinely satisfied.
- **Acceptance evidence** — recorded under the tasks it belongs to and in `docs/`, including the
  dated notes for 21.8, 34.5 and 34.7.
- **Strict validation** — `openspec validate --all --strict`, run as a gate.

Requirements were **amended when the product decision changed**, rather than left disagreeing with
the product: self-service plan selection (2026-09-13) and 21.8's acceptance contract (2026-09-14)
are both recorded as amendments with their reasoning, not as reinterpretations of an unchanged
requirement.

**308/308 tasks complete. The `weathra-mvp` change is archived.**

---

## 21. Known limitations

- **Weathra is not an official severe-weather warning system.** It issues no warnings and refers you
  to your national meteorological service. Do not rely on it for safety-of-life decisions.
- **One weather provider.** Everything comes from Open-Meteo, so its coverage, resolution, archive
  depth and rate limits are Weathra's. The confidence signal derives from a single provider's own
  spread and horizon distance — a bounded signal, and stated as one.
- **External provider availability.** A provider outage or rate limit degrades the surfaces that
  depend on it; each says so rather than substituting data.
- **The optional Dashboard historical baseline may be omitted.** If its archive retrieval fails the
  baseline section is left out; the rest of the Dashboard still renders and nothing is fabricated.
- **Plan & Usage may occasionally take several seconds to load** — roughly five to nine against a
  cold backend — before leaving its loading skeleton.
- **No payment processing.** Tiers control allowances and model class; there is no checkout, no
  billing and no published price.
- **The AI explains; it does not know.** It writes prose from computed findings, can still emphasise
  the wrong thing, and is labelled as interpretation so you can tell it from a measurement.
- **AI availability depends on the configured gateway.** Without `OPENROUTER_API_KEY` the
  deterministic capabilities all work and the Analyst says why it cannot answer.
- **Forecast-accuracy scoring is not implemented.** Weathra retrieves historical weather; it does
  not score how good its own past forecasts turned out to be.
- **Weather Watch reports; it does not notify.** Watches are evaluated on a schedule and surfaced in
  the product. There is no push or email delivery.
- **Physical assistive-technology and physical-device field QA remains optional** and has not been
  performed. See §12.

---

## 22. Future work

Beyond-MVP directions already aligned with the project's own roadmap:

- **Multi-provider weather consensus**, with a confidence signal derived from provider disagreement
  rather than from one provider's spread.
- **Forecast-accuracy scoring** — comparing stored forecast snapshots against subsequent
  observations, which needs a longer snapshot history and scheduled capture.
- **Richer scheduled intelligence delivery** — push and email for Weather Watch, subject to the
  official-warnings stance.
- **Real billing integration** — `subscription_plans` already carries a stable plan code and an
  unused external subscription reference so the integration has somewhere to land.
- **Expanded accessibility field QA** — the optional screen-reader and physical-handset passes.
- **Broader production telemetry** — scheduled model health probing, and reconciliation of
  estimated cost against a gateway invoice.
- **Behavioural personalisation** — intelligence shaped by usage history rather than only explicit
  preferences.

[`weathra/docs/roadmap.md`](weathra/docs/roadmap.md) and Part B of `openspec/.../tasks.md` record
the full list and what is deliberately out of scope.

---

## 23. Final project status

**Production deployed.** The backend runs on Render and the frontend on Vercel, both from `main`,
both verified live.

**OpenSpec**

- 308/308 tasks complete
- 0 partial
- 0 unstarted

**Acceptance**

- 21.8 complete
- 34.5 complete
- 34.7 complete

**Validation**

- Strict OpenSpec validation passed
- Documentation and traceability passed

**Archive**

- `weathra-mvp` archived

**Status: READY FOR SUBMISSION**

---

## Licence

MIT. See [LICENSE](LICENSE).
