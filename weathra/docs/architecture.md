# Architecture

Weathra is one repository holding two applications that are built, tested, and deployed
independently: a FastAPI backend and a Next.js frontend. They share nothing at runtime. The
frontend talks to the backend only through its documented versioned API and SSE streams; the
backend serves no frontend page or asset.

The whole design serves one property: **an answer can be traced to the data behind it.** Every
decision below either produces that traceability or protects it.

## The two applications

```
                       ┌──────────────────────────────┐
   browser ───────────▶│  frontend/  Next.js 15       │
                       │  App Router, TypeScript      │
                       └───────┬──────────────┬───────┘
                     bearer token         email + password
                               │              │
                               ▼              ▼
                    ┌──────────────────┐  ┌─────────────────┐
                    │ backend/ FastAPI │  │  Supabase Auth  │
                    │  REST + SSE      │◀─┤                 │
                    └────────┬─────────┘  └─────────────────┘
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────────────┐
     │ LangGraph      │ │ MCP      │ │ Supabase Postgres  │
     │ orchestration  │▶│ weather  │ │ + pgvector, RLS    │
     └───────┬────────┘ └────┬─────┘ └────────────────────┘
             ▼               ▼
     ┌──────────────┐   ┌────────────┐
     │ OpenRouter   │   │ Open-Meteo │
     └──────────────┘   └────────────┘
```

**Why one repository.** The API contract, the documentation, and CI live in one place, and a change
to a response model moves the backend's schema and the frontend's generated types in a single
reviewable commit (`backend/openapi.json` → `frontend/lib/api/schema.ts`). The applications are
still separately built and deployed, which is what the requirement asks for. Separate repositories
were considered and rejected for a project this size: it would split the contract without splitting
the release.

## The backend's module layout

```
backend/weathra/
  config.py               Settings — the only module that reads the environment
  redaction.py            log and error-body scrubbing
  domain/                 frozen models and the error hierarchy; imports nothing internal
    weather.py location.py comparison.py analytics.py evidence.py identity.py
    windows.py errors.py
  db/                     engine.py session.py urls.py models.py migrations/
  providers/              base.py (Protocol) registry.py open_meteo.py cache.py http.py
                          validation.py
  geocoding/              base.py (Protocol) open_meteo.py
  analytics/              descriptive.py precipitation.py wind.py rolling.py distribution.py
                          anomaly.py trend.py support.py — pure functions, no clock, no I/O
  weather/                forecast_service.py history_service.py comparison_service.py
                          snapshots.py uncertainty.py thresholds.py windows.py
  rag/                    corpus/ ingest.py embed.py store.py retrieve.py
  memory/                 checkpointer.py threads.py preferences.py locations.py retention.py
                          availability.py degradation.py
  auth/                   tokens.py jwks.py deps.py profiles.py repository.py rls.py
                          roles.py — the administrative role, as backend state and never a claim
  entitlements/           catalog.py policies.py plans.py snapshot.py records.py audit.py
                          the catalog, policy and plan stores — data access and administration,
                          deliberately not resolution
                          resolver.py — the one place a model is chosen
                          quotas.py — the one place a call is admitted or refused. Runs before
                          resolution: whether there is to be a call precedes which model serves it
  telemetry/              usage.py cost.py projection.py context.py aggregate.py
                          what each call cost in tokens, money and time. Records what happened;
                          decides nothing
  lab/                    compare.py records.py promotion.py
                          the model lab — run one question across several named models and record
                          what differed. Drives the graph, never a second application
  mcp/                    server.py client.py schemas.py errors.py — its own boundary
  agents/
    llm/                  base.py (Protocol) openrouter.py fake.py registry.py
    supervisor.py         routing
    plan.py               the capability catalogue and execution grouping
    graph.py              the run sequence
    nodes/                retrieval.py analytics.py knowledge.py synthesize.py support.py
    state.py budget.py context.py scope.py grounding.py safety.py evidence.py observer.py
  api/
    app.py errors.py middleware.py dependencies.py classification.py streaming.py openapi.py
    routers/              health.py locations.py weather.py history.py analysis.py
                          comparison.py agent.py evidence.py account.py usage.py support.py
  evaluation/             cases.py dataset/ fixtures.py harness.py offline_llm.py metrics.py
                          thresholds.py provisioning.py runner.py storage.py
                          criteria.py model_compare.py — the five promotion criteria, and one
                          comparison per candidate over the same pinned configuration
```

## The dependency rule

```
config, domain
      ↑
     db
      ↑
providers, geocoding, analytics
      ↑
weather, rag, memory, auth, entitlements, telemetry
      ↑
     mcp
      ↑
   agents
      ↑
     api
      ↑
 evaluation
```

A module may import its own layer and any layer below it, never above. `auth/` sits beside
`memory/` and is depended on by `api/`, `memory/`, and `evaluation/` only.

`backend/tests/test_architecture.py` enforces this by walking the source with `ast`, so a violating
import is caught whether or not anything executes it. Two consequences are load-bearing and are
asserted separately:

- **No module below `agents/` imports `agents` or any LLM client.** That is what keeps the
  deterministic spine — providers, analytics, weather, MCP, RAG, memory — fully working with no
  inference credential configured, and what makes the analytics purity requirement structural
  rather than aspirational.
- **No module in `agents/nodes/` imports a provider client.** Nodes reach weather data through the
  MCP tool boundary, which is what makes the evidence record complete: a node that called a
  provider directly would produce a figure with no tool call behind it.

The same test proves itself by introducing a deliberate violation and asserting the checker fails,
rather than asking a reader to trust that it would.

## Component boundaries

### `domain/`

Frozen pydantic models and the error hierarchy. Imports nothing internal, which is what lets every
layer above speak the same vocabulary without a cycle. The normalized weather model carries units
on the series and every timestamp twice — UTC and the location's local time — because a person
asks about their own morning and a computation needs an unambiguous instant.

### `providers/` and `geocoding/`

A provider is a Protocol with declared capabilities, not a class hierarchy: `open_meteo.py`
implements it, `cache.py` wraps *any* implementation with a two-tier cache while implementing the
same Protocol, and `registry.py` resolves the configured one. Adding a provider is a new module and
a registry entry. `http.py` holds one retry policy for provider calls and another for inference,
because their failure profiles are not alike.

### `analytics/`

Pure functions over normalized series. No clock, no I/O, no configuration: given the same series
they return the same figures, which is why the evaluation suite can assert numerical accuracy
against them as a reference. Every result states its method and its point count.

### `weather/`

The services that compose retrieval with analysis: forecast, history, comparison, snapshots for
*what changed*, and the uncertainty statement that accompanies a forecast figure. This is the layer
the MCP tools and the REST routers both sit on, so a capability behaves identically whether an
agent reached it or a person called the endpoint.

### `mcp/`

The tool boundary. The seven tools are the only route from an agent to weather data, and each
returns a structured payload with its data class, provider, period, and method. It runs in the same
container over an in-process transport by default — an extra network hop per tool call was not
worth its latency and cold-start cost in the MVP — but the boundary is clean enough that promoting
it to its own service is a deployment change. [`mcp.md`](mcp.md) has the catalogue.

