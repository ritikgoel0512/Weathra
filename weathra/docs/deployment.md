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
| Next.js frontend | Vercel | Next.js's own platform; the framework's build output needs no adapter |
| FastAPI + LangGraph + MCP + analytics | Render (container) | One container, deploys from this repository, supports streaming responses |
| Identity, verification, password reset | Supabase Auth | Weathra implements no credential handling |
| Postgres + pgvector + memory | Supabase | The database and the vector index are one service |
| Weather data | Open-Meteo | Keyless, no attribution key to leak |
| Inference | OpenRouter | One gateway, model chosen by configuration |
| Source control and CI/CD | GitHub | Where the repository already is; both runtimes deploy from it |

```
   Vercel ────────────▶ Render ──────────▶ Supabase (Postgres + pgvector)
   (frontend)   bearer  (backend)  pooler         │
        │        token       │                    │
        └── Supabase Auth ───┴──▶ Open-Meteo, OpenRouter
```

> **A superseded decision, recorded rather than erased.** Cloudflare and Google Cloud Run were named
> here first, with secrets in Google Cloud Secret Manager injected through a Cloud Run service
> account. Both are withdrawn, and neither appears anywhere in this repository as a requirement any
> more. Nothing had been built against them — no Dockerfile, no deploy workflow, no infrastructure
> definition — so the change cost prose and task wording only. The properties that motivated them are
> unchanged and are what Vercel and Render are being held to below.

## Environments

| | Frontend | Backend | Database |
|---|---|---|---|
| **Local** | `npm run dev` on :3000, `frontend/.env.local` | `uvicorn --reload` on :8000, `backend/.env` | The hosted Supabase project, or a `pgvector/pgvector:pg16` container for `db`-marked tests |
| **CI** | built with public placeholders | offline suite, then the `db` suite against a Postgres service container | ephemeral service container |
| **Production** *(pending)* | Vercel, public configuration per environment | Render, secrets injected | Supabase, pooler connection |

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
| Minimum password length | **12** | Mirrors the rule the Create Account screen states before submission (`frontend/lib/auth/password.ts`). A project configured stricter than the stated rules produces a password rejected *after* submission, which is what `specs/authentication` forbids |
| *Confirm signup* email template | includes `{{ .Token }}` | Without the token in the email there is no code to enter, and in-app code entry is a requirement |
| *Reset password* email template | includes `{{ .Token }}` | Same, for recovery |
| Email OTP Length | **6** | Mirrors the length the Verify Email screen states and validates (`VERIFICATION_CODE_LENGTH`, `frontend/lib/auth/verification.ts`). A project configured longer delivers a token the screen truncates before submitting, so a *correct* code is refused as an incorrect one — observed against this project at length 8 and corrected to 6 (§ *Verified against the project*) |
| Email OTP Expiration | **3600 s** (1 hour) | Mirrors `VERIFICATION_CODE_LIFETIME_MS` (`frontend/lib/auth/verification.ts`), which the Verify Email screen uses to tell an expired code apart from an incorrect one. GoTrue answers both with the same refusal, so a project configured differently makes that split report the wrong state |
| Redirect URLs | each environment's frontend origin | The returning-link path lands on `/auth/*`, which must be an allowed redirect |
| Access-token lifetime | above `AGENT_WALL_CLOCK_BUDGET_SECONDS` | The stream validates its token once at the start; the agent budget bounds how long the run may continue. A token shorter than the budget reintroduces mid-run expiry |
| Database → `pgvector` | enabled | The migration enables the extension; the image must support it |
| Connection | pooler in **session** mode (5432) for `DATABASE_URL`, direct for `DATABASE_URL_PRIVILEGED` | The request path wants pooled connections; migrations want a direct one. Not transaction mode (6543): it does not support prepared statements, which the asyncpg engine and the checkpointer's own pool both rely on |

Both database roles are created by migration rather than by hand, so neither can be forgotten in a
new environment: the restricted `weathra_request` by `0002_row_level_security`, and the login role
`weathra_api` that `DATABASE_URL` authenticates as by `0003_request_login_role`. See
[`authentication.md`](authentication.md) for why there are three roles across two connections.

Two properties of a managed Postgres are worth knowing before the first migration, because both
were discovered the hard way and neither reproduces on a stock PostgreSQL:

