## Why

Weathra is an empty repository with a stated ambition — agentic weather intelligence, forecast analysis, and analytics — but no runnable system, so there is nothing to evaluate the premise against. This change establishes the capstone architecture and its first working slice: a LangGraph multi-agent backend that answers weather questions by routing to specialized capabilities, computes every number deterministically in Python, retrieves conceptual background from a curated knowledge corpus, remembers a conversation and a person's preferences, and exposes all of it through a FastAPI service consumed by a separate Next.js application.

The premise being proved is that a supervised multi-agent system over normalized weather data — where the language model interprets but never calculates and never invents a measurement — produces weather intelligence a raw forecast cannot. The architecture below is locked: the MVP prioritizes which screens and refinements land first, but no architectural component is dropped to get there.

One thing the original architecture left implicit is now made explicit, because leaving it implicit is what would later force an architectural change: *which* model serves a given request, and on whose authority. A system with subscription tiers cannot decide that in a node, in the frontend, or in a single environment variable. So this change adds a backend-controlled model policy layer between orchestration and the language model client, a catalog of allowlisted models as operational data, per-call token/cost/latency telemetry, server-side quotas by plan, and an internal model lab for comparing candidates on measured evidence. None of it redesigns the locked architecture — it is a governance layer inside the existing provider-agnostic LLM seam, and the model remains as replaceable as it was.

## What Changes

### Architecture introduced

- **Two separately structured applications.** A Next.js + React + TypeScript frontend and a FastAPI backend, developed and deployed independently even though they may later sit behind one public domain. The backend never serves the UI.
- **Supabase Auth as the identity and authentication system.** Email-and-password accounts with mandatory email verification, sign-in, sign-out, password reset, and persistent sessions handled by Supabase Auth in the frontend; the backend derives every user identity from a validated Supabase access token and never from a client-asserted identifier. Every user-owned record is scoped to its owning authenticated user, with Row Level Security as a second gate.
- **LangGraph supervisor/orchestrator** routing requests among four specialized logical agents implemented as nodes/subgraphs: **Forecast Agent**, **Historical Agent**, **Analytics Agent**, and **RAG Agent**. The supervisor supports multi-step queries that touch several agents in one turn.
- **MCP Weather Server** as a first-class component with its own implementation boundary and test suite, exposing `geocode_location`, `weather_current`, `weather_forecast`, `weather_history`, `weather_compare`, `weather_statistics`, and `weather_anomaly`. LangGraph reaches approved weather and analytics capabilities through this tool interface rather than calling providers directly.
- **Pluggable weather-provider abstraction** with Open-Meteo as the first concrete provider, using its forecast, historical/archive, and geocoding APIs. All upstream access is funnelled through this layer; no agent, analytics function, or route touches a provider payload.
- **Provider-agnostic LLM layer** with an internal abstraction and OpenRouter as the first concrete inference gateway. The gateway and its credential are environment configuration (`LLM_PROVIDER`, `OPENROUTER_API_KEY`); the model for a given call is resolved per call by the model policy layer, with `LLM_MODEL` retained as the development and administrative fallback. No agent depends on a single model vendor and no application module hard-codes a model identifier.
- **Backend-controlled model policy layer** between the LangGraph orchestrator and the LLM client. Named, subscription-aware policies — `free_default`, `balanced`, `high_reasoning`, `admin_experimental` — resolve a model per call from the acting principal's backend-derived plan and the call role. Plans map onto Free / Plus / Premium. The frontend is never trusted to authorize premium model access; enforcement is server-side, and a caller-named model is advisory at most.
- **Model catalog as operational data.** Allowlisted gateway model ids with their metadata — capability role, tier, structured-output support, context window, pricing, enable/disable status — held in the database, seeded by migration, administrable at runtime. Model availability changes without a code change, and no business rule is coupled to a vendor model id.
- **Per-call LLM telemetry.** Every language model call — success or failure, on every path — records user, agent run, model, policy and plan, prompt/completion/total tokens, estimated cost, latency, status, and timestamp. Metadata only: no prompt or completion text.
- **Server-side usage limits.** Quotas by plan across daily and monthly request windows, monthly token totals, and concurrency, with internal/administrative usage accounted separately and room for a future estimated-cost budget. No payment processing — plans are assigned administratively.
- **Admin / internal model lab.** An administrative facility to run one prompt or question across several allowlisted models and record model, latency, tokens, cost, success/failure, and evaluation result side by side. It holds no privilege of its own: no security control and no user data isolation is bypassed.
- **Deterministic analytics engine** in pure Python. Every meteorological number a caller sees is computed here — never estimated by a language model.
- **RAG subsystem** over a curated weather-domain knowledge corpus, using pgvector on Supabase Postgres (ChromaDB documented as the fallback). Conceptual explanation only; never a source for live or historical measurements.
- **Shared memory layer** on PostgreSQL/Supabase, scoped by authenticated user and conversation thread: LangGraph short-term checkpointing for conversation and follow-up context, plus a durable long-term store for explicitly chosen non-sensitive preferences and saved locations.
- **REST plus SSE** on a versioned FastAPI surface with OpenAPI documentation. SSE streams agent progress, tool activity, and evidence as a question is worked.
- **Evaluation subsystem**: a ~40-case dataset, a runner, and ten measured metrics with stated acceptance thresholds.
- **Safety and grounding requirements** as a first-class capability, not a section of a design doc: no fabricated measurements, deterministic numbers only, explicit separation of observation from forecast from historical statistic from AI interpretation, source attribution, and honest handling of unavailable data.