### `agents/`

LangGraph orchestration over four specialized agents. The graph controls tool execution; the model
proposes a plan and writes prose. [`agents.md`](agents.md) covers the topology and why.

### `auth/` and `memory/`

Identity is one path: a validated bearer token becomes a `Principal`, and nothing else is identity.
Memory is two deliberately different stores — LangGraph's checkpointer for conversational state and
Weathra's own tables for preferences, saved locations, and thread records.
[`authentication.md`](authentication.md) covers both, with the ownership model and the RLS policies.

### `api/`

Routers, one error-to-status mapping, the request-id correlation middleware, the public/protected
classification table that the routers, the OpenAPI generator, and the tests all read, and the typed
SSE event vocabulary. [`api.md`](api.md) is the endpoint reference.

### `evaluation/`

The acceptance suite: 40 cases, ten metrics, seven gating thresholds, and an offline mode that
replays recorded Open-Meteo payloads through the real adapter.
[`evaluation.md`](evaluation.md) explains what it measures.

## Request paths

**A public weather request** — `GET /api/v1/weather/forecast?location=Berlin`

```
router → geocoder → provider (cached) → normalization → uncertainty → response envelope
```

No session, no database write, no model. Attribution — provider, location, period, retrieval time —
is assembled by code, not by a model.

**A protected agent request** — `POST /api/v1/agent/ask`

```
bearer token → Principal → thread memory → graph
   route (model proposes a plan)
   resolve (location, window, units — asks rather than assumes when ambiguous)
   execute  (MCP tools, in dependency-ordered groups)
   synthesize (model writes prose from the computed findings)
   ground   (three layers of verification)
→ envelope + evidence record, both owned by the acting user
```

**A stream** — `POST /api/v1/agent/stream` is the same run with an observer attached, mapped into
Weathra's own event vocabulary. The token is validated before the run begins and the principal is
held for the stream's lifetime; the agent's wall-clock budget is set below the token lifetime so a
long stream cannot outlive its authorization.

## Persistence

Supabase Postgres with `pgvector`, SQLAlchemy 2 async over asyncpg, Alembic migrations. Ten tables
in three ownership classes — user-owned, shared read-only, and operational — with Row Level
Security forced on every user-owned one. Two connections exist for one reason: the request-serving
connection runs under a `NOLOGIN NOBYPASSRLS` role so policies apply to the backend's own queries,
and the privileged connection exists only for migrations, retention, and evaluation provisioning.
The settings validator refuses to start a request-serving process that has the service-role key.

## Errors

One hierarchy in `domain/errors.py`, each class carrying a stable `code`, mapped to an HTTP status
in exactly one place (`api/errors.py`). Every failure answers with the same envelope —
`{"error": {code, message, details, request_id}}` — and the code is part of the contract while the
message is written for a person. A test asserts every error class appears in the status map, so a
new failure cannot be added without deciding what it means over HTTP.

## Testing

The default suite reaches nothing external: recorded provider payloads, locally minted tokens
against a test key pair, a deterministic hashing embedder, and an in-process MCP transport. A
`db`-marked suite runs against a real Postgres with `pgvector` — in CI as a service container — and
the RLS gate is proven by a query with its ownership predicate deliberately omitted. `live`-marked
tests reach the real upstreams and are deselected by default. Both CI workflows run on hosted
runners with no step that assumes a particular local machine.

## Traceability

Task 25.5. Every requirement in all twenty capability specs, traced to the tasks that implement it,
the modules that hold it, and the tests that prove it. It reads in both directions: a reviewer
starting from a requirement finds its tests, and a reviewer starting from a test finds the
requirement that governs it.

**Paths.** Implementation paths are relative to `backend/weathra/` and test paths to
`backend/tests/` unless they begin with `frontend/` or `docs/`, which are relative to the project
root. Task numbers refer to `openspec/changes/weathra-mvp/tasks.md`.

**Status.** `IMPLEMENTED` — the governing tasks are complete and the named tests exist and run.
`MANUAL` — implemented and automatically tested as far as automation reaches, with a human pass
still owed. `OPEN` — the governing task is open; where the row names no test, none exists yet.
A requirement is never marked implemented because code exists: the status follows its governing
task's checkbox, not the presence of a module.

**What the table is held to, and by what.** Two assertions in `test_documentation.py`, and between
them they are task 25.5's verification:

* `test_every_delivered_requirement_maps_to_at_least_one_test` — a requirement whose governing
  tasks are *all complete* must name a test. That is everything this project claims to have built,
  and a claim with no test behind it is unchecked.
* `test_every_untested_requirement_is_owned_by_an_open_task` — a requirement that names no test
  must name a task that is still open.

The second is why this table needs no invented tests to be complete. Sixty requirements — the five
SaaS specs' own, plus the ones the SaaS change added to `agent-orchestration`, `evaluation` and
`web-ui` — describe features nobody has written yet. Writing tests to fill their column would be
the worst possible way to satisfy a traceability requirement: the table would claim coverage of
code that does not exist. So each names the group 26-34 task that owes it, and the assertion holds
that task to being open. Close one of those tasks and the first assertion starts demanding its
tests. Both directions stay honest without anyone maintaining a list of which spec is which.

Of **211** requirements across twenty specs, **210** are implemented and tested, **1** is
manual-pending, and **0** are open. Exactly **0** requirements have no test. The one that remains
manual-pending is `web-ui`'s accessibility and responsive layout, which is automatically tested as
far as automation reaches and still owes a human pass (task 21.8).

Four rows closed with group 33, and what each of them claims is worth reading precisely, because
two of the four are requirements the spec itself defers. **Admin Model & AI Usage screen** and
**Plan and usage visible to the signed-in person** both say the screen is post-MVP and implemented
after the MVP; what this change owed them is an approved design and a route that does not pretend
otherwise, and that is what their rows name. Neither screen is built. **The UI never authorizes
model access or an allowance** and **the Visily design gate** are closed outright.

### Coverage by spec

| Spec | Requirements | Implemented | Manual | Open | Governing task groups |
|---|---:|---:|---:|---:|---|
| `agent-orchestration` | 17 | 17 | 0 | 0 | 13, 14 |
| `authentication` | 20 | 20 | 0 | 0 | 3, 4, 18 |
| `deterministic-analytics` | 10 | 10 | 0 | 0 | 7 |
| `evaluation` | 15 | 15 | 0 | 0 | 22, 28 |
| `forecast-analysis` | 10 | 10 | 0 | 0 | 8 |
| `historical-weather` | 5 | 5 | 0 | 0 | 8 |
| `http-api` | 24 | 24 | 0 | 0 | 15, 16 |
| `location-comparison` | 6 | 6 | 0 | 0 | 9 |
| `location-resolution` | 7 | 7 | 0 | 0 | 6 |
| `mcp-weather-server` | 7 | 7 | 0 | 0 | 10 |
| `memory` | 9 | 9 | 0 | 0 | 12 |
| `rag-knowledge` | 8 | 8 | 0 | 0 | 11 |
| `safety-grounding` | 10 | 10 | 0 | 0 | 17 |
| `weather-providers` | 7 | 7 | 0 | 0 | 5 |
| `web-ui` | 17 | 16 | 1 | 0 | 19, 20, 21, 33, 34 |
| `model-policy` | 10 | 10 | 0 | 0 | 28 |
| `model-catalog` | 7 | 7 | 0 | 0 | 26, 27 |
| `llm-telemetry` | 7 | 7 | 0 | 0 | 29 |
| `usage-limits` | 9 | 9 | 0 | 0 | 30 |
| `model-lab` | 6 | 6 | 0 | 0 | 32 |
| **Total** | **211** | **210** | **1** | **0** | |

