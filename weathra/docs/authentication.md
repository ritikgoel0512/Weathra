# Authentication and authorization

Weathra stores no password material and implements no credential handling. Supabase Auth owns
credentials, email verification, password reset, and session issuance; the backend validates the
tokens Supabase issues and enforces ownership on every row it serves.

There is **one identity path**: a validated bearer token becomes a `Principal`, and nothing else is
identity. Any user, profile, thread, or session identifier arriving in a header, query parameter, or
body is an untrusted parameter at best and is never read as identity.

```
Next.js  ──(email + password, verify, reset)──▶  Supabase Auth
   │                                               │
   │  ◀─────────── session (cookies) ──────────────┘
   │
   └──(Authorization: Bearer <access token>)──▶  FastAPI
                                                   │ validate → Principal(user_id, email, claims)
                                                   ▼
                                        graph / memory / services
                                                   │
                                                   ▼
                                  Supabase Postgres — restricted role, RLS
```

## The flows

### Creating an account

The frontend calls Supabase's `signUp`. The password rules are stated **before** submission, not
revealed by a rejection. An address that is already registered gets the same response as a new one:
confirming that an address has an account tells a stranger something about a person who did not
choose to tell them.

**The rules.** `specs/authentication` requires that they be stated up front and that a rejection
name the rule it failed, but it does not say what they are — so these are recorded decisions, held
in one place (`frontend/lib/auth/password.ts`) and stated on the screen as a checklist that marks
each rule met as a person types:

| Rule | Why |
|---|---|
| At least 12 characters | Length is what actually helps. The Supabase project's minimum-password-length setting is configured to match — see [`deployment.md`](deployment.md) — because a rule the provider enforces and the screen does not state is a rule "revealed by a rejection" |
| No more than 72 characters | The provider hashes with bcrypt, which ignores anything past 72 bytes. Accepting a longer passphrase would silently use part of it |
| Not your email address | A password containing the local part of the address it protects is one guess away from useless |

There is deliberately **no composition rule** — no required symbol, digit, or capital. Current
guidance (NIST SP 800-63B) is that composition rules push people towards predictable substitutions
and reuse while adding little entropy, and Weathra holds no password material to have an opinion
about in the first place.

A rejected password names the first rule it failed, one rule at a time: a list of everything wrong
at once reads as a scolding, and fixing the first usually fixes the rest.

With email confirmation required on the project, `signUp` returns **no session** until the address is
confirmed. So an unverified account has no access token, and the backend never has to decide
whether to trust one — the protection is structural rather than a check that could be forgotten.

### Verification: a code, with the link as a fallback

Supabase's *Confirm signup* email template is configured to include the one-time token
(`{{ .Token }}`), which lets Weathra present its own code-entry screen and call `verifyOtp`. People
who click the link instead land on a route handler that exchanges the token hash and completes the
same verification. **One verification concept, two entry paths.**

The screen distinguishes an incorrect code from an expired one, and each offers the appropriate next
step — a retry for the first, a resend for the second. The resend action has three states of its
own: in progress, confirmed, and rate-limited with how long to wait.

### Signing in

A failure is non-disclosing: an unknown address and a wrong password produce the *same* message. An
unverified account signing in with correct credentials is routed to the verification step rather
than shown a generic error, because the problem is solvable and the person needs to know which
problem it is.

### Password reset

Request, verify, set. The response to a reset request is identical for a known and an unknown
address, for the same reason sign-in failures are. The new-password screen states the rules up
front, and an expired reset shows an expired state with the option to request another.

### Sessions

The session lives in **cookies**, not `localStorage` — via Supabase's SSR helpers — because
Next.js middleware must read it on the server to gate a protected route *before* the screen
renders. A client-only session forces a flash of protected shell first, which the UI spec forbids
outright.

`middleware.ts` refreshes the session on every matched request and writes any refreshed cookies to
both the response and the request, so the render that triggered the refresh reads the new token
rather than the expiring one it arrived with. A 401 from the API is treated as an authentication
event by the shared client — it produces the expired-session state and returns the person to
sign-in with their destination preserved — and is never surfaced as a data or server error.

## Backend token validation

`auth/tokens.py` verifies the token locally:

