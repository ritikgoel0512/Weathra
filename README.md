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
| **Natural-language weather analysis** | Free-text questions answered in prose, with the routing, agents, and tool calls streaming as they happen |
| **Forecast analysis** | Current conditions, forecast movement, anomalies, a selectable horizon, every hourly entry the provider returned, and the confidence the forecast itself carries with its stated basis |
| **Historical analytics** | Archive retrieval, period-over-period comparison, and comparison against a multi-year baseline |
| **Multi-location comparison** | Several locations ranked on a criterion you choose, with the values behind each rank and the reason any candidate was excluded |
| **Evidence and provenance** | The full record of a run: agents, tool calls and results, analytics methods, cited knowledge, timings — and a list of the runs you own |
| **Scenario simulation** | Hypothetical conditions explored deterministically, with the unmodified baseline stated beside every adjusted figure |
| **Scheduled weather watch** | A condition you ask Weathra to check at a place, evaluated on a schedule, with each reading and outcome recorded and surfaced on a dashboard |
| **Travel intelligence** | Weather intelligence for a destination across your trip dates |
| **Saved locations** | Your places, resolved once and reused, with a weather overview across them |
| **Settings and preferences** | Unit system, default horizon, memory controls, and deletion of your data |
| **Plan and usage** | Your tier, your allowances, what you have consumed, when each window resets — and self-service tier selection |
| **Memory** | Conversation context within a thread, and durable preferences across sessions |