### `agent-orchestration`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Supervisor routing across specialized agents | 14.1, 14.2 | agents/supervisor.py, agents/graph.py | unit/test_agent_state_and_routing.py, unit/test_agent_graph.py | IMPLEMENTED |
| Multi-step queries spanning several agents | 14.6 | agents/graph.py, agents/nodes/ | unit/test_agent_graph.py | IMPLEMENTED |
| Provider-agnostic language model abstraction | 13.1–13.4 | agents/llm/base.py, agents/llm/openrouter.py, agents/llm/registry.py | unit/test_llm.py, unit/test_no_vendor_coupling.py | IMPLEMENTED |
| Tool access only through the approved tool interface | 14.14 | agents/nodes/, mcp/client.py | unit/test_agent_catalog.py, test_architecture.py | IMPLEMENTED |
| The language model interprets but never calculates | 14.4, 17.1 | agents/nodes/analytics.py, analytics/ | unit/test_analytics.py, integration/test_safety.py | IMPLEMENTED |
| Bounded execution | 14.9 | agents/budget.py | unit/test_agent_graph.py | IMPLEMENTED |
| Evidence record | 14.8 | agents/evidence.py, domain/evidence.py | unit/test_domain_evidence.py, frontend/lib/evidence/record.test.ts | IMPLEMENTED |
| Streaming progress | 16.1 | agents/observer.py, api/streaming.py | integration/test_api.py | IMPLEMENTED |
| Runs act as an authenticated user | 14.1 | agents/context.py, auth/deps.py | integration/test_auth_data_path.py | IMPLEMENTED |
| Conversation context and follow-up questions | 14.11 | agents/context.py, memory/threads.py | integration/test_agent_memory.py | IMPLEMENTED |
| Clarification instead of assumption | 14.12 | agents/nodes/support.py | unit/test_agent_graph.py | IMPLEMENTED |
| Scope confinement | 14.13 | agents/scope.py | unit/test_agent_state_and_routing.py | IMPLEMENTED |
| Untrusted content is data, not instruction | 14.13 | agents/safety.py | integration/test_safety.py | IMPLEMENTED |
| Operation without an inference credential | 13.5 | agents/llm/registry.py | integration/test_no_credential.py | IMPLEMENTED |
| Model selection comes from the policy layer, never from a node or a caller | 28.7 | entitlements/resolver.py, agents/models.py, agents/graph.py | unit/test_policy_resolver.py, integration/test_agent_resolution.py, test_architecture.py | IMPLEMENTED |
| Orchestration is gated by quota and instrumented per call | 29.3, 30.6 | api/routers/agent.py, entitlements/quotas.py, agents/llm/instrumented.py | integration/test_quota_api.py, integration/test_telemetry_persistence.py | IMPLEMENTED |
| Every language model call attempt is recorded in the evidence record | 22.8 | domain/evidence.py, agents/llm/base.py | unit/test_domain_evidence.py, unit/test_llm.py | IMPLEMENTED |

### `authentication`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Supabase Auth is the identity system | 4.1 | auth/tokens.py, auth/jwks.py | unit/test_auth_tokens.py, unit/test_auth_jwks.py, frontend/lib/supabase/clients.test.ts | IMPLEMENTED |
| Account creation with email and password | 20.5 | frontend/components/auth/create-account-form.tsx | frontend/components/auth/create-account.test.tsx, frontend/app/(auth)/create-account/page.test.tsx, frontend/lib/auth/password.test.ts | IMPLEMENTED |
| Mandatory email verification | 20.6 | frontend/components/auth/verify-email-form.tsx | frontend/components/auth/verify-email.test.tsx, frontend/app/(auth)/verify-email/page.test.tsx, frontend/app/auth/confirm/route.test.ts | IMPLEMENTED |
| Verification code entry, resend, and states | 20.6 | frontend/lib/auth/verification.ts | frontend/lib/auth/verification.test.ts | IMPLEMENTED |
| Sign in and sign out | 20.4 | frontend/components/auth/sign-in-form.tsx | frontend/components/auth/sign-in.test.tsx, frontend/tests/e2e/protected-route.spec.ts, frontend/app/(auth)/sign-in/page.test.tsx | IMPLEMENTED |
| Forgot password and password reset | 20.7 | frontend/components/auth/forgot-password-form.tsx, frontend/components/auth/reset-password-form.tsx | frontend/components/auth/forgot-password.test.tsx, frontend/components/auth/reset-password.test.tsx, frontend/app/(auth)/forgot-password/page.test.tsx, frontend/app/(auth)/reset-password/page.test.tsx | IMPLEMENTED |
| Session persistence and expiry | 20.8 | frontend/lib/session/state.ts, frontend/middleware.ts | frontend/lib/session/state.test.ts, frontend/middleware.test.ts, frontend/lib/session/session-layer.test.tsx | IMPLEMENTED |
| Backend validates every token | 4.2 | auth/tokens.py, auth/deps.py | unit/test_auth_deps.py, unit/test_auth_tokens.py | IMPLEMENTED |
| Application profile linked to the auth user | 4.4 | auth/profiles.py | integration/test_auth_data_path.py, unit/test_domain_identity.py, frontend/lib/auth/identity.test.ts | IMPLEMENTED |
| User-owned data is scoped to its owner | 3.4 | db/session.py, auth/rls.py | integration/test_auth_data_path.py, integration/test_db_schema.py | IMPLEMENTED |
| Cross-user access is denied | 18.3 | auth/rls.py, db/session.py | integration/test_auth_boundary.py | IMPLEMENTED |
| Endpoint protection classification | 15.2 | api/classification.py | test_openapi_snapshot.py, integration/test_api.py | IMPLEMENTED |
| Authorization enforced in the backend, not the client | 18.4 | auth/deps.py | integration/test_auth_boundary.py | IMPLEMENTED |
| Row Level Security on user-owned tables | 3.2, 3.3 | db/migrations/versions/0002_row_level_security.py | integration/test_db_schema.py, integration/test_shared_data_policies.py, unit/test_db_roles.py, integration/test_db_migration_privileges.py | IMPLEMENTED |
| Secret handling | 23.3 | config.py | test_secret_storage.py, frontend/scripts/secret-containment.test.ts, test_env_example.py, frontend/lib/env.test.ts | IMPLEMENTED |
| Authentication in streaming requests | 16.3 | api/streaming.py | integration/test_api.py | IMPLEMENTED |
| Account and data deletion | 15.5 | api/routers/account.py | integration/test_api.py | IMPLEMENTED |
| Administrative and internal roles are server-held | 31.1, 34.9 | auth/roles.py, auth/deps.py, api/routers/account.py, db/migrations/versions/0011_administrative_role_state.py | integration/test_admin_roles.py, integration/test_admin_api.py | IMPLEMENTED |
| Plan and model entitlement are derived, never asserted | 28.2 | entitlements/resolver.py, auth/roles.py | unit/test_policy_resolver.py, integration/test_agent_resolution.py | IMPLEMENTED |
| Row Level Security on the SaaS-ready tables | 26.3, 26.4 | db/migrations/versions/0006_saas_user_owned_tables.py, db/migrations/versions/0007_model_lab_and_audit_tables.py | integration/test_saas_rls.py, integration/test_saas_schema.py | IMPLEMENTED |

