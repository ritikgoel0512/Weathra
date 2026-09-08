# Weathra

**Agentic weather intelligence, forecast analysis, and analytics.**

Weathra answers weather questions in prose, and can show you where every figure in the answer came
from. Ask "is next week warmer than last week in Berlin?" and it plans the work, retrieves the
forecast and the archive through a tool boundary, computes the comparison with deterministic
statistics, writes the answer from those figures alone, and keeps a record of every tool call,
method, and citation behind it.

Two things shape the whole system:

- **The numbers are computed, not generated.** Every statistic comes from Python and numpy. The
  language model routes the question and writes the prose; it is given the computed findings and is
  never the thing that calculates. A figure in an answer that does not trace back to retrieved or
  computed data is caught by a grounding audit and reported.
- **Every value says what it is.** Current conditions, forecast, historical observation, computed
  statistic, and AI interpretation are five distinct data classes, and each is labelled wherever it
  appears — with its provider, location, period, and retrieval time.

## What it does

| Capability | What you get |
|---|---|
| **Dashboard briefing** | Current conditions, forecast movement, anomalies, historical context, and what changed since the last time you looked |
| **AI Weather Analyst** | Free-text questions, with the routing, agents, and tool calls streaming as they happen |
| **Historical analytics** | Archive retrieval, period-over-period comparison, and comparison against a multi-year baseline |
| **Compare cities** | Several locations ranked on a criterion you choose, with the values behind each rank and the reason any candidate was excluded |
| **Agent evidence** | The full record of a run: agents, tool calls and results, analytics methods, cited knowledge, timings |
| **Saved locations and settings** | Your places, unit system, default horizon, and deletion of your data |