### Repository structure introduced

- `backend/` — FastAPI app, authentication and authorization layer, LangGraph graph, MCP server, providers, analytics, RAG, memory, evaluation, tests.
- `frontend/` — Next.js app, TypeScript, Supabase Auth integration and protected routing, component and interaction tests.
- `docs/` — architecture, authentication, agents, MCP, RAG, evaluation methodology, privacy/ethics, deployment, configuration, API, roadmap, and the approved Visily design artifacts with the design direction carried forward from the earlier UXPilot exploration.
- `.github/workflows/` — CI for both applications.

No breaking changes — there is no existing behavior to break.

## Capabilities

### New Capabilities

Twenty capability specs, all new. `openspec/specs/` is currently empty.

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
| `web-ui` | The Next.js application: the Visily design phase, the design direction carried forward from the earlier UXPilot exploration, the design system, authentication screens and states, protected routing, MVP product screens, post-MVP screens, state handling, accessibility | Partial — see screen classification below |
| `evaluation` | The evaluation dataset, the ten metrics with their exact measurement definitions, the runner, and the acceptance thresholds | Yes |
| `safety-grounding` | Fabrication prohibitions, data-class labelling, attribution, uncertainty communication, severe-weather stance, privacy | Yes |
| `model-policy` | The backend-controlled policy layer between orchestration and the LLM client: named subscription-aware policies, plan-to-policy mapping, server-side entitlement, bounded administrative override, deterministic resolution and honest degradation, `LLM_MODEL` as development/administrative fallback, provider-agnosticism | Yes |
| `model-catalog` | Allowlisted gateway model ids and their metadata as persisted data: capability roles, tier, structured-output support, context window, pricing, enable/disable status; runtime availability changes; decoupling business logic from vendor model ids | Yes |
| `llm-telemetry` | The per-call usage event — user, agent run, model, policy, plan, prompt/completion/total tokens, estimated cost, latency, status, timestamp — with failures recorded, metadata-only storage, owner scoping, internal separation, aggregation and retention | Yes |
| `usage-limits` | Subscription plans as data, server-side quota enforcement by plan across daily/monthly/token/concurrency dimensions, explicit windows, honest refusal, concurrency-safe accounting, separate internal allowance, and the explicit exclusion of payment processing | Yes |
| `model-lab` | The administrative internal model lab: allowlisted model selection, same-prompt comparison across models, recorded latency/tokens/cost/status/evaluation result, no security or isolation bypass, internal accounting, and no implicit change to production policy | Partial — backend and records in scope; its screen is post-MVP |

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
| **Model policy and plan tiers** — server-side model routing by subscription plan, with per-call telemetry and quotas | **MVP**, backend-enforced | Free / Plus / Premium assigned administratively; no payment processing in this change |
| **Admin model lab** — comparing one prompt across allowlisted models on measured evidence | **MVP** backend and records; **post-MVP** screen | Promotion of a model into a policy is an explicit administrative action |

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
| Admin Model & AI Usage | Post-MVP — model status, token usage, cost, latency, errors, plan usage, internal model selector; administrative principals only |
| Plan & Usage | Post-MVP — the signed-in person's own plan, consumption, and window resets |