| Check | Why |
|---|---|
| Signature against the project's JSON Web Key Set | The token is Supabase's, not ours |
| Issuer | A token from another project is not a token for this one |
| Audience | `authenticated` — an anon-key token is not a user session |
| Expiry, with a configured leeway | Clock skew is real; unbounded leeway is not a check |
| Email-verified claim | Defence in depth: an unverified account has no token, and one that appeared anyway is rejected |

**Keys are cached, with a bounded refresh.** The key set is fetched once and held for
`SUPABASE_JWKS_CACHE_TTL` seconds, with an immediate refetch when a token names an unknown key id —
so a rotation is picked up without a redeploy and without a network call per request.

**Calling Supabase's user endpoint on every request was rejected.** It adds an external round trip
to the latency of every protected call and makes Weathra unavailable whenever Supabase's API is
slow. Local validation against published keys is the same trust decision without the coupling.

A validation failure is logged with its reason and **never with the token**. Each failure has its
own stable code — `token_missing`, `token_malformed`, `token_expired`, `token_signature_invalid`,
`token_issuer_invalid`, `token_audience_invalid`, `token_unknown_key`, `email_not_verified` — so a
client can tell an expired session from a malformed token, and a systemic rejection is diagnosable.
The frontend mirrors this list in `frontend/lib/api/errors.ts`, and a backend test fails if the two
disagree.

## The principal, and the application profile

A FastAPI dependency produces `Principal(user_id, email, claims)`. `require_principal` refuses the
request without one; `optional_principal` allows it and yields `None`, which is what lets a public
weather endpoint apply a signed-in caller's unit preference without requiring a session.

Weathra keeps its own `profiles` row keyed by the Supabase user id, created on first authenticated
use. It holds no credential and no contact detail beyond the address the token already carries: it
exists so Weathra's own tables have a foreign key to hang ownership from. Credentials and contact
data stay in Supabase Auth.

## The administrative role, and derived entitlement

Two things about a principal are decided by the backend and by nothing else: whether they are
**administrative**, and what their **plan** entitles them to. Both are the same shape of answer as
ownership — read from backend-held state keyed by the validated token subject — and both are
refused the moment a client tries to supply them.

**The administrative role is server-held.** It is a row in `admin_roles`, keyed by the validated
token subject, and **no client-supplied field grants it**: not a body field, a query parameter, a
header, a cookie, or an unverified token claim. A request from an ordinary user carrying
`{"admin": true}`, an `X-Admin` header, or a self-asserted claim is simply a non-administrative
request.

An earlier build read the role from the validated token's `app_metadata`. That was server-controlled
at Supabase and a defensible stand-in while Weathra held no role state, but it is not what this
document has always said, so `0011` moved it. The difference is the whole property: a claim travels
with the caller, so an identity-provider misconfiguration, a project's metadata copied between
environments, or a token minted by a compromised project each promote somebody. A row promotes
nobody, because Weathra wrote it. Two tests assert the old shape now grants nothing.

The role is written only on the privileged connection. The request-serving role is granted `SELECT`
on `admin_roles` under an owner-only policy and no write of any kind — so the predicate can be
answered on the request path (the quota gate and the model resolver both ask it) without the
privileged connection appearing there, and a caller can discover whether *they* are an
administrator and nothing else. Self-promotion is impossible by grant, not by check.

Administrative capabilities — model policy administration, model catalog administration, plan and
allowance administration, reading aggregate usage, and the internal model lab — are refused for
every principal without the role, and the refusal discloses nothing about the capability's
existence or its contents. It is the not-found treatment again, for the same reason.

Two limits on the role, both deliberate:

- **It grants no access to anyone's own data.** An administrative principal asking for another
  person's threads, memory, preferences, saved locations, or evidence records is refused exactly as
  any other caller is. The role reaches the model layer, not people's rows — which is why it is a
  separate question from ownership rather than a stronger answer to it.
- **A privileged write is attributed.** The acting principal and the time are recorded in
  `admin_audit` with the change — in the *same transaction* as the change, so there is no
  committed change with no record and no record of a change that rolled back. Every write across
  the catalog, the policies, the plans, the allowances, plan assignment and role promotion goes
  through one recorder, because six recorders would be six chances for the seventh to forget.

### The administrative endpoints

Each is **protected and administrative**: a validated token first, then the role. An
unauthenticated call is refused 401 by the same dependency every protected route uses; an
authenticated one without the role is refused 403 by a message that names no capability. The
privileged connection those routes need is itself a dependency *on* the administrative principal,
so there is no ordering in which a caller without the role obtains it.

