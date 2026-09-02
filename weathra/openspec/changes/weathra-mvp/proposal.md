## Why

Weathra is an empty repository with a stated ambition — agentic weather intelligence, forecast analysis, and analytics — but no runnable system, so there is nothing to evaluate the premise against. This change establishes the capstone architecture and its first working slice: a LangGraph multi-agent backend that answers weather questions by routing to specialized capabilities, computes every number deterministically in Python, retrieves conceptual background from a curated knowledge corpus, remembers a conversation and a person's preferences, and exposes all of it through a FastAPI service consumed by a separate Next.js application.

The premise being proved is that a supervised multi-agent system over normalized weather data — where the language model interprets but never calculates and never invents a measurement — produces weather intelligence a raw forecast cannot. The architecture below is locked: the MVP prioritizes which screens and refinements land first, but no architectural component is dropped to get there.

## What Changes

### Architecture introduced

- **Two separately structured applications.** A Next.js + React + TypeScript frontend and a FastAPI backend, developed and deployed independently even though they may later sit behind one public domain. The backend never serves the UI.
- **Supabase Auth as the identity and authentication system.** Email-and-password accounts with mandatory email verification, sign-in, sign-out, password reset, and persistent sessions handled by Supabase Auth in the frontend; the backend derives every user identity from a validated Supabase access token and never from a client-asserted identifier. Every user-owned record is scoped to its owning authenticated user, with Row Level Security as a second gate.
- **LangGraph supervisor/orchestrator** routing requests among four specialized logical agents implemented as nodes/subgraphs: **Forecast Agent**, **Historical Agent**, **Analytics Agent**, and **RAG Agent**. The supervisor supports multi-step queries that touch several agents in one turn.
- **MCP Weather Server** as a first-class component with its own implementation boundary and test suite, exposing `geocode_location`, `weather_current`, `weather_forecast`, `weather_history`, `weather_compare`, `weather_statistics`, and `weather_anomaly`. LangGraph reaches approved weather and analytics capabilities through this tool interface rather than calling providers directly.
- **Pluggable weather-provider abstraction** with Open-Meteo as the first concrete provider, using its forecast, historical/archive, and geocoding APIs. All upstream access is funnelled through this layer; no agent, analytics function, or route touches a provider payload.
- **Provider-agnostic LLM layer** with an internal abstraction and OpenRouter as the first concrete inference gateway. Provider and model are environment configuration (`LLM_PROVIDER`, `LLM_MODEL`, `OPENROUTER_API_KEY`), not architecture. No agent depends on a single model vendor.
- **Deterministic analytics engine** in pure Python. Every meteorological number a caller sees is computed here — never estimated by a language model.
- **RAG subsystem** over a curated weather-domain knowledge corpus, using pgvector on Supabase Postgres (ChromaDB documented as the fallback). Conceptual explanation only; never a source for live or historical measurements.
- **Shared memory layer** on PostgreSQL/Supabase, scoped by authenticated user and conversation thread: LangGraph short-term checkpointing for conversation and follow-up context, plus a durable long-term store for explicitly chosen non-sensitive preferences and saved locations.
- **REST plus SSE** on a versioned FastAPI surface with OpenAPI documentation. SSE streams agent progress, tool activity, and evidence as a question is worked.
- **Evaluation subsystem**: a ~40-case dataset, a runner, and ten measured metrics with stated acceptance thresholds.
- **Safety and grounding requirements** as a first-class capability, not a section of a design doc: no fabricated measurements, deterministic numbers only, explicit separation of observation from forecast from historical statistic from AI interpretation, source attribution, and honest handling of unavailable data.

### Repository structure introduced

- `backend/` — FastAPI app, authentication and authorization layer, LangGraph graph, MCP server, providers, analytics, RAG, memory, evaluation, tests.
- `frontend/` — Next.js app, TypeScript, Supabase Auth integration and protected routing, component and interaction tests.
- `docs/` — architecture, authentication, agents, MCP, RAG, evaluation methodology, privacy/ethics, deployment, configuration, API, roadmap, and the approved UXPilot design artifacts.
- `.github/workflows/` — CI for both applications.

No breaking changes — there is no existing behavior to break.

## Capabilities

### New Capabilities

Fifteen capability specs, all new. `openspec/specs/` is currently empty.

