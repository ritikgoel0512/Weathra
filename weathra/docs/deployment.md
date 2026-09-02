# Deployment

Two applications, deployed separately, to platforms suited to each. Nothing in the setup, test, or
deploy path requires a particular local machine: development is browser-based against the hosted
Supabase instance, and every automated step runs on a hosted runner.

> **Status.** The workflows and configuration described in this document are the target topology.
> The pull-request CI workflows for both applications exist and run
> ([`../../.github/workflows/`](../../.github/workflows)); the deploy workflows, the Supabase project
> configuration, and the secret storage are tasks 23.2–23.7 of the `weathra-mvp` change and require
> the cloud accounts to be provisioned. Anything below marked *(pending)* is not yet in place.

## Topology

| Component | Target | Why |
|---|---|---|
| Next.js frontend | Cloudflare | Static shell plus edge delivery; no server of our own to run |
| FastAPI + LangGraph + MCP + analytics | Google Cloud Run (container) | One container, scales to zero, supports streaming responses |
| Identity, verification, password reset | Supabase Auth | Weathra implements no credential handling |
| Postgres + pgvector + memory | Supabase | The database and the vector index are one service |
| Weather data | Open-Meteo | Keyless, no attribution key to leak |
| Inference | OpenRouter | One gateway, model chosen by configuration |
| CI/CD | GitHub Actions | Where the repository already is |

```
   Cloudflare ────────▶ Cloud Run ────────▶ Supabase (Postgres + pgvector)
   (frontend)   bearer  (backend)   pooler         │
        │        token       │                     │
        └── Supabase Auth ───┴──▶ Open-Meteo, OpenRouter
```

## Environments

| | Frontend | Backend | Database |
|---|---|---|---|
| **Local** | `npm run dev` on :3000, `frontend/.env.local` | `uvicorn --reload` on :8000, `backend/.env` | The hosted Supabase project, or a `pgvector/pgvector:pg16` container for `db`-marked tests |
| **CI** | built with public placeholders | offline suite, then the `db` suite against a Postgres service container | ephemeral service container |
| **Production** *(pending)* | Cloudflare, public configuration per environment | Cloud Run, secrets injected | Supabase, pooler connection |

Each environment needs its own Supabase redirect URL registered, and its own
`NEXT_PUBLIC_API_BASE_URL` pointing at the backend that belongs to it. Everything else the frontend
reads is the same in every environment because all of it is public.

## Required Supabase configuration

This is configuration the application *depends on*, so it is recorded here rather than left as
undocumented console state. A project missing any of it fails in a way that looks like a bug in
Weathra.

| Setting | Value | Why it is load-bearing |
|---|---|---|
| Authentication → Email provider | enabled | The only sign-in method in the MVP |
| Confirm email | **required** | `signUp` then returns no session until confirmation, which is what makes an unverified account structurally unable to reach protected features |
| *Confirm signup* email template | includes `{{ .Token }}` | Without the token in the email there is no code to enter, and in-app code entry is a requirement |
| *Reset password* email template | includes `{{ .Token }}` | Same, for recovery |
| Redirect URLs | each environment's frontend origin | The returning-link path lands on `/auth/*`, which must be an allowed redirect |
| Access-token lifetime | above `AGENT_WALL_CLOCK_BUDGET_SECONDS` | The stream validates its token once at the start; the agent budget bounds how long the run may continue. A token shorter than the budget reintroduces mid-run expiry |
| Database → `pgvector` | enabled | The migration enables the extension; the image must support it |
| Connection | pooler for `DATABASE_URL`, direct for `DATABASE_URL_PRIVILEGED` | The request path wants pooled connections; migrations want a direct one |

The restricted `weathra_request` role is created by migration `0002_row_level_security` rather than
by hand, so it cannot be forgotten in a new environment.

## Secrets

| Secret | Held in | Used by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secrets, Cloud Run secrets | Migrations, retention, evaluation provisioning — never a request path |
| `DATABASE_URL` | Cloud Run secrets | The API and stream processes, under the restricted role |
| `DATABASE_URL_PRIVILEGED` | GitHub Actions secrets, Cloud Run secrets | Migrations and administrative routines |
| `OPENROUTER_API_KEY` | Cloud Run secrets | `/ask` and `/stream` only |

