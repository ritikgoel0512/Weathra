# Evaluation

Weathra's acceptance suite runs 40 cases through the **real application** — the real routers, the
real graph, the real tools, the real analytics — and scores ten metrics against seven thresholds.
It exits non-zero when a threshold is missed, which is what makes it a gate rather than a report.

```bash
cd backend
weathra-evaluate                          # offline: no credentials, no network
weathra-evaluate --output run.json        # keep the per-case evidence
weathra-evaluate --category memory        # one category
weathra-evaluate --case an-berlin-maximum # one case
```

It needs a database (`DATABASE_URL` and `DATABASE_URL_PRIVILEGED`) because memory, evidence records,
and the knowledge index are part of what is being measured. It needs **no inference credential and
no network** in offline mode, which is why it runs on every pull request.

## The dataset

Version `1.0.0`, 40 cases across six categories, in
`backend/weathra/evaluation/dataset/*.json`:

| Category | Cases | What it exercises |
|---|---|---|
| `current_and_forecast` | 8 | Current conditions and forecast windows, units, horizons |
| `analytics` | 8 | Descriptive statistics, trend, anomaly, thresholds |
| `knowledge` | 7 | Concept questions answered from the corpus, and questions it does not cover |
| `historical` | 6 | Archive retrieval, period comparison, baseline comparison |
| `memory` | 6 | Multi-turn threads: references, preferences, and what carries over |
| `comparison` | 5 | Multi-location ranking with per-candidate evidence |

6 of the 40 are multi-turn. Each case declares what it expects — the tools that must be called,
the tools that must **not** be, the figures the answer must assert, the documents a knowledge answer
should draw on, and what each turn of a thread should resolve to — so a metric compares against a
declaration rather than a judgement made after the fact.

## The ten metrics

Definitions here match `backend/weathra/evaluation/metrics.py`, and a test asserts they do. A
metric that does not apply to a case **excludes** that case rather than passing it: an inapplicable
metric reports no value at all rather than a flattering one.

| Metric | Definition | Denominator |
|---|---|---|
| `tool_selection_accuracy` | Every expected tool called at least once, and no forbidden tool called at all | Every case that declares tool expectations — including a conceptual case that declares only *forbidden* tools, which is one of the more important claims in the set |
| `numerical_calculation_accuracy` | Every asserted figure equals the deterministic reference computed over the same fixture data — exactly for integers and counts, within a 1e-6 relative tolerance for floating point | Cases asserting figures. A case whose reference could not be computed is a **failure**, not an exclusion: it means the run produced no series to compute over |
| `groundedness` | Every numeric weather figure in the answer is present in that run's evidence record | Answers containing figures |
| `source_attribution_coverage` | Provider, location, period, and retrieval time all present | Answers containing weather data. A conceptual answer is *excluded* rather than passed — it has nothing to attribute, and counting it would inflate the metric while measuring nothing |
| `rag_retrieval_quality` | At least one chunk from a declared-relevant document, and at least one cited identifier | Knowledge cases |
| `memory_correctness` | Every turn resolved as the case declared it should | Multi-turn cases |
| `multi_turn_contextual_correctness` | The final answer satisfies the case's characteristics **and** the case passed memory correctness | Multi-turn cases |
| `hallucination_rate` | The proportion whose answer contains a figure the evidence does not support | **All** cases, as the spec defines it: normalizing over figure-bearing answers only would make the same number of fabrications look worse in a suite that mostly asks conceptual questions |
| `unsupported_weather_claim_rate` | The proportion asserting severity without a supporting field in the evidence | All cases. A *referral* is not a claim — "check your official authority for warnings" asserts nothing about conditions — so the check looks for an assertion and excuses an answer whose evidence carries a field supporting one |
| `backend_successful_response_rate` | The proportion of requests returning a non-5xx, schema-valid response | All requests. A 4xx is a correct response to a bad request and counts as a success |

Latency is reported alongside them — median and 95th percentile, overall and per category — as a
measurement rather than a gate.

## The thresholds

Seven gate the run. Three metrics are reported but do not gate, because the property they measure
is already gated by a stricter neighbour or is diagnostic rather than acceptance.