### `deterministic-analytics`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Analytics are pure, deterministic, and free of language models | 7.1, 7.9 | analytics/ | unit/test_analytics.py, test_architecture.py | IMPLEMENTED |
| Descriptive temperature statistics | 7.2 | analytics/descriptive.py | unit/test_analytics.py | IMPLEMENTED |
| Precipitation statistics and probability analysis | 7.3 | analytics/precipitation.py | unit/test_analytics.py | IMPLEMENTED |
| Humidity, pressure, and wind statistics | 7.3 | analytics/wind.py, analytics/descriptive.py | unit/test_analytics.py | IMPLEMENTED |
| Rolling averages, deltas, and percentiles | 7.4 | analytics/rolling.py | unit/test_analytics.py | IMPLEMENTED |
| Z-scores against a stated reference | 7.5 | analytics/distribution.py | unit/test_analytics.py | IMPLEMENTED |
| Anomaly detection | 7.6 | analytics/anomaly.py | unit/test_analytics.py | IMPLEMENTED |
| Trend analysis | 7.7 | analytics/trend.py | unit/test_analytics.py | IMPLEMENTED |
| Insufficient data handling | 7.8 | analytics/support.py | unit/test_analytics.py | IMPLEMENTED |
| Structured, self-describing results | 7.8 | domain/analytics.py | unit/test_analytics.py, unit/test_domain_weather.py | IMPLEMENTED |

### `evaluation`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Evaluation dataset | 22.1 | evaluation/dataset/, evaluation/cases.py | unit/test_evaluation.py | IMPLEMENTED |
| Metric definitions | 22.2 | evaluation/metrics.py | unit/test_evaluation.py | IMPLEMENTED |
| Acceptance thresholds | 22.3 | evaluation/thresholds.py | unit/test_evaluation.py | IMPLEMENTED |
| Evaluation runner | 22.4 | evaluation/runner.py, evaluation/harness.py | integration/test_evaluation_runner.py | IMPLEMENTED |
| Deterministic metrics run without external services | 22.5 | evaluation/offline_llm.py, evaluation/fixtures.py | integration/test_evaluation_runner.py | IMPLEMENTED |
| Evaluation runs authenticate | 22.6 | evaluation/provisioning.py | integration/test_evaluation_runner.py | IMPLEMENTED |
| Reproducibility and comparison across runs | 22.7 | evaluation/storage.py | integration/test_evaluation_runner.py, unit/test_db_models.py | IMPLEMENTED |
| Evaluation results are documented | 24.6 | docs/evaluation.md | test_documentation.py | IMPLEMENTED |
| Candidate models are evaluated through this framework | 32.6 | evaluation/model_compare.py, evaluation/runner.py | unit/test_lab_criteria.py, integration/test_lab_api.py | IMPLEMENTED |
| Model selection is decided on measured criteria, not on model name | 32.7, 32.9 | evaluation/criteria.py, lab/promotion.py, lab/evidence.py, api/routers/admin/models.py | unit/test_lab_criteria.py, unit/test_lab_evidence.py, integration/test_lab_api.py, integration/test_lab_evidence.py | IMPLEMENTED |
| Model evaluation results are persisted and comparable | 32.8 | lab/records.py, lab/evidence.py, evaluation/model_compare.py, db/models.py | integration/test_lab_records.py, integration/test_lab_evidence.py | IMPLEMENTED |
| Evaluation runs are internal usage | 32.10 | api/routers/admin/lab.py, evaluation/provisioning.py, entitlements/quotas.py | integration/test_lab_api.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| A live evaluation run is pinned to one named model | 22.10, 28.10 | evaluation/runner.py, evaluation/harness.py, entitlements/resolver.py, agents/llm/registry.py | integration/test_evaluation_runner.py, unit/test_policy_resolver.py, unit/test_llm.py | IMPLEMENTED |
| Live runs distinguish provider failure from model quality | 22.9 | evaluation/integrity.py | unit/test_evaluation.py, integration/test_evaluation_runner.py | IMPLEMENTED |
| Live runs are paced and bounded against provider limits | 22.9 | evaluation/runner.py, agents/llm/openrouter.py | unit/test_evaluation.py, unit/test_llm.py | IMPLEMENTED |

### `forecast-analysis`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Current conditions retrieval | 8.2 | weather/forecast_service.py | unit/test_weather_services.py | IMPLEMENTED |
| Forecast retrieval across granularities and measures | 8.2 | weather/forecast_service.py, weather/windows.py | unit/test_weather_services.py | IMPLEMENTED |
| Forecast window analysis | 8.1 | weather/windows.py | unit/test_weather_services.py | IMPLEMENTED |
| Threshold crossings | 8.3 | weather/thresholds.py | unit/test_weather_services.py | IMPLEMENTED |
| Forecast anomalies | 7.6 | analytics/anomaly.py, weather/forecast_service.py | unit/test_analytics.py, unit/test_weather_services.py | IMPLEMENTED |
| Forecast snapshot capture | 8.6 | weather/snapshots.py | integration/test_snapshots.py | IMPLEMENTED |
| What Changed? | 8.7 | weather/snapshots.py, api/routers/weather.py | integration/test_snapshots.py, unit/test_api_changes_route.py, integration/test_changes.py | IMPLEMENTED |
| Confidence and uncertainty communication | 8.4 | weather/uncertainty.py | unit/test_weather_services.py, integration/test_safety.py | IMPLEMENTED |
| Plain-language forecast summary without a language model | 8.5 | weather/forecast_service.py | unit/test_weather_services.py, integration/test_no_credential.py | IMPLEMENTED |
| Insufficient forecast data | 7.8 | weather/forecast_service.py, analytics/support.py | unit/test_weather_services.py | IMPLEMENTED |

### `historical-weather`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Historical observation retrieval | 8.8 | weather/history_service.py | unit/test_weather_services.py, frontend/lib/historical/analysis.test.ts | IMPLEMENTED |
| Period-versus-period comparison | 8.8 | weather/history_service.py, weather/comparison_service.py | unit/test_weather_services.py, unit/test_comparison.py | IMPLEMENTED |
| Historical baselines | 8.9 | weather/history_service.py | unit/test_weather_services.py | IMPLEMENTED |
| Comparison against baseline | 8.10 | weather/comparison_service.py | unit/test_comparison.py | IMPLEMENTED |
| Historical requests are separable from accuracy scoring | 8.11 | weather/history_service.py | unit/test_weather_services.py | IMPLEMENTED |