Weather data comes from [Open-Meteo](https://open-meteo.com). Weathra is not a forecaster and never
issues warnings: for severe weather it refers you to your official national meteorological service.

## Architecture at a glance

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
                    │  REST + SSE      │◀─┤  (credentials,  │
                    └────────┬─────────┘  │   verification) │
                             │            └─────────────────┘
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────────────┐
     │ LangGraph      │ │ MCP      │ │ Supabase Postgres  │
     │ orchestration  │▶│ weather  │ │ + pgvector, RLS on │
     │ 4 agents       │ │ server   │ │ every owned table  │
     └───────┬────────┘ └────┬─────┘ └────────────────────┘
             │               │
             ▼               ▼
    ┌─────────────────┐  ┌────────────┐
    │ OpenRouter      │  │ Open-Meteo │
    │ (routing/prose) │  │ (weather)  │
    └─────────────────┘  └────────────┘
```

One repository, two applications, built and deployed separately. The backend never serves the
frontend's pages; the frontend talks to the backend only through its documented versioned API.

- [`weathra/docs/architecture.md`](weathra/docs/architecture.md) — component boundaries and the dependency rule
- [`weathra/docs/agents.md`](weathra/docs/agents.md) — the graph, the four agents, and why the graph executes tools
- [`weathra/docs/authentication.md`](weathra/docs/authentication.md) — identity, ownership, RLS, and the secret split
- [`weathra/docs/api.md`](weathra/docs/api.md) — every endpoint, its classification, and the SSE event catalogue
- [`weathra/docs/configuration.md`](weathra/docs/configuration.md) — every environment variable for both applications
- [`weathra/docs/mcp.md`](weathra/docs/mcp.md) — the tool catalogue and its error semantics
- [`weathra/docs/rag.md`](weathra/docs/rag.md) — the knowledge corpus, embeddings, and retrieval
- [`weathra/docs/evaluation.md`](weathra/docs/evaluation.md) — the dataset, the ten metrics, and the acceptance gates
- [`weathra/docs/privacy-ethics.md`](weathra/docs/privacy-ethics.md) — data classes, grounding limits, retention, deletion
- [`weathra/docs/deployment.md`](weathra/docs/deployment.md) — topology, environments, and rollback
- [`weathra/docs/roadmap.md`](weathra/docs/roadmap.md) — what is in this MVP and what is deliberately not

## MVP versus post-MVP

**In the MVP.** Email-and-password accounts with verification by code or link; the seven product
screens above; forecast, current, historical, analytics, comparison, and knowledge capabilities; one
weather provider and one geocoder behind provider contracts; one inference gateway behind a
two-method client contract; thread memory and preferences; an evidence record for every agent run;
the ten-metric evaluation suite with seven acceptance thresholds.

**Deliberately not in the MVP.** Enterprise single sign-on, multi-factor authentication,
organizations and roles, API keys and rate limiting; forecast-accuracy scoring; scenario, travel,
watch, and report screens; multi-provider consensus; scheduled snapshot capture; a shared cache;
push notifications. The seams for each exist — a provider contract, a client contract, a cache
wrapper, a vector-store interface — so these are additions rather than rewrites.
[`weathra/docs/roadmap.md`](weathra/docs/roadmap.md) has the full list, and the post-MVP routes exist in the
frontend as pages that say plainly that they are not yet available.

## From clone to a running pair

Everything below runs in a cloud environment or a container. Nothing needs a particular local
machine.

### 1. What you need first

| | Why |
|---|---|
| **A Supabase project** (free tier is enough) | Accounts, email verification, password reset, and the Postgres database with `pgvector` |
| **Python 3.12** | The backend pins `>=3.12,<3.13` |
| **Node 20 or newer** | The frontend targets Node 20+; CI uses 22 |
| **An OpenRouter API key** (optional) | Only the AI Weather Analyst needs it. Everything else works without one |

### 2. Configure Supabase

In the project's dashboard:

1. **Authentication → Providers → Email**: enable email, and require email confirmation.
2. **Authentication → Email Templates**: add the one-time token to the *Confirm signup* and *Reset
   password* templates (`{{ .Token }}`) so Weathra can offer in-app code entry. Keep the link too —
   both paths complete the same verification.
3. **Authentication → URL Configuration**: add `http://localhost:3000` as a redirect URL for local
   work, and your deployed frontend origin.
4. **Database → Roles**: the migrations create the restricted `weathra_request` role the API runs
   as. Note the connection strings for both the pooled request connection and the direct privileged
   one.

[`weathra/docs/authentication.md`](weathra/docs/authentication.md) explains what each of these settings is load-bearing
for, and [`weathra/docs/deployment.md`](weathra/docs/deployment.md) records the values per environment.

### 3. The backend

```bash
cd weathra/backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env          # then fill in SUPABASE_URL and the two database URLs
```

Apply the schema with the **privileged** connection — migrations create tables, roles, and Row
Level Security policies, which the restricted request role deliberately cannot do:

```bash
WEATHRA_RUNTIME_MODE=privileged alembic upgrade head
WEATHRA_RUNTIME_MODE=privileged weathra-ingest-corpus
```

Then serve it:

```bash
uvicorn weathra.api.app:create_app --factory --reload
```

`http://localhost:8000/api/v1/health` answers immediately;
`http://localhost:8000/api/v1/ready` reports each dependency's configuration and reachability;
`http://localhost:8000/api/v1/docs` is the interactive API reference.

### 4. The frontend

```bash
cd weathra/frontend
npm ci
cp .env.example .env.local     # the Supabase URL, its public key, and the backend base URL
npm run dev
```

Open `http://localhost:3000`, create an account, and enter the code from the verification email.
You are in the product.

Everything in `weathra/frontend/.env.local` is public by design and ships in the browser bundle. The
service-role key, the database URLs, and the inference key are backend secrets and must never
appear there under any name — `npm run check:secrets` asserts exactly that, against the environment
files, the source, and the built bundle, and CI runs it on every pull request.

### 5. Verifying your setup

```bash
# backend — no network, no database, no credentials needed
cd weathra/backend && pytest

# backend — against a real Postgres with pgvector
WEATHRA_TEST_DATABASE_URL=postgresql://... pytest -m db

# the offline acceptance run: 40 cases, ten metrics, seven gates
weathra-evaluate

# frontend
cd ../frontend && npm run lint && npm run typecheck && npm test && npm run build
```

The default test suite reaches nothing external: weather payloads are replayed from recorded
Open-Meteo responses, tokens are minted locally against a test key pair, embeddings come from a
deterministic hashing model, and the MCP server runs in-process. That is why it can gate every pull
request. [`weathra/docs/evaluation.md`](weathra/docs/evaluation.md) explains what offline mode does and does not
measure.

## Repository layout

The application lives in one top-level project directory. Only what belongs to the repository
itself sits above it — the CI workflows GitHub Actions can discover nowhere else, the licence, the
README you are reading, and .gitignore.

```
.github/workflows/   CI for each application, at the root because Actions looks only here
weathra/             The application
  backend/           FastAPI application, LangGraph orchestration, MCP server, analytics, RAG, evaluation
  frontend/          Next.js application
  docs/              Architecture, API, configuration, evaluation, privacy, deployment, design artifacts
  openspec/          The specification-driven change this system was built from
.gitignore
LICENSE
README.md
```

Paths inside `weathra/docs/` and `weathra/openspec/` are relative to `weathra/`, since those
documents sit beside the applications they describe.

## Running it in production

Weathra is deployed, and the deployment is part of the design rather than an afterthought. Five
hosted services, each doing one thing, and no step that needs a particular computer:

| | What it holds | How it is reached |
|---|---|---|
| **GitHub Codespaces** | the development environment | Both applications run inside it; nothing needs installing on a laptop |
| **GitHub Actions** | every production credential | The only route to production. `release.yml` migrates and releases the backend; `frontend-release.yml` builds and promotes the frontend; `database-retention.yml` removes expired data on a schedule |
| **Vercel** | the Next.js frontend | Built *on the runner* and promoted with `--prebuilt`, so what is live is what the commit built. The three `NEXT_PUBLIC_` values are the only configuration it holds |
| **Render** | the FastAPI backend, as a container | Deployed with the request-serving database connection only. The privileged connection never reaches it |
| **Supabase** | accounts and Postgres with `pgvector` | Auth, the user-owned tables under Row Level Security, and the vector index |
| **Open-Meteo** | weather and geocoding | No credential. Every figure Weathra reports names it |
| **OpenRouter** | the language model | Optional. Without it every deterministic capability still works and the Analyst says why it cannot answer |

Auto-deploy is **off** on both platforms — `autoDeployTrigger: "off"` in `render.yaml`,
`git.deploymentEnabled.main: false` in `frontend/vercel.json` — so a push to `main` never releases
anything by itself. The workflows are the only route, which is what makes "migrations applied before
the new release serves traffic" a property of the system rather than of timing.

Setting it up yourself means creating the four accounts above, adding the repository secrets
[`docs/deployment.md`](weathra/docs/deployment.md) lists, and dispatching the two release workflows.
That document is the operational reference: what each secret is for, what each workflow may and may
not do, and how each environment is verified.

### Verifying a deployment

Three commands, none of which need a credential:

```bash
# the backend answers, and names every dependency it depends on
curl https://<backend>/api/v1/health
curl https://<backend>/api/v1/ready

# the frontend serves, and the route gate redirects an unauthenticated visitor
curl -i https://<frontend>/sign-in
```

For the whole deployed pair at once, the acceptance suite checks it from outside — the pages that
render, the routes that redirect with their destination kept, readiness, the public weather surfaces
and their attribution, the CORS answer a browser actually receives, and every protected endpoint
refusing every shape of invalid token:

```bash
cd weathra/backend
SUPABASE_URL=https://placeholder.supabase.co pytest -m deployed
```

It writes nothing: the checks run through a client that refuses any method but `GET`, `HEAD` and
`OPTIONS`. The handful of checks that need a real session skip unless deployed-account credentials
are configured, and say which are missing.

## Licence

MIT. See [LICENSE](LICENSE).