Weather data comes from [Open-Meteo](https://open-meteo.com). Weathra is not a forecaster and never
issues warnings: for severe weather it refers you to your official national meteorological service.

## Key product capabilities — the shipped screens

All thirteen are built and deployed.

| Screen | What it is for |
|---|---|
| **Dashboard** | The briefing: current conditions, forecast movement, anomalies, historical context, and what changed since last time |
| **AI Weather Analyst** | Ask anything in free text; watch the agents work |
| **Historical Analytics** | The archive, period comparison, and baseline comparison |
| **Compare Cities** | Several places ranked on one criterion |
| **Agent Evidence** | Which agents ran, which tools were called, and which figures the answer rests on |
| **Forecast Explorer** | Deep hourly and per-measure exploration beyond the Dashboard |
| **Weather Intelligence Report** | A composed report over a location and window |
| **Weather Scenario Lab** | Hypothetical conditions and their implications, against a stated baseline |
| **Weather Watch** | Conditions monitored at a place, on a schedule |
| **Travel Intelligence** | A destination across trip dates |
| **Saved Locations** | Your places, and the weather across them |
| **Settings** | Units, horizon, memory, account and data deletion |
| **Plan & Usage** | Your plan, allowances, consumption, resets, and tier selection |

One administrative screen exists in part: **Admin Model & AI Usage** carries the model policy
confirmation surface — each policy's ordered candidate list with the evaluation recorded per
candidate, and one audited write citing the runs relied upon. Its model-status, token-usage, cost,
latency, error and plan-usage panels are not built, and the route says so of itself rather than
fetching anything.

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

## AI and the grounding model

The division of labour is the point of the system, so it is worth stating plainly:

- **Weather observations and forecasts come from providers.** Open-Meteo supplies current
  conditions, forecasts and the historical archive; its geocoder resolves place names. Weathra does
  not model weather and does not forecast.
- **Deterministic analytics are computed by Weathra.** Anomalies, period comparisons, baseline
  comparisons, rankings and scenario adjustments are Python and numpy. The same inputs give the same
  figures every time, with no model involved.
- **The language model explains; it does not measure.** It routes a question to the right agents and
  writes prose from findings it is handed. It is never the thing that calculates, and a figure in an
  answer that does not trace back to retrieved or computed data is caught by a grounding audit and
  reported rather than shown.
- **Agent Evidence records the provenance.** Every run keeps which agents ran, which tools were
  called with what arguments, what came back, which analytics methods were used, which knowledge was
  cited, and how long each step took. It is readable only by the account that produced it.

Five data classes — current conditions, forecast, historical observation, computed statistic, and AI
interpretation — are labelled wherever they appear, each with its provider, location, period and
retrieval time.

## Memory

Two tiers, deliberately separate:

- **Short-term conversational memory** — thread-scoped state held by the orchestrator's
  checkpointing, so a follow-up question means something. Scoped to the pair of the authenticated
  user and the thread, and it survives a restart.
- **Long-term preference memory** — your unit system, default horizon and saved locations. Durable,
  owner-scoped, and the thing that makes a briefing yours rather than generic.

Both are yours. Settings exposes them, deleting your data removes them, and a retention routine
clears thread state on its own schedule. Usage records hold no conversation content at all.

## Plan model

Three tiers — **Free**, **Pro** and **Premium** — and, since the product decision of 2026-09-13,
**you choose your own**. Selecting a tier is one press in Plan & Usage, takes effect immediately,
and is reversible in either direction.

**Nothing is charged, because nothing bills.** There is no checkout, no card handling, no invoice,
no subscription record and no published price. A tier controls what you are allowed and which class
of model answers you — selectable is not purchasable. Changing tier resets no counter and deletes
no history: consumption already counted in a window stays counted, and if you move to a smaller tier
while over its allowance you are told you are over it rather than quietly forgiven.

What a tier controls:

| Allowance | Free | Pro | Premium |
|---|---|---|---|
| Requests per day | 25 | 250 | 1,000 |
| Requests per month | 300 | 4,000 | 20,000 |
| Token budget per month | 500,000 | 8,000,000 | 40,000,000 |
| Concurrent AI tasks | 1 | 3 | 6 |

And which class of model answers: **Economy**, **Standard** or **Frontier**. Those classes are
resolved from the catalog by the backend — plan to policy to catalog entry, three rows deep — and no
gateway model identifier is exposed to the frontend. Administrative assignment still governs another
principal's tier and every allowance; a person may change only their own.

## Security and ownership

- **Authentication** is Supabase Auth: email and password, with mandatory email verification by code
  or link. The frontend holds a cookie session and forwards the access token to FastAPI as a bearer
  token; the backend validates it against the issuer's signing keys.
- **Every protected route is owner-scoped by construction.** The routes that serve your own data
  take *no subject parameter* — the subject comes from the validated token. A caller who supplies
  somebody else's identifier in a query string, body or header is answered about themselves, because
  the identifier was never read. There is nothing to spoof.
- **Row Level Security is the second gate, in the database.** User-owned tables carry owner policies
  tested against the same `weathra_current_user_id()` accessor, and the request-serving role
  connects as a restricted login that RLS applies to. A query that asked for another person's rows
  would return none regardless of what the endpoint intended.
- **Writes are refused by the database, not only by Python.** Choosing your own plan, for instance,
  is granted to the request role with `WITH CHECK (user_id = weathra_current_user_id())` on both
  INSERT and UPDATE, so a request shaped to name somebody else writes nothing rather than writing
  their row. Cross-account mutation is not a bug that can be written.
- **Cross-account isolation is asserted, not assumed.** A parameterised boundary suite runs every
  protected route three ways — no token, a valid token, and acting as its subject — and a coverage
  test fails if a protected route is added without being added to it.
- **One administrative role, held as backend state**, never granted by a client-supplied field. Lab,
  catalog, policy and plan-assignment endpoints refuse every caller without it, and each
  administrative write records an audit row naming the acting principal and the before and after.
- **Secrets stay server-side.** The browser receives only the Supabase URL, the publishable key, and
  the backend base URL. A containment test asserts no service-role key, database URL or gateway
  credential reaches the bundle.

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

## Testing

Counts are from the verified runs of 2026-09-14 at commit `ecf0d9d`, not from memory.

| Suite | How it runs | Result |
|---|---|---|
| **Backend, offline** | `pytest` — no network, no database, no credentials | **2,786 passed, 1 skipped** |
| **Backend, database-backed** | `pytest -m db` against Postgres 16 with pgvector | **1,230 passed** |
| **Frontend** | `npm test` (Vitest), 97 files | **1,852 passed** |
| **Accessibility, automated** | Vitest a11y + design-rule suites, two engines | **59 passed**, plus 25 Playwright a11y cases |
| **Architecture / vendor coupling** | `tests/unit/test_no_vendor_coupling.py` | **passed** — no vendor SDK or model name in the backend outside one configuration default |
| **Documentation and traceability** | `tests/test_documentation.py` | **passed** — every requirement maps to a test, every route documented with its access |
| **Deployed, credential-free** | `pytest -m deployed` against the live pair | **102 passed, 53 skipped** — every protected route refuses an anonymous caller in production. The 53 skips each name the deployed-account credential they need rather than passing vacuously |
| **OpenSpec** | `openspec validate --all --strict` | **passed** |
| **Type and lint gates** | `ruff check`, `ruff format --check`, `mypy` (314 files), `tsc --noEmit`, `eslint` | **all clean** |

Nine GitHub Actions workflows gate the repository — backend, frontend, their two release pipelines,
allowed-origin, database identity, database retention, weather-watch evaluation, and live
acceptance. The backend workflow runs lint, types, the offline suite, migrations against an
ephemeral pgvector service, the database-backed suite, a migration downgrade-and-replay check, and
the offline acceptance run, in that order.

## Environment variables

**Names only. No value belongs in this file, in the repository, or in a commit.** Both applications
ship a `.env.example` listing every setting with its default;
[`weathra/docs/configuration.md`](weathra/docs/configuration.md) documents each one with its
classification, and a test asserts the two stay in step.

**Frontend** — public by definition, since the browser receives them:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_BASE_URL
```

**Backend** — the ones you must set. The four marked **secret** are server-side only and never reach
the browser:

```
SUPABASE_URL
SUPABASE_JWT_ISSUER
SUPABASE_JWT_AUDIENCE
SUPABASE_JWKS_URL
SUPABASE_SERVICE_ROLE_KEY        secret
DATABASE_URL                     secret
DATABASE_URL_PRIVILEGED          secret
OPENROUTER_API_KEY               secret
WEATHRA_ENVIRONMENT
WEATHRA_RUNTIME_MODE
CORS_ALLOWED_ORIGINS
```

Around sixty further settings carry working defaults and are only worth touching deliberately —
agent step and wall-clock budgets, HTTP and LLM timeouts and retry policy, cache TTLs, RAG chunking
and retrieval thresholds, quota windows, model-lab bounds, retention periods, and the MCP transport.
`.env.example` and `configuration.md` list them all.

The backend must start and serve every public capability with `OPENROUTER_API_KEY` absent, degrading
only the agent paths. Model selection is deliberately *not* configuration beyond `LLM_MODEL` as a
development and administrative fallback: policies, plan mappings and the catalog live in the
database so they change without a redeployment.

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

## OpenSpec

Weathra was built specification-first. [`weathra/openspec/`](weathra/openspec/) holds the change
this system was produced from — `proposal.md` for what and why, `design.md` for the decisions and
their trade-offs, `specs/` for the requirements as testable scenarios, and `tasks.md` for the
numbered work.

- **Active change:** `weathra-mvp`, **not archived**.
- **Task status:** 308 numbered tasks — **305 complete, 3 partially complete**, none unstarted.
- **The three that remain are operational acceptance and evidence tasks, not missing product
  implementation:**

| Task | What is done | What remains |
|---|---|---|
| **21.8** — accessibility and responsiveness | The automated half, on two engines: reachability, tab order, focus, contrast, 360-pixel fit, no horizontal scroll, WCAG 2.0/2.1 A and AA and 2.2 AA by rule | A screen-reader pass, a keyboard walkthrough beyond the authentication screens, and a physical-handset pass. All three need a human at a real device with real assistive technology |
| **34.5** — model comparison and promotion | Two live comparisons recorded. Run `c1e8768f` (2026-09-14) evidenced **both** seeded economy candidates over five cases with all five criteria, both passing both gating criteria and none unevidenced | The audited promotion write citing that run, which needs a session for the administrative principal |
| **34.7** — SaaS-layer deployed acceptance | The credential-free half: every protected route, including the newly covered ones, verified refusing an anonymous caller against the live backend | The half needing real accounts — a user, a second user for isolation, and an administrator — none of whose credentials exist in the development environment |

Validation is green: `openspec validate --all --strict` passes, and the documentation tests assert
that every requirement has a traceability row and at least one test.

## Development workflow

1. **OpenSpec first.** A change is proposed, designed, and written as requirements with testable
   scenarios before code. Requirements are amended when the product decision changes rather than
   left disagreeing with the product.
2. **UX design gate.** Every screen is designed in Visily and approved before substantial
   implementation, against the shared Weathra design system, with a recorded reason for any
   deliberate divergence. [`weathra/docs/design/`](weathra/docs/design/) holds the artifacts and reviews.
3. **Implementation** against the approved artifact and the written scenarios.
4. **Tests** as the requirements' evidence — unit, integration, database-backed, boundary,
   accessibility, architecture, and documentation traceability.
5. **CI and release.** Every pull request runs the gates above; merges to `main` deploy the backend
   to Render and the frontend to Vercel through their release workflows.

## Limitations

Stated plainly, because a weather product that overstates itself is worse than one that does less.

- **Weathra is not an official severe-weather warning system.** It does not issue warnings, and for
  severe weather it refers you to your national meteorological service. Do not rely on it for
  safety-of-life decisions.
- **One weather provider.** Everything comes from Open-Meteo, so its coverage, resolution, archive
  depth and outages are Weathra's. The confidence signal is derived from a single provider's own
  spread and horizon distance — a bounded signal, and stated as one. There is no multi-provider
  consensus.
- **The AI explains; it does not know.** The language model writes prose from computed findings. It
  can still phrase something poorly or emphasise the wrong thing, and its interpretation is labelled
  as interpretation so you can tell it from a measurement.
- **Forecast-accuracy scoring is not implemented.** Weathra retrieves historical weather; it does
  not yet score how good its past forecasts turned out to be.
- **Weather Watch reports; it does not notify.** Watches are evaluated on a schedule and surfaced in
  the product. There is no push or email delivery.
- **No billing.** Tiers control allowances and model class. There is no payment processing, no
  published price, and nothing is charged.
- **Three operational acceptance tasks remain open** — the manual accessibility passes, the audited
  model promotion, and the credentialed half of the deployed SaaS acceptance. Each is named above
  with its exact prerequisite.

## Status

**Production deployed.** The backend runs on Render and the frontend on Vercel, both from `main`,
both verified live.

- **All thirteen product screens are built and shipping**, plus the administrative model policy
  confirmation surface. The remaining administrative panels are unbuilt and say so.
- **CI is green** on the current commit across every applicable workflow.
- **305 of 308 OpenSpec tasks are complete.** The three open ones are operational acceptance and
  evidence tasks — a human-driven accessibility pass, an audited model promotion, and the
  credentialed deployed acceptance run — rather than missing product implementation.
- **OpenSpec is not archived**, and should not be until those three close.

## Licence

MIT. See [LICENSE](LICENSE).
