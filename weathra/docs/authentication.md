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

**The administrative role is server-held.** It is backend state keyed by the token subject, read
only by the backend, and **no client-supplied field grants it**: not a body field, a query
parameter, a header, a cookie, or an unverified token claim. A request from an ordinary user
carrying `{"admin": true}`, an `X-Admin` header, or a self-asserted claim is simply a
non-administrative request.

Administrative capabilities — model policy administration, model catalog administration, plan and
allowance administration, reading aggregate usage, and the internal model lab — are refused for
every principal without the role, and the refusal discloses nothing about the capability's
existence or its contents. It is the not-found treatment again, for the same reason.

Two limits on the role, both deliberate:

- **It grants no access to anyone's own data.** An administrative principal asking for another
  person's threads, memory, preferences, saved locations, or evidence records is refused exactly as
  any other caller is. The role reaches the model layer, not people's rows — which is why it is a
  separate question from ownership rather than a stronger answer to it.
- **A privileged write is attributed.** The acting principal and the time are recorded with the
  change, so an administrative action has an author.

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

Ten tables, three classes. The classification lives in the models (`ownership_of`), the migration
that applies the policies, and the tests — all three agree, and a test asserts it.

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

`forecast_snapshots` is location-keyed and carries no user reference — a snapshot of Berlin's
forecast is not anybody's private data, and *what changed* needs the previous snapshot whoever took
it. The knowledge corpus is the same shape: shared, and written only by the ingestion job.

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
   assumes this role inside its transaction with `SET LOCAL ROLE`.
3. **The policies themselves**, applied by migration `0002_row_level_security`.

Shared tables are left unrestricted on purpose, and the test asserts policies are *absent* there as
well as present on the user-owned ones — an asymmetry the spec requires, and one that a test
checking only for presence would let drift.

**The gate is proven independently of the data path.** A `db`-marked test runs a query with its
ownership predicate *deliberately omitted*, under one user's claims, against another user's row —
and gets nothing back. That is the only way to demonstrate that the database, and not the
repository code, is what refused.

## Two database connections

| | Role | Used by | Row Level Security |
|---|---|---|---|
| `DATABASE_URL` | `weathra_request` (restricted) | the API and stream processes | applies |
| `DATABASE_URL_PRIVILEGED` | the owner | migrations, retention, evaluation provisioning | bypassed |

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
