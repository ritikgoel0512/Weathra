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
                          comparison.py agent.py evidence.py account.py support.py
  evaluation/             cases.py dataset/ fixtures.py harness.py offline_llm.py metrics.py
                          thresholds.py provisioning.py runner.py storage.py
```

## The dependency rule

```
config, domain
      ↑
     db
      ↑
providers, geocoding, analytics
      ↑
weather, rag, memory, auth
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
