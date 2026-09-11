# The HTTP API

One versioned surface under `/api/v1`, documented by its own OpenAPI schema:

| | |
|---|---|
| Interactive reference | `GET /api/v1/docs` |
| ReDoc | `GET /api/v1/redoc` |
| Machine-readable schema | `GET /api/v1/openapi.json` |
| Committed snapshot | [`backend/openapi.json`](../backend/openapi.json) |

The committed snapshot is the contract between the two applications: the frontend's TypeScript
types are **generated** from it (`frontend/lib/api/schema.ts`), a backend test fails when the
snapshot no longer matches the running application, and a frontend test fails when the types no
longer match the snapshot. A change to a response model therefore moves the schema, the types, and
the code in one reviewable commit — and cannot move only one of them.

Regenerate both after changing a model:

```bash
cd backend  && python scripts/dump_openapi.py
cd frontend && npm run api:types
```

## Conventions

**Authentication.** A protected endpoint requires `Authorization: Bearer <access token>` — a
Supabase access token, validated locally against the project's published signing keys. There is no
other identity mechanism: an identifier in a header, a query parameter, or a body is never read as
identity. See [`authentication.md`](authentication.md).

**Units.** Every endpoint that returns weather accepts `units=metric|imperial`. When it is absent,
a signed-in caller's preference applies, then the configured default. Units travel *on the series*,
so a payload always says what its numbers are in.

**Timestamps.** Twice, always: UTC and the location's local time. A person asks about their own
morning; a computation needs an unambiguous instant.

**Attribution.** Every weather payload carries the provider, the location, the period covered, and
the retrieval time — assembled by code, not by a model. Every value carries its data class:
`current`, `forecast`, `historical_observation`, `computed_statistic`, or `ai_interpretation`.

**Errors.** One envelope, always:

```json
{
  "error": {
    "code": "location_not_found",
    "message": "No place matched “Atlantis”.",
    "details": {"query": "Atlantis"},
    "request_id": "01J8Z…"
  }
}
```

The `code` is stable and part of the contract; the `message` is written for a person and may be
reworded. `request_id` appears on every response and in every log line for that request, so a report
about one failure is findable. A 500 logs everything and returns nothing but the code and the
request id — an internal failure's details are for the operator, not the caller.

FastAPI's own 422 validation failures are re-mapped to **400** with the offending input dropped
from the response, because echoing a rejected body back is how a validation error becomes a
reflection vector.

## Every endpoint