The Admin Model & AI Usage screen and the Plan & Usage view are post-MVP but remain subject to the same Visily design gate as every other screen — designed and approved before substantial implementation, and represented in the design roadmap until then.

**Visily.ai** produces the UI/UX design artifacts for these screens before substantial frontend implementation begins, covering both the authentication and the core product experiences, and establishes the shared Weathra design system — typography, spacing, component hierarchy, navigation, cards, charts, weather visualization patterns, responsive behavior, and loading, empty, error, and authentication states. The implemented Next.js UI follows the approved artifacts rather than generic generated styling. Post-MVP screens remain represented in the design roadmap.

The delivery path is therefore **OpenSpec → Visily → approved UI/UX artifacts → React/Next.js implementation → FastAPI → LangGraph → MCP → weather providers**. This is a design-workflow change only: it replaces which tool the remaining screen design is done in and changes no part of the locked architecture.

An earlier UXPilot exploration already settled the design direction, and that work is preserved as prior design exploration rather than discarded — the Midnight Intelligence palette, the Plus Jakarta Sans and Inter typographic pairing, the Intelligent Command Center shell with persistent left navigation, the location-focused Dashboard, the premium modern SaaS visual direction, the named Weathra Intelligence, What Changed?, Why? and Agent Evidence surfaces, the visible distinction between observed, forecast, historical, deterministic-analytics and AI-interpretation content, source attribution, timestamps, uncertainty and confidence presentation, and the rule that nothing may imply the language model predicts numerical weather values. These are carried into Visily as approved design-direction inputs, per `specs/web-ui`.

Nothing in the gate requires a paid Visily export capability, a design-to-code handoff, or any other design tool — Figma is explicitly not mandatory. An approved Visily screen is a visual reference, and implementing it by hand in Next.js against the recorded design system is a conforming path.

## Impact

### Backend dependencies

FastAPI and uvicorn; LangGraph and LangChain core; `langgraph-checkpoint-postgres` for short-term checkpointing; the MCP Python SDK; httpx for upstream calls; pydantic and pydantic-settings; SQLAlchemy with asyncpg, plus Alembic for migrations; pgvector's Python bindings; a local ONNX embedding runtime (fastembed) so embedding needs no third-party key; the OpenRouter adapter over httpx (no vendor SDK); a JOSE/JWT library for validating Supabase access tokens against the project's published signing keys; pytest with pytest-asyncio and respx; ruff.

`anthropic` is **not** a dependency. Claude Code is used to develop Weathra; it is not Weathra's runtime LLM provider. A direct Anthropic adapter is an optional post-MVP addition behind the same abstraction.

### Frontend dependencies

Next.js, React, TypeScript, the Supabase JavaScript client with its SSR/cookie helpers for authentication and session handling, a charting library, an SSE client, and a component/interaction test stack (Vitest plus Testing Library, with Playwright for the few cross-screen flows).

### External services

- **Open-Meteo** — forecast, archive, and geocoding endpoints. Keyless.
- **OpenRouter** — runtime LLM gateway, and the only one shipped. It remains configuration: the model catalog holds its model ids as data, and substituting another gateway behind the same client contract is a configuration-and-catalog change, not a code change. Requires `OPENROUTER_API_KEY`.
- **Supabase** — Auth for identity, email verification, and password reset (Supabase sends the verification and reset messages); PostgreSQL with the pgvector extension holding profiles, memory, preferences, saved locations, forecast snapshots, the knowledge corpus and its embeddings, agent runs, and evaluation runs, plus the SaaS-ready entities — subscription plans, model policies, the model catalog, LLM usage events, usage limits and consumption, and model evaluations — with Row Level Security on user-owned tables, unchanged and unweakened.