- **The migration role is not a superuser.** Supabase's `postgres` holds `CREATEROLE`, `CREATEDB`
  and `BYPASSRLS`, and neither `SUPERUSER` nor `REPLICATION`. PostgreSQL lets a role change those
  four attributes on another role only if it holds the attribute itself, in either direction — so
  an `ALTER ROLE … NOSUPERUSER` is refused even though it asks for the value the role already has.
  Migration `0003` chooses its clauses from what the current role may change and then verifies the
  result, so it applies as a superuser and as a managed platform's owner alike.
- **The platform may enable Row Level Security for you.** An `ensure_rls` event trigger enables RLS
  on every table created in `public`. A `GRANT` does not survive that: RLS with no applicable policy
  denies every row to a role that is neither table owner nor `BYPASSRLS`, so a grant that reads
  correctly in the catalog reaches nothing. Migration `0004_shared_read_policies` gives the three
  shared tables explicit `weathra_request`-scoped policies for exactly the operations the request
  path performs. Weathra keeps RLS on rather than disabling it —
  [`authentication.md`](authentication.md) explains why, and why the policies name no other role.

The second point applies to the LangGraph checkpoint tables too, and they are not covered by any
migration: the library creates them, so `ensure_checkpoint_schema()` is what enables Row Level
Security on them, writes the owner-restricting policies, and grants the restricted role. Run it
after the migrations — it needs `weathra_current_user_id()` from `0002` and refuses to proceed
without it — and treat a failure as a failed deploy rather than a warning: it raises instead of
reporting memory ready over tables nothing can reach. Re-running is safe and changes nothing.

### Provisioning the `weathra_api` credential

Migration `0003` creates `weathra_api` with **no password**, so under SCRAM the role cannot
authenticate until one is set. This is deliberate: a migration is committed source, and a committed
credential is a leaked credential. Role structure belongs to the migration; the credential belongs
to the deployment.

Once, per environment, after migrations have been applied:

1. Generate a strong password locally. Do not echo it into a shell history, a log, or a commit.
2. Under the privileged connection — the Supabase SQL Editor, or `psql` with
   `DATABASE_URL_PRIVILEGED` — run `ALTER ROLE weathra_api PASSWORD '<generated>';`
3. Assemble `DATABASE_URL` from it, against the **session-mode pooler** with the username form
   `weathra_api.<project-ref>` (Supabase requires the project reference on a pooler username, for
   custom roles as well as for `postgres`).
4. Store it where that environment keeps secrets — `backend/.env` for local and Codespaces
   development (gitignored), and secret storage for CI and the Render service under task 23.3.

Rotation is the same `ALTER ROLE` plus a secret update. No migration re-runs, and no schema changes.
Re-running `0003` after provisioning is safe: it asserts the role's attributes with `ALTER ROLE`,
which does not disturb an existing password.

### Verified against the project

Task 23.2 asks that the documented configuration above match the real project, and that a real
sign-up deliver a usable code. This records that verification. No address, code, credential or
personal value from the test is recorded here or anywhere in the repository — the evidence is the
configuration state and the observed outcome, which is what a later reader needs.

**Date:** 2026-09-05. **Method:** the real hosted Supabase project with custom SMTP (Brevo), the
real Next.js frontend served from Google Cloud Shell Web Preview on `:3000`, a real address the
tester controls. No mock, stub, fixture, fake identity provider or automated test stood in for any
part of it. The FastAPI backend was deliberately not running: the flow under test is Supabase Auth
only, and the frontend reaches the backend only after the authenticated shell is entered.

| Setting | How it was verified | Result |
|---|---|---|
| Email provider enabled | `GET /auth/v1/settings` | `email: true` |
| Sign-ups permitted | `GET /auth/v1/settings` | `disable_signup: false` |
| Confirm email required | `GET /auth/v1/settings` | `mailer_autoconfirm: false` — so `signUp` returns no session and confirmation is structurally unavoidable |
| Custom SMTP | enabled in the project (Brevo), and a real email was delivered through it | enabled and delivering. The credentials live in the Supabase project only — they are deliberately absent from this repository and from both applications' environments |
| *Confirm signup* template carries `{{ .Token }}` | the delivered email carried a numeric code | confirmed |
| *Reset password* template carries `{{ .Token }}` | template saved in the dashboard | configured; not exercised end to end |
| Minimum password length = 12 | set in the project on 2026-09-05 | matches `PASSWORD_MINIMUM_LENGTH` (`frontend/lib/auth/password.ts`), the rule the Create Account screen states before submission, so the project can no longer refuse a password the screen accepted |
| Email OTP Length = 6 | see the defect below | corrected, then confirmed by a delivered 6-digit code |
| Real sign-up delivers a usable code | the full flow, below | passed |
| Access-token lifetime | read back from the project | 3600 s — thirty times above `AGENT_WALL_CLOCK_BUDGET_SECONDS` (120 s), so a stream cannot outlive the token it validated at the start |
| Email OTP Expiration | read back from the project | 3600 s (1 hour) — matches `VERIFICATION_CODE_LIFETIME_MS`, so the screen's expired-versus-incorrect split reports the state the provider actually means |
| `pgvector` availability | dashboard extension list | `vector` 0.8.2 available, left OFF so migration `0001` performs the enable |

