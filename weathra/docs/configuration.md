# Configuration

Both applications read **environment variables only**. There is no configuration file holding a
secret, and on the backend nothing outside `weathra/config.py` reads the environment at all —
everything else receives a `Settings` instance.

`backend/.env.example` and `frontend/.env.example` are the copy-and-fill versions of the tables
below, and a test asserts they document exactly the variables the code reads: a setting added
without documentation fails the build, and so does a documented setting nothing reads.

## The classification, and why it is a boundary

| Class | Meaning |
|---|---|
| **required** | The application will not start without it |
| **secret** | Server-side only. Never in the frontend, never `NEXT_PUBLIC_`-prefixed, held in CI and Cloud Run secret storage |
| **behaviour** | Tuning with a documented default; safe to omit |
| **public** | Deliberately shipped to browsers |

Four backend variables are secret: `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`,
`DATABASE_URL_PRIVILEGED`, and `OPENROUTER_API_KEY`. The service-role key is the most consequential
of them — it bypasses every Row Level Security policy — which is why the settings validator
**refuses to start** a request-serving process that has it set, and why CI asserts none of the four
reaches the frontend's environment or its built bundle (`npm run check:secrets`).

**The backend starts and serves every public capability with `OPENROUTER_API_KEY` absent.** The
inference client is constructed by the `/ask` and `/stream` dependencies rather than at startup, so
no other route touches it. This is not a convenience: the offline test suite and the offline
evaluation run both depend on it, and so does the requirement that a missing inference credential
degrade one screen rather than the product.

## Frontend

Everything the frontend reads is public by design and is inlined into the browser bundle at build
time. There are three variables, and there is deliberately no mechanism for a fourth to be a secret.

| Variable | Class | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Supabase public client key (the anon key, or its publishable-key equivalent). Carries no privilege beyond what Row Level Security and Supabase Auth allow an anonymous or signed-in caller |
| `NEXT_PUBLIC_API_BASE_URL` | public | Backend base URL. Changing it retargets the frontend with no code change, so the two applications can sit on different origins or later behind one domain |

`lib/env.ts` is the only module that reads them, and it names the missing variable when one is
unset rather than failing obscurely later. ESLint refuses any non-`NEXT_PUBLIC_` environment read
anywhere under `frontend/`, and the containment check asserts the same boundary on the built
bundle — see [`authentication.md`](authentication.md) for why the split is drawn where it is.

## Backend