None of these reaches the frontend, and none appears in a pull-request workflow: CI holds **no
credential at all**, which is why the default suite and the offline evaluation run reach nothing
external. The frontend's configuration is public in its entirety, and CI asserts that the four
secrets appear in neither its environment nor its built bundle (`npm run check:secrets`).

## The pipelines

### On every pull request

Two workflows, one per application, each triggered only by changes to its own paths — a frontend
change does not wait for a database to start.

**`backend.yml`** — `ruff check`, `ruff format --check`, `mypy`, the offline `pytest` suite, then
against a `pgvector/pgvector:pg16` service container: `alembic upgrade head` under the privileged
connection, `pytest -m db`, a down-and-up migration cycle to prove the migrations reverse, and the
**offline evaluation run**, which exits non-zero on a missed threshold and whose run record is
archived either way.

**`frontend.yml`** — `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
then the secret-containment check. The check runs *after* the build deliberately: Next.js inlines
`NEXT_PUBLIC_` values at build time, so the bundle is the only place that shows what a browser
actually receives, and a check that ran first would inspect a directory that does not exist and pass.

### On merge to `main` *(pending)*

1. Build the backend container and push it.
2. **Apply migrations as a release step, under the privileged connection, before the new revision
   takes traffic.** The order matters: a revision serving requests against a schema it expects to
   have been migrated is the failure this step exists to prevent.
3. Deploy the Cloud Run revision.
4. Deploy the frontend to Cloudflare with that environment's public configuration.

### On a schedule *(pending)*

`weathra-retention`, under the privileged connection, against `THREAD_RETENTION_DAYS` and
`SNAPSHOT_RETENTION_DAYS`. It refuses to run in anything but `WEATHRA_RUNTIME_MODE=privileged`, so a
misconfigured invocation fails rather than silently doing nothing.

## Cloud Run settings that matter

**Minimum instances ≥ 1.** LangGraph, SQLAlchemy, and the ONNX embedding runtime are all slow to
import, so a cold start is felt on the first request. The embedding model also loads lazily on first
RAG use, and the agent path streams progress so the wait is visible rather than blank — but the
honest fix for cold starts is not scaling to zero.

**Request timeout above `AGENT_WALL_CLOCK_BUDGET_SECONDS`.** The budget, not the platform, must be
what ends a long run — otherwise a stream dies without its terminal event and a client cannot tell
whether the answer was complete.

**A small connection pool.** `DATABASE_POOL_SIZE` is 5 by default. Supabase's connection limits bind
long before application throughput does, and each horizontally-scaled instance holds its own pool;
pool size is a deployment setting rather than a code constant for exactly this reason. Connect
through the pooler.

## Verifying a deployment

```bash
curl https://<backend>/api/v1/health     # answers immediately, depends on nothing
curl https://<backend>/api/v1/ready      # every dependency, configured and reachable
```

`/ready` reports `database`, `weather_provider`, `vector_store`, `mcp_server`,
`authentication_provider`, and `inference_provider` by name. It names what is missing and never a
credential value. An unconfigured inference credential shows the agent surface unavailable while
everything else stays ready — the same distinction the product makes on screen.

Then the smoke path: create an account, verify it by code, sign in, request an attributed public
forecast without a session, ask a question through `/ask` and check that every figure in the answer
appears in its evidence, open an authenticated stream and see it complete, and confirm a second
account sees none of the first's data.

## Rollback

**The backend.** Cloud Run keeps revisions; rolling back is redirecting traffic to the previous
one. The constraint is the schema: a rollback across a migration is only safe if the migration was
backwards-compatible, so migrations are written additively — a column is added and populated before
anything reads it, and a drop happens a release after the code that used it is gone. The migrations
are verified to downgrade cleanly in CI (`alembic downgrade base` then back up), which is what makes
`alembic downgrade -1` a real option rather than a hope.

**The frontend.** Cloudflare keeps deployments; rolling back is promoting the previous one. The
frontend holds no schema, so its rollback is unconditional.

**Order.** Roll the frontend back first when the two are incompatible: an older frontend against a
newer backend is the pairing the API's additive-change discipline is designed to survive.

## The no-local-machine requirement

Every path — setup, sign-up, test, deploy — is intended to be completable from a browser-based cloud
environment against the hosted Supabase project. The CI workflows assert their half of it: both run
on hosted `ubuntu-` runners, and a test rejects any step that reaches for a local install, a local
Postgres, or a home directory. The end-to-end confirmation from a browser environment is task 23.7
and will be recorded here when the cloud accounts are provisioned.