| Endpoint | What it administers |
|---|---|
| `/admin/models` | Lists and creates model catalog entries. |
| `/admin/models/{catalog_key}` | Edits one model catalog entry. |
| `/admin/models/{catalog_key}/enable` | Returns a model to resolution. |
| `/admin/models/{catalog_key}/disable` | Withdraws a model from resolution, refused for the last one serving a call role. |
| `/admin/policies` | Lists and creates model policies. |
| `/admin/policies/{policy_id}/candidates` | Re-points a policy's ordered candidate list — a model promotion. |
| `/admin/policies/{policy_id}/fallback` | Sets or clears a policy's declared fallback. |
| `/admin/plans` | Lists the subscription plans. |
| `/admin/plans/{plan_code}/policies` | Re-points a plan at different policies, per call role. |
| `/admin/plans/{plan_code}/allowances` | Sets one of a plan's usage allowances. |
| `/admin/allowances` | Lists the usage allowances, per plan and for the internal subject. |
| `/admin/allowances/internal` | Sets one of the internal allowances that lab, evaluation and administrative traffic is accounted against. |
| `/admin/principals/administrators` | Lists who holds the administrative role and who granted it. |
| `/admin/principals/{subject_id}/plan` | Assigns a principal to a subscription plan. |
| `/admin/principals/{subject_id}/role` | Grants and revokes the administrative role. |
| `/admin/usage` | Aggregate language model usage by model, policy, plan, call role, status and period, with internal usage separated. Measures only — never a row, and never one person's. |

The published classification is the same table the application enforces
(`api/classification.py`), stamped into the OpenAPI document's operation descriptions and asserted
against the registered routes by a test — so the documented classification and the enforced one
cannot drift.