### Configuration and secrets

Environment-based settings for both applications, with `.env.example` in each. The frontend receives only public configuration — `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or its current publishable-key equivalent) plus the backend base URL. The backend holds the server-side configuration: `SUPABASE_URL`, the Supabase JWT issuer and audience and signing-key endpoint, the service-role key where privileged access is genuinely required, the database connection string, and `OPENROUTER_API_KEY`. Model selection is deliberately *not* configuration beyond the fallback: `LLM_MODEL` stays as the development and administrative fallback, while policies, plan mappings, and the catalog live in the database so they change without a redeployment. The Supabase service-role key and every other secret exist only in server-side environment variables and are never exposed to the browser. The backend must start and serve every public capability with `OPENROUTER_API_KEY` absent, degrading only the agent paths.

### Deployment

Next.js on Vercel; FastAPI with LangGraph, MCP, and analytics on Render; Postgres with pgvector and persistent memory on Supabase; GitHub for source control and GitHub Actions for CI/CD. Development is browser/cloud-based — no step in the setup, test, or deploy path may require a specific local machine.

### Out of scope for this change

Enterprise single sign-on, additional OAuth identity providers, multi-factor authentication, organization and role-based access control beyond the single administrative/internal role this change introduces, multi-tenancy, rate limiting and API keys for third-party consumers, push notifications, severe-weather alerting, additional weather providers, additional LLM adapters, scheduled snapshot capture, and every capability and screen marked post-MVP above.

**Payment processing is explicitly out of scope.** No checkout, card handling, invoicing, dunning, proration, or billing-provider integration is implemented. Plans are assigned administratively; estimated cost is reported as an operational estimate and never as a charge. The schema leaves room for a later billing integration — a stable plan code and an unused external subscription reference — without that integration existing. Paid-model budgets are representable in the allowance model but are not funded or enforced against a real budget in this change.

## Assumptions

Recorded because they were not specified. Each is reversible without changing the locked architecture.

- **Verification delivers a code.** Supabase's signup-confirmation email template is configured to include the one-time token so Weathra can offer code-entry UI, and the returning confirmation link is also handled for people who click through instead. Both paths complete the same verification.
- **Sessions are cookie-based.** The frontend uses the Supabase SSR/cookie session helpers so Next.js can protect routes on the server before a protected screen renders, and forwards the access token to FastAPI as a bearer token.
- **Public weather endpoints stay public.** Locations, current weather, forecast, history, analysis, and comparison serve unauthenticated callers; everything touching user-owned data is protected. Rate limiting for those public endpoints remains post-MVP and is flagged as needed before public exposure.
- **Embeddings run in-process.** OpenRouter is an inference gateway and is not relied on for embeddings, so a small local ONNX model (BGE-small-en-v1.5, 384 dimensions) produces vectors inside the backend. This keeps RAG keyless and deterministic. An `EmbeddingProvider` abstraction allows a hosted embedding service later, with re-indexing.
- Python 3.12 for the backend; Node 20 LTS for the frontend.
- Units default to metric with an explicit per-request override; forecast horizon defaults to 7 days; hourly detail is available for at least the first 48 hours.
- The initial policy candidates are free-tier OpenRouter models, seeded as catalog data and expected to change. No model name appears in application logic, and the specific models seeded are an operational choice, not an architectural one.
- **Plans are administratively assigned.** With no payment processing, a person's plan is set by an administrative write. Free is the default when no assignment exists.
- **One administrative role, not an RBAC system.** A single server-held administrative/internal flag gates policy, catalog, plan, aggregate-usage, and model-lab access. Organizations, teams, and graded roles remain post-MVP.
- **Quota windows are calendar day and calendar month** in a configured time zone, with consumption reconcilable against the recorded usage events. A cost-budget dimension is representable but unset.
- **Cost is an estimate.** It is computed in Python from recorded token counts and the catalog pricing in effect at the time of the call, labelled as an estimate, and never reconciled against a gateway invoice in this change.