| Method | Path | Access | Success | Response model |
|---|---|---|---|---|
| `GET` | `/api/v1/health` | public | 200 | `HealthResponse` |
| `GET` | `/api/v1/locations/resolve` | public | 200 | `ResolvedResponse or AmbiguousResponse` |
| `GET` | `/api/v1/locations/search` | public | 200 | `SearchResponse` |
| `GET` | `/api/v1/plans` | public | 200 | `PlansResponse` |
| `GET` | `/api/v1/ready` | public | 200 | `ReadinessResponse` |
| `GET` | `/api/v1/weather/analysis` | public | 200 | `AnalysisResponse` |
| `GET` | `/api/v1/weather/changes` | **protected** | 200 | `WhatChanged` |
| `POST` | `/api/v1/weather/comparison` | public | 200 | `ComparisonResult` |
| `POST` | `/api/v1/weather/scenario` | **public** | 200 | `ScenarioResponse` |
| `GET` | `/api/v1/weather/current` | public | 200 | `CurrentResponse` |
| `GET` | `/api/v1/weather/forecast` | public | 200 | `ForecastResponse` |
| `GET` | `/api/v1/weather/history` | public | 200 | `HistoryResponse` |
| `GET` | `/api/v1/weather/history/baseline` | public | 200 | `Baseline` |
| `GET` | `/api/v1/weather/history/baseline/comparison` | public | 200 | `BaselineComparison` |
| `GET` | `/api/v1/weather/history/comparison` | public | 200 | `PeriodComparison` |
| `POST` | `/api/v1/agent/ask` | **protected** | 200 | `AskResponse` |
| `POST` | `/api/v1/agent/stream` | **protected** | 200 | `stream` |
| `GET` | `/api/v1/evidence/{evidence_id}` | **protected** | 200 | `EvidenceResponse` |
| `GET` | `/api/v1/me` | **protected** | 200 | `MeResponse` |
| `DELETE` | `/api/v1/me/data` | **protected** | 200 | `DeletionResponse` |
| `GET` | `/api/v1/me/locations` | **protected** | 200 | `SavedLocationsResponse` |
| `POST` | `/api/v1/me/locations` | **protected** | 201 | `SavedLocationRecord` |
| `DELETE` | `/api/v1/me/locations/{saved_id}` | **protected** | 204 | `no body` |
| `DELETE` | `/api/v1/me/preferences` | **protected** | 200 | `PreferenceView` |
| `GET` | `/api/v1/me/preferences` | **protected** | 200 | `PreferenceView` |
| `PUT` | `/api/v1/me/preferences` | **protected** | 200 | `PreferenceView` |
| `GET` | `/api/v1/me/watches` | **protected** | 200 | `WatchesResponse` |
| `POST` | `/api/v1/me/watches` | **protected** | 201 | `WatchRecord` |
| `PATCH` | `/api/v1/me/watches/{watch_id}` | **protected** | 200 | `WatchRecord` |
| `DELETE` | `/api/v1/me/watches/{watch_id}` | **protected** | 204 | — |
| `POST` | `/api/v1/me/watches/{watch_id}/evaluate` | **protected** | 200 | `WatchRecord` |
| `GET` | `/api/v1/me/usage` | **protected** | 200 | `UsageResponse` |
| `GET` | `/api/v1/admin/allowances` | **protected** | 200 | `AllowanceListResponse` |
| `PUT` | `/api/v1/admin/allowances/internal` | **protected** | 200 | `AllowanceRecord` |
| `GET` | `/api/v1/admin/lab/comparisons` | **protected** | 200 | `LabRunListResponse` |
| `POST` | `/api/v1/admin/lab/comparisons` | **protected** | 201 | `LabRunResponse` |
| `GET` | `/api/v1/admin/lab/comparisons/{run_id}` | **protected** | 200 | `LabRunResponse` |
| `GET` | `/api/v1/admin/models` | **protected** | 200 | `CatalogListResponse` |
| `POST` | `/api/v1/admin/models` | **protected** | 201 | `CatalogEntry` |
| `PATCH` | `/api/v1/admin/models/{catalog_key}` | **protected** | 200 | `CatalogEntry` |
| `POST` | `/api/v1/admin/models/{catalog_key}/disable` | **protected** | 200 | `CatalogEntry` |
| `POST` | `/api/v1/admin/models/{catalog_key}/enable` | **protected** | 200 | `CatalogEntry` |
| `GET` | `/api/v1/admin/plans` | **protected** | 200 | `PlanListResponse` |
| `PUT` | `/api/v1/admin/plans/{plan_code}/allowances` | **protected** | 200 | `AllowanceRecord` |
| `PUT` | `/api/v1/admin/plans/{plan_code}/policies` | **protected** | 200 | `no body` |
| `GET` | `/api/v1/admin/policies` | **protected** | 200 | `PolicyListResponse` |
| `POST` | `/api/v1/admin/policies` | **protected** | 201 | `PolicyRecord` |
| `GET` | `/api/v1/admin/policies/{policy_id}/audit` | **protected** | 200 | `PolicyAuditResponse` |
| `PUT` | `/api/v1/admin/policies/{policy_id}/candidates` | **protected** | 200 | `PolicyRecord` |
| `PUT` | `/api/v1/admin/policies/{policy_id}/fallback` | **protected** | 200 | `PolicyRecord` |
| `GET` | `/api/v1/admin/principals` | **protected** | 200 | `PrincipalListResponse` |
| `GET` | `/api/v1/admin/principals/administrators` | **protected** | 200 | `RoleListResponse` |
| `PUT` | `/api/v1/admin/principals/{subject_id}/plan` | **protected** | 200 | `PlanRecord` |
| `DELETE` | `/api/v1/admin/principals/{subject_id}/role` | **protected** | 204 | `no body` |
| `PUT` | `/api/v1/admin/principals/{subject_id}/role` | **protected** | 200 | `RoleGrantResponse` |
| `GET` | `/api/v1/admin/usage` | **protected** | 200 | `UsageSummaryResponse` |
| `GET` | `/api/v1/admin/usage/series` | **protected** | 200 | `UsageSeriesResponse` |
| `GET` | `/api/v1/threads` | **protected** | 200 | `ThreadsResponse` |
| `DELETE` | `/api/v1/threads/{thread_id}` | **protected** | 204 | `no body` |
| `GET` | `/api/v1/threads/{thread_id}` | **protected** | 200 | `ThreadSummary` |