### `http-api`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Authentication on the HTTP surface | 15.4 | api/dependencies.py, auth/deps.py | integration/test_api.py, integration/test_auth_boundary.py | IMPLEMENTED |
| Public and protected endpoint classification | 15.4 | api/classification.py | test_openapi_snapshot.py | IMPLEMENTED |
| Current-user endpoint | 15.11 | api/routers/account.py | integration/test_api.py | IMPLEMENTED |
| User data deletion endpoint | 15.14 | api/routers/account.py | integration/test_api.py | IMPLEMENTED |
| Versioned, documented API surface | 15.1 | api/app.py, api/openapi.py | test_openapi_snapshot.py, frontend/scripts/api-types.test.ts | IMPLEMENTED |
| Location endpoints | 15.5 | api/routers/locations.py | integration/test_api.py | IMPLEMENTED |
| Current weather and forecast endpoints | 15.6 | api/routers/weather.py | integration/test_api.py | IMPLEMENTED |
| Forecast changes endpoint | 8.7 | api/routers/weather.py | unit/test_api_changes_route.py, integration/test_changes.py | IMPLEMENTED |
| History endpoint | 15.7 | api/routers/history.py | integration/test_api.py | IMPLEMENTED |
| Analysis endpoint | 15.8 | api/routers/analysis.py | integration/test_api.py | IMPLEMENTED |
| Comparison endpoint | 15.9 | api/routers/comparison.py | integration/test_api.py | IMPLEMENTED |
| Agent ask endpoint | 15.10 | api/routers/agent.py | integration/test_api.py | IMPLEMENTED |
| SSE streaming of agent progress | 16.1, 16.2 | api/streaming.py | integration/test_api.py | IMPLEMENTED |
| Preferences and saved-locations endpoints | 15.12 | api/routers/locations.py, memory/preferences.py | integration/test_memory_preferences.py, integration/test_memory_saved_locations.py | IMPLEMENTED |
| Evidence endpoint | 15.13 | api/routers/evidence.py | integration/test_api.py | IMPLEMENTED |
| Request validation | 15.2 | api/errors.py, mcp/schemas.py | integration/test_api.py | IMPLEMENTED |
| Consistent error model | 15.2 | api/errors.py, domain/errors.py | unit/test_domain_errors.py, test_frontend_error_codes.py, frontend/lib/api/client.test.ts | IMPLEMENTED |
| Health and readiness | 15.15 | api/routers/health.py | integration/test_api.py | IMPLEMENTED |
| Request correlation and observability | 15.3 | api/middleware.py | integration/test_api.py | IMPLEMENTED |
| Cross-origin access for the frontend | 15.1, 16.4 | api/app.py | integration/test_api.py | IMPLEMENTED |
| Model selection is not caller-selectable on product endpoints | 28.2, 31.6 | api/routers/agent.py, entitlements/resolver.py, api/classification.py | unit/test_policy_resolver.py, integration/test_admin_api.py | IMPLEMENTED |
| Quota enforcement on the HTTP surface | 30.6 | api/routers/agent.py, api/errors.py, domain/errors.py | integration/test_quota_api.py | IMPLEMENTED |
| Plan and usage endpoint for the signed-in person | 30.7 | api/routers/usage.py, entitlements/quotas.py | integration/test_quota_api.py, integration/test_auth_boundary.py | IMPLEMENTED |
| Administrative model, usage, and lab endpoints | 31.3–31.6, 32.5 | api/routers/admin/ | integration/test_admin_api.py, integration/test_lab_api.py | IMPLEMENTED |

### `location-comparison`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Comparison across multiple locations | 9.1 | weather/comparison_service.py | unit/test_comparison.py, frontend/lib/comparison/ranking.test.ts | IMPLEMENTED |
| Comparison across days for one location | 9.2 | weather/comparison_service.py | unit/test_comparison.py | IMPLEMENTED |
| Supported comparison criteria | 9.3 | domain/comparison.py | unit/test_comparison.py | IMPLEMENTED |
| Comparison fairness | 9.4 | weather/comparison_service.py | unit/test_comparison.py | IMPLEMENTED |
| Historical comparison mode | 9.5 | weather/comparison_service.py | unit/test_comparison.py | IMPLEMENTED |
| Ties and partial failures | 9.5 | weather/comparison_service.py | unit/test_comparison.py | IMPLEMENTED |

### `location-resolution`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Canonical location shape | 2.2 | domain/location.py | unit/test_domain_location.py | IMPLEMENTED |
| Geocoding behind its own provider seam | 6.1 | geocoding/base.py, geocoding/open_meteo.py | unit/test_geocoding.py | IMPLEMENTED |
| Resolution by place name | 6.2 | geocoding/open_meteo.py | unit/test_geocoding.py, frontend/lib/locations/place.test.ts | IMPLEMENTED |
| Ambiguous place names | 6.3 | geocoding/open_meteo.py, domain/location.py | unit/test_geocoding.py, frontend/lib/locations/resolution.test.ts | IMPLEMENTED |
| Unknown place names | 6.4 | geocoding/open_meteo.py | unit/test_geocoding.py | IMPLEMENTED |
| Resolution by coordinates | 6.3 | geocoding/open_meteo.py, domain/location.py | unit/test_geocoding.py, unit/test_domain_location.py | IMPLEMENTED |
| Location search | 6.4 | api/routers/locations.py | integration/test_api.py | IMPLEMENTED |

### `mcp-weather-server`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Server boundary and independence | 10.1 | mcp/server.py | unit/test_mcp_server.py, test_architecture.py | IMPLEMENTED |
| Tool catalog | 10.2 | mcp/tools/, mcp/server.py | unit/test_mcp_server.py, unit/test_agent_catalog.py | IMPLEMENTED |
| Tools return normalized, attributed results | 10.3 | mcp/schemas.py | unit/test_mcp_server.py | IMPLEMENTED |
| Statistics and anomaly tools are deterministic | 10.4 | mcp/tools/, analytics/ | unit/test_mcp_server.py, unit/test_analytics.py | IMPLEMENTED |
| Input validation | 10.5 | mcp/schemas.py | unit/test_mcp_server.py | IMPLEMENTED |
| Error semantics | 10.6 | mcp/errors.py | unit/test_mcp_server.py | IMPLEMENTED |
| Transport and configuration | 10.8 | mcp/client.py, config.py | unit/test_mcp_server.py, test_config.py | IMPLEMENTED |