| Capability | Covers | MVP |
|---|---|---|
| `authentication` | Supabase Auth identity, account creation, mandatory email verification and resend, sign-in/out, password reset, session persistence and expiry, backend token validation, the application profile, user-owned data scoping, cross-user denial, endpoint protection classification, Row Level Security, and secret handling | Yes |
| `weather-providers` | Provider protocol and registry, normalized weather model, caching, upstream failure handling, Open-Meteo forecast/archive/geocoding implementation | Yes |
| `location-resolution` | Place name and coordinate resolution, ambiguity, search, timezone | Yes |
| `deterministic-analytics` | The pure-Python computation engine: extremes, means, ranges, totals, probability analysis, humidity and wind statistics, gusts, rolling averages, deltas, percentiles, z-scores, anomaly detection, trend | Yes |
| `forecast-analysis` | Forecast Agent behavior: current, hourly, daily retrieval across all measures; threshold crossings; forecast anomalies; What Changed?; confidence and uncertainty communication | Yes |
| `historical-weather` | Historical Agent behavior: archive retrieval, period-versus-period comparison, historical baselines, comparison of current or forecast conditions against baseline | Yes |
| `location-comparison` | Multi-location and multi-day comparison and ranking with evidence | Yes |
| `agent-orchestration` | LangGraph supervisor, routing among the four agents, multi-step queries, the LLM provider abstraction, bounded execution, evidence capture, streaming progress | Yes |
| `mcp-weather-server` | The MCP server boundary, its seven tools, their contracts, error semantics, and transport | Yes |
| `rag-knowledge` | Knowledge corpus, ingestion and chunking, embedding, retrieval, citation, and the prohibition on sourcing measurements from RAG | Yes |
| `memory` | Short-term conversation memory and checkpointing scoped by authenticated user and thread, durable preferences and saved locations, retention and privacy rules | Yes |
| `http-api` | Versioned REST surface, SSE streams, bearer-token authentication, public/protected endpoint classification, request/response contracts, error model, health and readiness, observability | Yes |
| `web-ui` | The Next.js application: the UXPilot design phase and design system, authentication screens and states, protected routing, MVP product screens, post-MVP screens, state handling, accessibility | Partial — see screen classification below |
| `evaluation` | The evaluation dataset, the ten metrics with their exact measurement definitions, the runner, and the acceptance thresholds | Yes |
| `safety-grounding` | Fabrication prohibitions, data-class labelling, attribution, uncertainty communication, severe-weather stance, privacy | Yes |

### Modified Capabilities

None. Every capability above is new.

## Product capabilities: MVP versus post-MVP

### Signature capabilities

| Capability | Status | Note |
|---|---|---|
| **Accounts and authentication** — Supabase Auth email/password identity with mandatory email verification, and per-user private data | **MVP** | Enterprise SSO, additional OAuth providers, and organization RBAC remain post-MVP |
| **Weathra Intelligence** — a synthesized briefing for a location combining current conditions, forecast movement, anomalies, and historical context | **MVP** | Rendered on the Dashboard |
| **Agent Evidence** — the full record of which agents ran, which tools were called with what arguments, what came back, and which figures the answer rests on | **MVP** | Streamed over SSE and shown on its own screen |
| **What Changed?** — how the forecast for a location and window has moved since the last captured snapshot | **MVP**, opportunistic capture | Snapshots are written on each forecast retrieval; scheduled capture is post-MVP |
| **Why?** — an explanation of what drove a stated conclusion, grounded in the computed analytics and the retrieved knowledge corpus | **MVP** | |
| **Forecast anomaly detection** | **MVP** | Deterministic, in the analytics engine |
| **Historical comparison** | **MVP** | Historical Agent; distinct from forecast-accuracy scoring |
| **Multi-location comparison** | **MVP** | |
| **Forecast confidence / uncertainty communication** | **MVP** | Derived from provider-supplied spread and horizon distance; single-provider, so it is a bounded signal — stated as such |
| **Personalized weather intelligence** — briefings shaped by saved locations, preferred units, and preferred horizon, private to the signed-in person | **MVP**, preference-driven | Behavioral personalization from usage history is post-MVP |
| **Weather Scenario Lab** — explore hypothetical or alternative weather conditions and their implications | **Post-MVP** | Screen and capability both deferred |
| **Travel Intelligence** — weather intelligence along a route or across trip dates | **Post-MVP** | |
| **Weather Watch** — monitoring a location against conditions and notifying on change | **Post-MVP** | Requires scheduling and notification infrastructure |
| **Historical forecast-accuracy / skill scoring** | **Post-MVP** | Requires a long snapshot history; explicitly *not* the same as historical weather retrieval, which is MVP |

### Screens

| Screen | Status |
|---|---|
| Sign In | **MVP** |
| Create Account | **MVP** |
| Verify Email / Enter Verification Code | **MVP** |
| Verification Successful | **MVP** |
| Verification Failed / Expired Code | **MVP** |
| Resend Verification Code | **MVP** |
| Forgot Password | **MVP** |
| Reset Password | **MVP** |
| Dashboard | **MVP** |
| AI Weather Analyst | **MVP** |
| Historical Analytics | **MVP** |
| Compare Cities | **MVP** |
| Agent Evidence / Activity | **MVP** |
| Saved Locations | **MVP** |
| Settings | **MVP** |
| Weather Intelligence Report | Post-MVP — a composed, exportable report |
| Forecast Explorer | Post-MVP — deep hourly/measure exploration beyond the Dashboard |
| Weather Scenario Lab | Post-MVP |
| Weather Watch | Post-MVP |
| Travel Intelligence | Post-MVP |

