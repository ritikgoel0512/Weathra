## Context

The repository contains a README, a LICENSE, and a Python `.gitignore` — no source, no dependency manifest, no tests. Every structural decision is open. See `proposal.md` for motivation and the MVP/post-MVP split, and the twenty spec files under `specs/` for the behavior this design must satisfy.

Six constraints shape everything below:

1. **The architecture is locked.** Two applications, LangGraph supervision over four specialized agents, an MCP tool boundary, a pluggable provider layer, a provider-agnostic LLM layer, Postgres with pgvector, and a shared memory layer. The MVP chooses which screens and refinements land first — not which components exist.
2. **The language model must be replaceable and initially weak.** OpenRouter is the first gateway and the first model may be a free-tier model. The design cannot assume reliable native tool-calling, long context, or high instruction-following fidelity.
3. **Numbers may never come from the model.** `specs/deterministic-analytics` and `specs/safety-grounding` make this a hard requirement, which pushes real architectural weight out of the prompt and into code.
4. **Identity is real, and the client is not trusted.** Supabase Auth issues identity; the backend derives the acting user from a validated token and nothing else. Every user-owned row has an owner, and the frontend hiding a control is never the mechanism that protects data.
5. **No local-machine dependency.** Development happens in browser/cloud tooling; every setup, test, and deploy path must run in a cloud environment and in CI.
6. **Which model serves a request is a product decision the backend owns.** Subscription tiers mean model choice is neither a constant nor a client's to make. It has to be resolved per call, server-side, from data an administrator can change — and measured, so the choice rests on evidence. This constraint is satisfied *inside* the existing provider-agnostic LLM seam of constraint 1, not by changing it.

## Goals / Non-Goals

**Goals:**

- Component boundaries that match the locked architecture in the code layout, so each capability is separately testable and separately replaceable.
- Grounding and attribution that hold *structurally* — guaranteed by how responses are assembled, not by asking a model nicely.
- A system whose data, analytics, MCP, RAG-retrieval, and public API layers all work with no inference credential at all.
- An authorization boundary that holds against a direct API call, not only against the UI: ownership is applied in the data path and again by Row Level Security.
- A test suite that runs fully offline: no weather network, no inference network, no live database.
- Robustness against a weak or changing LLM: any model that can emit valid JSON and write prose should work.
- Model governance that adds no new authority to the model and no new decision to any node: the graph asks for a client and gets one, and every entitlement, quota, and telemetry concern is resolved around it rather than inside it.
- Every language model call measured — tokens, estimated cost, latency, status — so that model choice, quota design, and cost are questions with recorded answers.