### `memory`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Short-term memory scoped by user and thread | 12.1 | memory/threads.py, memory/checkpointer.py | integration/test_memory_threads.py, unit/test_memory_checkpointer.py, integration/test_memory_checkpointer.py | IMPLEMENTED |
| Follow-up reference resolution | 14.11 | agents/context.py, memory/threads.py | integration/test_agent_memory.py | IMPLEMENTED |
| Conversation retention is bounded and non-sensitive by default | 12.5 | memory/retention.py | integration/test_memory_retention.py | IMPLEMENTED |
| Durable preference store | 12.3 | memory/preferences.py | integration/test_memory_preferences.py, frontend/lib/settings/preferences.test.ts | IMPLEMENTED |
| Saved locations | 12.4 | memory/locations.py | integration/test_memory_saved_locations.py | IMPLEMENTED |
| Ownership derived from the authenticated user | 12.2 | memory/, auth/rls.py | integration/test_auth_data_path.py, integration/test_checkpoint_policies.py | IMPLEMENTED |
| Memory unavailability degrades honestly | 12.6 | memory/degradation.py, memory/availability.py | unit/test_memory_degradation.py | IMPLEMENTED |
| Both memory tiers are retained unchanged by the model policy layer | 26.5, 28.8 | db/migrations/versions/0006_saas_user_owned_tables.py, agents/graph.py | integration/test_saas_rls.py, integration/test_agent_resolution.py | IMPLEMENTED |
| Plan, policy, and usage state are not conversational memory | 26.3, 30.1 | db/models.py, memory/threads.py, memory/retention.py, entitlements/quotas.py | integration/test_quota_enforcement.py, integration/test_saas_rls.py | IMPLEMENTED |

### `rag-knowledge`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Curated knowledge corpus | 11.1 | rag/corpus/ | unit/test_rag_corpus.py | IMPLEMENTED |
| Ingestion and chunking | 11.4 | rag/ingest.py | unit/test_rag_corpus.py, integration/test_rag.py | IMPLEMENTED |
| Embedding behind an abstraction | 11.2 | rag/embed.py | integration/test_rag.py, test_architecture.py | IMPLEMENTED |
| Semantic retrieval | 11.5 | rag/retrieve.py, rag/store.py | integration/test_rag.py | IMPLEMENTED |
| Conceptual answers are cited | 11.5, 14.5 | agents/nodes/knowledge.py, agents/nodes/retrieval.py | integration/test_rag.py, integration/test_safety.py | IMPLEMENTED |
| RAG is never a source of measurements | 11.6 | agents/nodes/knowledge.py | integration/test_safety.py, integration/test_rag.py | IMPLEMENTED |
| Vector store selection and portability | 11.3 | rag/store.py | integration/test_rag.py | IMPLEMENTED |
| Retrieval available without an inference credential | 11.6 | rag/retrieve.py | integration/test_no_credential.py | IMPLEMENTED |

### `safety-grounding`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| No fabricated weather measurements | 14.10 | agents/grounding.py | integration/test_safety.py | IMPLEMENTED |
| Numerical analytics are deterministic | 7.9 | analytics/ | unit/test_analytics.py, integration/test_safety.py | IMPLEMENTED |
| Data classes are labelled and never conflated | 17.3 | domain/weather.py, agents/evidence.py | unit/test_domain_weather.py, frontend/lib/design/data-class.test.ts | IMPLEMENTED |
| Source attribution on every weather answer | 17.2 | agents/evidence.py, domain/evidence.py | integration/test_safety.py, unit/test_domain_evidence.py | IMPLEMENTED |
| Uncertainty is communicated | 8.4 | weather/uncertainty.py | unit/test_weather_services.py, integration/test_safety.py | IMPLEMENTED |
| Weathra does not present itself as a forecaster | 17.3 | agents/safety.py | integration/test_safety.py | IMPLEMENTED |
| Not a replacement for official warnings | 17.3 | agents/safety.py | integration/test_safety.py | IMPLEMENTED |
| No unsupported severe-weather claims | 17.4 | agents/safety.py, agents/grounding.py | integration/test_safety.py | IMPLEMENTED |
| Honest handling of unavailable data | 17.5 | agents/nodes/support.py, providers/validation.py | integration/test_safety.py, unit/test_providers.py | IMPLEMENTED |
| Data minimization in persistence | 17.6 | redaction.py, memory/retention.py | unit/test_auth_redaction.py, integration/test_memory_retention.py | IMPLEMENTED |

### `weather-providers`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Normalized weather data model | 2.3 | domain/weather.py | unit/test_domain_weather.py | IMPLEMENTED |
| Provider interface and registry | 5.1 | providers/base.py, providers/registry.py | unit/test_providers.py, test_architecture.py | IMPLEMENTED |
| Open-Meteo provider implementation | 5.2 | providers/open_meteo.py | unit/test_providers.py | IMPLEMENTED |
| Forecast horizon bounds | 5.6 | weather/windows.py, providers/validation.py | unit/test_weather_services.py | IMPLEMENTED |
| Historical range bounds | 5.6 | weather/windows.py, providers/validation.py | unit/test_weather_services.py | IMPLEMENTED |
| Response caching | 5.3 | providers/cache.py | unit/test_providers.py | IMPLEMENTED |
| Upstream failure handling | 5.7 | providers/http.py, providers/validation.py | unit/test_providers.py | IMPLEMENTED |