### Why each endpoint is classified as it is

| Path | Access | Reason |
|---|---|---|
| `/health` | public | Liveness. A load balancer cannot present a token. |
| `/plans` | public | The subscription tiers and what each allows. A pricing question, not a per-caller one: no subject is read and the answer is the same signed in or out. |
| `/locations/resolve` | public | Resolving one place from a name or coordinates. Reads no user-owned row. |
| `/locations/search` | public | Geocoding a free-text query. Reads no user-owned row. |
| `/ready` | public | Readiness. Reports what is configured and reachable, and no credential material. |
| `/weather/analysis` | public | Deterministic analytics over a supplied window. Reads no user-owned row. |
| `/weather/changes` | **protected** | Forecast movement since the last snapshot. Records the retrieval it compares, and is not one of the endpoints specs/http-api admits to the public surface. |
| `/weather/comparison` | public | Ranking supplied candidates. Reads no user-owned row. |
| `/weather/scenario` | **public** | Applies stated assumptions to a real forecast. Hypothetical, never a forecast. |
| `/weather/current` | public | Current conditions for supplied parameters. Applies the caller's units when signed in. |
| `/weather/forecast` | public | A forecast for supplied parameters. Applies the caller's units when signed in. |
| `/weather/history` | public | Archive observations for a supplied range. Reads no user-owned row. |
| `/weather/history/baseline` | public | A baseline over supplied years. Reads no user-owned row. |
| `/weather/history/baseline/comparison` | public | Places a supplied past period against its baseline. Reads no user-owned row. |
| `/weather/history/comparison` | public | Compares two supplied past periods. Reads no user-owned row. |
| `/agent/ask` | **protected** | Uses and writes the acting user's thread memory and stores an owned evidence record. |
| `/agent/stream` | **protected** | The same run, streamed. Same memory and same owned record. |
| `/admin/lab/comparisons` | **protected**, administrative | Runs one question or dataset subset across several enabled models, and lists the runs. Internal usage, bounded, and it changes no policy. |
| `/admin/lab/comparisons/{run_id}` | **protected**, administrative | One comparison and its per-model results, readable after a compared model is disabled. |
| `/admin/models` | **protected**, administrative | Lists and creates model catalog entries. |
| `/admin/models/{catalog_key}` | **protected**, administrative | Edits one model catalog entry. |
| `/admin/models/{catalog_key}/enable` | **protected**, administrative | Returns a model to resolution. |
| `/admin/models/{catalog_key}/disable` | **protected**, administrative | Withdraws a model from resolution, refused for the last one serving a call role. |
| `/admin/policies` | **protected**, administrative | Lists and creates model policies. |
| `/admin/policies/{policy_id}/audit` | **protected**, administrative | Reads one policy's audit trail, with the comparison runs each change cited. |
| `/admin/policies/{policy_id}/candidates` | **protected**, administrative | Re-points a policy's ordered candidate list — a model promotion. |
| `/admin/policies/{policy_id}/fallback` | **protected**, administrative | Sets or clears a policy's declared fallback. |
| `/admin/plans` | **protected**, administrative | Lists the subscription plans. |
| `/admin/plans/{plan_code}/policies` | **protected**, administrative | Re-points a plan at different policies, per call role. |
| `/admin/plans/{plan_code}/allowances` | **protected**, administrative | Sets one of a plan's usage allowances. |
| `/admin/allowances` | **protected**, administrative | Lists the usage allowances, per plan and for the internal subject. |
| `/admin/allowances/internal` | **protected**, administrative | Sets one of the internal allowances that lab, evaluation and administrative traffic is accounted against. |
| `/admin/principals` | **protected**, administrative | Lists the principals and the plan each is on. A subject and a tier; Weathra holds no contact detail to list. |
| `/admin/principals/administrators` | **protected**, administrative | Lists who holds the administrative role and who granted it. |
| `/admin/principals/{subject_id}/plan` | **protected**, administrative | Assigns a principal to a subscription plan. |
| `/admin/principals/{subject_id}/role` | **protected**, administrative | Grants and revokes the administrative role. |
| `/admin/usage` | **protected**, administrative | Aggregate language model usage by model, policy, plan, call role, status and period, with internal usage separated. Measures only — never a row, and never one person's. |
| `/admin/usage/series` | **protected**, administrative | The same usage measures as a time series over the period, bucketed by hour or day, with internal usage separated. Measures only — never a row, and never one person's. |
| `/evidence/{evidence_id}` | **protected** | One of the acting user's stored evidence records. |
| `/me` | **protected** | The acting user's own profile and effective preferences. |
| `/me/data` | **protected** | Deletes the acting user's Weathra application data. |
| `/me/locations` | **protected** | Lists and adds the acting user's saved locations. |
| `/me/locations/{saved_id}` | **protected** | Removes one of the acting user's saved locations. |
| `/me/preferences` | **protected** | Reads, updates, and deletes the acting user's preferences. |
| `/me/watches` | **protected** | Lists and creates the acting user's weather watches. |
| `/me/watches/{watch_id}` | **protected** | Changes or removes one of the acting user's watches. |
| `/me/watches/{watch_id}/evaluate` | **protected** | Checks one watch against the current forecast, on request. |
| `/me/usage` | **protected** | The acting user's own plan, allowances and consumption. No other subject's, and no internal usage. |
| `/threads` | **protected** | The acting user's conversation threads. |
| `/threads/{thread_id}` | **protected** | One of the acting user's threads, and its deletion. |