UXPilot produces the UI/UX design artifacts for these screens before substantial frontend implementation begins, covering both the authentication and the core product experiences, and establishes the shared Weathra design system — typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, and loading, empty, error, and authentication states. The implemented Next.js UI follows the approved artifacts rather than generic generated styling. Post-MVP screens remain represented in the design roadmap.

## Impact

### Backend dependencies

FastAPI and uvicorn; LangGraph and LangChain core; `langgraph-checkpoint-postgres` for short-term checkpointing; the MCP Python SDK; httpx for upstream calls; pydantic and pydantic-settings; SQLAlchemy with asyncpg, plus Alembic for migrations; pgvector's Python bindings; a local ONNX embedding runtime (fastembed) so embedding needs no third-party key; the OpenRouter adapter over httpx (no vendor SDK); a JOSE/JWT library for validating Supabase access tokens against the project's published signing keys; pytest with pytest-asyncio and respx; ruff.

`anthropic` is **not** a dependency. Claude Code is used to develop Weathra; it is not Weathra's runtime LLM provider. A direct Anthropic adapter is an optional post-MVP addition behind the same abstraction.

### Frontend dependencies

Next.js, React, TypeScript, the Supabase JavaScript client with its SSR/cookie helpers for authentication and session handling, a charting library, an SSE client, and a component/interaction test stack (Vitest plus Testing Library, with Playwright for the few cross-screen flows).

### External services

- **Open-Meteo** — forecast, archive, and geocoding endpoints. Keyless.
- **OpenRouter** — runtime LLM gateway. Requires `OPENROUTER_API_KEY`.
- **Supabase** — Auth for identity, email verification, and password reset (Supabase sends the verification and reset messages); PostgreSQL with the pgvector extension holding profiles, memory, preferences, saved locations, forecast snapshots, the knowledge corpus and its embeddings, agent runs, and evaluation runs, with Row Level Security on user-owned tables.

### Configuration and secrets

Environment-based settings for both applications, with `.env.example` in each. The frontend receives only public configuration — `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or its current publishable-key equivalent) plus the backend base URL. The backend holds the server-side configuration: `SUPABASE_URL`, the Supabase JWT issuer and audience and signing-key endpoint, the service-role key where privileged access is genuinely required, the database connection string, and `OPENROUTER_API_KEY`. The Supabase service-role key and every other secret exist only in server-side environment variables and are never exposed to the browser. The backend must start and serve every public capability with `OPENROUTER_API_KEY` absent, degrading only the agent paths.

### Deployment

Next.js on Cloudflare; FastAPI with LangGraph, MCP, and analytics on Google Cloud Run; Postgres with pgvector and persistent memory on Supabase; GitHub Actions for CI/CD. Development is browser/cloud-based — no step in the setup, test, or deploy path may require a specific local machine.

### Out of scope for this change

Enterprise single sign-on, additional OAuth identity providers, multi-factor authentication, organization and role-based access control, multi-tenancy, rate limiting and API keys for third-party consumers, push notifications, severe-weather alerting, additional weather providers, additional LLM adapters, scheduled snapshot capture, and every capability and screen marked post-MVP above.

## Assumptions

Recorded because they were not specified. Each is reversible without changing the locked architecture.

- **Verification delivers a code.** Supabase's signup-confirmation email template is configured to include the one-time token so Weathra can offer code-entry UI, and the returning confirmation link is also handled for people who click through instead. Both paths complete the same verification.
- **Sessions are cookie-based.** The frontend uses the Supabase SSR/cookie session helpers so Next.js can protect routes on the server before a protected screen renders, and forwards the access token to FastAPI as a bearer token.
- **Public weather endpoints stay public.** Locations, current weather, forecast, history, analysis, and comparison serve unauthenticated callers; everything touching user-owned data is protected. Rate limiting for those public endpoints remains post-MVP and is flagged as needed before public exposure.
- **Embeddings run in-process.** OpenRouter is an inference gateway and is not relied on for embeddings, so a small local ONNX model (BGE-small-en-v1.5, 384 dimensions) produces vectors inside the backend. This keeps RAG keyless and deterministic. An `EmbeddingProvider` abstraction allows a hosted embedding service later, with re-indexing.
- Python 3.12 for the backend; Node 20 LTS for the frontend.
- Units default to metric with an explicit per-request override; forecast horizon defaults to 7 days; hourly detail is available for at least the first 48 hours.
- The initial OpenRouter model is a free-tier model such as NVIDIA Nemotron, set purely by configuration and expected to change.