| Variable | Default | Class | Purpose |
|---|---|---|---|
| `WEATHRA_RUNTIME_MODE` | `request_serving` | behaviour | `request_serving` for the API and stream processes; `privileged` for migrations, retention, and evaluation provisioning |
| `WEATHRA_ENVIRONMENT` | `development` | behaviour | Names the deployment. Reported by `/health` and `/ready` |
| `LOG_LEVEL` | `INFO` | behaviour | Root log level |
| `API_VERSION_PREFIX` | `/api/v1` | behaviour | Version prefix every route sits under. Changing it moves the whole surface |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | behaviour | Explicit frontend origins, comma-separated. A wildcard is refused |
| `SUPABASE_URL` | — | **required** | Supabase project URL. The issuer and key-set URLs derive from it |
| `SUPABASE_JWT_ISSUER` | — | behaviour | Override when the issuer is not `<SUPABASE_URL>/auth/v1` |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | behaviour | Audience a user token must carry |
| `SUPABASE_JWKS_URL` | — | behaviour | Override when the key set is not at the derived well-known path |
| `SUPABASE_JWKS_CACHE_TTL` | `600` | behaviour | Signing-key cache lifetime. A rotation is picked up within it; an unknown key id refetches immediately |
| `SUPABASE_JWT_LEEWAY_SECONDS` | `30` | behaviour | Clock-skew allowance on expiry and not-before |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **secret** | Bypasses every RLS policy. Permitted only in `privileged` mode; the API refuses to start with it set |
| `DATABASE_URL` | — | **secret** | Request-serving connection, running under the restricted role |
| `DATABASE_URL_PRIVILEGED` | — | **secret** | Migrations, retention, and provisioning only |
| `DATABASE_POOL_SIZE` | `5` | behaviour | Deliberately small: Postgres connection limits bind before application throughput |
| `DATABASE_POOL_MAX_OVERFLOW` | `2` | behaviour | Extra connections a burst may open |
| `DATABASE_RESTRICTED_ROLE` | `weathra_request` | behaviour | Role a request-scoped session assumes so RLS applies to Weathra's own queries |
| `LLM_PROVIDER` | `openrouter` | behaviour | Which client implementation the registry resolves |
| `LLM_MODEL` | `nvidia/nemotron-nano-9b-v2:free` | behaviour | Any gateway model id. Configuration, never architecture |
| `OPENROUTER_API_KEY` | — | **secret** | Absent by design in every offline path. Only `/ask` and `/stream` need it |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | behaviour | Gateway base URL |
| `LLM_TIMEOUT_SECONDS` | `60.0` | behaviour | Per-request inference timeout |
| `LLM_MAX_RETRIES` | `2` | behaviour | Transport retries on a retryable inference failure |
| `LLM_JSON_MAX_ATTEMPTS` | `3` | behaviour | Attempts at a routing plan before the deterministic router takes over |
| `DEFAULT_WEATHER_PROVIDER` | `open-meteo` | behaviour | Provider used when a request names none |
| `DEFAULT_GEOCODER` | `open-meteo` | behaviour | Geocoder used when a request names none |
| `DEFAULT_UNIT_SYSTEM` | `metric` | behaviour | `metric` or `imperial`, when neither the request nor a preference says |
| `DEFAULT_FORECAST_DAYS` | `7` | behaviour | Forecast horizon when a request names none |
| `MINIMUM_HOURLY_HOURS` | `48` | behaviour | Hourly detail guaranteed at least this far into the horizon |
| `HTTP_TIMEOUT_SECONDS` | `10.0` | behaviour | Total timeout for a provider call |
| `HTTP_CONNECT_TIMEOUT_SECONDS` | `5.0` | behaviour | Connect timeout for a provider call |
| `HTTP_MAX_RETRIES` | `2` | behaviour | Retries on a retryable provider failure |
| `HTTP_BACKOFF_SECONDS` | `0.25` | behaviour | Base backoff between provider retries |
| `CACHE_CURRENT_TTL_SECONDS` | `900` | behaviour | Current conditions move quickly |
| `CACHE_FORECAST_TTL_SECONDS` | `3600` | behaviour | A forecast run is issued a few times a day |
| `CACHE_HISTORY_TTL_SECONDS` | `604800` | behaviour | Past weather does not change, so historical entries outlive forecast ones |
| `CACHE_GEOCODING_TTL_SECONDS` | `604800` | behaviour | Places do not move |
| `CACHE_MAX_ENTRIES` | `2048` | behaviour | Bound on the process-local cache |
| `AGENT_MAX_STEPS` | `24` | behaviour | Step budget for one run |
| `AGENT_WALL_CLOCK_BUDGET_SECONDS` | `120.0` | behaviour | Real elapsed budget for one run. Set below the access-token lifetime so a stream cannot outlive its token |
| `COMPARISON_MAX_LOCATIONS` | `8` | behaviour | Upper bound on locations in one comparison |
| `MCP_TRANSPORT` | `in-process` | behaviour | `in-process` or a network transport |
| `MCP_SERVER_ADDRESS` | `http://127.0.0.1:8000/mcp` | behaviour | Where the MCP server listens when it is not in-process |
| `MCP_TIMEOUT_SECONDS` | `30.0` | behaviour | Per-tool-call timeout |
| `MCP_ENABLED_TOOLS` | `geocode_location, weather_current, weather_forecast, weather_history, weather_compare, weather_statistics, weather_anomaly` | behaviour | The tools the server registers. A tool absent here cannot be called at all |
| `EMBEDDING_MODEL_ID` | `BAAI/bge-small-en-v1.5` | behaviour | Embedding model. Changing it requires a re-index |
| `EMBEDDING_DIMENSION` | `384` | behaviour | Vector width. Must match the model and the column |
| `RAG_TOP_K` | `4` | behaviour | Chunks retrieved per query |
| `RAG_RELEVANCE_THRESHOLD` | `0.35` | behaviour | Minimum cosine similarity. Below it, nothing is returned at all |
| `RAG_CHUNK_MAX_TOKENS` | `320` | behaviour | Chunk size at ingestion |
| `RAG_CHUNK_OVERLAP_TOKENS` | `48` | behaviour | Overlap between chunks, so a definition split across a boundary is still retrievable |
| `VECTOR_STORE` | `pgvector` | behaviour | Vector store implementation |
| `THREAD_RETENTION_DAYS` | `30` | behaviour | How long an inactive thread and its checkpoints are kept |
| `SNAPSHOT_RETENTION_DAYS` | `90` | behaviour | How long forecast snapshots are kept |
| `SAVED_LOCATIONS_LIMIT` | `25` | behaviour | Saved locations per person |