**Plan and model entitlement are derived, never asserted.** The effective plan comes from
backend-held state keyed by the token subject. A plan, policy identifier, model identifier,
allowance, or entitlement presented by a caller does not grant access, raise an allowance, or
change which model serves a request — it is ignored for both model resolution and allowance
accounting. A caller bypassing the frontend entirely gets the same outcome as one using it, because
hiding or disabling a control was never the mechanism: it is a presentation convenience, and the
backend refuses the underlying request regardless. This is the same rule as
[the two gates below](#two-gates-deliberately-independent), applied to the model layer instead of
to rows.

*This section is the authorization model for the tables classified below; the resolution order and
the policies themselves belong to `docs/model-policy.md`.*

## Ownership and the table classification

Twenty-one tables, three classes. The classification lives in the models (`ownership_of`), the
migrations that apply the policies, and the tests — all three agree, and a test asserts it.

| Table | Class | Who may read | Who may write |
|---|---|---|---|
| `profiles` | user-owned | its owner | its owner |
| `preferences` | user-owned | its owner | its owner |
| `saved_locations` | user-owned | its owner | its owner |
| `threads` | user-owned | its owner | its owner |
| `agent_runs` | user-owned | its owner | its owner |
| `forecast_snapshots` | shared | anyone | the request path appends |
| `knowledge_documents` | shared, read-only | anyone | the privileged ingestion job |
| `knowledge_chunks` | shared, read-only | anyone | the privileged ingestion job |
| `evaluation_runs` | operational | the privileged role | the privileged role |
| `evaluation_case_results` | operational | the privileged role | the privileged role |
| `subscription_plans` | operational | anyone signed in | the privileged role |
| `model_catalog` | operational | anyone signed in | the privileged role |
| `model_policies` | operational | anyone signed in | the privileged role |
| `usage_limits` | operational | anyone signed in | the privileged role |
| `user_plans` | user-owned | its owner | **the privileged role only** |
| `usage_counters` | user-owned | its owner | its owner |
| `llm_usage_events` | user-owned | its owner | its owner, append-only |
| `model_evaluations` | operational | the privileged role | the privileged role |
| `model_comparison_runs` | operational | the privileged role | the privileged role |
| `model_comparison_results` | operational | the privileged role | the privileged role |
| `admin_roles` | operational | **its own subject only** | the privileged role |
| `admin_audit` | operational | the privileged role | the privileged role |

`forecast_snapshots` is location-keyed and carries no user reference — a snapshot of Berlin's
forecast is not anybody's private data, and *what changed* needs the previous snapshot whoever took
it. The knowledge corpus is the same shape: shared, and written only by the ingestion job.

The SaaS-ready tables added in group 26 follow the same rule and depart from it in three places
that are worth stating rather than leaving to be discovered:

* **`user_plans` is readable and not writable by the request path.** Its policy is `FOR SELECT` and
  its grant is `SELECT`, where every other user-owned table gets `FOR ALL`. An owner policy written
  the usual way would let a caller `INSERT` their own row naming `premium` — and it would pass,
  because it *is* their row. Entitlement is something the backend establishes, so assignment is an
  administrative write on the privileged connection, recorded in `admin_audit`.
* **`usage_counters` is keyed by `subject`, not `user_id`.** The column holds either an auth subject
  or the reserved non-UUID subject `internal`, which is how lab, evaluation and administrative
  traffic is accounted separately. The owner policy compares `subject` against the acting user's id,
  so the internal rows are denied to every caller by arithmetic rather than by a clause.
* **`llm_usage_events` has two ownership shapes and two policies.** Reading is owner-only, so an
  internal row — whose `user_id` is null — is invisible to every caller, since `NULL = anything` is
  not true. Writing is owner-only *plus* the anonymous case, because a call with no principal must
  be recordable with a null subject and never a placeholder. The administrative aggregate is a
  separate privileged read returning counts and sums, which is safe precisely because the table
  holds no prompt, completion or retrieved text.

The four operational policy tables — `subscription_plans`, `model_catalog`, `model_policies` and
`usage_limits` — carry a `SELECT`-only policy for `weathra_request` because resolving a model and
checking an allowance genuinely happen on the request path. The four lab and audit tables carry no
grant and no policy at all: nothing a browser does has any business reading a comparison run's
provenance or the trail of who changed which model.

**Cross-user access is denied identically to a missing record.** Asking for another person's
evidence record, thread, or saved location returns the same not-found response as an identifier that
never existed, because "this exists but is not yours" is itself a disclosure.

### The SaaS-ready tables

The **SaaS-ready tables** — those carrying subscription plans, model policies, the model catalog,
language model usage events, usage limits and consumption, and model evaluations — are classified
in advance, by the same three classes and with the same two gates. They are created by the SaaS
schema migrations, so they are absent from the table above until they exist; the classification is
decided here so the migration has something to conform to rather than the other way round.

| Table class | What it holds | Enforcement |
|---|---|---|
| user-owned | usage events carrying a user identifier, per-principal plan assignment, per-principal consumption counters | Row Level Security enabled with an owner-restricting policy; the request-serving restricted role reads and writes only the owner's rows |
| operational, read-only to users | subscription plans, model policies, model catalog | readable as needed to serve a request; writable only through the administrative path, never by the request-serving restricted role acting for an ordinary user |
| operational, not user-owned | model evaluations, comparison runs and their results, internal consumption counters, administrative audit records | not exposed to an ordinary authenticated caller at all |

Three rules hold across all of them:

1. **No existing policy is weakened, removed, or bypassed** to accommodate a new table. The
   policies on `profiles`, `preferences`, `saved_locations`, `threads`, checkpoints, and
   `agent_runs` are the same before and after, and a test compares them.
2. **No request path reaches a user-owned row through the privileged connection.** A new
   user-owned table is read and written under `weathra_request`, like every other one — otherwise
   the second gate would exist and not apply.
3. **Policies are established by migration**, so they are versioned with the schema rather than
   applied by hand to a running database.

## Two gates, deliberately independent

**Gate one: the ownership predicate.** Every repository query filters by the acting user.

**Gate two: Row Level Security.** Every user-owned table has `ENABLE ROW LEVEL SECURITY` with
`FORCE`, and one policy per table restricting every command to rows the acting user owns — `WITH
CHECK` as well as `USING`, so a write cannot create or move a row into someone else's ownership.

Three pieces make the second gate apply to Weathra's own queries:

1. **`weathra_current_user_id()`** reads the acting user's subject from the `request.jwt.claims`
   setting that the request-scoped session establishes with `set_config`. Deliberately *not*
   Supabase's `auth.uid()`: a policy depending on Supabase's own schema could not be tested against
   a plain Postgres, and the point of the RLS test is that it runs in CI.
2. **The `weathra_request` role** — `NOLOGIN NOBYPASSRLS`. A table's owner is exempt from its
   policies, so the backend's own connection would otherwise bypass RLS entirely. Each request
   assumes this role inside its transaction with `SET LOCAL ROLE`. It is `NOLOGIN` because it is
   *assumed*, never connected as — which is why there is a third role, below.
3. **The policies themselves**, applied by migration `0002_row_level_security`.

**Shared tables carry no owner predicate, which is not the same as carrying no policy.** The corpus
and the location-keyed snapshots have no owner to test — that is their whole classification — so
none of their policies mentions `weathra_current_user_id()`, and a test asserts that asymmetry
rather than only asserting presence on the user-owned side. They do have policies, since migration
`0004_shared_read_policies`, for a reason worth stating plainly:

> **A `GRANT` does not survive Row Level Security.** A table with RLS enabled and no applicable
> policy denies every row to any role that is neither the table owner nor `BYPASSRLS`. The grant
> stays in the catalog looking entirely correct.

Weathra's migrations originally left RLS switched off on the shared tables, so their grants were the
only thing in play. **A managed Postgres may switch it on regardless:** Supabase runs an
`ensure_rls` event trigger that enables Row Level Security on every table created in `public`, which
is a sensible default for a platform that exposes `public` through PostgREST. The three shared
tables therefore came out of migration `0001` with RLS on and no policy, and `weathra_request` — a
role that is neither owner nor `BYPASSRLS` — could reach none of them. Corpus search returned an
empty result and the snapshot append was rejected, with nothing in the ACL to suggest why.

The resolution keeps Row Level Security rather than disabling it, and states the access explicitly:

| Table | Policy | Operations |
|---|---|---|
| `forecast_snapshots` | `_request_read`, `_request_append` | `SELECT`, `INSERT` |
| `knowledge_documents` | `_request_read` | `SELECT` |
| `knowledge_chunks` | `_request_read` | `SELECT` |
| `subscription_plans`, `model_catalog`, `model_policies`, `usage_limits` | `_request_read` | `SELECT` |
| `user_plans` | `user_plans_owner_read` | `SELECT` |
| `usage_counters` | `usage_counters_owner_only` | `SELECT`, `INSERT`, `UPDATE` |
| `llm_usage_events` | `llm_usage_events_owner_read`, `_owner_append` | `SELECT`, `INSERT` |
| `admin_roles` | `admin_roles_owner_read` | `SELECT` |
| `model_evaluations`, `model_comparison_runs`, `model_comparison_results`, `admin_audit` | none, by design | none |

Each is `TO weathra_request` — never `PUBLIC`, `anon`, or `authenticated` — and each mirrors exactly
the grant `0002` already made, so the policy and the ACL say the same thing rather than one silently
overriding the other. `UPDATE` and `DELETE` on the snapshots get neither, because the request path
performs neither: retention expires snapshots under the privileged connection. Keeping RLS on is
worth more than the original grant-only arrangement, because these tables are reachable by
Supabase's own roles through PostgREST, and a policy scoped to `weathra_request` denies those roles
instead of merely not granting them. The shared tables are *not* `FORCE`d, unlike the user-owned
ones: forcing would apply these policies to the table owner, which is the privileged connection that
ingests the corpus and runs retention, and both legitimately touch every row.

Migration `0004` enables RLS on the three tables itself rather than relying on the platform having
done it, so a stock PostgreSQL test cluster and a real project agree on the property under test. A
`db`-marked test asserts the effective behaviour by running real statements as `weathra_request`,
and a further test fails if *any* table ever again grants that role a privilege that Row Level
Security then denies.

### The LangGraph checkpoint tables

Conversation state is the opposite case: it is *user* data, and it lives in four tables Weathra does
not own. LangGraph's saver creates them, so no Alembic revision can — a migration would have to
duplicate the library's schema and track its migrations by hand. `ensure_checkpoint_schema()` runs
at deploy time instead, and it installs the security alongside the schema rather than only the
grants, for the reason above: the same `ensure_rls` trigger fires when the library creates them, so
grants alone would leave every user's memory unreadable.

Ownership is enforced, not merely obscured. Three of the four tables carry `thread_id`, and Weathra
only ever writes the composed key `{user_id}:{thread_id}` into it, so `split_part(thread_id, ':', 1)`
recovers the owner. Each gets one `FOR ALL` policy scoped `TO weathra_request`, comparing that owner
against the same `weathra_current_user_id()` the user-owned tables use — `WITH CHECK` as well as
`USING`, so a write cannot attach a row to someone else's thread. `compose_thread_key` refuses the
separator in either half, which is what makes the split unambiguous by construction.

| Table | Access |
|---|---|
| `checkpoints`, `checkpoint_blobs`, `checkpoint_writes` | RLS enabled; `SELECT/INSERT/UPDATE/DELETE` to `weathra_request`, restricted to its own threads |
| `checkpoint_migrations` | the library's schema-version bookkeeping; privileged only, no grant |

**A policy is only as strong as the identity bound on the connection.** The checkpointer speaks
psycopg over its own pool, not the request session, so it does not inherit the claims
`db/session.py` binds. Every checkpoint statement therefore runs inside `Checkpointer.acting_as()`,
which binds the acting subject for the block; the saver applies it on whichever pooled connection it
picks up, clears it as the cursor closes, and the pool clears it again on return. A graph invoked
outside that block matches no row and writes nothing — it fails closed, loudly, rather than reading
or writing unscoped state.

Retention is deliberately outside all of this. It runs on the privileged connection, deletes every
expired user's rows, and could not satisfy an owner predicate; the checkpoint tables are not
`FORCE`d, so the table owner is not subject to the policies.

**The gate is proven independently of the data path.** A `db`-marked test runs a query with its
ownership predicate *deliberately omitted*, under one user's claims, against another user's row —
and gets nothing back. That is the only way to demonstrate that the database, and not the
repository code, is what refused.

## Two database connections, three roles

| | Authenticates as | Runs as | Used by | Row Level Security |
|---|---|---|---|---|
| `DATABASE_URL` | `weathra_api` (login) | `weathra_request` (restricted) | the API and stream processes | applies |
| `DATABASE_URL_PRIVILEGED` | the owner | the owner | migrations, retention, evaluation provisioning | bypassed |

The two columns differ for the request-serving connection, and that gap is the design. Postgres
will not let a `NOLOGIN` role be connected as, so `DATABASE_URL` needs a login identity of its own —
and the obvious candidate, the owner, would make the request-serving credential and the migration
credential the same secret. So migration `0003_request_login_role` adds **`weathra_api`**: `LOGIN`,
`NOINHERIT`, `NOBYPASSRLS`, no table privileges, and a member of `weathra_request`.

`NOINHERIT` is what makes that membership safe. Without it the restricted role's privileges would
apply to every query automatically and the `SET LOCAL ROLE` would be decorative; with it, the
membership confers exactly one capability — the right to *become* `weathra_request` — so a request
that somehow skipped the role switch runs as a role that can read nothing rather than one that can
read everything. A `db` test asserts precisely that.

**The runtime sequence**, in the order `db/session.py` performs it:

    DATABASE_URL → authenticate as weathra_api → BEGIN
      → set_config('request.jwt.claims', …, local)   the acting user's validated claims
      → SET LOCAL ROLE weathra_request               the policies now bind
      → the handler's queries                        RLS enforced
      → COMMIT / ROLLBACK, then RESET ROLE

Claims are bound *before* the role switch on purpose: the setting is written while still connected
as `weathra_api`, and everything after the switch runs with no privilege beyond what the policies
allow. Both are `SET LOCAL`, so a pooled connection carries neither to the next request.

**`weathra_api`'s password is not in this repository and never will be.** Migration `0003` creates
the role with no password — under SCRAM it therefore cannot authenticate at all until a deployment
sets one out of band with `ALTER ROLE weathra_api PASSWORD …`. That password becomes part of
`DATABASE_URL` and lives only in development and deployment secret storage. The migration owns the
role's structure and membership; the deployment owns its credential.

The separation is enforced at startup: a settings validator **refuses to start** a
request-serving process that has `SUPABASE_SERVICE_ROLE_KEY` set, and the privileged command-line
jobs refuse to run unless `WEATHRA_RUNTIME_MODE=privileged`. A misconfiguration fails loudly at
boot rather than quietly serving requests with RLS bypassed.

## Endpoint protection

Every endpoint is explicitly classified in exactly one place (`api/classification.py`), which the
routers, the OpenAPI security metadata, and the tests all read — so the documented classification
and the enforced one cannot drift. [`api.md`](api.md) lists all of them with the reason for each.

Public endpoints take parameters and return weather. They read no user-owned row, with one exception
the spec names: a signed-in caller's unit preference applies. Protected endpoints are everything
that reads or writes something owned.

**Authorization is enforced in the backend, not the client.** The frontend's route gate is about
experience — nobody should watch a product screen render and then empty itself out — and the backend
rejects an unauthenticated protected request regardless of what the frontend rendered.

## Streaming

The stream is authenticated exactly as the request/response endpoints are: the bearer token is
validated *before* any run begins and the principal is held for the stream's lifetime. Because the
token is validated up front, a long stream does not re-validate on every event; the agent's
wall-clock budget bounds how long a stream can outlive its token, and that budget is configured
below the token lifetime. A token that expires mid-run produces a **terminal authentication error
event** rather than a silent stall, and the frontend routes it to the expired-session state like any
other 401.

## Deletion

Two levels, both available to the person themselves:

- **A thread** — `DELETE /api/v1/threads/{id}` removes the thread record and its LangGraph
  checkpoints. Checkpoints go first: a checkpoint whose thread row is gone is unreachable garbage.
- **Everything** — `DELETE /api/v1/me/data` removes the profile, preferences, saved locations,
  threads, checkpoints, and evidence records, and answers with the count removed per table so the
  person can see what happened rather than being told "done".

The Supabase Auth account itself is deleted in Supabase, which owns it. Retention also runs on a
schedule (`weathra-retention`, privileged) against the configured thread and snapshot windows.

## The secret split

| Where | Variable | Classification |
|---|---|---|
| Frontend | `NEXT_PUBLIC_SUPABASE_URL` | public |
| Frontend | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public |
| Frontend | `NEXT_PUBLIC_API_BASE_URL` | public |
| Backend | `SUPABASE_URL`, the JWT validation settings | not secret |
| Backend | `SUPABASE_SERVICE_ROLE_KEY` | **secret** — privileged jobs only |
| Backend | `DATABASE_URL`, `DATABASE_URL_PRIVILEGED` | **secret** |
| Backend | `OPENROUTER_API_KEY` | **secret** |

No secret may carry a `NEXT_PUBLIC_` prefix. The service-role key bypasses every RLS policy, which
is why it is refused on the request path at all and why CI asserts it appears in neither the
frontend environment nor the built bundle (`npm run check:secrets`, and
`backend/tests/test_env_example.py` for the convention half). [`configuration.md`](configuration.md)
documents every variable.

## Known issue — the code entry silently truncates an over-length code

A hardening follow-up, recorded here rather than fixed inside task 23.2 so that the task records
what was verified rather than quietly absorbing a defect it uncovered.

`normalizeVerificationCode` (`frontend/lib/auth/verification.ts`) reduces what a person types to
digits and then **discards everything past `VERIFICATION_CODE_LENGTH`**, and the code field carries
the same limit as `maxLength`. Both were written for a benign case — a pasted `"Code: 123456"`, a
fat-fingered seventh digit — and for a code of the expected length they behave correctly.

For a code *longer* than the expected length they do something worse than reject it. The extra
digits are dropped without a word, the truncated string then satisfies
`verificationCodeFormatError` because it is exactly the expected length, and it is submitted to the
provider as if it were what arrived in the email. The provider refuses it, and the screen reports
`CODE_INCORRECT` — *"That code is not right."* A correct code, refused, with the interface asserting
the person mistyped it.

This is how the task 23.2 verification failed on its first attempt: the project was configured with
Email OTP Length 8 and the screen was built for 6. It cost a real delivered email and a manual test
to find something the interface had the information to state plainly. Pinning the project to 6
([`deployment.md`](deployment.md)) removes the trigger; it does not remove the failure mode, which
returns the moment a project is configured otherwise.

The smallest fix is to stop discarding: let `normalizeVerificationCode` keep the digits it is given
and let `verificationCodeFormatError` report a code that is too long, in the same voice as the one
that reports a code that is too short. A too-long code is then a stated, visible refusal before the
provider is troubled with it, and a length mismatch announces itself instead of impersonating a
typo. Two test files pin the current wording and would move with it:
`frontend/lib/auth/verification.test.ts` and `frontend/components/auth/verify-email.test.tsx`.

Accepting a provider-configured range (GoTrue permits 6–10) rather than one length is a larger
change and is not proposed here: `specs/authentication` requires only that Weathra submit the code
the configured flow delivered, and a single documented length satisfies that with far less surface.
