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
| **Production** | Vercel, public configuration per environment | Render, secrets injected | Supabase, pooler connection |

**The frontend release is verified (task 23.5).** The production frontend is
[https://weathra-bice.vercel.app](https://weathra-bice.vercel.app) — the domain the deployment's own
`alias` names, not the per-deployment URL, which Vercel's Deployment Protection answers with a
redirect to its login. Verified 2026-09-08, in this order:

| What | How | Result |
|---|---|---|
| The release runs end to end | `frontend-release` run 34230788056 on commit 967e153 | environment resolved, ownership asserted, built on the runner, promoted `--prebuilt`, production domain verified |
| The frontend serves | `GET /sign-in` | 200, `<title>Sign in · Weathra</title>` |
| The gate is live | `GET /` and `GET /dashboard` unauthenticated | 307 to `/sign-in?next=…`, destination preserved |
| The backend answers the frontend's origin | preflight and `GET` with `Origin: https://weathra-bice.vercel.app` | 200 with `access-control-allow-origin` for that origin; a foreign origin still refused with 400 |
| **A real user signs in and reaches the product** | manual pass by the product owner against production | sign-in succeeded, the authenticated application was reached, and the Dashboard rendered live Berlin weather from Open-Meteo — so the bearer-token path to the deployed backend served real data |

The last row was the acceptance criterion the automated checks could not reach. **Half of it can
now.** Since 2026-09-11 the deployed suite signs in as a real production account and reads its own
protected data, so *signing in and reaching the product* is automated (see *The session tier, run
for the first time*). What still needs a real inbox is *creating* the account and confirming it by
code, which no automation here performs. The live data on the Dashboard remains what proves the
whole chain — Supabase session, bearer token, deployed backend, provider — rather than any one link
in it.

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

### Assigning a subscription plan

Plans are administered through the product: `PUT /api/v1/admin/principals/{subject}/plan`, which the
administrative screen calls, and which writes `admin_audit` in the same transaction.
`scripts/assign_plan.py` is the escape hatch for the case that screen cannot cover — nobody signed in
as an administrator to press it — and it uses the same `PlanStore.assign`, so the audit row is
identical whichever way the change happened.

```
python scripts/assign_plan.py --list
python scripts/assign_plan.py --subject <auth-subject-uuid> --plan premium
python scripts/assign_plan.py --subject-for-email <address>     # prints the subject, writes nothing
```

It needs `DATABASE_URL_PRIVILEGED`: `user_plans` grants the request-serving role `SELECT` and
nothing else, so an assignment is a privileged write however it is made.

**A plan is not a role.** Premium grants no administrative capability and the administrative role
entitles nobody to a tier. `--subject-for-email` reads Supabase's own `auth.users` to turn an
address into a subject and prints nothing else; Weathra still stores no email of its own.

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

**Configured for production on 2026-09-08**: Site URL `https://weathra-bice.vercel.app`, with
`https://weathra-bice.vercel.app/auth/confirm` added to the redirect list and the localhost entry
retained. Before that the Site URL was `http://localhost:3000`, so every email link production sent
— the sign-up confirmation, which follows the Site URL because `signUp` is called with no
`emailRedirectTo`, and the recovery link, which names `/auth/confirm?type=recovery` — landed on a
developer's machine. Password sign-in uses no redirect, which is why it worked throughout and why
this stayed invisible until it was looked for.

**How to check it without credentials, an account, or an email.** Ask the project to verify a
deliberately invalid token and read where it sends the browser: an allow-listed `redirect_to` comes
back in the `Location` header unchanged, and one that is not falls back to the Site URL — which is
how the Site URL reveals itself too.

```
curl -sSI "https://<project-ref>.supabase.co/auth/v1/verify?token=invalid&type=recovery&redirect_to=<url-encoded>"
```

Run against production after the change: `https://weathra-bice.vercel.app/auth/confirm?type=recovery`
comes back unchanged, and an unrelated origin falls back to `https://weathra-bice.vercel.app` — both
halves of the configuration, confirmed from outside.

> **One consequence for local development.** The retained localhost entry is the bare origin, and
> Supabase matches a redirect against the whole URL: `http://localhost:3000` is still allowed, but
> `http://localhost:3000/auth/confirm?type=recovery` now falls back to the production Site URL. It
> used to work only because localhost *was* the Site URL. A local recovery link therefore lands on
> production until `http://localhost:3000/**` is added alongside it. Nothing in production depends
> on this.

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
`weathra/frontend/**`. One job: `.github/scripts/vercel_release_env.py` resolves the project and
writes its Production environment, `vercel build --prod` produces the bundle *on the runner* — so
what is promoted is what this commit built — and `vercel deploy --prebuilt --prod` promotes it.
`.github/scripts/vercel_release_alias.py` then resolves the public production domain from the
deployment it just promoted, and the job asks *that* for `/sign-in` and fails unless it answers 200,
because an upload that succeeded is not a frontend that renders.

**Why the release does not run `vercel pull`.** `VERCEL_TOKEN` is an access token scoped to the
`weathra` team, which is the recommended shape for CI — a leaked token reaches that team and
nothing else — and `vercel pull` is incompatible with it. Reading Vercel CLI 59.11.7:
`getLinkedProject` resolves `--project <id>` *before* printing its `Retrieving project…` spinner,
and then, holding a link, calls `getOrgById(orgId)` — `GET /v2/teams/<team_id>` — unconditionally.
A team-scoped token is refused there with 403 `team_unauthorized`, and the CLI reports that as
*"Could not retrieve Project Settings. To link your Project, remove the `.vercel` directory and
deploy again"* ([vercel/vercel#10874](https://github.com/vercel/vercel/issues/10874)): a message
about a directory a fresh runner does not have, for a request that never touched the project.
`vercel deploy` survives the refusal — it is the only command that passes
`allowOwnerLookupFallback`, letting it fall back to the project's own `accountId` — while `pull`
passes neither that nor `skipRemoteLookup` and then reads `org.id`, so for `pull` it is fatal.

**No flag changes that**, which is the part that cost three runs: `--scope`, then renaming the
auto-detected identifiers, then `--project`, each failed at the same step, because the failing
request is one `pull` makes regardless of how it was invoked. So the release does what `pull` would
have done, from the project-scoped API the token *can* read:

- `.github/scripts/vercel_release_env.py` reads `GET /v9/projects/<id>` for the project and
  `GET /v3/env/pull/<id>/production` for its environment — the endpoint `vercel pull` itself reads
  values from, which answers with the finished map: decrypted, and with target, branch and
  custom-environment scoping already applied by Vercel. Resolving raw records by hand is a second,
  private opinion about which record applies to production, and a value that disagrees with the one
  the dashboard shows is then indistinguishable from a value that is simply wrong. The record
  listing (`GET /v9/projects/<id>/env?decrypt=true`) is kept only as a fallback for a refusal on
  that endpoint, since the token is team-scoped and a surprise refusal is the class of failure this
  pipeline has already lost three runs to. It writes `.vercel/project.json` in the shape
  `writeProjectSettings` writes it and `.vercel/.env.production.local` in the format
  `vercel env pull` writes — sorted `KEY="value"` lines with newlines escaped, which is what
  `vercel build` parses with dotenv. `project.json`'s `settings.rootDirectory` is the load-bearing
  field: it is what makes a build invoked from the repository root build `weathra/frontend`.
- **It fails closed**, because the failure it prevents looks like success. Next.js inlines
  `NEXT_PUBLIC_` values at build time, so a build missing one produces a bundle that deploys,
  promotes, and then cannot reach Supabase from a browser. A refused token, a malformed body, a
  truncated listing, a Production value that cannot be read, a missing public value, a name that
  reads as a backend secret, or a value a dotenv file cannot carry faithfully each end the run.
- **Every URL-valued variable is held to being a URL** before the build, and this is not
  defensive tidiness: `frontend/lib/env.ts` reads each `NEXT_PUBLIC_` value as
  `process.env.NEXT_PUBLIC_…`, which Next.js **inlines at build time** — the generated Edge
  middleware bundle carries the literal and keeps no runtime lookup, so no runtime configuration
  can repair a bad one. On 2026-09-08 the Production `NEXT_PUBLIC_SUPABASE_URL` was present and
  non-empty but carried no `https://`, the build compiled it in, and
  `@supabase/supabase-js` threw *"Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL."* on
  every request — `MIDDLEWARE_INVOCATION_FAILED`, 500 on every route, from a release that reported
  success. The script now requires no whitespace, a scheme of exactly `http` or `https`, and a
  host; `http` stays valid because `.env.example` documents `http://localhost:8000`. Whitespace
  fails rather than being trimmed, so the value gets fixed where it is stored rather than papered
  over on the way past. A refusal reports the value's *shape* — its length and character class,
  enough to tell a bare hostname from a ciphertext from an opaque token — and never the value: the
  likeliest way this check fires is a credential pasted into the wrong field, and an Actions log on
  a public repository is readable by anyone.
- The org id is used **only as an assertion**, twice. The script holds the project's own
  `accountId` — the resolved answer to who owns it — to `WEATHRA_VERCEL_ORG_ID` and writes nothing
  if they differ; the workflow's next step then holds the `orgId` in the file it wrote to the same
  value. The second is not a restatement of the first: it checks the link `vercel build` and
  `vercel deploy --prebuilt` will actually resolve the project from. Neither step prints an id.
- **`--project "$WEATHRA_VERCEL_PROJECT_ID"`** stays on the deploy. It sets the CLI's
  `failIfNotFound`, which is what makes an unresolvable project a hard failure: `--yes` on its own
  would let the CLI read one as licence to create a project named after the directory it ran in and
  promote that instead.
- **No `--scope`,** still. The CLI resolves `--scope` *through the user identity* — `getUser` runs
  first — and a team-scoped token is blocked from `/v2/user`, so `--scope` fails with *"Not able to
  load user because of unexpected error: User not found. (404)"* before reaching the project.
- The identifiers reach the job as `WEATHRA_VERCEL_ORG_ID` and `WEATHRA_VERCEL_PROJECT_ID`, **not**
  under their own names; the repository secrets keep theirs. This was once believed to be the fix
  for the pull failure and was not. It is kept for a smaller reason: with `VERCEL_ORG_ID` and
  `VERCEL_PROJECT_ID` both set, the CLI re-resolves the project through the API on every command,
  and under neutral names the verified `.vercel/project.json` stays the authority instead.
- `vercel build` names nothing, deliberately: it consumes the two files the script wrote and the
  assertion vouched for, rather than re-resolving the project and risking disagreement with them.

**What gets verified, and why not the URL the deploy printed.** `vercel deploy` prints the
deployment's *own* URL, and production is not served on it: Vercel's Standard Deployment Protection
answers every generated deployment URL — and the generated `<project>-<team>.vercel.app` alias —
with a `302` to `vercel.com/sso-api`. A check pointed there can never see a 200, and it cannot see
a 500 either, which is how the run that promoted a frontend answering 500 on every route reported
the same 302 it would have reported for a healthy one. So `vercel_release_alias.py` reads the
public production domain from the deployment's own `alias` field — the entry the CLI prints as
`▲ Aliased` — and refuses to name one until that deployment is this project's, targets
`production`, is `READY`, and has had its aliases assigned. Those four are what stop a green
verification from meaning "the previous build answered". Resolving the domain rather than writing
it down matters for the same reason: a hard-coded hostname stays green while pointing at whatever
was promoted last, possibly from another commit, and would outlive a domain change in silence. The
verification also names Vercel's SSO redirect explicitly, so a protected domain says so instead of
looking like a frontend that is slow to start.

`test_frontend_release_alias.py` holds the resolver's behaviour — the nine refusals above, the
preference for a custom domain, and that the SSO-protected deployment URL is never what gets
verified. `test_frontend_release_environment.py` holds the environment script's — the ownership refusal, every
fail-closed path, the round trip through dotenv's own rules, and that no value is ever printed and
no backend secret or release token can reach the build environment.
`test_the_frontend_release_does_not_run_vercel_pull`,
`test_the_frontend_release_writes_the_project_link_itself`,
`test_the_frontend_release_hides_the_identifiers_from_the_cli`,
`test_the_frontend_release_never_names_the_scope`,
`test_the_frontend_release_targets_the_existing_vercel_project`,
`test_the_frontend_release_proves_the_project_belongs_to_the_team`,
`test_the_frontend_release_builds_on_the_runner_and_promotes_that_build`,
`test_the_frontend_release_verifies_the_public_production_domain` and
`test_the_frontend_release_cannot_create_a_vercel_project` hold the workflow's. The absences are
asserted as well as the presences: restoring `vercel pull`, either auto-detected variable name, or
`--scope` puts the release back on a path that cannot work.

Nothing about this requires a developer's local `.vercel` directory — the runner writes both files
from the project id on every run, and `.gitignore` keeps the local ones out of the tree
(`test_no_vercel_runtime_state_is_committed`).

`weathra/frontend/vercel.json` sets `git.deploymentEnabled.main` to `false`, which is the frontend's
half of `autoDeployTrigger: "off"` and exists for the same reason. Vercel's default, once a project
is connected to a repository, is to build and promote on every push to the production branch — so
with the default left in place a push to `main` would produce two production deployments, Vercel's
own and this workflow's, racing to be promoted last. The setting lives in the repository rather than
in the dashboard so that changing it arrives as a diff;
`test_vercel_does_not_deploy_on_its_own` fails if it is lost.

The three `NEXT_PUBLIC_` values are held in the Vercel project per environment rather than in this
workflow, which is what lets a preview and production point at different backends with no commit —
and is why the workflow file names no configuration value at all. The token reaches the CLI through
`VERCEL_TOKEN` in the job environment rather than as `--token` on each command, so no step names
the credential; `test_no_frontend_release_step_names_the_token` holds that.

### By hand, to change configuration

**`backend-allowed-origin.yml`** — adds one browser origin to the backend's
`CORS_ALLOWED_ORIGINS`. It exists because that variable is declared `sync: false` in `render.yaml`,
so its value lives in Render and no commit can reach it — and the frontend cannot call the backend
from an origin the list does not name. A preflight from a missing origin answers 400 with no
`Access-Control-Allow-Origin` header at all, which is a failure no bearer token can get past and
one that looks nothing like a CORS problem from inside the browser console.

It is *additive*: it reads what is configured, appends the origin if absent, and never rewrites or
removes an existing entry. A reconciler holding the whole list here would be easier to review and
would also delete, on its first run, every origin someone added in Render that this repository did
not know about. Two consequences follow from that choice: an origin already present produces no
write at all — so a second run cannot restart production for a value that is already correct — and
comparison is normalised for surrounding whitespace and a trailing slash only. Not case: the CORS
middleware compares the browser's `Origin` header against the list as exact strings, and a browser
sends the scheme and host lower-cased, so `https://WEATHRA-BICE.vercel.app` is not an equivalent
spelling but an entry that will never match.

Render's per-key endpoint (`PUT /v1/services/<id>/env-vars/<key>`) is what makes this safe:
`PUT /v1/services/<id>/env-vars` replaces a service's *entire* environment, and a partial body
there deletes every variable omitted from it. The script reads the environment back afterwards and
holds every other variable to being byte-identical, because "the endpoint cannot do that" is a
claim and this is a check. It fails closed if the current configuration cannot be read, and refuses
to *create* the variable when the service does not hold one directly — the value may resolve from a
linked environment group, and setting it here would replace whatever the service resolves today
with a single origin.

**Saving is not applying, and a restart does not apply it either.** The backend reads
`CORS_ALLOWED_ORIGINS` once, when `build_app` constructs the application, so a new value reaches it
only in a new process — `tests/unit/test_api_cors.py` holds that, along with the exactness of the
match. Render agrees about its own side: its dashboard's "Save only" option says the service "will
not use the new variables until its next deploy", and its restart is documented as deliberately
*not* being that deploy — "the new instance always uses the exact same Git commit **and
configuration** as the running instance at the time of the restart … if you've recently updated
your service's environment variables but haven't redeployed since then, restarting does not
incorporate those changes". The first run of this operation failed on precisely that: it saved the
origin, restarted, and waited nine times for a change a restart is defined never to apply.

So a saved-but-inactive value is activated with a **redeploy of the commit that is already live** —
`deployMode: "deploy_only"`, the API equivalent of the dashboard's "Save and deploy: redeploys the
existing build with the new variables". The commit is read from the service's current live deploy
and pinned, and that pin is what keeps this a configuration change rather than a second release
path: an unpinned deploy takes the branch tip, which may be a commit whose migrations have not run
— the ordering `release.yml`'s `needs:` edge exists to guarantee. A service with no identifiable
live commit is refused rather than deployed from "latest". `release.yml` therefore remains the
authority on *what* is deployed, and `test_the_maintenance_workflow_never_promotes_a_commit` fails
if the pin is ever dropped.

The run waits on *that deploy's* status rather than on a sleep — `live` is the only success, and
`build_failed`, `update_failed`, `canceled`, `pre_deploy_failed` and `deactivated` each end it —
then checks health, then asks production for a real preflight from the real origin. A deploy
already in flight is waited for instead of duplicated, since it may already carry the new value.
And when production already accepts the origin, nothing is written and nothing is deployed at all.

Hand-dispatched only, and classified as `MAINTENANCE` in `test_release_workflow.py` rather than as
ordinary CI: `RENDER_API_KEY` is account-scoped, so a workflow holding it must not be reachable by
pushing a commit. It prints the origin it added and nothing else — not the credential, not the
origin list, and not the values of the variables it read in order to prove it had not changed them.

### On a schedule

**`database-retention.yml`** — `weathra-retention` under the privileged connection, at 03:17 UTC
daily, against `THREAD_RETENTION_DAYS` and `SNAPSHOT_RETENTION_DAYS`. Expired conversation threads
with their checkpoints, and forecast snapshots past their own longer window; nothing else. A
person's saved locations and preferences are not expiring data, and whole-account deletion is a
separate operation its owner performs on the request path.

design.md decision 11 puts this in CI rather than in the server, and the reason is the credential
rather than the scheduling: deleting expired rows belonging to *other people* is exactly the work
the request-serving role must not be able to do. `weathra-retention` refuses to run in anything but
`WEATHRA_RUNTIME_MODE=privileged`, because under the request-serving configuration the policies
narrow every delete to nothing and the job would report success having removed almost nothing.

**It verifies before it deletes.** `backend/scripts/verify_database.py` reads the deployed database
in a session PostgreSQL refuses writes for and holds it to what task 23.6 requires: the migrations
applied and at this checkout's head, `pgvector` present, Row Level Security enabled *and forced*
with at least one policy on every user-owned table, and the two roles as the design needs them —
`weathra_request` unable to log in or bypass RLS, `weathra_api` able to log in but not inheriting,
not bypassing, and holding none of `SUPERUSER`, `CREATEDB`, `CREATEROLE` or `REPLICATION`. A failure
there stops the run before anything is removed, because a schema that is not the one this code
expects is the last state in which to start deleting rows.

That verification exists because the obvious way to check a deployed database is the one thing that
must never happen. Task 23.6's wording asks for "the `db` suite" against it, and that suite
truncates every user-owned table between tests (`tests/db_support.py:145`) — running it against
production would delete every account's data in order to prove a schema claim. The suite runs
against a disposable `pgvector` database on every push instead, and the properties it asserts about
the schema are asserted directly against production here.
`tests/integration/test_database_verification.py` proves the check notices when each property it
reports is broken, so a green run means something.

The report is counts, the two windows, and a timestamp. Never a deleted row's contents, and never
the connection string: a failure message is scrubbed of the DSN before it is printed.

**Verified against production, 2026-09-08** — `database-retention` run 34252635695, dispatched with
`dry_run` selected. The verification step reported nine passes against the deployed Supabase
database:

| Checked | Reported |
|---|---|
| Migrations | applied, at `0004_shared_read_policies` — this checkout's head |
| pgvector | `vector 0.8.2` |
| Row Level Security | `enabled=True forced=True policies=1` on `profiles`, `preferences`, `saved_locations`, `threads` and `agent_runs` |
| `weathra_request` | `canlogin=False bypassrls=False` |
| `weathra_api` | `canlogin=True inherit=False bypassrls=False` |

and the routine then reported `threads_expired: 0`, `thread_checkpoints_cleared: 0`,
`snapshots_expired: 0` against windows of 30 and 90 days. Nothing has aged out yet — the project's
oldest thread is days old, not months — so the first pass with anything to remove will be the first
that exercises a delete. What the dry run establishes is everything up to that point: the schedule,
the privileged connection, the schema, and the counting.

A dry run is deliberately *not* the routine. `main()` calls `_dry_run()` **instead of** `retain()`,
and the two do not share their predicates — a dry run that called the real routine and rolled back
would have to hold a transaction open across the checkpoint deletions, which are not transactional
because the checkpointer has its own connection. So the deletion path — the privileged checkpointer,
the two `DELETE`s and the commit — is proven only by a run in `remove` mode.

**Which is why the mode is a named choice.** Runs 34252635695 and 34256787050 were dispatched a
checkbox apart, and both counted: each rendered `if [ "true" = "true" ]`, and the only way to tell
what a run had done was to find the `--dry-run` in its echoed script. The second was intended as the
real pass, so a run that had not done what it was dispatched to do reported success. The input is
now `mode`, defaulting to `remove` — the operation the schedule performs, since a scheduled run
supplies no inputs at all — and the chosen word is printed before anything runs.

**The real pass ran on 2026-09-08**: run 34262284576 on commit b309214, `MODE: remove`, its log
reading `mode: remove` and `removing what has expired` before the routine's report. The nine
verification checks passed first, and the routine reported `threads_expired: 0`,
`thread_checkpoints_cleared: 0`, `snapshots_expired: 0` — nothing had aged out, which is right for a
project days old. That completes task 23.6: the routine is scheduled, it runs under the privileged
connection, and it has completed a real invocation against production.

**One clause of 23.6 was met by different means, recorded rather than glossed.** Its wording asks
for "the `db` suite passes against it", meaning the deployed database. That suite truncates every
user-owned table between tests (`tests/db_support.py:145`), so running it there would delete every
account's data — including the owner's — in order to prove a schema claim. It runs against a
disposable `pgvector` database on every push instead, and the schema properties it would have
asserted are asserted directly against production by the verification step above. The deviation is
deliberate; the wording is what should change if this is ever revisited.

## Deployed acceptance

Tasks 25.3, 25.4 and 34.7 ask for the deployed pair to be exercised and the results recorded. This
is the record. `backend/tests/deployed/` is the suite — `test_deployed_acceptance.py` for 25.3 and
25.4, `test_saas_acceptance.py` for 34.7's SaaS layer. It runs from a Codespace or from
`live-acceptance.yml` with `pytest -m deployed`. Its last credential-free full run reported
**84 passed, 28 skipped, 0 failed** (2026-09-09); its first run *with a live session* is recorded
under *The session tier, run for the first time* below (2026-09-11), and
`test_deployed_rls_gate.py` — 25.3's RLS gate, asked of the deployed database read-only — joined the
directory with it.

**Re-verified 2026-09-11, after the visual product-gap pass redeployed both halves.** The 25.3/25.4
module was re-run against the same pair at commit `602fb33`:
`pytest tests/deployed/test_deployed_acceptance.py -m deployed` → **59 passed, 5 skipped, 0
failed**. The five skips are the session tier, unchanged and named below. Nothing in the
credential-free half regressed across the redeploy, and the run needed no credential of any kind.

**A gap that run found, and closed.** `test_every_protected_path_has_a_credential_free_check`
failed, naming three protected paths no deployed check had ever probed: `/me/watches`,
`/me/watches/{watch_id}` and `/me/watches/{watch_id}/evaluate`. Weather Watch was added to the
protected surface without being added to either module's list, so five production operations —
`GET` and `POST` on the collection, `PATCH` and `DELETE` on the member, and `POST …/evaluate` —
had never been confirmed to refuse an unauthenticated caller. All five are now checked and all five
answer 401. This is the second time that assertion has caught a protected surface nobody was
probing; the first was group 31's administrative paths. It is the reason the check list is asserted
against the contract rather than maintained by hand.

### The session tier, run for the first time (2026-09-11)

Every earlier pass recorded the authenticated half of 25.3 and 25.4 as *implemented and skipping*:
the checks existed, and no account had ever been supplied to them. On **2026-09-11**, against
`weathra-backend.onrender.com` and `weathra-bice.vercel.app` at `4cd193f`, one production account
was supplied and that tier ran for the first time. `pytest tests/deployed/test_deployed_acceptance.py
tests/deployed/test_deployed_rls_gate.py -m deployed` → **65 passed, 16 skipped, 0 failed**, with
the two inference checks run separately and reported below.

Three things came out of it, and none of them is the thing anybody expected.

**A second account was configured, and it was the first account.** The two sets of live credentials
supplied to `WEATHRA_LIVE_USER_A_*` and `WEATHRA_LIVE_USER_B_*` were byte-identical, and both
sessions resolved to the same deployed subject — confirmed against `/me`, which answered with one
`user_id` and one address for both. The first run of the isolation tier therefore reported that
"account B" could list and delete "account A's" saved location. **That was true, and it was not a
leak**: there was one account, doing what an account may do with its own row. It is exactly what a
broken policy looks like from the outside, which is why the harness now refuses the configuration
instead of asserting over it. `Credentials.has_second_account` compares the two addresses, and the
suite additionally compares the two *subjects the deployment reports*, because two distinct
addresses can still resolve to one Supabase user. Either way the isolation checks skip, naming
`WEATHRA_LIVE_USER_B_EMAIL` and `WEATHRA_LIVE_USER_B_PASSWORD`, rather than recording a data leak
that did not happen. A unit test holds both halves of that guard.

**A live bearer token and an account password were printed into the run log.** pytest renders every
fixture argument's `repr` into the traceback of any test that takes it, so the moment an
authenticated check failed, the session token, the account address, its password and the public
client key were all in the output — by a route `redact` never sees, because `redact` only ever
handled assertion text. `sign_in` now returns a `Token` whose `repr` is `«token»` and whose value is
unchanged everywhere it is *used*, and every secret field of `Credentials` is `repr=False`. This is
recorded rather than quietly fixed because it is 18.11's property — secret containment — failing in
the acceptance harness itself rather than in the product.

**The RLS gate is now asserted rather than cited.** `tests/deployed/test_deployed_rls_gate.py` asks
18.9's question of the deployed database directly, in a transaction PostgreSQL itself refuses writes
for: the claims are bound the way `request_session` binds them, the role is dropped to
`weathra_request`, and `transaction_read_only` is switched on before any `SELECT` runs. It replaces
a citation of a scheduled retention run with a check that runs beside the rest of the tier. Five of
its fourteen checks need only one account and passed: Row Level Security **enabled and forced with
at least one policy on all nine user-owned tables** — `profiles`, `preferences`, `saved_locations`,
`weather_watches`, `threads`, `agent_runs`, `user_plans`, `usage_counters` and `llm_usage_events`,
which closes the five-table gap the earlier record noted; `weathra_request` unable to log in, unable
to bypass the policies and not a superuser; a request session that really does run as that role with
the acting subject bound and the transaction read-only; an anonymous session seeing **zero** rows in
every one of those nine tables; and claims not surviving into the next session on the same pool. The
remaining nine need a second subject and skip.

### The deployed group 18 run, clean (2026-09-11, third pass — 25.3 closed)

The credential was corrected on the Render service and the deployment rebuilt. The same suite, run
against it: **83 passed, 0 failed, 0 errors, 0 skipped.** Every case of group 18 passes against the
deployment, including the evidence-record isolation that could not run while the agent could not
answer, and every check of the RLS gate. **Task 25.3 is closed.**

The three cases that were outstanding, and what each now reports:

| Case | Group | Result |
|---|---|---|
| `test_neither_account_is_served_the_other_s_evidence_record` | 18.5 | **PASS** — A reads its own evidence (200); B is refused (404) with the same code and message it gets for an identifier that was never issued |
| `test_a_question_s_every_figure_appears_in_its_evidence` | 25.4 §6 | **PASS** |
| `test_an_authenticated_stream_completes` | 18.8 / 25.4 §7 | **PASS** — terminal event `final`, no `error` |

**A defect in the harness surfaced the moment the stream worked.** The completion assertion read
`"complete" in event or "done" in event`, and Weathra's event vocabulary has never contained either
word: the terminal events are `final` and `error`. The assertion could not have passed against a
working stream, and nobody found out, because every previous run terminated on `error` and failed
for the reason everyone already expected — a wrong check agreeing with a real failure. It now
imports `StreamEventType` and `TERMINAL_EVENTS` from the application, asserts **exactly one**
terminal event and that it is `final`, and reads the `final` payload to confirm it carries both an
answer and an evidence identifier. An empty terminal event would otherwise have satisfied it.

### The earlier run, before the credential was corrected (2026-09-11, second pass)

The second account is real this time. `WEATHRA_LIVE_USER_B_*` now names an account whose subject and
address both differ from A's — checked before anything else ran, because the previous pass's
"isolation failures" were one account supplied twice.

`pytest tests/deployed/test_deployed_acceptance.py tests/deployed/test_deployed_rls_gate.py -m
deployed` → **80 passed, 1 failed, 2 errors, 0 skipped**. Nothing skipped for want of a second
account, and all fourteen RLS-gate checks ran, including the nine that need a second subject.

Every one of the three exceptions is the same inference condition, and nothing else:

| Case | Group | Result |
|---|---|---|
| `test_neither_account_is_served_the_other_s_evidence_record` | 18.5 | **ERROR at setup** — the fixture asks `/agent/ask` for an answer whose evidence record can then be asked about, and there is no answer |
| `test_a_question_s_every_figure_appears_in_its_evidence` | 25.4 §6 | **ERROR at setup** — same fixture |
| `test_an_authenticated_stream_completes` | 18.8 / 25.4 §7 | **FAIL** — authorizes and opens, then terminates on `event: error` |

Bidirectional isolation is proven for every resource class that does not need an answer: saved
locations in both directions including the destructive one, threads by listing and by identifier in
both directions including a delete attempt that must not remove the row, `/me` answering as each
account's own subject, and the RLS gate over all nine user-owned tables asked with one subject's
claims against another's rows. **Evidence records are the one class left unproven**, because an
evidence record is what a completed run produces and no run completes.

**Thread isolation no longer depends on the agent answering.** It used to, and that was the wrong
dependency: `/agent/stream` opens the thread *before* it reaches inference, so a run that fails at
the gateway still leaves a real owned row behind. The fixture now asks for exactly that. Evidence
isolation cannot be freed the same way — there is no evidence without an answer.

### The two inference checks, run once each (2026-09-11, after the fix)

25.4's sixth and seventh criteria are the only checks in either task that reach the inference
gateway. Each was run **exactly once**, through the deployed product, as the signed-in account, with
no retry:

| Criterion | Result |
|---|---|
| A question through `/ask` whose every figure appears in its evidence | **FAIL** — `POST /api/v1/agent/ask` answered **503 `provider_authentication_failed`**, `details: {"provider": "openrouter", "status": 401}`, with the person-facing sentence the product is designed to show: *"Weather intelligence is temporarily unavailable. Forecasts, history, analytics, comparison and your saved locations are all unaffected."* |
| An authenticated SSE stream completing | **FAIL** — `POST /api/v1/agent/stream` **authorized and opened**: 200, `text/event-stream`. Its terminal event is `event: error` carrying the same code and request id. No bearer token appears anywhere in the stream. |

**The cause is now established, and it is not in this repository.** `docs/agents.md` carries the
full working; in short, the deployed `OPENROUTER_API_KEY` is present — `/ready` reports
`inference_provider` `configured: true` — and OpenRouter refuses it with 401, while the same code
path driven with a credential the gateway accepts returns 200 against the same model, through
`complete` and the structured-output `complete_json` alike. There is nothing to route around: every
row of the model catalog is on the one registered gateway, so the credential is common to every
candidate a policy could resolve, and failover correctly declines to try a second model that would
be refused identically.

**What closes it:** setting the deployed `OPENROUTER_API_KEY` to a credential OpenRouter accepts.
That is an operator action on the Render service — the variable is `sync: false`, so its value is
entered by hand and lives nowhere in this repository. No key was read, changed, rotated or replaced
by this pass, and no model was changed.

**One defect was found on the way and fixed.** The 401 used to be reported to callers as
`agent_not_configured`, directly contradicting the same deployment's readiness probe. It now raises
`ProviderAuthenticationFailed` — `provider_authentication_failed`, still 503, still the same
sentence on the screen, and `provider_auth_failed` in the evidence record. `AgentNotConfigured` now
means only what it says: no credential at all. The `Settings` boundary also strips surrounding
quotes from the credential now, alongside the whitespace and `Bearer ` prefix it already stripped —
a `.env` line's quoting is the third artefact a hand-entered value carries, and it produces exactly
this 401. It was not this deployment's cause: the value is still refused after the fix shipped.

**What it does not touch.** Everything else in the same run passed: readiness, the public weather
surfaces, the frontend, the refusal half, the RLS gate, and the authenticated session's own reads.
The 503's own message is the accurate one — the rest of the product is unaffected.

### What automation proved (task 25.4)

| Criterion | Evidence |
|---|---|
| Readiness all-reachable | `/api/v1/ready` → `ready: true`, `environment: production`, no required dependency unreachable, and database, authentication_provider and weather_provider each named |
| An attributed public forecast without a session | `/weather/forecast` → 200 carrying an `attribution` block with the provider, the resolved location and the fetch time |
| A baseline comparison with both sides labelled | `/weather/history/baseline/comparison` → 200 with the baseline's `labelling`, the observed side's data class, and a characterisation |
| The frontend serves | `/sign-in` → 200, titled *Sign in · Weathra* (re-verified 2026-09-11) |
| The route gate holds | `/`, `/dashboard`, `/settings`, `/locations`, `/historical`, `/analyst`, `/report`, `/evidence` → 307 to `/sign-in`, each carrying its own `?next=` (re-verified 2026-09-11, after the visual pass rebuilt three of those screens) |
| No 5xx on any public surface | every path in `PUBLIC_PATHS`, swept |
| The frontend carries no private credential | the served page mentions no `SERVICE_ROLE`, `DATABASE_URL`, `OPENROUTER`, `sk-or-` or `SUPABASE_SERVICE` (re-verified 2026-09-11) |
| Every protected endpoint refuses an unauthenticated caller | eighteen operations now, the five Weather Watch ones included — see the gap above |

### What was verified in production after the Visily parity pass (2026-09-11)

The pass of 2026-09-11 added a backend endpoint, two response fields and one deterministic
calculation. Each was checked against the deployed pair after `release` and `frontend-release`
succeeded on `d3e4a57`, read-only and with no credential:

| What | Evidence |
|---|---|
| The new endpoint is live and classified | `/api/v1/admin/usage/series` is present in the deployed `openapi.json` and answers **401 `token_missing`** with no token — verified before anything is looked up |
| The new response fields reached the contract | `RecentUsage.series` and `BaselineComparison.percentile_rank` are both in the deployed schema, not only in the working tree |
| Every administrative operation still refuses | `pytest tests/deployed -m deployed` → **97 passed, 32 skipped, 0 failed**, which now includes the new series endpoint and the two 34.22 reads whose absence that run found |
| Readiness unchanged | `/ready` → `ready: true`, `environment: production`, `version 0.1.0` |

**The percentile rank, computed by production from real archive data.** This is the one new
*calculation*, so it was checked end to end rather than by contract. `/weather/history/baseline/comparison`
is public, so it needed no session:

```
GET /weather/history/baseline/comparison?location=Lisbon&start=2026-09-01&end=2026-09-05
    &measure=temperature_mean&years=6
```

Lisbon, Portugal — deliberately a city with no committed artwork and no fixture, so nothing about
the answer could have come from this repository. Six real archive years, each with its own mean for
the calendar window and six usable days behind it: 2020 23.95, 2021 21.63, 2022 20.83, 2023 20.10,
2024 19.95, 2025 21.42 °C. Baseline mean 21.31 °C; the compared window 26.0 °C.

    percentile_rank = (years below + half the years equal) / years × 100
                    = (6 + 0) / 6 × 100
                    = 100.0

Returned as **100.0 percentile**, `status: computed`, with the convention (`mid-rank; no
interpolation`), the counts it used (`years_below: 6`, `years_equal: 0`) and its own resolution
stated in the method: *"6 years, so the finest distinction is 17 points"*. The arithmetic is
checkable by hand from the figures in the same response, which is the property
`specs/deterministic-analytics` exists to require.

**The correlation and the density, computed by production from two real forecasts.** The sixth
revision's two new statistics, checked the same way — `/weather/comparison` is public, so it needed
no session:

```
POST /weather/comparison  {"criterion":"warmest","locations":["Lisbon","Porto"],"days":5}
```

Two Portuguese cities about 270 km apart, neither in any fixture. Production aligned **120 hourly
instants** — both providers reported every slot, so `data_density` is a genuine **100%** with
`expected_instants: 120` and `usable_instants: 120` — and returned
**r = 0.8236** as `correlation`, dimensionless, with `aligned_points: 120`, `common_instants: 120`
and both sides' offered counts equal. A coefficient of 0.82 for two cities in the same country is
the physically plausible answer, which is the sanity check a formula this easy to get wrong needs:
paired by index instead of by instant, a five-day window would still have produced *a* number.

**What was not captured, and why.** §16 of the parity brief asks for production *screenshots* of the
populated states. Every product screen is behind `/sign-in`, so photographing one needs an account
password — the same blocker as 25.4's criteria 6 to 8, and the owner has declined to store one
here. The captures in `frontend/capture/` are of the real shipping bundle driven against the offline
stubs, which is honest evidence about composition and no evidence about production data. The
production checks above are what can be verified without a credential, and the percentile above is
production computing a real figure from a real provider.

### What automation proved (task 25.3)

Group 18's suite splits into cases that need a session and cases that do not. The second half runs
against production in full:

| Group 18 case | Evidence |
|---|---|
| 18.3 missing token, every protected endpoint | all thirteen refuse with 401 — GET, POST, PUT and DELETE alike |
| 18.4 expired and invalid tokens | `/me` refuses nine shapes — expired, wrong issuer, wrong audience, bad signature, unknown key id, malformed, truncated, unsigned, and a structurally *valid* token signed by a key production has never seen — with no token material echoed back |
| 18.8 unauthenticated stream | `/agent/stream` refuses with 401 rather than opening a stream |
| 18.10 frontend protected routes | the redirects above, with the destination kept |
| 18.11 secret containment | the served bundle, plus the repository check on every push |
| The RLS gate | verified against the deployed database itself, read-only: Row Level Security **enabled and forced** with a policy on each of `profiles`, `preferences`, `saved_locations`, `threads` and `agent_runs`, `weathra_request` unable to log in or bypass it, `weathra_api` not inheriting and holding no privileged attribute — `database-retention` run 34328049918 (2026-09-09T08:15Z, commit `12d394a`) |

**On the five tables, and why it was five.** *(Superseded 2026-09-11 — the deployed RLS gate now
covers all nine user-owned tables; kept because it records why the earlier number was what it was.)* Those are the user-owned tables group 18 was written
against, and 18.9's RLS gate is the gate on them. Three more became user-owned later the same day —
`user_plans`, `usage_counters` and `llm_usage_events`, added by `6a85a9a` at 07:55Z, after the
05:44Z commit the run above verified — so the production verification of *those three* is a
34.3/34.7 matter and is not part of 25.3's evidence. `scripts/verify_database.py` derives its list
from the model metadata, so the next scheduled retention run covers all eight without any change
here.

**Re-verified after group 33.** The credential-free half of 25.3 was run again on **2026-09-09**
against the then-current production deployment — after group 33 shipped and after `release`
succeeded on `6b38159` — as `pytest tests/deployed/test_deployed_acceptance.py -m deployed`:
**52 passed, 4 skipped, 0 failed**. The four skips are the session tier, named below. Nothing in
the rejection half regressed, and the re-run needed no credential of any kind.

### What automation proved (task 34.7, the SaaS layer)

The credential-free tier of 34.7 ran in full. It needs nothing configured, so this is the half of
the SaaS-layer acceptance verification that is *done* rather than pending:

| Criterion | Evidence |
|---|---|
| Every administrative operation refuses an absent token | all 22 published administrative operations across the 18 paths — GET, POST, PUT, PATCH and DELETE alike — answer 401, with path parameters filled by identifiers that do not exist so the refusal cannot be a 404 in disguise |
| Every administrative read refuses a foreign token | a structurally valid token signed by a key production has never seen is refused on all 8 administrative GETs |
| A refusal discloses no model identifier | no administrative refusal body contains any seeded catalog key or any vendor model string — `specs/model-lab` requires the unentitled caller to learn nothing about which models exist |
| The check list cannot fall behind the surface | the completeness assertion compares *operations* against `openapi.json`, so a route added or a method changed fails it |

**A defect this found.** The equivalent assertion for the ordinary protected surface,
`test_every_protected_path_has_a_credential_free_check`, had been failing since group 31 added the
administrative paths — the `deployed` marker is deselected by default, so no ordinary CI run
reported it. Both modules now assert their own half, and a third assertion holds that the two
halves partition the protected surface, so a path cannot be dropped from one list and excluded from
the other with both modules still reporting themselves complete.

**What the three method corrections cost.** The first run of this tier reported 5 failures, all
405 rather than 401: `/admin/models/{catalog_key}` publishes only `PATCH`,
`/admin/allowances/internal` only `PUT`, and `/admin/plans` no `POST`. A hand-written path list
had assumed each answered `GET`. That is why the assertion is now driven off the contract.

### What the product owner verified by hand

The owner signed into production with their own account and reported: sign-up confirmed by emailed
code, sign-in succeeded, the authenticated Dashboard rendered live Berlin weather from Open-Meteo,
and `/dashboard` and `/settings` were protected before signing in. Live weather on an authenticated
screen is the whole chain answering — Supabase session, bearer token, deployed backend, provider —
and the saved-location preference was exercised through the same session afterwards. That is 25.4's
*create an account and verify it by code* and *sign in*, and group 18.2's valid-request case for the
endpoints the product uses.

### What is not verified, and why

None of these is a gap in the deployment. Each is a criterion that needs something this repository
deliberately cannot produce: a real account, a real inbox, or real spend.

**Task 34.7's session tiers.** The SaaS-layer criteria that need a signed-in account are
implemented in `test_saas_acceptance.py` and skip, naming their variables. They are, exactly:

| Criterion | Needs | Tier |
|---|---|---|
| A Free-plan caller served their entitled model with the resolution in the evidence record | one account | `WEATHRA_LIVE_USER_A_*` |
| A body field claiming Pro ignored | one account | `WEATHRA_LIVE_USER_A_*` |
| A usage event recorded for every call, including a failed one | one account | `WEATHRA_LIVE_USER_A_*` |
| Forecast, history, analysis and comparison still serving throughout | one account | `WEATHRA_LIVE_USER_A_*` |
| An ordinary account refused the administrative surface with no model disclosed | one account | `WEATHRA_LIVE_USER_A_*` |
| A second account seeing none of the first's usage | a second account | `WEATHRA_LIVE_USER_B_*` |
| An override accepted for an enabled model and refused for an absent one | an administrative account | `WEATHRA_LIVE_ADMIN_*` |
| An estimated cost present and labelled | an administrative account | `WEATHRA_LIVE_ADMIN_*` |
| Internal lab and evaluation usage reported separately from every product plan | an administrative account | `WEATHRA_LIVE_ADMIN_*` |
| An exhausted allowance returning 429 with its basis | one account, and its day allowance | `WEATHRA_LIVE_EXHAUST_ALLOWANCE=1` |

Two of those deserve their reasons stated rather than listed.

The **429** is opt-in per dispatch because the honest way to reach it costs a real day's
allowance on the dedicated account. The convenient way — lowering a plan's allowance to a number
the check can reach quickly — is refused in the suite: `plan_allowances` rows are shared by every
account on that plan, so it would be changing production for real people to make an assertion
cheap.

The **disabled-model refusal** is asked with an *absent* catalog key rather than a disabled one.
Disabling a seeded model to watch a refusal would take it out of resolution for every account on a
plan that names it, for as long as the check ran plus one cache TTL. Absent and disabled are one
branch apart in the same allowlist check, and `integration/test_agent_resolution.py` covers the
disabled branch in process, against a database that is nobody's.

**Task 34.5's live comparison.** The first model comparison across the seeded catalog candidates is
not run. The implementation is complete and tested — group 32's lab, its bounds, its records, its
criteria and its promotion action — but executing it means four candidates' worth of real
inference against the gateway and writing `model_comparison_runs` rows into the production
database, and *then* re-ordering a policy's candidate list from what it found. An offline run
cannot substitute: it scores `FakeLLMClient`, so promoting a candidate from its numbers would be a
decision made on measurements of the harness. The task stays open rather than being satisfied with
a comparison whose evidence means nothing.

**And criteria from 25.3 and 25.4** — restated 2026-09-11 after a second pass the same day, which
supplied a genuinely distinct second account and resolved the inference diagnosis:

* **A question through `/ask` whose every figure appears in its evidence**, and **an authenticated
  SSE stream completing** (25.4), together with **18.5's evidence-record isolation** (25.3). All
  three were held up by one thing — the `OPENROUTER_API_KEY` configured on the Render service was a
  credential OpenRouter refused with 401 — and all three **now pass**, the value having been
  corrected to the credential this project already held. The diagnosis is recorded in
  `docs/agents.md`; the remedy was an operator action on a value that lives nowhere in this
  repository, and no key was created, purchased or rotated to achieve it.
* **A second account seeing none of the first's data** (25.4), and **cross-user isolation against
  the deployed backend** (25.3). These needed two live production accounts and now have them.
  Saved-location and thread isolation pass in both directions against the deployment, and the RLS
  gate's two-subject half passes over all nine user-owned tables on the deployed database. Only the
  evidence-record class is still unproven, for the reason immediately above.

### Task 25.4's standing, stated as a whole

The task reads: *run the live smoke check against the deployed pair — create an account and verify
it by code, sign in, readiness all-reachable, an attributed public forecast without a session, a
baseline comparison with both sides labelled, a question through `/ask` whose every figure appears
in its evidence, an authenticated SSE stream completing, and a second account seeing none of the
first's data; verify each and record the results.* Eight criteria, verified one by one on
**2026-09-09** against `weathra-backend.onrender.com` and `weathra-bice.vercel.app`.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Create an account and verify it by code | **PASS** — performed by the product owner against the deployed pair, 2026-09-11 | A **fresh** address, never previously registered with Weathra, taken through the deployed frontend at `https://weathra-bice.vercel.app`: Create Account accepted the sign-up and issued no session → Choose Plan → Verify Email, which stated *"We sent a 6-digit verification code…"* and offered the code field → the six-digit code arrived by email → **the code was entered and submitted** → verification succeeded, the account was confirmed, and the authenticated application was reached. **Verification was by code, not by the link** — the link was deliberately not used as the acceptance action. No address, password, code, token or message content was recorded, here or anywhere in the repository; the evidence is the observed outcome, which is what a later reader needs. |
| 2 | Sign in | **PASS** — verified by automation 2026-09-11 | Supabase's password grant with the public client key, the way the browser does it, then `GET /api/v1/me` → 200 naming that subject, its own address, and `email_verified: true`. The whole chain — identity provider, bearer token, deployed backend, Row Level Security — answering as one subject. Previously recorded as a manual pass; it is now automated. |
| 3 | Readiness all-reachable | **PASS** — re-verified 2026-09-11 | `/api/v1/ready` → 200, `ready: true`, `environment: production`, `version 0.1.0`. All seven dependencies `configured: true`; `database`, `vector_store`, `mcp_server` and `conversation_memory` each `reachable: true`. `weather_provider`, `authentication_provider` and `inference_provider` report `reachable: null` **by design**, each with its reason in `detail` — a readiness probe that called Open-Meteo on every hit would spend the provider's rate limit on liveness. |
| 4 | An attributed public forecast without a session | **PASS** — re-verified 2026-09-11 | `/weather/forecast?location=Berlin&days=3` → 200 with no credential, `provider: open-meteo`, the resolved location (`Berlin`, *State of Berlin*, `DE`, 52.52437/13.41053, `Europe/Berlin`, 74 m), `units: metric`, and `retrieved_at: 2026-09-11T04:41:50Z`. |
| 5 | A baseline comparison with both sides labelled | **PASS** — re-verified 2026-09-11 | `/weather/history/baseline/comparison` → 200 carrying `baseline.data_class: computed_statistic` with its calendar period and `years_used: [2021, 2022, 2023, 2024, 2025]`, the observed side's own `observed_data_class`, a `characterization`, a `z_score`, and a `forecast_side_caveat`. Both sides labelled, and an instantaneous measure is still refused clearly rather than averaged. |
| 6 | A question through `/ask` whose every figure appears in its evidence | **PASS** — verified 2026-09-11, after the credential was corrected | One request, no retry. `POST /agent/ask` → **200**, served by `openrouter` / `nvidia/nemotron-3-super-120b-a12b:free` for both the routing and synthesis stages, with an evidence record persisted and readable at `/evidence/{id}`. The prose carried five numerical weather figures — 17.9, 21.5, 19.766…, 11.6 and 16.866… °C — and each was **independently recomputed from the raw open-meteo daily series in the run's own tool result** (`min`, `max` and `mean` of `temperature_max`, `min` of `temperature_min`, `mean` of `temperature_mean`) as well as matched to a labelled finding carrying open-meteo attribution. The product's own grounding report agrees: `verified: true`, `figures_checked: 5`, `ungrounded_figures: []`. No token appeared in the response. |
| 7 | An authenticated SSE stream completing | **PASS** — verified 2026-09-11 | One request, no retry. Authorization succeeded, **200 `text/event-stream`**, events arrived, and the stream reached **exactly one terminal event: `final`** — no `event: error`. The `final` payload carried both the answer envelope and the evidence record's identifier, and the bearer token appeared in no frame. |
| 8 | A second account seeing none of the first's data | **PASS** — verified by automation 2026-09-11 | A genuinely second account, confirmed before anything ran: B's subject and address both differ from A's as the deployment itself reports them. B is served none of A's saved locations and none of A's threads, by listing and by identifier, and cannot delete either — and the same holds in the other direction, over records created for the check and removed afterwards. The deployed RLS gate asks the same question of the database directly, with one subject's claims against another's rows, across all nine user-owned tables. |

**Eight of eight pass. The task is complete.**

Criterion 1 was the last, and it closed the only way it could: by somebody performing it. The
distinction that kept it open for three passes is worth preserving, because it is the reason the
task was not closed earlier on evidence that looked sufficient:

* **An account that is verified is not proof of how it was verified.** Supabase sets
  `email_confirmed_at` identically whether a six-digit code or a link was used, and carries no
  `otp`-shaped field anywhere on the user object. `confirmation_sent_at` and `confirmed_at` bound
  *when* it happened and say nothing about *how*. So no amount of reading production metadata could
  have established "verified by code", and reading it that way would have been asserting a fact the
  system does not store.
* **The earlier passing run was against a different surface.** *Verified against the project* above
  records a real signup-by-code on 2026-09-05 — but for task 23.2, against the frontend served from
  Cloud Shell Web Preview with the backend deliberately not running. 25.4 asks for the smoke check
  *against the deployed pair*, and that is the delta today's run closed.
* **The flow itself was never in doubt.** `/create-account` calls `signUp` with no
  `emailRedirectTo`, so the code path consults no redirect URL — which is why it worked on the
  deployed origin with no Supabase configuration change. `/verify-email` calls
  `verifyOtp({email, token, type: "signup"})` for a typed code and `verifyOtp({token_hash, type})`
  for a followed link, and both converge on one success state.
* **Criteria 6 and 7** now **pass**. The `OPENROUTER_API_KEY` on the Render service was corrected
  to the credential this project already held — nothing created, purchased or rotated — and the
  deployment rebuilt. The first authenticated request after it answered 200.

Criterion 8 moved from blocked to passing the moment a genuinely second account existed; criterion 2
had already moved from a manual pass to an automated one. The scoped suite — `pytest
tests/deployed/test_deployed_acceptance.py tests/deployed/test_deployed_rls_gate.py -m deployed` —
now reports **83 passed, 0 failed, 0 errors, 0 skipped**.

Nothing remains. **Task 25.4 is checked.**

**A gap this pass found, and closed.** The record above used to say the suite implemented criterion
6. It did not. `test_an_authenticated_stream_completes` covered criterion 7, and 34.7's module has
an `/ask` helper for the model-resolution criteria, but nothing anywhere asserted that an answer's
figures appear in its evidence against the deployment — the criterion was listed as pending when it
was in fact unwritten, which is worse than pending. `test_a_question_s_every_figure_appears_in_its_evidence`
now covers it and skips like its siblings. It holds the answer to its own grounding report, which is
documented as verified exactly when every figure in the prose matched a finding or an evidence
value, and additionally requires that the report checked a non-zero number of figures, listed no
ungrounded ones, and did not withhold the prose — a verified report over nothing checked is the
shape a broken extractor takes. Then it follows `evidence_id` to `/evidence/{id}` as the same
caller and requires the two request identifiers to agree, which is the round trip a person makes
when they follow an answer's evidence link.

**No inference call was made, and none could be.** Criterion 6 is the only one that would reach
OpenRouter, and it is protected. The production configuration is intact and untouched:
`/api/v1/ready` reports `inference_provider` as `configured: true`. Nothing in either pass sent a
prompt, changed a key, or retried a provider — **re-affirmed on 2026-09-11**, where the whole
re-verification was GETs plus method-only refusal probes that are answered at the authentication
boundary before any handler runs.

**What production discloses when it refuses.** Six read-only probes across the public and
unauthenticated-protected surface — `/ready`, `/me`, `/me/usage`, `/evidence/{unknown}`, a baseline
with an instantaneous measure, and a forecast for an unresolvable location — were checked for
`SCREAMING_SNAKE_CASE` configuration identifiers, stack-trace markers, and gateway or database
credential shapes. **All six clean**, each answering its own stable code: `token_missing` three
times, `validation_failed`, `location_not_found`. This is the production side of task 33.5's rule
that a refusal names no configuration a reader cannot act on.

**Deterministic analytics are the arithmetic, not the model.** `/weather/analysis` needs no session
and no inference provider, and every figure it returned carried `data_class: computed_statistic`,
`points_used`, and its method named in full — *arithmetic mean of usable points*, *maximum minus
minimum over usable points*, *Theil-Sen slope (median of pairwise slopes) per day* with its
insignificance margin. The summary is composed from those figures and names the provider. There is
no path by which a language model produced any of it: the endpoint is public, and a public endpoint
has no principal to bill an inference call to.

**What would close it.** Criterion 8 needs a genuine second production account in
`WEATHRA_LIVE_USER_B_*`. Criteria 6 and 7 need the inference condition in `docs/agents.md` resolved;
they are no longer waiting on a credential of Weathra's. Criterion 1 needs a signup the automation
performs itself against a real inbox, which nothing in this repository can provide today — it is the
one criterion that will not be closed by supplying a variable.

### Task 25.3's standing, stated as a whole

The task reads: *run the authentication and authorization suite of group 18 against the deployed
backend and record the results; verify every case passes, including cross-user isolation and the RLS
gate.* Its cases divide into three, and the division is the reason the task is still open.

**Proven against the deployment, with no credential** — re-run 2026-09-11, 0 failures: 18.3 on all
eighteen protected operations, 18.4 on nine token shapes including a structurally valid one signed by
a key production has never seen, 18.8's unauthenticated half, 18.10's redirects with the destination
kept, and 18.11 on the served bundle. Two structural assertions hold the list to `openapi.json`, so
a protected path cannot be added without a check.

**Proven against the deployment, with one live session** — new on 2026-09-11, and the first time any
of it has run: 18.2's valid-request case on `/me`, `/me/locations`, `/threads` and `/evidence/{id}`,
each answering 200 and acting as the token's own subject and no other; 18.8's authenticated case, in
that a valid token **opens** a stream where an absent one is refused — the stream's *completion* is
25.4's criterion and failed for the inference reason recorded above, which is a different finding
from an authorization one and is recorded as one.

**Proven against the deployed database, read-only** — the RLS gate, now asserted by
`tests/deployed/test_deployed_rls_gate.py` beside the rest of the tier rather than cited from a
scheduled retention run, and now over **all nine** user-owned tables rather than five. Its one-subject
half — the policies enabled and forced, the restricted role unable to log in or bypass them, the
request session genuinely running as that role with the acting subject bound, an anonymous session
seeing nothing, and claims not surviving into the next session — passed in full.

**Proven against the deployment, with two genuinely distinct sessions** — new on 2026-09-11's second
pass, and the first time any of it has run. `WEATHRA_LIVE_USER_B_*` now names a real second account:
its subject and its address both differ from A's, checked against what the deployment itself reports
before anything else ran, because the previous pass's credentials were the first account supplied
twice. On that footing 18.5, 18.6 and 18.7 pass in **both** directions over saved locations and
threads — by listing and by identifier, with the delete attempt asked each way and the owner's row
still there afterwards — and the RLS gate's two-subject half passes over all nine user-owned tables,
with one subject's claims bound against another's rows and the ownership predicate deliberately
omitted. Every record these checks needed was created for them in the dedicated accounts and removed
afterwards; nothing pre-existing was touched.

**Not proven against the deployment** — one case: **18.5's evidence-record isolation**. An evidence
record is what a completed agent run produces, `/agent/ask` does not complete, and there is therefore
no record of A's to ask B about. The check is written and correct; it errors at its fixture rather
than reporting anything, which is the honest outcome and not an isolation finding. Thread isolation
used to be stuck behind the same fixture and is not any more — `/agent/stream` opens a thread before
it reaches inference, so a failed run still leaves a real owned row to ask about. Evidence cannot be
freed the same way: there is no evidence without an answer.

**Closed, 2026-09-11.** The `OPENROUTER_API_KEY` on the Render service was corrected to the
credential this project already held, the deployment rebuilt, and the suite run again: **83 passed,
0 failed, 0 errors, 0 skipped**. The evidence-record case was the last one outstanding and it passes
— A reads its own evidence, B is refused with the same code, message and status it gets for an
identifier that was never issued, and the two refusals differ only in the `request_id` every response
carries. Every case of group 18 now passes against the deployment, and the task is checked.

Recorded for continuity, because the reasoning survives its own resolution: the owner's constraints
were **no new Supabase account is to be created**, **no second test account is to be requested**,
**no personal login credential is to be stored in GitHub Actions** — an Actions secret is readable by
every workflow that names it — and **Supabase Auth configuration is not to be changed** without
evidence that it is wrong, of which there was none. The second account was supplied directly instead,
which satisfies all four.

## No local machine

Task 23.7. Every step of this project — setup, sign-up, test, and deploy — has been carried out from
a browser. Recorded here because the requirement is easy to satisfy by accident and impossible to
demonstrate later: what follows is what actually happened, not a claim that it could have.

| Step | Where it happened | Evidence |
|---|---|---|
| **Setup** | GitHub Codespaces | The repository has no local-machine step: `README.md` opens on a Codespace, and both applications run inside it. `frontend/.env.local` and `backend/.env` are written in the Codespace and never leave it. |
| **Sign-up** | the browser, against production | The product owner created an account at `https://weathra-bice.vercel.app/sign-in` and confirmed it with the emailed code. Recorded in *Verified against the project* above. |
| **Test** | Codespaces and GitHub-hosted runners | The offline suite, the `db` suite against a `pgvector` container, the frontend suites, Playwright in both browsers, and the deployed-acceptance suite all run in the Codespace; `backend.yml` and `frontend.yml` run the same commands on hosted runners for every push. |
| **Deploy** | GitHub Actions | `release.yml` migrates under the privileged connection and releases the container on Render; `frontend-release.yml` builds on the runner and promotes to Vercel. Neither can be run from a workstation: the credentials exist only as repository secrets, and `test_only_the_release_pipeline_reads_a_repository_secret` keeps it that way. |
| **Operate** | GitHub Actions and provider dashboards | Configuration changes go through `backend-allowed-origin.yml` and the Supabase and Vercel dashboards; retention runs unattended on a schedule. Nothing operational needs a shell on a laptop. |

Two things this deliberately does not claim. It does not claim a laptop is *incapable* of running
Weathra — a developer with Docker and Python 3.12 can, and `README.md` says how. And it does not
claim any single person never opened a local editor; what it records is that no step *required* one,
which is the requirement.

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

### The SaaS-layer settings, and what Render does *not* hold

Groups 26 to 32 added backend variables. None is a secret, all have working defaults, and the
service holds only the ones whose default is wrong for a deployed environment.

| Variable | Default | On Render | Why |
|---|---|---|---|
| `MODEL_CATALOG_CACHE_TTL_SECONDS` | `60` | default | The documented staleness window. Each instance holds its own snapshot, so a disable binds within the TTL per instance, not instantly. Set `0` to read every resolution |
| `QUOTA_ENABLED` | `true` | default (**must stay `true`**) | Allowance enforcement. On by default so the development path is the deployed path; setting it `false` in a deployed environment removes the gate |
| `QUOTA_WINDOW_TIMEZONE` | `UTC` | default | The zone the day and month allowance boundaries are computed in. Explicit rather than the container's local time, which would make a reset hour depend on where the process runs |
| `LLM_USAGE_RETENTION_DAYS` | `90` | default | Raw usage-event retention. The scheduled retention job reads it; metadata only, so the window is about storage rather than confidentiality |
| `LLM_FAILOVER_MAX_MODELS` | `2` | default | How many models one call role may attempt, counting the first |
| `MODEL_LAB_MAX_MODELS` / `_MAX_CASES` / `_TIME_BUDGET_SECONDS` | `4` / `40` / `900` | default | Lab bounds. The time budget is wall clock, and a comparison stops between candidates rather than truncating one |
| `LLM_SINGLE_MODEL_MODE` | `false` | **refused** | It bypasses resolution entirely. `Settings` refuses to start a deployed environment with it set, so this is not a variable to be careful with — the service will not boot |

**`DATABASE_URL_PRIVILEGED` is still not on the service**, and the administrative API does not
change that. Every administrative write — a catalog disable, a policy re-order, a plan re-mapping,
a promotion — runs on the ordinary request connection under `weathra_request`, authorized by an
`admin_roles` row and audited into `admin_audit`. The administrative surface is a Row Level
Security boundary, not a second database credential; see [`authentication.md`](authentication.md).

**No policy, plan mapping, allowance or catalog entry is an environment variable.** They are rows,
seeded by migration and administrable at runtime, which is why a model or tier change is a write
against the running system rather than a redeployment.
[`configuration.md`](configuration.md#what-is-deliberately-not-configuration) has the table and the
reasoning; [`model-policy.md`](model-policy.md) has the resolution order.

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

## Open-Meteo request volume per screen

Recorded 2026-09-11 against the production pair — frontend
`https://weathra-bice.vercel.app`, backend `https://weathra-backend.onrender.com`.

Written because ordinary, low-volume manual navigation was repeatedly producing
`open-meteo rate-limited the request`. That is not something to attribute upstream without
first knowing how many requests one screen actually causes.

### What one screen costs

Counts are upstream requests to Open-Meteo, derived from the route → service → provider call
graph and checked against production where a response exposes `from_cache`. "Cold" means no
entry in the process cache for that place; "cached" means a second load inside the TTL
(current 900 s, forecast 3 600 s, history 30 d, geocoding 7 d).

| Screen | Cold load | Cached load | Parallel | Can batch? | Can cache? | Can deduplicate? |
| --- | --- | --- | --- | --- | --- | --- |
| Dashboard | 3 — current, forecast, history | 0 | 2 (current ‖ forecast) | No — three different endpoints | Yes, already | Yes, already |
| Forecast Explorer | 2 — current, forecast | 0 | 2 | No | Yes, already | Yes, already |
| Weather Intelligence Report | 3 — current, forecast, history | 0 | 3 | No | Yes, already | Yes, already |
| Historical Analytics | 1–3 archive calls, by range | 0 | up to 3 | Partly — adjacent ranges could merge | Yes, already | Yes, already |
| Compare Cities (*N* cities) | ***N*** forecasts | 0 | ***N*** | **Yes — not yet done** | Yes, already | Yes, already |
| Travel Intelligence | 1 forecast | 0 | 1 | n/a at one destination | Yes, already | Yes, already |
| Weather Scenario Lab | 1 forecast | 0 | 1 | No | Yes, already | Yes, already |
| Weather Watch | 1 forecast, whatever the number of watches | 0 | 1 | No | Yes, already | Yes, already |
| Resolving a typed place name | 1 geocoding call | 0 | 1 | No | Yes, already | Yes, already |

Two entries are worth reading twice. A Dashboard load is **three** calls rather than the six
endpoints it hits, because `/weather/analysis` and `/weather/changes` ask for the same forecast the
Dashboard already asked for and are served from the cache — verified in production: `/weather/forecast`
for a cold place answered `from_cache: false`, and `/weather/analysis` for the same place and horizon
immediately after answered `from_cache: true`. And a cached load of *any* screen is **zero** upstream
calls, also verified: three consecutive `/weather/current` calls for the same place returned one
`retrieved_at`, the first with `from_cache: false` and the rest `true`.

### Why 429s were reached anyway

The caching, the single-flight collapsing and the 429 handling are all in place and all working.
What produces the refusals is the combination below, and none of it is fixed by caching harder:

1. **The cache is process-local and the process is not long-lived.** `CachedProvider` is built once
   per process in the lifespan, so it is exactly as durable as the Render instance. An instance that
   has been idle and spun down starts empty, which means low-volume manual use — a few minutes of
   clicking, then nothing for an hour — meets a cold cache almost every time. High-volume use would
   hit the cache; occasional use is the pattern that misses it.
2. **The egress IP is shared.** Open-Meteo's free tier limits by IP, and outbound requests from
   Render leave through addresses shared with other tenants. Weathra's own volume is not the only
   volume counted against it, which is why the refusals do not correlate with anything the product
   owner did.
3. **Compare Cities multiplies a cold load by the number of cities.** `ComparisonService.compare`
   issues one forecast per location through `asyncio.gather` — four cities is four simultaneous
   requests from one IP for one screen.

A 429 is *not* retried on the weather path (`RetryPolicy.for_providers` leaves
`rate_limit_max_wait_seconds` at zero), so a refusal costs one request rather than three. That was
fixed earlier and is asserted by test; it is recorded here so the next reader does not re-fix it.

### What changed now

**The agent tool surface no longer discards the shared cache.** `ToolContext.weather(name)` returned
the process-wide `CachedProvider` only when the provider argument was *omitted*. Every weather tool
forwards `arguments.provider`, and that argument is a free-text field the tool schema openly invites
a model to fill in — so a model naming `open-meteo` explicitly got a brand-new empty cache, missed it
by construction, issued an upstream call the shared cache already had the answer for, and then threw
the populated cache away. A name matching the configured default now resolves to the shared provider;
a name for a genuinely different provider still gets its own, which is what the argument is for.

### What is still open

**Batching Compare Cities into one request.** Open-Meteo accepts several coordinates in a single
call — `latitude=52.52,48.85&longitude=13.41,2.35` returns an array of per-location payloads — so an
*N*-city comparison could cost one upstream request instead of *N*. It is not implemented here. The
route is: a `forecast_many` on the `WeatherProvider` protocol with a default implementation that
falls back to today's `asyncio.gather`, so no other provider has to change; `CachedProvider` splitting
the request into the keys it already holds and the ones it does not, asking only for the misses;
`OpenMeteoProvider` joining the misses into one query and un-interleaving the array by index.
The fiddly part is partial failure — today one location failing is excluded from the ranking by name,
and a batched call has to preserve that rather than failing the whole comparison.

**A shared cache across instances.** Every point above about cold processes disappears with a cache
that outlives one. `CachedProvider` is deliberately the seam where that drops in; nothing else would
need to change.

### The remedy the product does not ship with

Reproduced on 2026-09-11, signed in as an existing production account and navigating normally:
naming *Lisbon* on Forecast Explorer resolved the place correctly — "Lisbon, Lisbon District,
Portugal" — and then answered `open-meteo rate-limited the request` in two regions of the screen.
Asking the backend directly for two cold cities immediately afterwards returned
`provider_rate_limited` for both, while cities already in the cache still served. Six upstream calls
had been made in the whole session, so this is not Weathra's own burst.

`OPEN_METEO_API_KEY` is now read (see `docs/configuration.md`). Unset, everything is exactly as it
was — the free hosts, no credential parameter, and a test asserting so. Set, every Open-Meteo call
moves to the `customer-*` hosts with the key attached: forecast, archive **and** geocoding, because
on the free tier resolving a name counts against the same per-IP quota as retrieving weather, and
moving only half would have moved neither in practice.

It is a `SecretStr`, so a settings dump in a log or an error page cannot carry it, and
`request_json` records the provider and the status rather than the URL.

**This is a credential the owner has to obtain and set; it is deliberately not set here.** Until it
is, the graceful 429 handling stays exactly as it is — one refused request rather than three, and a
message rather than a blank screen — and cold cities on a cold instance will sometimes still be
refused.