## Notes on the ones that bite

**`WEATHRA_RUNTIME_MODE`** is the safety interlock, not a label. In `request_serving` mode the
service-role key is refused and the request connection is used; the privileged command-line jobs
(`weathra-ingest-corpus`, `weathra-retention`) refuse to run in anything but `privileged`. A
migration run under the restricted role fails confusingly, and this is what prevents it.

**`CORS_ALLOWED_ORIGINS`** rejects a wildcard. A credentialed request from any origin is not a
configuration anyone wants by accident.

**`EMBEDDING_MODEL_ID` and `EMBEDDING_DIMENSION`** must agree with each other and with the stored
vectors. Changing either invalidates the index: the retrieval layer detects the mismatch and raises
rather than returning quiet nonsense, and the fix is a re-ingest
(`weathra-ingest-corpus`). [`rag.md`](rag.md) explains the check.

**`RAG_RELEVANCE_THRESHOLD`** is a floor, not a ranking tweak. Below it *nothing* is returned, so a
question the corpus does not cover produces an answer that says so instead of the four
least-irrelevant chunks.

**`AGENT_WALL_CLOCK_BUDGET_SECONDS`** must stay below the Supabase access-token lifetime. The
stream validates its token once, at the start; this budget is what bounds how long a run can
continue afterwards. Raising it above the token lifetime reintroduces the mid-stream expiry the
design avoids.

**`MCP_ENABLED_TOOLS`** is an allow-list at registration. A tool left out of it is not merely
hidden — it is not registered, so a plan that named it gets an error rather than a silent no-op.

**`DATABASE_POOL_SIZE`** is small on purpose. Supabase's connection limits bind long before
application throughput does, and a pool sized for the application starves the database.

**`LLM_MODEL`** is the only place the runtime model is chosen. No model id appears in the backend
outside this setting's default in `config.py`, and a test asserts it across the whole package — so
switching models is an environment change, never a code change. Which id to put there is a
question about the account rather than about Weathra, and there is a command for it:

```
cd backend  && python scripts/list_openrouter_models.py --free --tools
```

It queries the gateway's models endpoint over the same HTTP client and retry policy the weather
providers use, and prints each model's id, context length, tool-calling support where the catalogue
exposes it, and per-million-token cost, free models first. `--search`, `--limit`, and `--json`
narrow or reshape the output; `--help` lists them. It reads `OPENROUTER_API_KEY` from the
environment to fetch the account's own catalogue and **never prints it** — the header line says
only whether a credential was sent, and every message it emits passes through `redaction.redact`
first.