**Non-Goals (design-level, beyond the proposal's exclusions):**

- No microservice decomposition. The backend is one deployable containing separately-bounded modules; the MCP server has its own boundary and its own transport but ships in the same container for the MVP.
- No billing system. No payment provider, checkout, invoicing, or reconciliation against a gateway invoice. Plans are administratively assigned rows; cost is an estimate computed from token counts and catalog pricing.
- No graded permission model. One server-held administrative/internal flag, not roles, scopes, or organizations.
- No model auto-selection or bandit routing. Policies are declared candidate lists in a fixed order; promotion between them is a human decision recorded against evaluation evidence.
- No identity system of our own. Supabase Auth owns credentials, sessions, verification, and reset; Weathra stores no password material. Enterprise SSO, additional OAuth providers, multi-factor authentication, and organization role hierarchies are out of scope.
- No custom vector database, ranking model, or reranker. pgvector with cosine distance and a threshold.
- No agent framework beyond LangGraph, and no vendor agent SDK.
- No infrastructure-as-code. Deployment is CI workflows plus documented console configuration for the MVP.

## Decisions

### 1. Monorepo, two applications, one-way dependencies

```
backend/
  weathra/
    config.py               Settings (pydantic-settings)
    domain/                 Frozen models + error hierarchy. Imports nothing internal.
    providers/              base.py (Protocol), registry.py, open_meteo.py, cache.py, http.py
    geocoding/              base.py (Protocol), open_meteo.py
    analytics/              descriptive.py, precipitation.py, wind.py, rolling.py,
                            distribution.py, anomaly.py, trend.py  — pure functions
    weather/                forecast_service.py, history_service.py, comparison_service.py,
                            snapshots.py, uncertainty.py
    mcp/                    server.py, tools/, schemas.py        — its own boundary
    rag/                    corpus/, ingest.py, embed.py, store.py, retrieve.py
    auth/                   tokens.py (validation), jwks.py (key cache), deps.py (principal),
                            profiles.py (application profile), rls.py (session claims),
                            roles.py (administrative/internal role)
    memory/                 checkpointer.py, preferences.py, threads.py, retention.py
    entitlements/           plans.py, catalog.py, policies.py, resolver.py, quotas.py
    telemetry/              usage.py (usage-event recorder), cost.py (estimator), aggregate.py
    agents/
      llm/                  base.py (Protocol), openrouter.py, fake.py, factory.py,
                            instrumented.py (telemetry + quota wrapper)
      graph.py              LangGraph assembly
      supervisor.py         routing node
      nodes/                forecast.py, historical.py, analytics.py, rag.py, synthesize.py
      evidence.py           evidence record assembly
      grounding.py          the audit layers
    api/
      app.py, deps.py, errors.py, middleware.py
      routers/              locations, weather, history, analysis, comparison, ask,
                            stream, me, preferences, saved_locations, evidence,
                            account (data deletion), health, usage (own plan + usage),
                            admin_models, admin_plans, admin_usage, admin_lab
    evaluation/             dataset/, runner.py, metrics.py, report.py, model_compare.py
    lab/                    compare.py (model lab runner), records.py
    db/                     models.py, migrations/ (Alembic)
  tests/
frontend/
  app/
    (auth)/                 sign-in, create-account, verify-email, verification-result,
                            forgot-password, reset-password
    auth/confirm/           route handler for a returning verification or reset link
    (app)/                  dashboard, analyst, historical, compare, evidence,
                            saved, settings, + post-MVP stubs  — protected group
  middleware.ts             session refresh + protected-route gate
  lib/supabase/             browser client, server client, middleware helper
  components/, hooks/, tests/
docs/
  architecture.md, authentication.md, agents.md, mcp.md, rag.md, evaluation.md,
  privacy-ethics.md, deployment.md, configuration.md, api.md, roadmap.md,
  design/ (approved Visily artifacts + design system + carried-forward direction)
.github/workflows/
```

The import rule: `domain` ← `providers`/`geocoding`/`analytics` ← `weather`/`rag`/`memory` ← `mcp` ← `agents` ← `api`, with `auth/` sitting beside `memory/` and depended on only by `api/` and `memory/`. `entitlements/` and `telemetry/` sit at the same level as `auth/` and `memory/`: they import `domain` and `db` and nothing above, and are depended on by `agents/` and `api/`. `lab/` sits beside `evaluation/` and is the only module above `agents/` other than `api/`. Never the reverse. Three consequences are load-bearing and are enforced by a test: no module below `agents/` imports `agents` or any LLM client; no module in `agents/nodes/` imports a provider client directly; and no module in `agents/nodes/` imports `entitlements/` — a node receives a client, it does not resolve one.

**Alternative considered:** separate repositories for frontend and backend. Rejected for a capstone — one repo keeps the API contract, the docs, and CI in one place, and the applications remain separately built and deployed, which is what the requirement actually asks for.

**Alternative considered:** MCP as its own separately deployed service. Rejected for the MVP on cost and latency (an extra network hop on every tool call, an extra cold start), but the boundary is kept clean enough that promoting it is a deployment change rather than a rewrite.

### 2. The graph controls tool execution; the model proposes and explains

This is the most consequential decision in the design, and it is driven by constraint 2 and constraint 3 together.

A conventional agent lets the model emit tool calls that a runtime executes. With a possibly-free, possibly-weak model, native tool-calling support is inconsistent and malformed calls are common. More importantly, letting the model drive execution puts it in a position to *not* call analytics and answer from its own arithmetic instead.

So the graph, not the model, executes tools:

1. **Supervisor node** — the model is asked for a routing decision as a JSON object validated against a pydantic schema: which capabilities are needed, in what order, with what parameters, and the reason. Invalid JSON is retried a bounded number of times with the validation error appended; on repeated failure the supervisor falls back to a deterministic keyword-and-entity router so the request still gets answered.
2. **Capability nodes** — `forecast`, `historical`, `analytics`, and `rag` nodes execute their work deterministically through the MCP tool client and the analytics functions. The model is not consulted about *how* to retrieve or compute anything.
3. **Synthesis node** — the model receives the structured results and writes prose only. It is given no numbers to compute and no authority over the response envelope.

The model therefore influences *routing* and *wording*. Every figure, label, and attribution in the response is placed there by code.

This satisfies `specs/agent-orchestration`'s tool-catalog requirements (a proposed capability outside the catalog returns an error to the model rather than executing) while making `specs/safety-grounding`'s attribution requirement structurally achievable rather than aspirational.

**Alternative considered:** native tool-calling loop via LangGraph's prebuilt ReAct agent. Rejected — it depends on tool-calling fidelity the first model may not have, and it hands number-production to the model. A post-MVP path can add a tool-calling route for models known to support it, behind the same graph interface.

### 3. LLM abstraction: a two-method Protocol over raw HTTP

`agents/llm/base.py`:

```python
class LLMClient(Protocol):
    provider_id: str
    model_id: str
    async def complete(self, *, system: str, messages: list[Message]) -> Completion: ...
    async def complete_json(self, *, system: str, messages: list[Message],
                            schema: type[BaseModel]) -> BaseModel: ...
```

`complete_json` is where routing lives: it prompts for JSON, parses, validates against the pydantic schema, and retries with the error on failure. Doing schema enforcement in the abstraction rather than per-node means a provider that gains native structured output can implement it natively without touching any node.

`OpenRouterClient` talks to OpenRouter's chat-completions endpoint over the shared `httpx.AsyncClient`. No vendor SDK is used — the surface needed is one POST, and a vendor SDK would be a coupling the specs forbid. Configuration:

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `openrouter` (the registry key) |
| `LLM_MODEL` | development and administrative fallback model id only — **not** the production selection mechanism; see decision 22 |
| `OPENROUTER_API_KEY` | credential |
| `LLM_TIMEOUT_SECONDS`, `LLM_MAX_RETRIES` | transport policy |

`model_id` on the Protocol is therefore per-instance, not per-process: a client is built for a resolved model each time one is needed (decision 22), so the same `provider_id` may serve two different `model_id` values in one run — the routing call and the synthesis call. `Completion` carries `model_id`, `prompt_tokens`, and `completion_tokens` as reported by the gateway so telemetry (decision 24) has real counts rather than an estimate of an estimate; where the gateway reports none they stay `None`, never `0`.

`FakeLLMClient` implements the Protocol from a scripted sequence of completions and JSON payloads, and is what the entire test suite and offline evaluation mode use. `anthropic` is not a dependency of the runtime; Claude Code is a development tool only.

### 4. Identity: Supabase Auth in the frontend, validated tokens in the backend

Supabase Auth owns credentials, email verification, password reset, and session issuance. Weathra implements none of that and stores no password material. The flow is:

```
Next.js  ──(email+password, verify, reset)──▶  Supabase Auth
   │                                              │
   │  ◀────────── session (cookies) ──────────────┘
   │
   └──(Authorization: Bearer <access token>)──▶  FastAPI
                                                   │ validate → principal(user_id)
                                                   ▼
                                        LangGraph / memory / services
                                                   │
                                                   ▼
                                          Supabase Postgres (RLS)
```

**Frontend session handling.** The Supabase SSR/cookie helpers hold the session in cookies rather than `localStorage`, because Next.js middleware must be able to read it on the server and gate a protected route *before* the screen renders — a client-only session forces a flash of protected shell first. `middleware.ts` refreshes the session and redirects unauthenticated requests for the protected route group to sign-in with the intended destination preserved. The access token is forwarded to FastAPI as a bearer token on every protected call, including the SSE stream.

**Verification uses a code, with the link as a fallback.** Supabase's signup-confirmation email template is configured to include the one-time token, so Weathra can present its own code-entry screen and call `verifyOtp` — which is what the requirement for in-app OTP entry needs. People who click the link instead land on a route handler that exchanges the token hash and completes the same verification. Password reset works the same way: request, verify the code or link, then set the new password. Both flows therefore have one verification concept and two entry paths.

**Unverified accounts cannot reach protected features, structurally.** With email confirmation required on the Supabase project, `signUp` returns no session until the address is confirmed — so an unverified account has no access token, and the backend never has to decide whether to trust one. The frontend still routes an unverified sign-in attempt to the verification screen rather than showing a generic failure, and the backend additionally rejects a token carrying an unverified-email claim if one ever appears, as defence in depth.

**Backend validation is local, with cached keys.** `auth/tokens.py` verifies the token's signature against the project's published JSON Web Key Set, and checks issuer, audience, and expiry. Keys are fetched once and cached with a bounded refresh (and an immediate refetch on an unknown key id), so rotation is picked up without a redeploy and without a network call per request. Calling Supabase's user endpoint on every request was rejected: it adds an external round trip to the latency of every protected call and makes the backend unavailable whenever Supabase's API is slow.

The result is a `Principal(user_id, email, claims)` produced by a FastAPI dependency. **Nothing else is identity.** A `X-Weathra-Profile-Id` header — the previous design's mechanism — is gone entirely; any user, profile, thread, or session identifier arriving in a header, query parameter, or body is treated as an untrusted parameter at best and ignored as identity.

**Alternative considered:** keeping the opaque profile id alongside tokens for anonymous use. Rejected — two identity paths means two authorization paths and a standing risk that a handler reads the wrong one. Anonymous use is served by the public endpoints, which own no data.

### 5. Data ownership, RLS, and two database roles

Ownership is enforced twice, deliberately.

**In the data path.** Every user-owned table carries `user_id` referencing the Supabase Auth user, and every repository function takes the principal and constrains its query by it. A record identifier supplied by a caller is never sufficient — it is always `WHERE id = :id AND user_id = :principal`. A miss returns not-found rather than forbidden, so a probe cannot distinguish "exists but not yours" from "does not exist".

**In the database.** Row Level Security is enabled on every user-owned table with an owner-restricting policy. Because the backend's own connection would ordinarily bypass RLS, each request runs its work inside a transaction that first sets the request's claims and assumes the non-privileged role, so the policies apply to backend queries too. A bug that forgets a `user_id` predicate then returns nothing instead of another user's row.

Two connections, deliberately separated: a privileged one used only by migrations and administrative routines, and the request-serving one that runs under the restricted role. The service-role key is used only where privileged access is genuinely required (schema migration, the retention routine, provisioning an evaluation test user) and never on a request path serving a browser.

Classification of every table is explicit and documented, because "scope everything to a user" would be wrong here:

| Table | Ownership |
|---|---|
`profiles`, `preferences`, `saved_locations`, `threads`, `agent_runs`, LangGraph checkpoints | user-owned, RLS on |
`forecast_snapshots` | shared, keyed by location and window, **no user column** |
`knowledge_documents`, `knowledge_chunks` | shared, read-only to users |
provider response cache | in-process, not persisted |
`evaluation_runs`, `evaluation_case_results` | operational, not user-owned |

Forecast snapshots deliberately carry no user reference: a forecast for Berlin is not private, and keying snapshots by location rather than requester both avoids storing a browsing trail and gives What Changed? far better coverage, since every user's request improves everyone's history. Where a snapshot genuinely needs to be associated with a person — a future per-user watch — that association goes in a user-owned table of its own rather than a nullable column here.

### 6. Normalized weather model: units on the series, timestamps twice

Each series carries `units: dict[str, str]` once and values as `float | None`; `None` means the provider did not supply it, never zero. Per-value `Quantity` objects would triple hourly-series payload size and make chart code unpack objects per point.

Every entry carries both `time_utc` (aware UTC) and `time_local` (ISO-8601 with offset). All windowing, threshold, and comparison logic uses `time_utc`; everything a person reads uses `time_local`. Windows are resolved to UTC bounds from the location's `zoneinfo` timezone at request time; the server's own timezone is never consulted. This redundancy is cheap and removes the largest bug class in a system where "Thursday evening" means Thursday *there*.

Every retrieval result carries `data_class` — one of `current`, `forecast`, `historical_observation`, `computed_statistic` — from the moment it leaves the provider layer. Labelling at the source is what makes `specs/safety-grounding`'s no-conflation requirement cheap to honour everywhere downstream.

### 7. Provider and geocoder contracts as Protocols with declared capabilities

`WeatherProvider` is a runtime-checkable Protocol with `current()`, `forecast()`, `history()`, and `capabilities()`. Horizon and archive-range validation read `capabilities()` rather than hardcoding Open-Meteo's limits, which is what makes those spec scenarios provider-independent. The registry is an explicit `dict[str, Callable[[Settings], WeatherProvider]]` populated by import — not entry-point discovery, which would add packaging ceremony and defer errors to runtime.

`Geocoder` is a separate Protocol for the same reason the spec separates them: a deployment might geocode from a local place database while fetching weather remotely. Ambiguity is a return value (`Resolved | Ambiguous`), not an exception, because `specs/http-api` requires it to be a successful, distinguishable response.

### 8. Caching: a wrapper implementing the same Protocol, with two tiers

`CachedProvider` wraps any provider, keyed on `(provider, round(lat,4), round(lon,4), kind, range, unit_system)`. Coordinate rounding to ~11 m is far below Open-Meteo's kilometre-scale grid, so merged entries would have returned identical data anyway. Forecast entries get a short TTL, historical entries a long one — past weather does not change. A per-key `asyncio.Lock` collapses concurrent identical misses into one upstream call. `retrieved_at` and `from_cache` propagate to the response.

The cache is process-local in the MVP. Multiple backend instances each keep their own, which multiplies upstream calls against a keyless provider — an acceptable trade for not operating Redis. The wrapper is the seam where a shared cache drops in.

**Alternative considered:** HTTP-level caching (`hishel`). Rejected — it cannot report `from_cache` in domain terms or key on unit system.

### 9. Analytics: pure functions, numpy, no clock

Every analytics function takes a series and parameters and returns a structured result carrying value, unit, window, location, provider, point count, and method. No I/O, no clock reads, no randomness, no LLM — which is what makes the determinism scenarios testable and the metric "numerical calculation accuracy = 100%" meaningful.

numpy provides percentiles and rolling windows; the interpolation method for percentiles is stated in the result rather than left implicit. Method choices worth stating:

- **Trend** — Theil–Sen slope (the median of the slopes between every pair of points), classified against a per-measure materiality margin (temperature 0.5 °C/day, precipitation 0.5 mm/day). A slope rather than first-versus-last, so a single end spike does not read as a trend. **Amended during implementation:** this was first specified as a least-squares slope, for exactly that reason, but least-squares does not achieve it — a flat 11 °C week with one 24 °C day on the end fits at 1.4 °C/day, which `specs/deterministic-analytics` forbids being reported as a trend. Theil–Sen gives 0.0 on that series and 2.0 on a genuinely warming one, because moving one point of seven changes only six of twenty-one pairwise slopes and leaves the median where it was. It is also the standard robust trend estimator in climatology, for the same reason.
- **Anomaly** — window extremes always reported; additionally any point that is *both* beyond 2.0 median-absolute-deviations from the median *and* materially different in absolute terms, by the same per-measure margin the trend classifier uses. MAD rather than standard deviation because a 7-point window containing one extreme has its own SD inflated by that extreme, suppressing exactly the outlier the spec wants surfaced. Zero MAD (flat window) reports extremes only. **Amended during implementation:** the materiality floor is the second condition, added because MAD alone is scale-free — a week of 11.0–11.4 °C has a median absolute deviation of 0.1 °C, so the 11.4 °C day scores 2.02 MADs and would be reported as an anomaly. A third of a degree is not a finding, and `specs/deterministic-analytics` requires a series that does not deviate materially to report no anomalies rather than forcing a selection.
- **Absent values** are excluded from every computation and the exclusion count is reported — never coerced to zero.
- **Minimum points** per statistic is declared, and a short series reports that statistic not-computable while others still compute.

### 10. Persistence: Supabase Postgres, SQLAlchemy async, Alembic

Tables:

| Table | Holds | Owner |
|---|---|---|
| `profiles` | `user_id` (the Supabase Auth subject, primary key), created and last-seen timestamps | user |
| `preferences` | unit system, forecast horizon, default location | user |
| `saved_locations` | canonical resolved locations, unique per (user, location id) | user |
| `threads` | thread id, resolved-entity state, last activity, expiry | user |
| `langgraph_checkpoints` (+ writes/blobs) | LangGraph short-term checkpointing, managed by the checkpointer library, keyed by the composed thread key | user (via `threads`) |
| `agent_runs` | request id, question, answer, evidence record, provider/model, timings | user |
| `forecast_snapshots` | location, window, provider, units, retrieved_at, daily series — for What Changed? | **shared, no user column** |
| `knowledge_documents` | corpus documents with identifier, title, topic, provenance | shared |
| `knowledge_chunks` | chunk text, position, `vector(384)`, document reference | shared |
| `evaluation_runs`, `evaluation_case_results` | run configuration, per-case results, metrics | operational |
| `subscription_plans` | plan code, display name, per-role policy mapping, allowances, unused external subscription reference | operational, read-only to users |
| `user_plans` | `user_id` → plan code, assigned-by, assigned-at | **user-owned** |
| `model_policies` | policy id, ordered candidate catalog keys, applicable call roles, eligibility, declared fallback policy | operational, read-only to users |
| `model_catalog` | catalog key, gateway provider and model id, display name, capability roles, tier, structured-output support, context window, input/output price, pricing date, currency, status, free-or-paid | operational, read-only to users |
| `llm_usage_events` | the per-call record of decision 24 | **user-owned where `user_id` is set; internal rows carry none** |
| `usage_limits` | plan/dimension/window allowances, plus the internal allowance | operational, read-only to users |
| `usage_counters` | `user_id` (or the internal subject), dimension, window key, consumed | **user-owned** |
| `model_evaluations` | per-model per-run metric and criterion values, dataset version, commit | operational |
| `model_comparison_runs`, `model_comparison_results` | lab run provenance and per-model-per-case results | operational |
| `admin_audit` | acting principal, action, subject, before/after, timestamp | operational |

`profiles.user_id` references the Supabase Auth user and is the ownership key every other user-owned table carries — including the four SaaS-ready tables above that are user-owned, which get the same owner-restricting Row Level Security policy from the same migration pattern as the rest. The operational tables get no owner column and no owner policy: they are read to serve a request and written only through the administrative path, so an owner predicate on them would be meaningless. `llm_usage_events` is the one table with both shapes, which decision 27 addresses explicitly rather than by a nullable-owner shrug. There is no separate internal profile id: a second identifier would only create a mapping to get wrong, and the auth subject is already stable and opaque.

Async SQLAlchemy with asyncpg through Supabase's connection pooler, with a deliberately small per-instance pool — the backend runtime scales instances horizontally and Postgres connection limits, not application throughput, are the binding constraint. Alembic owns schema and runs under the privileged connection; `pgvector` and the Row Level Security policies of decision 5 are established by migration, so the policies are versioned with the schema rather than clicked into a console.

### 11. Memory: two stores, deliberately different

Short-term conversation state uses LangGraph's Postgres checkpointer (`AsyncPostgresSaver`). Using the library's own checkpointer rather than a hand-rolled store means graph state, including interrupted runs, persists correctly across instances and restarts without reimplementing serialization.

**Scoping a library-managed table.** The checkpointer owns its schema, so ownership cannot simply be a column we add. Two mechanisms combine instead: the checkpointer's `thread_id` is a composed key, `{user_id}:{thread_id}`, so a thread key is meaningless without the owning user in it; and a `threads` row we do own records the thread's owner, which the API checks before the graph is ever invoked. A caller presenting another user's raw thread id fails the ownership check; a caller guessing a composed key fails because the key must contain their own user id to be built. Neither mechanism alone would be enough — the first is obscurity, the second is the actual gate.

Alongside it, the `threads` row holds the *resolved entities* a follow-up needs — locations, units, window, criterion, last data class — as an explicit, queryable projection. Reconstructing "which cities did we just compare" by replaying a checkpoint would couple follow-up resolution to graph internals; a small explicit projection is what `specs/memory`'s follow-up scenarios actually need, and it is a table we can put RLS on.

Long-term preferences and saved locations are ordinary user-owned application tables, never a checkpoint. Retention is a bounded window on `threads` and their checkpoints, applied by a retention routine invoked from a scheduled CI job in the MVP (no in-process scheduler), plus explicit per-thread deletion and whole-account data deletion exposed through the API.

### 12. RAG: local embeddings, pgvector, threshold-gated retrieval

OpenRouter is an inference gateway and is not relied upon for embeddings, so embedding runs in-process: `fastembed` with BGE-small-en-v1.5, 384 dimensions, ONNX, no credential, deterministic output. `EmbeddingProvider` is an abstraction so a hosted service can replace it — with re-indexing, which is why the embedding model identity and dimension are recorded alongside the index and a mismatch is refused rather than silently producing garbage similarity.

The corpus is authored as Markdown under `rag/corpus/` with front-matter carrying identifier, title, topic, and provenance. Chunking is heading-aware with a token-bounded window and overlap. Retrieval is cosine distance in pgvector with a top-k bound *and* a relevance threshold — the threshold is what makes "return nothing rather than the least-bad match" implementable, which in turn is what keeps the RAG Agent from explaining a concept it has no source for.

Index choice: an HNSW index on the chunk vectors, given a corpus small enough that build cost is irrelevant and recall matters more than write throughput.

**Alternative considered:** ChromaDB. It is the documented fallback in `specs/rag-knowledge`, but with Postgres already required for memory, a second datastore would add an operational dependency for no capability gain.

### 13. MCP server: same container, own boundary, own transport

`weathra/mcp/` implements the seven tools over the MCP Python SDK, depending on `providers`, `geocoding`, `analytics`, and `weather` — and on nothing above it. Its schemas are hand-written rather than derived from API request models, because tool descriptions the model reads are prompt engineering and coupling them to HTTP models would make every wording tweak an API change.

Transport is configuration. In the MVP the server is mounted as an ASGI sub-application in the backend container and the graph's MCP client connects over the loopback (in-memory transport in tests), which keeps one deployable while preserving the protocol boundary. Promoting it to its own service later changes configuration and deployment, not code.

Every tool result carries location, period, units, provider, retrieval time, and data class, so attribution reaches the response envelope without the graph having to reconstruct it.

### 14. Response assembly: the envelope is built by code

Every answer-bearing response is a structured envelope assembled by `agents/evidence.py` and the routers:

```
answer_prose            (model-written, labelled as AI interpretation)
findings[]              (structured values, each with data_class, unit, method,
                         provider, location, period, retrieved_at)
uncertainty             (horizon distance, provider spread, basis statement)
attribution[]           (provider, location, period, retrieved_at per source)
evidence                (agents, tool calls, tool results, analytics results,
                         cited knowledge chunks, provider/model, timings)
grounding               (verified flag, ungrounded figures, method)
```

The model contributes `answer_prose` and nothing else. This is what makes "source attribution coverage = 100%" reachable: attribution is not something the model remembers to include, it is a field the code fills.

### 15. Grounding enforcement in three layers, honestly bounded

1. **System prompt** — states the rules: interpret the supplied results, never compute, never introduce a figure, name the location and window. Necessary, not sufficient.
2. **Hard guard** — if synthesis produces prose containing a numeric weather figure while no tool or analytics result exists in the run, the prose is discarded and the response states it could not answer from retrieved data. Deterministic, and it makes the corresponding spec scenario testable.
3. **Numeric audit** — figures in the prose are extracted and matched against the structured findings and evidence within a rounding tolerance; unmatched figures are reported in `grounding.ungrounded_figures` with `verified: false` rather than suppressing the answer, because a false positive (a legitimately rounded or converted value) must not destroy a correct answer.

The full evidence record ships with every answer and is retrievable afterwards, which is the property that actually makes a figure checkable. The audit heuristic is a reporting mechanism, not a proof — stated plainly in `docs/privacy-ethics.md` and in the evaluation methodology.

### 16. Errors: one hierarchy, mapped to HTTP once

`domain/errors.py` defines `WeathraError` with a stable `code`, subclassed into `ValidationFailed`, `LocationNotFound`, `ProviderNotFound`, `UnsupportedHorizon`, `RangeOutsideCoverage`, `NoDataForRange`, `ProviderUnavailable`, `ProviderTimeout`, `ProviderRateLimited`, `AnalyticsNotPossible`, `MemoryUnavailable`, `VectorIndexMismatch`, `AgentNotConfigured`, `AgentBudgetExceeded`, and `McpUnavailable`. Nothing below `api/` knows about HTTP.

| Error | Status | Code |
|---|---|---|
| `ValidationFailed`, FastAPI request validation | 400 | `validation_failed` |
| `LocationNotFound`, unknown evidence id | 404 | `location_not_found` / `evidence_not_found` |
| `ProviderNotFound`, `UnsupportedHorizon`, `RangeOutsideCoverage` | 400 | per-error code |
| `NoDataForRange` | 404 | `no_data_for_range` |
| `ProviderRateLimited` | 429 | `provider_rate_limited` |
| `ProviderUnavailable`, `McpUnavailable` | 502 | per-error code |
| `ProviderTimeout` | 504 | `provider_timeout` |
| `AgentNotConfigured`, `MemoryUnavailable` | 503 | per-error code |
| unhandled `Exception` | 500 | `internal_error` |

FastAPI's own 422 is overridden into the same envelope at 400 so clients see exactly one error shape: `{"error": {code, message, details, request_id}}`. Request-id middleware binds the id to a `contextvar` that the logging filter reads, so the id appears in log lines from deep in the provider layer without threading a parameter through every call.

### 17. SSE: typed events off LangGraph's event stream

The stream endpoint returns a `StreamingResponse` over `text/event-stream`, driven by LangGraph's `astream_events`, mapped into Weathra's own typed events: `routing`, `agent_start`, `agent_end`, `tool_start`, `tool_end`, `answer_delta`, `final`, `error`. Each carries the request id and a monotonic sequence number. Mapping rather than forwarding matters — raw framework events are an internal shape that would become a de-facto public contract.

The stream is authenticated exactly as the request/response endpoints are: the bearer token is validated before any run begins, the principal is captured for the lifetime of the stream, and a token that expires mid-run produces a terminal authentication error event rather than a silent stall. Because the token is validated up front and the principal held, a long stream does not re-validate on every event — the agent wall-clock budget bounds how long a stream can outlive its token, and that budget is set below the token lifetime.

Client disconnects are caught and end the run without an unhandled error. The backend runtime must support streaming responses, and its request and idle timeouts must sit above the agent wall-clock budget so the budget, not the platform, terminates a long run. The agent path emits progress events throughout, so a run that is still working is never an idle connection.

### 18. Frontend: App Router, TanStack Query for REST, a hook for SSE

Next.js App Router with TypeScript. Static shell in server components; every interactive surface a client component. TanStack Query owns REST fetching, caching, and the `loading | empty | error | ready` states the spec requires — one query state feeding one render branch per view. A dedicated `useAgentStream` hook consumes the SSE endpoint via `fetch` with a streamed body reader rather than `EventSource`, which cannot set an `Authorization` header — with token auth on the stream, that ceases to be a preference and becomes the only workable option.

**Route groups carry the auth boundary.** `(auth)/` holds the unauthenticated screens and `(app)/` the protected ones, so protection is a property of the group rather than something each page remembers to check. `middleware.ts` refreshes the session and redirects unauthenticated requests for `(app)/` to sign-in with the destination preserved; the protected layout resolves the session server-side before rendering, which is what prevents a flash of protected shell. A 401 from the API is treated as an authentication event by a shared response interceptor — it clears the session and routes to sign-in with an expired-session state — never surfaced as a data error.

**Design comes first, and it is done in Visily.** The Visily design phase produces the approved artifacts and the shared design system — typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, and loading, empty, error, and authentication states — before substantial implementation. Components are built from that system rather than styled ad hoc per screen, and the artifacts are recorded in `docs/design/`. Charts use Recharts, which is React-idiomatic and avoids imperative canvas lifecycle management inside components. Theming via CSS custom properties with a `prefers-color-scheme` override, contrast verified for both palettes against the design system's tokens.

The design direction is not reopened. An earlier UXPilot exploration settled it, and those decisions enter Visily as approved inputs: the **Midnight Intelligence** palette (dark-first, light derived from it), **Plus Jakarta Sans** for display and heading type with **Inter** for body and UI, the **Intelligent Command Center** shell with persistent left navigation, a location-focused Dashboard, a premium modern SaaS level of finish, the named **Weathra Intelligence**, **What Changed?**, **Why?** and **Agent Evidence** surfaces, the visible distinction between observed, forecast, historical, deterministic-analytics and AI-interpretation content, source attribution, timestamps, uncertainty and confidence presentation, and the rule that nothing may imply the model predicts a numerical weather value. Those last few are not styling preferences — they are how `specs/safety-grounding` reaches the screen, so the design system carries them as presentational primitives (the data-class badge, the attribution footer, the uncertainty indicator, the interpretation treatment) rather than leaving each screen to remember them. The Midnight Intelligence palette is what the CSS custom properties above hold, which is why contrast is verified against the design system's tokens and not chosen per component.

**Alternative considered:** a design-to-code export, from Visily's paid tiers or via Figma. Rejected as a dependency — an exported component tree carries its own structure, and reconciling it with the App Router layout, the route groups that carry the auth boundary, and the TanStack Query state convention above costs more than reading the design and building the component. So the pipeline is `OpenSpec → Visily → approved artifacts → hand-written Next.js`, the approved Visily screen is a visual reference, and no paid export capability and no second design tool is on the critical path. Figma is deliberately not mandatory.

Post-MVP routes exist as explicit "not yet available" pages so navigation structure is real and nothing renders broken.

Testing: Vitest with Testing Library for components and interactions, mocking both the API and the Supabase client at their boundaries; Playwright for a small number of cross-screen flows (sign up through verification into the product; ask a question and see evidence; save a location and see it applied; expired session routed to sign-in).

### 19. Configuration

Both applications read environment variables only; no config files with secrets. `backend/.env.example` and `frontend/.env.example` document every variable. The backend must start and serve every public capability with `OPENROUTER_API_KEY` absent — the LLM client is constructed lazily by the `/ask` and `/stream` dependencies, so no other route touches it.

The split is the security boundary, and it is enforced by convention *and* by a check:

| Where | Variable | Purpose |
|---|---|---|
| Frontend (public) | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| Frontend (public) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public client key (or its current publishable-key equivalent) |
| Frontend (public) | `NEXT_PUBLIC_API_BASE_URL` | backend base URL |
| Backend | `SUPABASE_URL` | project URL, for issuer and key-set derivation |
| Backend | `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWKS_URL`, `SUPABASE_JWKS_CACHE_TTL` | token validation |
| Backend (secret) | `SUPABASE_SERVICE_ROLE_KEY` | privileged operations only — migrations, retention, evaluation test-user provisioning |
| Backend (secret) | `DATABASE_URL`, `DATABASE_URL_PRIVILEGED` | request-serving and privileged connections |
| Backend (secret) | `OPENROUTER_API_KEY` | inference gateway |
| Backend | `LLM_PROVIDER`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_RETRIES` | gateway and transport |
| Backend | `LLM_MODEL` | development and administrative fallback model only (decision 22) |
| Backend | `LLM_SINGLE_MODEL_MODE` | when set, bypass policy resolution and use `LLM_MODEL` for every call — development and CI only |
| Backend | `MODEL_CATALOG_CACHE_TTL_SECONDS` | the documented staleness window for catalog and policy reads (decision 23) |
| Backend | `QUOTA_WINDOW_TIMEZONE` | the time zone in which day and month boundaries are computed (decision 25) |
| Backend | `QUOTA_ENABLED` | quota enforcement on/off, for local and CI runs; on by default in deployed environments |
| Backend | `LLM_USAGE_RETENTION_DAYS` | raw usage-event retention before aggregation (decision 24) |
| Backend | `MODEL_LAB_MAX_MODELS`, `MODEL_LAB_MAX_CASES`, `MODEL_LAB_TIME_BUDGET_SECONDS` | lab bounds (decision 26) |
| Backend | provider default, unit and horizon defaults, cache TTLs, HTTP timeout and retry policy, agent step and wall-clock budgets, MCP transport address, embedding model id, RAG top-k and threshold, thread and snapshot retention windows, allowed CORS origins, log level | behavior |

No secret may carry a `NEXT_PUBLIC_` prefix, and CI asserts that the service-role key and the database URLs appear in neither the frontend environment nor the built bundle. A settings validator refuses to start the backend if `SUPABASE_SERVICE_ROLE_KEY` is set on the request-serving path where the restricted connection is expected.

Note what is deliberately *not* here: policies, plan mappings, allowances, and the catalog. Putting them in the environment would make every model or tier change a redeployment, which is exactly what `specs/model-catalog` forbids. They are database rows, seeded by migration and administrable at runtime; `LLM_MODEL` survives only as the fallback, and `LLM_SINGLE_MODEL_MODE` is refused in a deployed environment by the same settings validator.

### 20. Testing strategy

| Layer | Approach |
|---|---|
| Providers | `respx` against recorded Open-Meteo forecast, archive, and geocoding payloads |
| Analytics | direct unit tests over synthetic series, including every edge scenario the specs name |
| MCP tools | called directly over the in-memory transport with fake providers |
| Graph routing | `FakeLLMClient` with scripted routing decisions; assertions on which nodes ran |
| Grounding | scripted synthesis output including a fabricated figure; assert the guard fires |
| RAG | a fixture corpus ingested into a test schema; retrieval asserted on known documents |
| Memory | a test database schema; follow-up resolution, retention, per-user isolation, and deletion |
| Authentication | locally-minted tokens signed by a test key pair whose public key the JWKS cache is seeded with — valid, expired, wrong issuer, wrong audience, bad signature, unknown key id — with no Supabase network calls |
| Authorization | two test principals; every user-owned endpoint exercised for read and mutate across the boundary, plus a direct-call attempt that bypasses the frontend entirely |
| RLS | a `db` test running a query under one user's claims against another user's row, asserting the policy returns nothing even when the predicate is deliberately omitted |
| API | `httpx.ASGITransport` with provider, LLM, MCP, and principal dependencies overridden |
| Frontend | Vitest + Testing Library at the fetch and Supabase-client boundaries, including protected-route and expired-session behavior; Playwright for the sign-up-through-verification, ask-and-see-evidence, and expired-session flows |
| Evaluation | the runner in offline mode over fixtures and `FakeLLMClient` |
| Live | a handful of real Open-Meteo and real OpenRouter checks behind a `live` marker, deselected by default |

Database-backed tests run against an ephemeral Postgres with pgvector provided by CI services — no local database required.

### 21. Deployment and CI

| Component | Target |
|---|---|
| Next.js frontend | Vercel |
| FastAPI + LangGraph + MCP + analytics | Render (container) |
| Identity, email verification, password reset | Supabase Auth |
| Postgres + pgvector + memory | Supabase |
| Weather data | Open-Meteo (external) |
| Inference | OpenRouter (external) |
| CI/CD | GitHub Actions |

**Superseded: Cloudflare and Google Cloud Run.** An earlier revision of this decision named Cloudflare for the frontend and Google Cloud Run for the backend, with secrets in Google Cloud Secret Manager injected through a Cloud Run service account. That is withdrawn. The reasons it was chosen — a host that serves a Next.js build at the edge, and a container runtime that scales horizontally and streams — are properties Vercel and Render both provide, so nothing downstream of the choice changes. The record is kept rather than overwritten because the constraints below are written against those properties, and a later reader should be able to tell which of them are vendor facts and which are requirements. Nothing had been built against the old target: no Dockerfile, no deploy workflow, no infrastructure definition existed, so the correction costs prose only.

Two consequences of the new targets are load-bearing and are stated here rather than left to the deployment document. **Secrets on Render are the service's own environment variables and secret files, set server-side and never committed** — there is no IAM binding and no separate secret service, which removes a moving part rather than adding one. **Migrations run from GitHub Actions under `DATABASE_URL_PRIVILEGED`, and only on their success may deployment proceed** — the Render service holds `DATABASE_URL` and stays request-serving and least-privileged.

An earlier draft of this paragraph said migrations would run as Render's pre-deploy step. That is withdrawn. Render's pre-deploy command executes in the service's own environment, so it would have required putting a privileged database credential inside the container that serves browser traffic — a standing grant, bought to obtain an ordering guarantee a CI job already provides. Decision 19 puts every other privileged job in CI for the same reason, and `resolve_url()` refuses to substitute either database connection for the other precisely so the two credentials can be kept apart; issuing the privileged one to the serving container would make that separation ceremonial. The ordering requirement is unchanged and is what task 23.4 must satisfy: schema first, traffic second.

Supabase project configuration that the application depends on is documented and version-controlled as configuration notes rather than left as undocumented console state: email confirmation required, the confirmation and recovery email templates carrying the one-time token so code entry works, redirect URLs for each environment's frontend origin, and the token lifetimes the agent budget is set below.

GitHub Actions runs, on every pull request: backend lint, type-check, and tests (with a Postgres+pgvector service); frontend lint, type-check, unit tests, and build; the secret-exposure check of decision 19; and the offline evaluation run. On merge to the default branch: build and deploy the backend container to Render, deploy the frontend to Vercel, and apply Alembic migrations as a release step before the new backend release serves traffic.

Development is browser-based (cloud IDE or Codespaces) against the hosted Supabase instance; nothing in the setup, test, or deploy path requires a specific local machine.

### 22. Model policy: a resolver between the graph and the client, not a branch inside either

This is the load-bearing decision of the SaaS-ready layer, and its shape is chosen to keep decision 2 intact.

The graph does not know what a plan is. A node asks for a client for its call role and gets one:

```python
# entitlements/resolver.py
@dataclass(frozen=True)
class Resolution:
    policy_id: str            # "free_default" | ... | "__fallback_config__"
    catalog_key: str
    gateway_provider: str
    gateway_model: str
    reason: str               # ordered, human-readable: what was considered and why
    override_by: str | None   # administrative subject, when an override applied

class ModelPolicyResolver(Protocol):
    async def resolve(self, *, principal: Principal | None,
                      role: CallRole, override: str | None = None) -> Resolution: ...
```

`CallRole` is an enum with `ROUTING` and `SYNTHESIS` — the two call roles the graph actually has — plus `LAB`. It is the role, not the node, that a policy maps against, so a third node needing a structured decision reuses `ROUTING` without a policy change.

Resolution is a pure walk over data, and its order is the whole security argument:

1. Principal → plan. `user_plans` keyed by the validated auth subject, defaulting to `free` on no row. Nothing in the request contributes. A `None` principal is `free` and can never be anything else.
2. Plan + role → policy id, from `subscription_plans`. `admin_experimental` is reachable only when the principal holds the administrative role, and that check is on the *policy*, not on the plan, so no plan row can accidentally grant it.
3. Policy → ordered candidate catalog keys. First candidate that is present in `model_catalog` **and** enabled wins. Each skip is appended to `reason`.
4. Nothing available → the policy's declared fallback policy → the plan's default policy → `LLM_MODEL`, itself validated against the catalog. Never a stronger policy's model: falling *up* would turn an outage into a free upgrade, and the spec forbids it.
5. Still nothing → raise `NoEligibleModel`, a configuration error. No answer is produced from an unentitled model.

An administrative `override` is checked against the catalog before anything else and refused outright if absent or disabled — it is a shortcut through steps 2–4, never a shortcut past step 1's identity or past the catalog allowlist.

`reason` is not decoration. It is what makes "why did this caller get that model" answerable from the evidence record without re-running the resolution, and it is what the resolution tests assert against.

**Where the caller's advisory preference fits.** `AskRequest.model` (if accepted at all) is passed as a *hint*, honoured only when the resolved policy's candidate list already contains it and the catalog has it enabled. A hint outside entitlement is dropped and reported as ignored — never a 403, because failing the request would leak which models exist above the caller's tier.

**Alternative considered:** resolve once per request in the API layer and put the client in graph state. Rejected — the two call roles want different policies, and a single per-request client would make per-role mapping impossible without the graph re-resolving anyway.

**Alternative considered:** a `plan` field on `Principal`, resolved during token validation. Rejected — it would put a database read on every protected request including the ones that never touch a model, and it would tempt a node to branch on the plan directly. The resolver reads it only when a model is actually needed.

### 23. The catalog is data, and the cache is a TTL, not an invalidation protocol

`model_catalog`, `model_policies`, and `subscription_plans` are read on nearly every agent request and change perhaps weekly. Reading them per call is three queries on the hot path; caching them without expiry means an administrator's disable takes effect on redeploy, which `specs/model-catalog` forbids.

So: a process-local snapshot with a TTL of `MODEL_CATALOG_CACHE_TTL_SECONDS` (60 by default), refreshed on read when stale. Multiple backend instances converge within one TTL, and that window is the documented staleness window the spec asks to be stated. No pub/sub, no cache-invalidation message, no second datastore — the same trade decision 8 makes for the provider cache, for the same reason.

The consequence is honest and worth stating: **a disable is not instant.** An administrator disabling a model may see it serve requests for up to one TTL on instances that have not refreshed. That is acceptable for a cost or quality decision and would not be for a safety one — which is why the safety controls (grounding, attribution, the tool catalog) are code, not catalog rows. An administrative override and a lab selection read through the cache but validate against the database directly, so an administrator never acts on a stale allowlist.

`catalog_key` is the stable internal handle and the only thing policies, evaluations, and comparison results reference. `gateway_model` is the vendor string and is mutable — a gateway rename is a one-row update that breaks nothing. This split is what makes the "no vendor model id in business logic" requirement mechanically checkable: a test greps the source for the pattern of a gateway model id and allows it only in `db/migrations/`, `.env.example`, and the OpenRouter adapter's request body.

### 24. Telemetry: a wrapper implementing the same Protocol, written outside the answer path

Instrumentation is a decorator over `LLMClient`, not a call inside every node — the same pattern as `CachedProvider` in decision 8:

```python
class InstrumentedLLMClient:              # satisfies LLMClient
    def __init__(self, inner: LLMClient, ctx: CallContext, sink: UsageSink): ...
```

`CallContext` carries the principal, the agent run id, the request id, the resolution from decision 22, the plan, and the call role. Every `complete` and `complete_json` is timed around the gateway call only, and emits exactly one `llm_usage_events` row per attempt — including failures, with a classified reason (`timeout`, `gateway_rate_limit`, `transport`, `auth_config`, `schema_validation`, `unclassified`). A schema retry inside `complete_json` emits its own row carrying `attempt` and `retried_event_id`, so "how often does this model need two tries" is a query rather than a guess. That single number is the structured-JSON-reliability criterion in `specs/evaluation`, which is why the retry is instrumented at all.

Two rules make it safe to have on every call:

- **Fire-and-forget with a bounded budget.** The row is written on a background task with its own short timeout and its own session. A write failure logs and increments a counter; it never propagates. `specs/llm-telemetry` requires the answer to be unaffected, and the only way to guarantee that is for the write not to be in the request's critical path at all.
- **Metadata only.** No prompt, no completion, no retrieved passage. Diagnosis goes through `agent_run_id` to the evidence record, which already has its own ownership and retention. The row is small and boring on purpose — a table with no content in it cannot leak content, and it can be aggregated for an admin screen without an isolation argument.

Cost is `cost.py`: a pure function of token counts and the catalog price row, returning `None` when either is unknown — never `0`, since zero is a claim and null is the truth. The price and its `pricing_date` are copied onto the event at write time, so re-pricing the catalog never rewrites history. Cost is labelled an estimate everywhere it surfaces; nothing reconciles it against a gateway invoice, and `specs/usage-limits` forbids presenting it as a charge.

**Alternative considered:** logging usage as structured log lines and aggregating in the log platform. Rejected — quotas need to *read* consumption transactionally (decision 25), and a log pipeline cannot be the source of truth for a gate.

### 25. Quotas: a reservation in the same transaction as the counter

Counting after the fact cannot gate; counting optimistically races. So consumption is a row per `(subject, dimension, window_key)` in `usage_counters`, and admission is one statement:

```sql
INSERT INTO usage_counters (subject, dimension, window_key, consumed)
VALUES (:subject, :dim, :window, 1)
ON CONFLICT (subject, dimension, window_key)
DO UPDATE SET consumed = usage_counters.consumed + 1
WHERE usage_counters.consumed < :allowance
RETURNING consumed;
```

No row returned means the allowance is exhausted — the check and the increment are the same atomic operation, so concurrent requests from one principal cannot race past a limit. `window_key` is a string derived from `QUOTA_WINDOW_TIMEZONE` (`2026-09-03` for a day, `2026-09` for a month), which makes the reset a new key rather than a scheduled job, and makes a window's history queryable after it closes.

Request dimensions reserve up front and release on a failure before any gateway call. Token dimensions cannot be reserved — the count is not known until the call returns — so they are enforced as a *pre-check* against the window's consumed total and settled from the telemetry events afterward. This admits a bounded overshoot of one request's tokens past a monthly ceiling, which is the honest trade for not pre-declaring token counts, and is stated as such rather than papered over. Concurrency is its own counter, incremented on run start and decremented in a `finally`.

Where several dimensions apply the most restrictive binding one is reported, because "you are over your limit" without naming which limit is not actionable. The refusal is a distinct error code mapping to 429 with the allowance, the consumption, the reset time, and a retry-after — distinguishable from a gateway 429, which is a transport failure and not the caller's fault.

`subject` is the auth subject for a user and a reserved internal subject for administrative, lab, and evaluation traffic, so internal work is accounted against its own allowance by construction rather than by a flag that could be forgotten. An accounting store failure **fails closed** for a bounded dimension: refusing a request is recoverable, silently granting unlimited paid inference is not.

**Alternative considered:** a token-bucket rate limiter in front of the API. Rejected — it answers a different question (requests per second) than a subscription allowance (requests per month), and it has no per-plan notion of entitlement.

### 26. The model lab: the evaluation runner with the model as its axis

The lab is deliberately not a new evaluation implementation. `lab/compare.py` drives the existing runner from `specs/evaluation` with the candidate set as the varying axis and everything else pinned — dataset version, recorded weather fixtures, corpus, embedding model, analytics, commit. A comparison is therefore *n* runner invocations sharing one fixed configuration, and its results are `model_evaluations` rows plus `model_comparison_results` rows, not a parallel scoring system with its own definitions of groundedness.

Holding the retrieval fixed is what makes the comparison mean anything: two models given different upstream data are not being compared on interpretation. Fixtures do that for dataset runs; an ad-hoc question retrieves once and replays the same structured results to every candidate.

The lab holds no privilege. It runs under the request-serving restricted role with the administrator's own principal, so RLS applies to it exactly as to any request — and `specs/model-lab`'s "no data isolation bypass" is then a property of the connection rather than a rule the code has to remember. Its input comes from the dataset, a fixture, or the administrator's own data; there is no code path that reads another user's thread, because there is no such repository function that ignores an owner predicate.

Bounds (`MODEL_LAB_MAX_MODELS`, `MODEL_LAB_MAX_CASES`, `MODEL_LAB_TIME_BUDGET_SECONDS`) exist because a comparison is the one place a single administrative click can spend real money across a matrix. Exceeding the time budget returns a partial result naming what completed, following the same bounded-execution stance as decision 2's step and wall-clock budgets.

Promotion is a separate administrative write to `model_policies`, recorded in `admin_audit` with the cited comparison run ids. Nothing about running a comparison changes what any other caller receives — the lab writes result rows, never policy rows.

### 27. `llm_usage_events` and the two-shape ownership problem

One table holds both a user's calls and internal calls. The tempting answers are both wrong: a nullable `user_id` with an RLS policy of `user_id = auth.uid()` silently hides internal rows from the admin aggregate as well, and two separate tables duplicate every aggregation query and every retention routine.

The resolution: one table, `user_id` nullable, and *two* policies — an owner policy on the restricted role (`user_id = current_setting('request.jwt.claims')::json->>'sub'`) that a caller reading their own usage runs under, and no read path at all for the restricted role to rows where `user_id IS NULL`. The administrative aggregate is a separate, explicitly administrative repository function that reads aggregates — counts, sums, percentiles grouped by model, policy, plan, role, status — and never returns rows. Since the table holds no content (decision 24), an aggregate across users discloses nothing about anyone's questions, which is what makes this safe rather than merely convenient.

`is_internal` is a generated classification (`user_id IS NULL OR subject_kind = 'internal'`) so every aggregate splits product from internal usage without each query remembering to, and an internal event can never be counted against a plan.

Account deletion removes a user's rows here alongside their threads, preferences, and saved locations. Aggregates that no longer attribute to anyone may be retained, and raw rows age out at `LLM_USAGE_RETENTION_DAYS` through the same retention routine decision 11 already schedules from CI — one routine, not a second scheduler.

**Alternative considered:** writing user usage and internal usage to separate tables. Rejected — every aggregate, every retention rule, and every reconciliation against `usage_counters` would exist twice, and the first divergence between the two copies would be a bug nobody notices.

## Risks / Trade-offs

- **A free-tier model may route badly or write sloppily.** Routing quality directly determines tool-selection accuracy, one of the gated metrics. → The deterministic fallback router keeps requests answerable when JSON parsing fails repeatedly; the model has no authority over numbers, so bad routing degrades relevance rather than correctness; and the model is a catalog row inside a policy's candidate list, so a better model is a data change measured by the same eval suite through the model comparison of decision 26.
- **Grounding cannot be fully enforced.** The numeric audit will not catch a wrong figure that happens to appear somewhere in the evidence, and prose can mislead without stating a number. → The envelope carries structured findings alongside prose so the UI can show the real values, the zero-retrieval case is hard-blocked, `grounding.verified` is surfaced rather than hidden, and the evaluation suite measures hallucination and unsupported-claim rates explicitly.
- **Cold starts plus a heavy import graph make first-request latency poor.** LangGraph, SQLAlchemy, and the ONNX embedding runtime are all slow to import. → An instance type that does not idle-spin-down for the deployed service, the embedding model loaded lazily on first RAG use, and the agent path already streams progress so the wait is visible rather than blank.
- **Postgres connection limits, not CPU, will bind first.** Horizontally-scaled backend instances each holding a pool can exhaust Supabase connections. → Connect through the Supabase pooler with a small per-instance pool, and treat pool size as a deployment setting rather than a code constant.
- **Process-local caching multiplies upstream calls across instances.** → Acceptable against a keyless provider; the `CachedProvider` wrapper is the drop-in seam for a shared cache.
- **What Changed? coverage depends on request traffic.** With opportunistic snapshot capture, a location nobody asked about yesterday has nothing to compare against. → The no-prior-snapshot state is a first-class, honest response; scheduled capture is post-MVP and named as such.
- **Confidence communication is single-provider.** Without a second provider there is no consensus signal, so "confidence" rests on horizon distance and whatever spread Open-Meteo supplies. → The basis is disclosed in every uncertainty statement, per `specs/forecast-analysis`; multi-provider consensus is post-MVP.
- **A leaked service-role key would bypass every policy.** It is the one credential that can read any row. → It lives only in backend and CI secret storage, is never `NEXT_PUBLIC_`, is used only by migrations, retention, and evaluation provisioning, and CI asserts it is absent from the frontend environment and the built bundle. The request-serving connection uses the restricted role, so a request path has no access to it even in-process.
- **The backend's connection would bypass RLS if the claims-setting transaction were skipped.** A handler that opens a plain session gets a connection that policies do not constrain. → Ownership is applied in the data path as the primary gate, RLS is the second; the request-scoped session dependency is the only sanctioned way to get a session, and an RLS test deliberately omits the `user_id` predicate to prove the policy still returns nothing.
- **Token validation is a new failure mode on every protected request.** A JWKS fetch failure or a clock skew could reject valid users en masse. → Keys are cached with a bounded refresh and refetched on an unknown key id rather than per request; a small leeway is allowed on expiry for clock skew; and validation failures are logged with their reason (never the token) so a systemic rejection is diagnosable rather than looking like user error.
- **Email deliverability is now on the critical path to a working account.** Supabase's default SMTP is rate-limited and shared, so verification mail may be slow or filtered — a person who cannot receive a code cannot use the product at all. → The resend path with its rate-limit state is a first-class requirement rather than an afterthought, the link path works for anyone whose client mangles the code, and configuring a project SMTP sender is documented as the step to take before showing Weathra to more than a handful of people.
- **Verification depends on Supabase email-template configuration.** The code-entry screen only works if the confirmation template emits the one-time token; a default template sends only a link, and the OTP screen would then have nothing to enter. → The template requirement is documented with the deployment configuration, the link path is implemented as a working fallback rather than a nicety, and the sign-up-through-verification Playwright flow fails loudly if the configured project does not deliver a usable code.
- **Real accounts mean real personal data.** Weathra now holds email-identified users, which raises the stakes on everything persisted. → Credentials and contact data stay in Supabase Auth and application tables reference only the auth subject; persistence remains restricted to explicitly-chosen non-sensitive preferences and bounded conversation context; and account data deletion is an MVP endpoint rather than a future request.
- **The provider abstraction is shaped by its only implementation.** The normalized model will lean toward Open-Meteo's field set. → Fields are derived from what the capabilities need rather than what the payload offers, `capabilities()` is mandatory so absent measures are declared, and the Open-Meteo mapping is written as explicit field-by-field translation rather than passthrough.
- **The RAG corpus is authored, not licensed.** Weather explanations written for the corpus carry Weathra's own provenance and could contain errors. → Every document carries a provenance note, the corpus is small enough to review, and the evaluation suite includes conceptual cases that would surface a wrong explanation.
- **Evaluation against a live model costs money and varies run to run.** → Deterministic metrics run offline in CI on every pull request; live runs are deliberate, recorded with their provider and model, and compared against earlier runs rather than treated as absolute.
- **The model policy layer is a new gate on every agent request.** A bug in resolution, a policy with no available candidate, or an unreachable catalog would refuse answers for everyone at once. → Resolution is a pure function over data with no network call, its fallback chain ends at `LLM_MODEL`, the catalog snapshot is cached so a database blip does not fail the path, and `NoEligibleModel` is a distinct configuration error rather than a generic 500 so a systemic refusal is diagnosable in one look. A resolution test asserts every step of the chain including the case where nothing is available.
- **A catalog disable is not instant.** Up to one cache TTL of requests may still reach a model an administrator has just disabled. → Stated as the documented staleness window rather than hidden; overrides and lab selections validate against the database directly; and no safety control lives in the catalog, so the worst case is a cost or quality decision arriving a minute late.
- **Token quotas can overshoot by one request.** Token counts are unknown until a call returns, so a monthly token ceiling is pre-checked and settled afterward. → The overshoot is bounded by one request's tokens, request-count dimensions are reserved atomically and cannot overshoot at all, and the trade is stated in decision 25 rather than presented as an exact limit.
- **Quota accounting fails closed, which means an outage refuses paying customers.** → The alternative is granting unmetered paid inference during exactly the incident when nobody is watching. The refusal is a distinct 429 naming the reason, non-agent capabilities keep serving, and `QUOTA_ENABLED` exists so a local or CI run is never gated by a store it does not have.
- **Telemetry on every call is a write amplification.** Two or more rows per agent request, forever, is the largest-growing table in the system. → Rows are small and content-free, they age out at `LLM_USAGE_RETENTION_DAYS` into retained aggregates through the retention routine that already exists, and the write is a background task so its cost never lands on a caller's latency.
- **An administrative role is a new privilege class in a system that had none.** A wrongly-granted flag exposes the catalog, plans, aggregate usage, and the lab. → The role is backend-held state keyed by the auth subject and never a token claim or client field; it grants no access to any other user's own data; every privileged write is recorded in `admin_audit`; and the lab runs under the restricted connection so the role cannot be used to read around RLS.
- **Cost figures invite being read as bills.** An estimate on an admin screen will eventually be quoted at somebody. → It is `None` rather than `0` when unknown, carries the pricing basis and date it was computed from, is labelled an estimate at every surface by spec, and nothing in the system reconciles or charges against it.
- **Twenty capabilities is a large MVP.** The risk is a thin slice of everything rather than a working product, and the SaaS layer adds five specs to a change that was already large. → Task ordering builds the data and analytics spine first, so that every layer above it has something real to stand on, and each task carries its own verification. Every one of the five later capabilities sits inside a seam that spine already establishes — the LLM client Protocol, the settings layer, the migration and Row Level Security pattern, the retention routine, and the evaluation runner — so groups 26–34 add tables, a resolver, a wrapper, and a runner axis rather than new architecture. None of the fifteen original capabilities changes shape.

## Migration Plan

Nothing to migrate — this is the first code in the repository.

**Bring-up order:** provision the Supabase project, enable pgvector, and configure Auth (email confirmation required, confirmation and recovery templates carrying the one-time token, redirect URLs per environment) → apply migrations, including the Row Level Security policies and the seeded catalog, policies, plans, and allowances → verify the backend serves the public weather, history, analysis, and comparison endpoints with no inference credential and no session → create a test account through the real sign-up and verification flow and verify a protected endpoint accepts its token and rejects a missing or expired one → ingest the RAG corpus → configure `OPENROUTER_API_KEY` and verify `/ask` and the authenticated SSE stream, with a resolution recorded in the evidence record and a usage event recorded for each call → grant the administrative role to the operating account and verify the administrative catalog, plan, usage, and lab endpoints → deploy the backend to Render → deploy the frontend to Vercel pointed at it → run the evaluation suite as an authenticated test user and record its results → run the first model comparison and seed the policy candidate lists from its recorded evidence.

**Rollback:** the backend is a container revision, so rollback is redeploying the previous revision; the frontend likewise. Migrations are additive in this change (no destructive operations), so a rolled-back revision runs against the newer schema without loss. Data rollback is not required — there is no pre-existing data.

**Verification that the slice is real:** readiness reports every dependency reachable; a public forecast request for a named city returns attributed data without a session; a new account can be created, verified by code, and signed into; a historical baseline comparison returns both sides labelled; a question through `/ask` returns an answer whose every figure appears in its evidence record; a second account cannot see the first account's saved locations, preferences, or threads by any route; a Free-plan caller is served their entitled model with the resolution recorded and a body field claiming Pro ignored; every language model call has a usage event with tokens, latency, and a labelled estimated cost; an exhausted allowance returns 429 naming its basis while forecast, history, analysis, and comparison keep serving; an administrative override is accepted for an enabled catalog model and refused for a disabled one; internal lab and evaluation usage is reported separately from every product plan; and the evaluation suite passes its gated thresholds.

## Open Questions

- **Which SMTP sender for verification mail.** Supabase's shared default sender is rate-limited and prone to filtering, which is a poor fit for a flow where a missing email blocks all access. Configuring a project SMTP provider is a deployment decision, not a design change, but it should be made before the product is shown to more than a handful of people.
- **Session and token lifetimes.** The access-token lifetime interacts with the agent wall-clock budget (a stream must not outlive its token) and with how often a returning person is asked to sign in again. Starting from Supabase's defaults with the agent budget set below the token lifetime; both are configuration.
- **Which OpenRouter models to seed the catalog with.** The architecture is model-agnostic and the eval suite is how the choice gets made. A free-tier model is the starting point for `free_default`, and the first eval run may show routing accuracy below the 95% threshold on it — in which case the answer is a different catalog row and a reordered candidate list, not a design change. Which specific models fill `balanced` and `high_reasoning` is a seeding decision made from the first model-comparison run.
- **What the initial allowances should be.** Free, Pro, and Premium need numbers for daily and monthly requests and monthly tokens, and there is no traffic history to derive them from. Starting deliberately conservative on Free and generous on Premium, with the intent of tuning from recorded usage rather than guessing well — the allowance rows are data, so tuning is not a deployment.
- **Whether a cost budget dimension gets enabled.** The allowance model can express an estimated-cost budget per plan and window, and nothing enables one in this change. It becomes worth turning on when a policy first resolves a paid model, and that is a pricing decision rather than a design one.
- **Whether the caller-facing advisory model hint is accepted at all.** The design supports it and drops it outside entitlement; the simpler option is not accepting the field on the product endpoints in the first place. Leaning toward not accepting it until a real reason appears, since a field that is usually ignored is a field that gets misread.
- **Snapshot retention and granularity.** Forecast snapshots accumulate per location, window, and retrieval. How long to keep them, and whether to store hourly as well as daily series, depends on how What Changed? is actually used. Settings, not structure.
- **Cache TTL values.** 15 minutes for current conditions and 1 hour for forecasts are starting points that depend on Open-Meteo's model-run cadence. Settings.
- **RAG chunk size, top-k, and relevance threshold.** Starting at heading-aware chunks with a modest overlap, top-k of 4, and a cosine threshold to be tuned against the conceptual evaluation cases. Tuning changes no interface.
- **Whether MCP becomes its own service.** Kept in-container for the MVP; the boundary is clean enough that the decision can wait for a real reason (independent scaling, or an external MCP consumer).