**The flow that passed.** Create Account on the running frontend → Supabase accepted the sign-up and
issued no session → Brevo delivered the *Confirm signup* email → the email carried a six-digit code
→ the code was entered into Weathra's own Verify Email screen, which called `verifyOtp` → Supabase
accepted it → the screen showed its verified state ("Email verified — Your address is confirmed and
you are signed in") → *Continue to Weathra* entered the authenticated application shell. The
Dashboard's data surfaces showed their backend-unreachable error state, which is the correct
degradation for a run with no backend and is itself evidence that the session was real: the shell
renders only for a session the server resolved against Supabase.

**A defect this verification found.** The project was initially configured with **Email OTP Length
8**, while the Verify Email screen states and validates six digits. The screen truncated the
delivered eight-digit token to its first six characters, submitted those, and reported the
provider's refusal as *"That code is not right."* — a correct code refused as an incorrect one, with
nothing on screen indicating that two digits had been dropped. The project was set to 6 and the flow
then passed unchanged. `specs/authentication` states no code length; it defers to "the configured
Supabase email verification flow", so pinning the project to the length the screen already states is
the same contract the *Minimum password length* row above records, and the row was added for the
same reason. The truncation itself is a real defect independent of the setting and is tracked
separately as a hardening follow-up in [`authentication.md`](authentication.md); it is deliberately
not folded into this task.

**Not covered by this verification.** The *Reset password* template is configured and carries the
token, but the recovery flow was not exercised end to end. Redirect URLs are registered for no
environment yet, because none exists beyond the ephemeral Cloud Shell preview origin — the
code-entry path does not consult them (`signUp` is called with no `emailRedirectTo`), which is why
this verification could pass without one, but the returning-link path and password recovery both do.
Each deployed environment must register its own frontend origin before either is used there; task
23.5 is where that lands for the hosted frontend.

## Secrets

| Secret | Held in | Used by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secrets **only** | Evaluation test-user provisioning. Never a request path, and never on the Render service — `Settings` refuses to start a `request_serving` process that has it set |
| `DATABASE_URL` | Render service environment **only** | The API and stream processes — authenticates as `weathra_api`, runs under the restricted role |
| `DATABASE_URL_PRIVILEGED` | GitHub Actions secrets **only** | Migrations and administrative routines. Deliberately absent from the Render service; see below |
| `OPENROUTER_API_KEY` | Render service environment | `/ask` and `/stream` only — optional, and its absence degrades nothing else |
| `RENDER_API_KEY` | GitHub Actions secrets | The `deploy` job of `release.yml`, to release a migrated commit |
| `RENDER_SERVICE_ID` | GitHub Actions secrets | Which service that job releases |

An earlier revision of this table listed the service-role key and the privileged database URL as
living in *both* GitHub Actions and the Render service environment. That was wrong, and it is
recorded here rather than quietly corrected because the mistake is the natural one to make: both
credentials are "backend" credentials, and it takes a second look to see that the backend has two
halves with very different privileges. Neither belongs on the service that answers browser
requests. `backend/tests/test_secret_storage.py` now fails if either is added to `render.yaml`.

### Where a production secret actually lives

Not in a file, and never in Git. Each of the four is set as an environment variable on the **Render
service itself**, server-side, and Render injects it into the container at start — the backend reads
it through `Settings` exactly as it reads a local `.env` value, and nothing in the image or the
repository holds it. Rotation is editing the value and redeploying; no code or configuration file
changes.

The backend now ships as a container (see **The production image** below), which adds one place a
credential could hide and does not: an image layer keeps whatever was copied into it even if a later
layer deletes the file, so a `.env` swept into a build context is a published credential. Two
independent things prevent it — `backend/.dockerignore` excludes every `.env*` from the build
context, and the image's runtime stage copies no source tree at all, only the virtualenv built in
the previous stage. The image is therefore publishable; every secret arrives at run time from the
Render service environment.

If a blueprint file (`render.yaml`) is used to define the service, secret values are **not** written
into it. Render's blueprint syntax marks such a variable `sync: false`, which declares that the
variable exists and must be set on the service without carrying its value — the file stays
committable, which is the whole point of the marker. A blueprint holding a real value would be a
committed credential like any other.

The privileged jobs that run in CI rather than on Render (migrations, retention, evaluation
provisioning) take theirs from GitHub Actions secrets, which is why the service-role key and the
privileged database URL appear in both columns of the table above.

**What this deliberately no longer involves.** The withdrawn Cloud Run design routed these through
Google Cloud Secret Manager with an IAM grant to a service account. Render has no equivalent
indirection and none is being reintroduced: the secret is set on the service and injected. That is
one fewer system holding production credentials and one fewer set of permissions to get wrong. The
security requirement is unchanged and unweakened — server-side only, never in the repository, never
`NEXT_PUBLIC_`-prefixed, never on a request-serving process in the case of the service-role key —
because none of those requirements ever depended on which vendor stored the value.

The local counterparts are `backend/.env` and `frontend/.env.local`, both git-ignored; the
committed `backend/.env.example` and `frontend/.env.example` carry placeholders only. That split is
the whole rule: **a real value exists in exactly two kinds of place — a developer's ignored local
file, and server-side secret storage.** The repository is public, so anything committed is
published, and a leaked value cannot be unpublished by deleting it later.

None of these reaches the frontend, and none appears in a pull-request workflow: CI holds **no
credential at all**, which is why the default suite and the offline evaluation run reach nothing
external. The frontend's configuration is public in its entirety, and CI asserts that the four
secrets appear in neither its environment nor its built bundle (`npm run check:secrets`).

### Which secret belongs to which destination

Four destinations, and the split is not a preference — it is what the code actually reads. Names
and purposes only; no value appears here or anywhere else in the repository.

| Destination | Holds | Purpose |
|---|---|---|
| **Codespaces / local** | `backend/.env`, `frontend/.env.local` — both gitignored | Development. Never committed; the `.env.example` templates carry placeholders |
| **GitHub Actions** | `DATABASE_URL_PRIVILEGED` | Migrations, retention, administrative routines |
| | `SUPABASE_SERVICE_ROLE_KEY` | Evaluation test-user provisioning — its only consumer in the whole backend |
| | `SUPABASE_URL` | Project URL for those jobs (public, but per-environment) |
| | `RENDER_API_KEY`, `RENDER_SERVICE_ID` | Releasing a migrated commit on Render, from `release.yml` |
| | `VERCEL_TOKEN` | Building and promoting the frontend, from `frontend-release.yml` |
| | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Identifiers, not credentials — which Vercel project that token acts on |
| **Render** (backend service) | `DATABASE_URL` | The request path, as `weathra_api` under the restricted role |
| | `OPENROUTER_API_KEY` | `/ask` and `/stream` only — **optional**; the backend serves everything else without it |
| | `SUPABASE_URL`, `CORS_ALLOWED_ORIGINS` | Required, not secret; per-environment |
| **Vercel** (frontend) | `NEXT_PUBLIC_SUPABASE_URL` | Public |
| | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public client key |
| | `NEXT_PUBLIC_API_BASE_URL` | The Render backend's origin for that environment |

**Vercel holds nothing else.** Not `DATABASE_URL`, not `DATABASE_URL_PRIVILEGED`, not
`SUPABASE_SERVICE_ROLE_KEY`, not `OPENROUTER_API_KEY`. Every `NEXT_PUBLIC_` value is inlined into
the browser bundle at build time, so a secret there is a published secret.

**Two placements are deliberate and worth stating, because both look like omissions:**

- **The Render service does not hold `SUPABASE_SERVICE_ROLE_KEY`.** That key bypasses every Row
  Level Security policy, and `Settings` refuses to start a `request_serving` process which has it
  set (`SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE`, `weathra/config.py`). Adding it would not weaken a
  check — the service would fail to boot. Its one consumer, `weathra/evaluation/provisioning.py`,
  runs privileged in CI.
- **The Render service does not hold `DATABASE_URL_PRIVILEGED` either. Settled, not pending.**
  Migrations run from GitHub Actions. Render's pre-deploy command would have executed in the
  service's own environment, so using it meant putting a privileged database credential inside the
  container that serves browser traffic — a standing grant, bought to obtain an ordering guarantee
  a CI job provides just as well. Decision 19 already puts every other privileged job in CI. Task
  23.4 implements the workflow and may not satisfy the ordering by adding this variable to the
  service.

`resolve_url()` refuses to substitute either database connection for the other, in either
direction. That is what makes keeping the two credentials apart worth doing;
`backend/tests/test_secret_storage.py` guards it.

### Provisioning: what a person has to do, once, per environment

**Status.** Production is provisioned. GitHub Actions holds `DATABASE_URL_PRIVILEGED`,
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`; the Render service `weathra-backend` exists on the
Starter plan, holds `DATABASE_URL`, `OPENROUTER_API_KEY`, `SUPABASE_URL` and `CORS_ALLOWED_ORIGINS`,
and serves `https://weathra-backend.onrender.com`. `DATABASE_URL` was verified to be the
least-privileged `weathra_api` login through the Supabase session pooler on port 5432. What remains
outstanding is named under **Still outstanding** at the end of this section.

None of this can be done from the repository — each is a dashboard action by an account holder, and
that is the point: the credential is entered where it will be used and never travels through Git, a
pull request, or a chat transcript.

**GitHub Actions** — repository *Settings → Secrets and variables → Actions → New repository
secret*. Add `DATABASE_URL_PRIVILEGED`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_URL`. These are
for privileged jobs only; the pull-request workflows must continue to reference none of them, which
`test_ordinary_ci_needs_no_production_credential` enforces.

**Render** — create the service from `render.yaml` (*New → Blueprint*, pointed at this repository),
then set each variable declared `sync: false` under the service's *Environment* tab:
`DATABASE_URL`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `CORS_ALLOWED_ORIGINS`. The blueprint names
them and carries no value, so this step is unavoidable rather than a default someone might skip.

**Render, the deploy credential** — *Account Settings → API Keys → Create API Key*, stored in
GitHub Actions as `RENDER_API_KEY`, together with the service's own id (the `srv-…` value in the
service's dashboard URL) as `RENDER_SERVICE_ID`. These exist because the release pipeline, not
Render, decides when a release happens: see **On merge to `main`** below. An API key is
account-scoped, so treat it as the most powerful credential in the store — it can reach every
service on the account, which a deploy hook cannot.

A deploy hook URL would need only one secret and would be narrower in scope. It is not used because
it cannot answer the question the release has to ask: a hook returns once the deploy is *created*,
and nothing about whether it reached `live`. The release would then verify readiness against
whichever release happened to be serving, which is the failure the verification step exists to
catch.

**Vercel** — *Project Settings → Environment Variables*, per environment: the three `NEXT_PUBLIC_`
values above, and nothing more.

**Supabase** — register each environment's Vercel origin under *Authentication → URL Configuration*
so the returning-link and password-recovery paths land on an allowed redirect.

After the Render service is up, `curl https://<backend>/api/v1/ready` reports each dependency by
name and never a credential value. That response is the evidence that secrets were injected and the
backend started with them — which is the part of task 23.3 no repository change can satisfy.

**Still outstanding.** Three dashboard actions, none of which the repository can perform:

1. **Add `RENDER_API_KEY` and `RENDER_SERVICE_ID` to GitHub Actions secrets**, as above. Until they
   exist, the `deploy` job refuses to run rather than failing obscurely mid-release.
2. **Create the Vercel project and add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`
   to GitHub Actions secrets**, which task 23.5 needs. The two identifiers do not exist until the
   project does, so the project has to be created first; `frontend-release.yml` is committed and
   inert until all three are present.
3. **Sync the blueprint**, so Render picks up `runtime: docker` and — the important one —
   `autoDeployTrigger: "off"`. Until that sync happens the service still deploys on every push to
   `main`, which is exactly the race the release ordering exists to remove: the committed
   configuration says auto-deploy is off, and the running service does not yet agree.

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

### On merge to `main`

**`release.yml`** — four jobs, and the order between them is the whole point:

```
image  →  migrate  →  deploy  →  verify
```

1. **`image`** builds `weathra/backend/Dockerfile` and smoke-tests the result: the container must
   start with only the configuration Render sets and answer `/api/v1/health`, and must not be
   running as root. It runs first because it is the only job that cannot damage anything — a
   Dockerfile that does not build is found here, rather than after the database has been migrated
   for a release that was never going to start.
2. **`migrate`** applies `alembic upgrade head` under `DATABASE_URL_PRIVILEGED` with
   `WEATHRA_RUNTIME_MODE=privileged`. This includes the Row Level Security policies — revisions
   `0002_row_level_security` and `0004_shared_read_policies` — which is why RLS is part of a release
   rather than a one-time setup step. `DATABASE_URL` is deliberately not in this job's environment:
   `resolve_url()` refuses to substitute one connection for the other, so there is no fallback to
   the restricted role. The job refuses to start at all if the secret is unset, rather than
   discovering it part-way through a revision.
3. **`deploy`** calls Render's deploy API with an explicit `commitId` — this run's commit, not the
   branch tip, which may already have moved on to a commit whose migrations have not run — and then
   polls the deploy until Render reports it `live`. `build_failed`, `update_failed`,
   `pre_deploy_failed`, `canceled` and `deactivated` fail the job; anything unrecognised keeps
   waiting and times out, which is the fail-closed direction.
4. **`verify`** asks the deployed service for `/api/v1/health` and `/api/v1/ready`, with bounded
   retries, and fails unless readiness reports every required dependency reachable.

**Why the ordering holds.** Two mechanisms, and both are needed:

- **`needs:` between jobs.** GitHub Actions never runs a job whose dependency failed, so applying
  migrations under the privileged connection **before the new release serves traffic** is a
  property of the job graph rather than of relative timing.
- **`autoDeployTrigger: "off"` in `render.yaml`.** This is the half that is easy to miss. Render's
  default is to deploy on every push to the tracked branch — so with the default, pushing to `main`
  would start a container build *in parallel with* the migration job, and a new release could begin
  answering requests against an un-migrated database. The `needs:` edge would guarantee nothing,
  because the release would not have come through the workflow at all. With auto-deploy off, `main`
  moving changes nothing by itself, and the `deploy` job is the only route to production.

The privileged credential stays in CI rather than moving to the service, so ordering is bought with
one `needs:` edge instead of with a standing grant of a Row-Level-Security-bypassing connection to
the container that serves browser traffic. Render's pre-deploy command was the alternative and was
rejected for exactly that reason; `test_the_render_service_never_holds_the_privileged_database_url`
holds the line, because the pressure to reverse it arrives disguised as a simplification.

The release pipelines are the only workflows permitted to read a repository secret.
`backend.yml` and `frontend.yml` hold none — a fork's CI has to work, and a contributor must never
need the production password. `test_release_workflow.py` asserts both halves, and fails if a new
workflow appears that has not been placed on one side of that boundary.

There are two release pipelines, not one, and the split is deliberate. `release.yml` is
path-filtered to `weathra/backend/**` and `render.yaml`, so a frontend-only change never triggers
it; a Vercel job living there would either never run for the changes it exists to publish, or
would force every frontend commit to re-run a migration and a container release it has no reason
to touch. The frontend also has no ordering constraint to honour — the backend's four-job chain
exists because migrations must land before the new release serves traffic, and nothing in the
frontend touches the database. `frontend-release.yml` therefore holds a Vercel token and nothing
else: `test_the_frontend_release_holds_nothing_of_the_backend_s` fails if a database connection,
the service-role key, the inference key, or a Render credential ever appears in it, so the blast
radius of a leaked Vercel token stays one Vercel project.

**`frontend-release.yml`** — the frontend's release, triggered by a push to `main` touching
`weathra/frontend/**`. One job: `vercel pull` brings down the Production environment's variables,
`vercel build --prod` produces the bundle *on the runner* — so what is promoted is what this commit
built — and `vercel deploy --prebuilt --prod` promotes it. It then asks the deployment it just
promoted for `/sign-in` and fails unless it answers 200, because an upload that succeeded is not a
frontend that renders.

The three `NEXT_PUBLIC_` values are held in the Vercel project per environment rather than in this
workflow, which is what lets a preview and production point at different backends with no commit —
and is why the workflow file names no configuration value at all. The token reaches the CLI through
`VERCEL_TOKEN` in the job environment rather than as `--token` on each command, so no step names
the credential; `test_no_frontend_release_step_names_the_token` holds that.

### On a schedule *(pending)*

`weathra-retention`, under the privileged connection, against `THREAD_RETENTION_DAYS` and
`SNAPSHOT_RETENTION_DAYS`. It refuses to run in anything but `WEATHRA_RUNTIME_MODE=privileged`, so a
misconfigured invocation fails rather than silently doing nothing.

## The production image

The backend is deployed as a container. `render.yaml` sets `runtime: docker` and points at
`weathra/backend/Dockerfile`, with `weathra/backend` as the build context; Render builds that image
and runs it, and nothing else serves production traffic. Render supports changing an existing
service's runtime through a Blueprint sync, so this replaced the previous native-Python service in
place — same service id, same URL, same environment variables.

**Two stages.** The build stage creates a virtualenv and installs the project into it. The runtime
stage starts from a clean `python:3.12-slim`, adds `libgomp1` (OpenMP, which `onnxruntime` links
against — `fastembed` needs it to produce the BGE-small embeddings the RAG corpus is indexed with)
and `ca-certificates`, then copies **only that virtualenv**. It copies no source tree, which is the
structural reason no credential can reach the image: there is nowhere for one to land even if the
build context were wrong.

**Reproducible installs.** `pyproject.toml` declares floors, which is right for a package and wrong
for a deployable artefact — two builds of the same commit, a week apart, would install different
versions, and a green CI run would then say nothing about what production runs. `constraints.txt`
pins the fully resolved set and the image installs with `pip install --constraint constraints.txt .`.
A dependency added to `pyproject.toml` without a matching pin fails the build rather than floating
silently. Regenerate it from a clean `linux/amd64` interpreter whenever dependencies change; the
exact command is in the file's own header.

**Runtime shape.** A non-root user (`weathra`, uid 10001). `HF_HOME` and `FASTEMBED_CACHE_PATH` point
at a directory that user owns, because `fastembed` fetches the ONNX weights on first use and would
otherwise fail on a permission error at the first retrieval rather than at start-up. The server
binds `0.0.0.0` on Render's assigned `$PORT`, under `exec` so uvicorn is PID 1 and receives SIGTERM
directly — which is what lets in-flight requests drain instead of being killed alongside a shell.

**What the image never does.** It never runs Alembic. Migrations belong to the release pipeline,
under the privileged connection, before the image is released; a container that migrated on start
would need `DATABASE_URL_PRIVILEGED` in the request-serving environment and would run the migration
once per container rather than once per release.

`backend/tests/test_container.py` asserts these properties statically, and the `image` job of
`release.yml` builds the thing and starts it.

## Render settings that matter

**An instance type that does not idle-spin-down.** LangGraph, SQLAlchemy, and the ONNX embedding
runtime are all slow to import, so a cold start is felt on the first request. The embedding model
also loads lazily on first RAG use, and the agent path streams progress so the wait is visible
rather than blank — but the honest fix for cold starts is not letting the service sleep. Render's
free instance type spins down when idle and is therefore not a candidate for a deployed environment.

**Timeouts above `AGENT_WALL_CLOCK_BUDGET_SECONDS`.** The budget, not the platform, must be what
ends a long run — otherwise a stream dies without its terminal event and a client cannot tell
whether the answer was complete. Render's proxy applies an idle timeout measured between bytes, not
across the whole response; the agent path emits progress events throughout a run, so a working run
is never an idle connection. Confirm this against the service's actual configuration when it is
provisioned rather than assuming it — a silent mid-stream cut is exactly the failure this note
exists to prevent.

**A small connection pool.** `DATABASE_POOL_SIZE` is 5 by default. Supabase's connection limits bind
long before application throughput does, and each horizontally-scaled instance holds its own pool;
pool size is a deployment setting rather than a code constant for exactly this reason. Connect
through the pooler.

## Verifying a deployment

The `verify` job of `release.yml` does this automatically after every release, with bounded
retries, and fails the run unless readiness reports every required dependency reachable. By hand:

```bash
curl https://weathra-backend.onrender.com/api/v1/health   # answers immediately, depends on nothing
curl https://weathra-backend.onrender.com/api/v1/ready    # every dependency, configured and reachable
```

Neither probe spends provider quota: `/ready` reports the weather provider as configured without
calling it, deliberately, so that scraping readiness on every release and every few seconds costs
nothing at Open-Meteo.

`/ready` reports `database`, `weather_provider`, `vector_store`, `mcp_server`,
`authentication_provider`, and `inference_provider` by name. It names what is missing and never a
credential value. An unconfigured inference credential shows the agent surface unavailable while
everything else stays ready — the same distinction the product makes on screen.

Then the smoke path: create an account, verify it by code, sign in, request an attributed public
forecast without a session, ask a question through `/ask` and check that every figure in the answer
appears in its evidence, open an authenticated stream and see it complete, and confirm a second
account sees none of the first's data.

### Verified in production

Task 23.4 asks that a deployment succeed and that readiness report every dependency reachable.
This records that verification. No credential, connection string, project reference or secret value
from the release is recorded here — the evidence is the pipeline's own output and the state it left
behind, which is what a later reader needs.

**Date:** 2026-09-07. **Method:** the real `release.yml` pipeline, dispatched once by hand from
`main`, against the real Supabase project and the real Render service. No mock, stub or local
container stood in for any part of it.

| What | How it was verified | Result |
|---|---|---|
| The four jobs ran in order | run `34121363240`, job graph `image → migrate → deploy → verify` | all four succeeded |
| Migration finished *before* the deploy began | job timestamps | `migrate` completed 12:22:27Z, `deploy` started 12:22:29Z — the `needs:` edge holding, not timing |
| Migrations applied under the privileged connection | `migrate` job environment | `WEATHRA_RUNTIME_MODE=privileged`, `DATABASE_URL_PRIVILEGED` only; no `DATABASE_URL` in scope |
| No revision was outstanding | `alembic upgrade head` emitted no `Running upgrade` line | database already at head; the release applied no DDL |
| The revision now live | `alembic current` | `0004_shared_read_policies (head)` — so the RLS policies of `0002` and `0004` are in place |
| Render released the migrated commit | deploy `dep-dafap1ht0dsc73dbgq20` | created for `f9e24cd44771f9dd159f15b19b56a812af823829`, the run's own commit, and polled to `live` |
| Auto-deploy stayed off | `render.yaml` | `autoDeployTrigger: "off"` — the `deploy` job remains the only route to production |
| The service holds no privileged credential | `render.yaml` `envVars`, and the service booting at all | neither `DATABASE_URL_PRIVILEGED` nor `SUPABASE_SERVICE_ROLE_KEY` is declared; `Settings` refuses to construct in `request_serving` mode while the service-role key is set, so a healthy service is itself the proof it is absent |
| Liveness | `GET /api/v1/health` | `status: ok`, `environment: production`, `version: 0.1.0` |
| Readiness | `GET /api/v1/ready` | `ready: true`, `environment: production`. All seven dependencies `configured: true`, and **none** reports `reachable: false`. `database`, `vector_store`, `mcp_server` and `conversation_memory` report `reachable: true`; `weather_provider`, `authentication_provider` and `inference_provider` report `reachable: null`, which is the deliberate design recorded above — the probe does not call them, so readiness costs no provider quota |

**On `reachable: null`.** Read the readiness clause as *no dependency reports itself unreachable*,
because that is what the endpoint can honestly assert without spending Open-Meteo quota on every
poll. A dependency that is genuinely unreachable reports `false`, which fails the `verify` job for
a required one and warns for an optional one. Confirming the three unprobed providers end to end is
the smoke path above, and for the weather provider the `/ask` and forecast steps of it.

**Two releases before this one failed**, both on `migrate`, with `permission denied for table
alembic_version` — the restricted role's fingerprint, raised by Alembic's first read before any
revision ran. Nothing was left half-applied, and `db-identity.yml` was added to answer the question
the failure did not: it reports which role the privileged DSN authenticates as on a GitHub-hosted
runner, read-only. It proved `postgres`, the owner. That workflow is a diagnostic, not part of the
release, and should be deleted now that the answer is known.

## Rollback

**The backend.** Render keeps previous deploys; rolling back is redeploying the previous one, from
the service's *Deploys* tab or through the same API the release pipeline uses. Because auto-deploy
is off, a rollback stays rolled back — pushing an unrelated commit to `main` does not quietly
re-release the broken version, and the next release is a deliberate one.

A rollback does **not** reverse a migration, and should not: the release pipeline migrates forward
before deploying, so rolling the container back leaves the newer schema in place. That is safe
precisely because of the discipline below, and it is the reason that discipline is not optional.
The constraint is the schema: a rollback across a migration is only safe if the migration was
backwards-compatible, so migrations are written additively — a column is added and populated before
anything reads it, and a drop happens a release after the code that used it is gone. The migrations
are verified to downgrade cleanly in CI (`alembic downgrade base` then back up), which is what makes
`alembic downgrade -1` a real option rather than a hope.

**The frontend.** Vercel keeps deployments; rolling back is promoting the previous one. The
frontend holds no schema, so its rollback is unconditional.

**Order.** Roll the frontend back first when the two are incompatible: an older frontend against a
newer backend is the pairing the API's additive-change discipline is designed to survive.

## The no-local-machine requirement

Every path — setup, sign-up, test, deploy — is intended to be completable from a browser-based cloud
environment against the hosted Supabase project. The CI workflows assert their half of it: both run
on hosted `ubuntu-` runners, and a test rejects any step that reaches for a local install, a local
Postgres, or a home directory. The end-to-end confirmation from a browser environment is task 23.7
and will be recorded here when the cloud accounts are provisioned.