Tool-calling support is worth seeing but is not a requirement: the graph executes tools and the
model proposes (see [`agents.md`](agents.md)), so what the routing path actually needs is reliable
JSON-object output against a supplied schema within `LLM_JSON_MAX_ATTEMPTS` attempts. The eval
suite settles the choice — `weathra-evaluate` against a candidate id — and this command only
narrows the field.

## Where the values live

| Environment | Frontend | Backend |
|---|---|---|
| Local | `frontend/.env.local` | `backend/.env` |
| CI | workflow `env:` — public placeholders only | workflow `env:` plus the Postgres service; no credentials at all |
| Deployed | Cloudflare Pages environment variables | Cloud Run secrets, injected as environment variables |

CI holds no credential. That is why the default suite and the offline evaluation run reach nothing
external: recorded provider payloads, locally minted tokens, a deterministic embedder, and an
in-process MCP transport. [`deployment.md`](deployment.md) covers the deployed values.

`backend/.env` and `frontend/.env.local` are the local files, and both are git-ignored — the
repository is public, so that is a property to check rather than assume. The committed
`.env.example` templates carry placeholders only and are deliberately *not* ignored; the
repository `.gitignore` re-includes them explicitly so a broader pattern cannot quietly make the
templates uncommittable. A real production secret never enters Git at all: it lives in
server-side deployment secret storage — **Google Cloud Secret Manager**, surfaced to the service as
Cloud Run environment secrets, with GitHub Actions secrets for the privileged jobs — and is
injected as an environment variable at start.

### Putting the inference key into `backend/.env`

A credential typed at a prompt ends up in the shell's history file, and one pasted into an editor
session or a chat transcript ends up somewhere it cannot be deleted from. `read -s` avoids both: it
does not echo, and the history records the command rather than the value.

```bash
cd backend
read -rsp 'OpenRouter API key: ' OPENROUTER_KEY; echo
OPENROUTER_KEY="$OPENROUTER_KEY" python3 - <<'PY'
import os, pathlib, re
path = pathlib.Path(".env")
text, count = re.subn(
    r"(?m)^OPENROUTER_API_KEY=.*$",
    "OPENROUTER_API_KEY=" + os.environ["OPENROUTER_KEY"],
    path.read_text(),
)
path.write_text(text)
print(f"OPENROUTER_API_KEY set in backend/.env ({count} line replaced)")
PY
unset OPENROUTER_KEY
```

It rewrites the one line in place, leaves the rest of the file alone, and prints only a count. The
same shape works for any other secret — change the variable name in both places. Verify without
revealing anything, once `SUPABASE_URL` is filled in too:

```
python -c "from weathra.config import get_settings; print(get_settings().inference_configured)"
```

`Settings` holds every secret as a `SecretStr`, so it renders as `**********` in a log line, a
traceback, a `repr`, and `model_dump_json`; the root logger additionally carries a redaction filter
that rewrites anything token- or key-shaped that reaches a log record by another route.

## What is deliberately not configuration

**The design tool** has no environment variable in either application, and needs no key at runtime.
Visily.ai is the design tool for Weathra's UI/UX work — and UXPilot was, in an earlier exploration
whose approved design direction Visily carries forward — but both are design-time tools: they
produce the UI/UX artifacts and the shared design system recorded under [`design/`](design/), and no
Weathra process ever calls either. Weathra's runtime LLM/provider layer is OpenRouter for inference
and Open-Meteo for weather data — those are the only two upstreams the running system has, and the
settings table above is complete. If a design-tool credential is ever needed it belongs to whoever
runs the design tool, not to a deployed Weathra process, and adding one here would fail the test
that asserts this document names nothing the code reads.

The same holds for anything else that is part of how Weathra is *built* rather than how it *runs*:
a tool that never executes inside a Weathra process has no place in `Settings`, in either `.env`
file, or in this table.