### `web-ui`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Separate frontend application | 20.1 | frontend/ | test_repository_layout.py | IMPLEMENTED |
| Visily design artifacts precede implementation | 19.1 | docs/design/ | test_documentation.py | IMPLEMENTED |
| Approved design direction carried into Visily | 19.1 | docs/design/design-system.md, docs/design/tokens.md | test_documentation.py, frontend/lib/design/tokens.test.ts, frontend/tests/design-rules.test.ts | IMPLEMENTED |
| MVP authentication screens | 20.4–20.7 | frontend/app/(auth)/, frontend/components/auth/ | frontend/components/auth/*.test.tsx, frontend/tests/e2e/flows.spec.ts | IMPLEMENTED |
| Protected areas and authentication states | 20.8 | frontend/middleware.ts, frontend/lib/session/ | frontend/tests/protected-route.test.tsx, frontend/tests/e2e/protected-route.spec.ts, frontend/app/(app)/layout.test.tsx | IMPLEMENTED |
| MVP product screens | 21.1–21.7 | frontend/components/{dashboard,analyst,compare,historical,locations,settings,evidence}/ | frontend/components/*/*.test.tsx, frontend/components/shell/complete-product.test.tsx, frontend/lib/dashboard/briefing.test.ts, frontend/lib/analyst/run.test.ts, frontend/lib/fixtures/fixtures.test.ts, frontend/lib/images/locations.test.ts, frontend/lib/images/provider.test.ts | IMPLEMENTED |
| Post-MVP screens are designed, not built | 21.7 | frontend/lib/routes.ts, frontend/lib/navigation.ts | frontend/lib/routes.test.ts, frontend/lib/navigation.test.ts | IMPLEMENTED |
| Data classes and attribution are visible | 21.4 | frontend/components/ui/provenance.tsx | frontend/components/ui/provenance.test.tsx, frontend/lib/design/data-class.test.ts | IMPLEMENTED |
| Loading, empty, and error states | 20.9 | frontend/components/view-state.tsx | frontend/components/ui/primitives.test.tsx, frontend/lib/query/query-layer.test.tsx | IMPLEMENTED |
| Agent unavailability handled gracefully | 21.2 | frontend/components/analyst/, frontend/hooks/use-agent-stream.ts | frontend/components/analyst/analyst.test.tsx, frontend/hooks/use-agent-stream.test.tsx | IMPLEMENTED |
| Ambiguous location handling in the UI | 21.5 | frontend/components/locations/candidate-choice.tsx | frontend/components/locations/candidate-choice.test.tsx | IMPLEMENTED |
| Accessibility and responsive layout | 21.8 | frontend/components/shell/, frontend/app/globals.css | frontend/tests/accessibility.test.tsx, frontend/tests/e2e/accessibility.spec.ts, frontend/tests/e2e/axe.spec.ts, frontend/lib/design/contrast.test.ts | MANUAL |
| Admin Model & AI Usage screen | 33.1, 33.4 | docs/design/screens/09-admin-model-ai-usage.png, frontend/app/(app)/admin/model-usage/page.tsx | frontend/app/(app)/unlisted-routes.test.tsx, test_documentation.py | IMPLEMENTED |
| Administrative model policy confirmation | 34.8, 34.9 | frontend/components/admin/model-policy.tsx, frontend/lib/admin/policy-evidence.ts, frontend/lib/api/client.ts, frontend/lib/navigation.ts, frontend/components/shell/navigation.tsx, api/routers/admin/models.py | frontend/components/admin/model-policy.test.tsx, frontend/lib/admin/policy-evidence.test.ts, frontend/components/shell/shell.test.tsx, frontend/app/(app)/unlisted-routes.test.tsx, integration/test_admin_api.py | IMPLEMENTED |
| The UI never authorizes model access or an allowance | 33.4–33.6 | frontend/lib/api/quota.ts, frontend/lib/inference/served.ts, frontend/components/ui/states.tsx, frontend/components/analyst/, frontend/components/dashboard/, frontend/components/evidence/ | frontend/lib/api/quota.test.ts, frontend/lib/inference/served.test.ts, frontend/components/analyst/analyst.test.tsx, frontend/components/dashboard/dashboard.test.tsx, frontend/components/evidence/evidence.test.tsx, frontend/components/ui/primitives.test.tsx, test_frontend_error_codes.py | IMPLEMENTED |
| Plan and usage visible to the signed-in person | 33.2, 34.10 | docs/design/screens/10-plan-usage.png, frontend/app/(app)/plan/page.tsx, frontend/components/plan/plan-usage.tsx, frontend/lib/plan/usage.ts | frontend/components/plan/plan-usage.test.tsx, frontend/lib/plan/usage.test.ts, test_documentation.py | IMPLEMENTED |
| Administrative and plan screens remain subject to the Visily design gate | 33.3 | docs/design/screens.md, docs/design/roadmap.md | test_documentation.py, frontend/lib/navigation.test.ts, frontend/app/(app)/unlisted-routes.test.tsx | IMPLEMENTED |

### `model-policy`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Model policy layer between orchestration and the language model client | 28.1, 28.6 | entitlements/resolver.py, agents/llm/factory.py, agents/models.py | unit/test_policy_resolver.py, unit/test_llm_failover.py, test_architecture.py | IMPLEMENTED |
| Subscription-aware named policies | 26.6, 27.2, 28.1 | entitlements/policies.py, entitlements/plans.py, db/migrations/versions/0008_seed_model_policy_data.py | integration/test_entitlement_stores.py, integration/test_saas_seed.py | IMPLEMENTED |
| Entitlement is enforced server-side and never trusted from the client | 28.2 | entitlements/resolver.py, auth/roles.py | unit/test_policy_resolver.py, integration/test_agent_resolution.py | IMPLEMENTED |
| Administrative override is bounded by the allowlist | 28.3 | entitlements/resolver.py, entitlements/snapshot.py | unit/test_policy_resolver.py, integration/test_entitlement_snapshot.py | IMPLEMENTED |
| Resolution is deterministic, ordered, and degrades honestly | 28.1, 28.5 | entitlements/resolver.py, entitlements/snapshot.py | unit/test_policy_resolver.py, integration/test_entitlement_snapshot.py | IMPLEMENTED |
| Configured model remains the development and administrative fallback | 28.4, 28.5 | entitlements/resolver.py, config.py | unit/test_policy_resolver.py, test_config.py | IMPLEMENTED |
| The policy layer stays provider-agnostic | 27.4, 28.6 | agents/llm/factory.py, entitlements/records.py | unit/test_no_vendor_coupling.py, unit/test_llm_failover.py | IMPLEMENTED |
| Model policy never affects deterministic computation or grounding | 28.8 | agents/graph.py, entitlements/records.py | integration/test_agent_resolution.py | IMPLEMENTED |
| Policy administration is privileged and auditable | 31.2, 31.3 | api/routers/admin/models.py, entitlements/policies.py, entitlements/audit.py | integration/test_admin_api.py, integration/test_entitlement_stores.py | IMPLEMENTED |
| Runtime provider failure fails over within the entitled policy, never on quality | 28.9 | agents/llm/failover.py | unit/test_llm_failover.py | IMPLEMENTED |

### `model-catalog`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Model catalog as persisted data | 26.2, 26.6 | db/models.py, db/migrations/versions/0005_saas_operational_tables.py, db/migrations/versions/0008_seed_model_policy_data.py | integration/test_saas_schema.py, integration/test_saas_seed.py | IMPLEMENTED |
| Model availability changes without a code change | 27.1, 27.3 | entitlements/catalog.py, entitlements/snapshot.py | integration/test_entitlement_stores.py, integration/test_entitlement_snapshot.py | IMPLEMENTED |
| Enable and disable status is honoured at resolution time | 27.1, 28.1 | entitlements/catalog.py, entitlements/resolver.py, entitlements/snapshot.py | unit/test_policy_resolver.py, integration/test_entitlement_stores.py, integration/test_entitlement_snapshot.py | IMPLEMENTED |
| Business logic is decoupled from vendor model identifiers | 27.4 | entitlements/records.py, db/migrations/versions/0008_seed_model_policy_data.py | unit/test_no_vendor_coupling.py | IMPLEMENTED |
| The catalog is the allowlist | 28.3 | entitlements/snapshot.py, agents/llm/factory.py | unit/test_policy_resolver.py, integration/test_entitlement_snapshot.py | IMPLEMENTED |
| Catalog administration is privileged and validated | 27.1, 31.3 | api/routers/admin/models.py, entitlements/catalog.py | integration/test_admin_api.py, integration/test_entitlement_stores.py | IMPLEMENTED |
| Catalog state is observable | 31.3, 32.2 | api/routers/admin/models.py, entitlements/catalog.py, lab/records.py | integration/test_admin_api.py, integration/test_lab_api.py | IMPLEMENTED |