Public means: takes parameters, returns weather, reads no user-owned row — with the single
exception the spec names, that a signed-in caller's unit preference applies. The classification
lives in exactly one place (`api/classification.py`), which the routers, the OpenAPI security
metadata, and the tests all read, so the documented classification and the enforced one cannot
drift.

## The streaming endpoint

`POST /api/v1/agent/stream` runs the same graph as `/agent/ask` and reports it as it happens, over
`text/event-stream`. It is authenticated identically — the bearer token is validated before the run
begins — and it answers **503 before the stream opens** when no inference credential is configured,
rather than opening a stream that immediately reports one.

`EventSource` cannot be used to consume it: that API has no way to set an `Authorization` header.
The frontend reads the stream with `fetch` and a body reader (`hooks/use-agent-stream.ts`).

### The event catalogue

Every event carries `sequence` (monotonic from 1) and `request_id`, and is framed as a named SSE
event with one JSON data line:

```
event: tool_start
data: {"sequence": 4, "request_id": "01J8Z…", "tool": "weather_forecast", "agent": "forecast"}
```

| Event | Fields beyond `sequence` and `request_id` | When |
|---|---|---|
| `routing` | `capabilities`, `source`, `reason` | Once, after the plan is decided. `source` is `model` or `deterministic_fallback` |
| `agent_start` | `agent`, `reason` | Each agent begins |
| `agent_end` | `agent`, `status`, `duration_ms` | Each agent finishes, succeeds or not |
| `tool_start` | `tool`, `agent` | A tool call begins. The tool's *name*, never its arguments — those are in the evidence record, and a progress indicator does not need coordinates |
| `tool_end` | `tool`, `ok`, `duration_ms` | A tool call finishes |
| `answer_delta` | `text` | Prose, as it is produced |
| `final` | `answer`, `evidence_id` | **Terminal.** The complete envelope and the evidence record's identifier |
| `error` | `code`, `message` | **Terminal.** The same code and message the non-streaming endpoint would have returned |

**Exactly one terminal event, always.** `final` or `error`, never both and never neither. The
response status is already 200 by the time the first byte goes out, so a client that merely saw the
connection close would have to guess whether the answer was complete — which is the one thing a
streaming interface must not make it guess. A client that sees the stream end without a terminal
event knows the run was interrupted, and says so.

The event vocabulary is Weathra's, not LangGraph's. Mapping rather than forwarding matters: raw
framework events are an internal shape that would become a de-facto public contract, and re-routing
a capability would then break a progress bar.

A mid-stream token expiry produces a terminal `error` carrying an authentication code, which the
frontend routes to the expired-session state. The agent's wall-clock budget is configured below the
token lifetime, so this is rare by construction rather than by hope.

**Client disconnects** are caught and end the run without an unhandled error — someone navigating
away is normal, not a failure.

## Health and readiness

`GET /api/v1/health` answers immediately and depends on nothing: a load balancer cannot present a
token, and a liveness probe that touches the database reports the database's health as the
application's.

`GET /api/v1/ready` reports each dependency by name with whether it is *configured* and whether it
is *reachable* — `database`, `weather_provider`, `vector_store`, `mcp_server`,
`authentication_provider`, and `inference_provider`. It names what is missing and never a credential value: that a
configuration variable is required is documentation, while its contents are not.

An unconfigured inference credential makes readiness report the agent surface as unavailable while
everything else stays ready, which is the same distinction the product makes on screen.