| Threshold | Gate |
|---|---|
| Tool-selection accuracy | ≥ 95% |
| Numerical calculation accuracy | = 100% |
| Source attribution coverage | = 100% of weather-data answers |
| RAG grounded answer rate | ≥ 90% |
| Multi-turn contextual correctness | ≥ 90% |
| Unsupported weather claim rate | < 2% |
| Backend successful-response rate | ≥ 95% |

Reported, not gating: `groundedness`, `memory_correctness`, `hallucination_rate`.

**A missed threshold is reported, never adjusted.** A threshold moved to make a run pass measures
nothing.

## Offline and live

|  | Offline (the default) | Live |
|---|---|---|
| Weather data | Recorded Open-Meteo payloads, replayed **through the real adapter** | The real provider |
| Tokens | Minted locally from a generated key pair whose public half feeds the JWKS cache | Supabase Auth issues a real session |
| Embeddings | A deterministic hashing model | `fastembed` |
| Routing and prose | A stand-in that states the findings it was handed | A real model over OpenRouter |
| Needs | A database | A database, Supabase credentials, an OpenRouter key |

**Why replay rather than synthesize.** The payloads are genuine Open-Meteo responses replayed
through the real provider adapter, so normalization, timezone resolution, field mapping, and
coverage validation are all exercised on data the provider actually produced. A synthetic generator
would test the arithmetic and skip the layers where a provider's quirks live. Re-record with
`python scripts/record_evaluation_fixtures.py` when the dataset gains a place or a window — an
offline run fails loudly, naming what is missing, rather than reaching the network.

**What offline mode measures, and what it does not.** It measures execution: tool selection against
the plan, the arithmetic, grounding, attribution, retrieval, memory resolution, and the API. It does
**not** measure whether a real model would have routed correctly or worded an answer well, because
the plan is derived from the case's own expectations. Live mode measures those, and
tool-selection accuracy is the metric where the difference shows.

The offline stand-in states the findings it was given and invents nothing. An earlier version
returned figure-free prose, which made numerical accuracy 0% *by construction* — the metric asks
whether the asserted figure equals the reference, and an answer asserting no figure fails that
however well the pipeline computed. The numbers it states come from findings the code produced and
handed over, so the metric measures the pipeline rather than a hard-coded string.

## Test-user provisioning

A run authenticates as a real user and provisions one if it does not exist — a suite that needed
somebody to click "create account" first is a suite that will not run in CI.

The email is **derived**, not random: `evaluation+<slug>@weathra.test`, so re-running provisions the
same user instead of accumulating an account per run. Offline provisions directly through the
privileged connection and mints its own token; live asks Supabase Auth with the service-role key —
one of the four places that credential is permitted, alongside migrations, retention, and the
privileged jobs.

**The identity is recorded; the credential never is.** The run record carries the subject and the
email and holds the access token in a field that does not serialize. A run record is an artifact
people read and CI archives, and a token in one is a token in a log.

## The latest recorded results

Offline run, dataset `1.0.0`, 40 cases, commit `6636115`:

| Metric | Result |
|---|---|
| Tool-selection accuracy | **100.0%** (33/33) |
| Numerical calculation accuracy | **100.0%** (6/6) |
| Groundedness | **100.0%** (30/30) |
| Source attribution coverage | **100.0%** (30/30) |
| RAG retrieval quality | **100.0%** (6/6) |
| Memory correctness | **100.0%** (6/6) |
| Multi-turn contextual correctness | **100.0%** (6/6) |
| Hallucination rate | **0.0%** (0/40) |
| Unsupported weather claim rate | **0.0%** (0/40) |
| Backend successful-response rate | **100.0%** (40/40) |

Latency: median 55 ms, p95 172 ms over 40 samples — 29 ms median for knowledge questions, 134 ms
for multi-turn memory cases. These are offline figures with replayed provider payloads, so they
measure Weathra's own work and not the network.

**All seven thresholds pass.** The CI workflow runs this on every pull request and archives the run
record whether it passed or failed — a failing run's per-case evidence is what makes the failure
diagnosable, and it is gone once the process exits.

## Comparing runs

Run records are persisted (`evaluation_runs`, `evaluation_case_results`) and can be compared. A
comparison flags a differing dataset version or mode rather than presenting the numbers side by
side as though they were commensurable: an offline run and a live run measure different things, and
so do two runs over different datasets.