### `llm-telemetry`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Every language model call emits a usage event | 29.1, 29.3 | telemetry/usage.py, telemetry/projection.py, agents/llm/instrumented.py | unit/test_telemetry.py, integration/test_telemetry_persistence.py, integration/test_agent_resolution.py | IMPLEMENTED |
| Failures, timeouts, and refusals are recorded | 29.4 | agents/llm/instrumented.py, telemetry/projection.py, agents/llm/attempts.py | unit/test_telemetry.py, integration/test_telemetry_persistence.py | IMPLEMENTED |
| Cost estimation is deterministic and labelled as an estimate | 29.2 | telemetry/cost.py | unit/test_telemetry.py | IMPLEMENTED |
| Telemetry records metadata, not conversation content | 29.6 | domain/usage.py, telemetry/projection.py | integration/test_telemetry_persistence.py, unit/test_telemetry.py | IMPLEMENTED |
| Telemetry never degrades or blocks the answer path | 29.5 | telemetry/usage.py, agents/llm/instrumented.py | integration/test_telemetry_persistence.py, integration/test_agent_resolution.py | IMPLEMENTED |
| Telemetry is owner-scoped and internal usage is separated | 29.1, 30.5 | telemetry/usage.py, telemetry/aggregate.py, entitlements/quotas.py, db/migrations/versions/0010_internal_quota_accounting.py | integration/test_telemetry_persistence.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| Telemetry is aggregatable and retained for a bounded period | 29.7, 29.8 | telemetry/aggregate.py, memory/retention.py, db/migrations/versions/0009_usage_counter_delete_grant.py | integration/test_telemetry_persistence.py | IMPLEMENTED |

### `usage-limits`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Subscription plans are persisted server-side data | 26.2, 26.6, 28.2, 30.1 | db/models.py, db/migrations/versions/0005_saas_operational_tables.py, db/migrations/versions/0008_seed_model_policy_data.py, entitlements/quotas.py | integration/test_saas_seed.py, integration/test_saas_rls.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| Quotas are enforced in the backend before the call | 30.2, 30.6 | entitlements/quotas.py, api/routers/agent.py | integration/test_quota_api.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| Allowances differ by plan and are expressed in stated dimensions | 30.1, 30.3, 30.4 | domain/usage.py, entitlements/quotas.py, db/migrations/versions/0008_seed_model_policy_data.py | unit/test_quotas.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| Windows are explicit and reset predictably | 30.1, 30.9 | domain/usage.py, entitlements/quotas.py, config.py | unit/test_quotas.py, integration/test_quota_enforcement.py | IMPLEMENTED |
| Quota refusal is honest, structured, and non-destructive | 30.6, 30.9 | domain/errors.py, api/errors.py, entitlements/quotas.py | unit/test_quotas.py, integration/test_quota_api.py | IMPLEMENTED |
| Accounting is consistent with recorded usage and safe under concurrency | 30.2, 30.3, 30.4, 30.8 | entitlements/quotas.py, api/routers/agent.py | integration/test_quota_enforcement.py, unit/test_quotas.py | IMPLEMENTED |
| Internal and administrative usage is tracked separately | 30.5 | entitlements/quotas.py, auth/roles.py, db/migrations/versions/0010_internal_quota_accounting.py, evaluation/provisioning.py | integration/test_quota_enforcement.py, integration/test_quota_api.py | IMPLEMENTED |
| Quota administration is privileged and auditable | 31.4 | api/routers/admin/plans.py, entitlements/plans.py, entitlements/audit.py | integration/test_admin_api.py | IMPLEMENTED |
| No payment processing in this change | 26.2 | db/models.py, db/migrations/versions/0005_saas_operational_tables.py | test_no_payment_processing.py, integration/test_saas_seed.py | IMPLEMENTED |

### `model-lab`

| Requirement | Tasks | Implementation | Tests | Status |
|---|---|---|---|---|
| Internal model selection restricted to administrative principals and the allowlist | 32.5 | api/routers/admin/lab.py, lab/compare.py, auth/roles.py | integration/test_lab_api.py | IMPLEMENTED |
| The same prompt or query compared across models | 32.1, 32.6 | lab/compare.py, evaluation/model_compare.py | integration/test_lab_api.py, unit/test_lab_criteria.py, integration/test_lab_evidence.py | IMPLEMENTED |
| Comparison runs are recorded with their measurements | 32.2 | lab/records.py, lab/evidence.py, api/routers/admin/lab.py | integration/test_lab_records.py, integration/test_lab_api.py, integration/test_lab_evidence.py | IMPLEMENTED |
| The lab bypasses no security control and no data isolation | 32.4 | lab/compare.py, api/routers/admin/lab.py, auth/rls.py | integration/test_lab_api.py | IMPLEMENTED |
| Lab usage is internal, bounded, and attributed | 32.3, 32.10 | lab/compare.py, api/routers/admin/lab.py, agents/llm/registry.py, config.py | unit/test_lab_criteria.py, integration/test_lab_api.py | IMPLEMENTED |
| The lab does not change production policy implicitly | 32.9 | lab/promotion.py, api/routers/admin/models.py, entitlements/audit.py | integration/test_lab_api.py, integration/test_lab_evidence.py | IMPLEMENTED |

### What the table does not cover

**Five test files govern no capability requirement**, because they prove properties of the
repository and its pipelines rather than of a capability:
`test_ci_workflows.py`, `test_container.py`, `test_release_workflow.py` (groups 23.1 and 23.4),
`test_dependencies.py` (the dependency rule of group 1), and `unit/test_db_migration_chain.py`
(migration-chain integrity, group 3). They are listed here so that every test file in the
repository lands somewhere, in the same way every requirement does. Deployment and CI have no
capability spec by design — they are governed by tasks 23.1–23.7 and recorded in
[`deployment.md`](deployment.md).

**No capability spec is unimplemented by accident.** The five specs of the SaaS layer —
`model-policy`, `model-catalog`, `llm-telemetry`, `usage-limits`, and `model-lab` — were wholly
open when this table was first written. **All thirty-nine of their requirements are now
implemented and tested**, closed by groups 26 through 32 and traced above: the schema and its Row
Level Security (26), the catalog, plan and policy stores (27), the resolver and its failover (28),
the usage events and cost estimation (29), the allowances and the gate (30), the administrative
control plane (31), and the lab with its criteria and its promotion action (32). Task 34.6 is the
check that they *are* all traced, and it is asserted per spec rather than in aggregate, so one
spec regressing cannot be hidden by the other four.

The counts in the table above are the rows below it, recounted rather than remembered — they had
drifted while groups 27 to 29 filled in their own sections and left the summary alone, and they
drifted again in the other direction: two rows stayed `OPEN` after their governing tasks closed.
`model-policy`'s subscription-aware policies row was written while 27.2 was open and never
followed the checkbox. `evaluation`'s pinned-model row was honestly open for longer than that —
the resolution existed and nothing called it, so a live run reached its model through the product
walk; group 34's wiring is what made the requirement true, and the row cites it. A status
following the checkbox is now asserted in both directions, which is what would have caught both.

**Two requirements are outstanding, and neither is a gap in the mapping.** `web-ui`'s
accessibility and responsive layout is `MANUAL` — its automated half passes in two browser
engines, and Task 21.8's recorded human pass is still owed. The four `OPEN` rows are `web-ui`'s
Admin Model & AI Usage and Plan & Usage screens, which group 33 may not begin until the Visily
designs exist (33.1, 33.2) — they are **DESIGN-GATED**, not merely unwritten, and no route
advertises either screen as working. They name no test on purpose: writing tests for screens
nobody has designed would make this table claim coverage of code that does not exist.
