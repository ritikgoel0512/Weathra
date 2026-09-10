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

## Did the model actually answer?

A live run's metrics are model-quality metrics **only when the configured model materially served
the run**. This section exists because a run once proved they are not the same thing.

### What went wrong

Two Task 22.8 live runs are stored. Both are recorded `passed = false`, and **neither is a
model-quality result** — but they failed in different ways, which is itself the point.

| Run | Model | Routed by model | Synthesis succeeded | Recorded as |
|---|---|---|---|---|
| `86fd7e31…` | `nvidia/nemotron-nano-9b-v2:free` | **0 / 40** | 0 | threshold failure |
| `fd31cf83…` | `nvidia/nemotron-3-super-120b-a12b:free` | **24 / 40** | 23 | threshold failure |

The first run was executed after its model had been withdrawn upstream. Every inference call
returned HTTP 404, so all forty cases routed deterministically and every synthesis step that ran
failed. Weathra behaved exactly as designed — the supervisor fell back to the keyword router, the
synthesis node fell back to `code_written_summary`, and every question still got a correct, fully
attributed, fully grounded answer. That is the product working.

The evaluation then scored those forty code-written answers as though a language model had written
them, reported tool-selection accuracy of 23/33, missed its thresholds, and recorded the result as
a **quality** failure of a model that had never answered a single call. The run record named the
provider and the model — because it read them off the *configured* client, which names a model
whether or not it replies.

The second run is the more instructive one. Its replacement model *did* answer — for 24 of 40
cases. The other 16 fell back. Its recorded tool-selection accuracy of 28/33 was therefore computed
over a **mixture** of model-routed and fallback-routed cases, and is not a measurement of either.
Why those 16 fell back cannot be recovered from the stored records: the classification that would
have said `rate_limited` or `model_unavailable` did not exist yet. A free-tier account receiving
forty cases at up to two calls each as a single unpaced burst is the most likely explanation, which
is what `EVALUATION_LLM_MIN_INTERVAL_SECONDS` now addresses.

That second run is exactly the case this work exists to make visible: **partially served, and
therefore not interpretable in either direction.** Under the rules below both runs classify as
provider failures and neither reports a threshold verdict.

Both runs are retained unchanged, with `passed = false` as originally recorded. Rewriting a stored
verdict would be the same category of dishonesty this section exists to prevent — those rows record
what the system concluded at the time, and that is a fact about the runs. Nothing in either should
be read as a measurement of the model it names.

### What the record now says

Every language model call attempt is recorded on the evidence record as an `InferenceAttempt`,
with the stage, the attempt number, the outcome, the provider, the model selected, the model the
gateway reported as having served it, the provider status where the failure had one, and why the
run continued as it did.

| Outcome | Meaning | Served? |
|---|---|---|
| `served` | A completion came back | yes |
| `invalid_output` | The model answered; the output failed schema validation | **yes** |
| `rate_limited` | 429 from the gateway | no |
| `model_unavailable` | 404 — the model is not served | no |
| `provider_error` | 5xx, another 4xx, or a completion with no text | no |
| `timeout` | A timeout, or a connection or DNS failure | no |
| `not_configured` | No inference credential, or one the gateway rejected | no |

`invalid_output` counting as *served* is the load-bearing row. A model that answers with
unparseable JSON has materially served the evaluation and performed badly — that is a quality
result and is scored as one. Folding it into infrastructure would let a weak model launder its
failures as an outage, which is the exact mirror of the defect above.

### Quarantine, then gate

A case is **model-served** when every attempt it made was served — not "at least one". A case whose
routing came from the model and whose prose came from code is contaminated in precisely the
dimension the wording metrics measure.

An unserved case is **excluded from every numerator and every denominator**. It is not counted as a
pass and not counted as a failure. This is the treatment an inapplicable case already receives, for
the same reason.

The obvious intuition — that a fallback run simply scores worse, so a partial one reads
pessimistically — is wrong, and wrong in the direction that matters. The deterministic router keys
off real vocabulary and routes many questions *correctly*, so tool-selection accuracy can be
**inflated** by fallback; `code_written_summary` copies findings verbatim, so groundedness and
numerical accuracy score *well*. A mixed run is not uniformly worse than a served one — it is
differently shaped, and no interpolation recovers the model's number from it.

The run is then classified `provider_failure` when either:

1. the served-case proportion falls below `EVALUATION_MIN_SERVED_RATE` (default **1.0**); or
2. quarantine leaves a gated threshold that *had* applicable cases with none.

Rule 2 compares against the same metrics computed without quarantine, so a legitimately filtered
run — `--category knowledge` has no numeric cases — is reported as unmeasured rather than as a
provider failure. Rule 1 defaults to 1.0 because two gating thresholds are 100%, and a 100% gate
over a basis silently shrunk by quarantine is a weaker claim wearing the same number.

A `provider_failure` run reports **no threshold verdict**, states plainly that its metrics are not
model-quality metrics, retains every case's evidence, and persists with `passed = NULL` — which
`compare_runs` has always rendered as "not scored". No migration was needed: the column was already
nullable and the honest third answer was already expressible; it was simply being collapsed into
"failed".

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Scored; every applicable threshold met |
| `1` | Scored; a threshold missed — **a genuine quality failure** |
| `2` | Misconfiguration (live mode with no credential) |
| `3` | **Provider failure — the model did not serve the run; no quality verdict** |

A provider outage never again shares an exit code with a model that scored badly.

### Pre-flight and pacing

A live run asks the configured model one structured question before executing the dataset. A
non-served answer aborts the run as a provider failure with **no case executed** — one gateway call
instead of eighty. That is what should have happened to both historical runs.

`EVALUATION_LLM_MIN_INTERVAL_SECONDS` (default **5.0**) spaces live cases so the dataset does not
arrive at a free tier's per-minute ceiling as a single burst. It is a property of how the harness
drives the API, never of the product.

The value is arithmetic, not a guess. The 40 cases carry **46 turns**, and routing and synthesis
each call once per turn, so a run makes about 92 gateway calls. At a spacing of *g* seconds and a
per-call latency of *L*, the run sustains `5520 / (39g + 92L)` requests per minute. Against
OpenRouter's 20-per-minute free-tier ceiling, 2s spacing breaches it whenever the model answers in
under about 2.5 seconds; 5s spacing stays under it at any plausible latency. A breach is worse than
it looks: this gateway sends no `Retry-After` on a rate limit, so the bounded-ceiling path cannot
fire, the client spends all three transport attempts, and the turn falls back — costing triple the
quota *and* tripping the served-rate gate into a provider failure.

A 429 is retried within `LLM_RATE_LIMIT_MAX_WAIT_SECONDS` (default **30.0**), honouring the
gateway's own `Retry-After` where it states one — the gateway knows when its window opens and
sub-second linear backoff cannot clear a per-minute limit however often it is repeated. A stated
delay beyond the ceiling stops the retry and reports the limit. There is no unbounded retry, and a
provider limit is never resolved by adjusting a threshold, omitting a recorded failure, or
substituting another model.

### The task 22.10 run — 2026-09-08

The third live run, and the third with **no threshold verdict**. Executed against the configured
model with nothing adjusted: 40 cases, no `--category` or `--case` filter, `EVALUATION_MIN_SERVED_RATE`
at 1.0, 5s spacing, real Open-Meteo, real `fastembed` embeddings, and the derived evaluation user
(`provisioned_now: false` — the account from the 22.8 runs was reused rather than a new one created).

| | |
|---|---|
| Commit | `734d885` |
| Dataset | `1.0.0`, 40 cases selected |
| Provider and model | `openrouter` / `nvidia/nemotron-3-super-120b-a12b:free` |
| Embeddings | `BAAI/bge-small-en-v1.5` |
| Outcome | **`provider_failure`** — exit code 3 |
| Model served | **23 of 40 cases (57.5%)**, against a 100% floor |
| Attempts | 60 served, **22 timed out** |
| Quarantined | 17 cases |

**Why there is no verdict.** The served-rate gate withheld one, and that is the gate working. The
seventeen quarantined cases are the ones the model did not answer; scoring the run would have
computed every metric over the twenty-three it happened to answer, and a rate over a
self-selected subset measures neither the model nor the product. `docs/evaluation.md`'s own history
above is why this gate exists.

**What the twenty-three served cases looked like**, recorded because the per-case observations are
real even though the rates are not generalisable:

| Metric (over the served subset only) | |
|---|---|
| Tool-selection accuracy | 20/20 |
| Numerical calculation accuracy | 2/2 |
| Groundedness | 13/13 |
| Source attribution coverage | 13/13 |
| RAG retrieval quality | 5/5 |
| Memory correctness | 2/2 |
| Multi-turn contextual correctness | 1/2 — `me-unresolvable-reference` failed |
| Hallucination rate | 0/23 |
| Unsupported weather claim rate | 1/23 — `cf-munich-wind` |
| Backend successful-response rate | 23/23 |

**These are not the recorded results of Weathra's evaluation.** The offline run above is, and it
passes all seven thresholds. These ten figures describe twenty-three cases a slow free-tier model
managed to answer.

**How this run differs from the two before it.** The first 22.8 run's model had been withdrawn and
every call returned 404. The second served 24 of 40 with no single dominant cause. This one's
failure is almost entirely **timeout** — 22 of 82 attempts — which is a statement about the free
tier's latency under load rather than about availability or about the model's judgement. Two of the
served cases' tool calls also hit `range_outside_coverage` against the live archive, a boundary the
recorded fixtures never exercise; no case failed because of it.

**What would produce a verdict.** A model that can serve forty cases. That is a decision about
which model to configure, not a threshold to lower: the floor stays at 1.0, the model stays as
configured, and the run stays whole rather than split across days. Until then Weathra has an
offline acceptance result that passes and no live model-quality result at all — stated plainly here
rather than left to be inferred from a green tick.

### What is unchanged

The product's graceful fallback is untouched. `/agent/ask` still returns 200 with a correct,
attributed, grounded answer when the gateway is down. The only difference is that the evidence
record now says so.

## Comparing models

The ten metrics answer "did this run pass". Choosing between two models is a different question,
and `specs/evaluation` names **five criteria** a promotion decision may rest on. They are computed
in `evaluation/criteria.py` from what each run already recorded — nothing is measured twice, and
nothing is measured differently for a comparison than for an ordinary run.

### The five criteria, and how each is measured

| Criterion | Measured by | Definition |
|---|---|---|
| **Structured JSON reliability** | `first_attempt_valid_rate`, `mean_attempts_to_valid` | Of the structured routing decisions observed, the proportion whose *first* attempt parsed and validated against the supplied schema; and the mean number of calls spent reaching a valid decision. Counted per decision rather than per call, so a model needing three attempts once scores worse than one needing one attempt three times |
| **Groundedness** | `groundedness`, `hallucination_rate`, `unsupported_weather_claim_rate` | The groundedness metric as the ten already define it, reported alongside the two rates that say *how* it was lost — a fabricated figure and a weather claim the data does not support are different defects |
| **Latency** | `overall_median_ms`, `p95`, and `by_call_role` | Median and 95th percentile of the recorded per-call latency, **per call role** as well as overall. Per role because a routing call and a synthesis call have different shapes and a single blended figure hides which one is slow. The same percentile implementation as the latency metric, deliberately: two would eventually disagree about the 95th of an even-length sample |
| **Planning quality** | `tool_selection_accuracy`, `plan_correctness`, `plan_order_correct/incorrect` | Whether the tools the plan named were the right ones, and for multi-step cases whether the plan was complete *and in a workable order*. The case identifiers are recorded on both sides, so "which multi-step case did it get wrong" is answerable rather than inferable from a rate |
| **Cost** | `estimated_total`, `estimated_per_case`, token counts | Recorded prompt and completion tokens against the catalog price of the day, in the catalog's currency. `is_estimate` is set and the figure is **labelled an estimate everywhere it appears** — it is computed from a published price, not from an invoice, and it is never presented as an amount owed |

**An unmeasured criterion reports null, never a default.** A candidate evaluated over a subset
containing no multi-step case has not achieved perfect plan correctness — it has not been asked.
Filling that in with `1.0` would put a number on a promotion decision that nothing measured, which
is the failure this layer exists to prevent. Every one of the five is always *present* in the
record; some of them may be null, and null is a finding.

### Why numerical accuracy is not one of the five

Figures come from the deterministic analytics engine, not from the model. The model receives
computed values and writes prose over them; it is never asked to add, average, or compare a number.
So **numerical calculation accuracy is 100% for every candidate over the same fixtures**, and a
criterion on which every candidate always ties cannot inform a choice between them.

It is checked anyway, as an invariant rather than a criterion. `numerical_accuracy_intact` reports
a candidate that failed it — and such a candidate has not lost a comparison, it has **exposed a
grounding defect**: a figure reached an answer without coming from analytics, which is a bug in the
grounding layer that no model choice fixes. Recording it as a criterion would invite trading it
away against a cheaper model, which is precisely backwards.

### What is pinned across candidates

The claim a comparison makes is that **only the model varied**. That claim is worth exactly as much
as the pinning behind it, so the pinned configuration is recorded **once for the whole run** rather
than per candidate — a record that repeated the fields per candidate could describe an unpinned
comparison without contradicting itself.

| Pinned | Why |
|---|---|
| `dataset_version` and the exact `case_ids`, in order | Two candidates scored over different cases are not comparable. The identifiers are recorded, not just the count |
| `mode` — offline or live | An offline run and a live run measure different things |
| `weather_provider` and its fixtures | Every candidate sees the same weather data |
| `embedding_model` | Retrieval must return the same passages, or a candidate is being judged on a different corpus |
| The retrieved passages themselves, for an ad-hoc question | Retrieval is performed **once** and replayed to every candidate, so a re-ranking between candidates cannot be mistaken for a difference between models |
| `commit_sha` | The analytics, the metric definitions and the thresholds are the ones this commit implements |

The deterministic figures, the tool selection and the grounding outcomes are pinned as a
consequence: they do not depend on the model, and a comparison in which they differ has found a
defect rather than a preference.

### Reliability and groundedness cannot be traded away

Two of the five are **gates**; three are not. `GATING_CRITERIA` is
`("structured_json_reliability", "groundedness")`, and the promotion action refuses a candidate
that failed either — *on those grounds specifically*, naming which one, whatever its cost and
latency say.

This is a rule and not a preference. A model that returns invalid JSON half the time makes the
product unreliable in a way no saving compensates for, and a model that fabricates figures makes it
dishonest. Cost and latency are real considerations **among candidates that pass both gates**, and
they are never a reason to promote one that does not. The finding lives in
`criteria.promotion_blockers`; the refusal lives in the promotion action — separated because a
comparison must be free to *measure* a candidate that would be refused, and the decision has to be
recorded against the criteria it was made on.

A promotion is also a **separate, separately authorized write**: a comparison run alone changes no
policy record, no catalog status and no plan mapping. Re-pointing a policy's candidate list is
`PUT /api/v1/admin/policies/{policy_id}/candidates`, which records an `admin_audit` row citing the
comparison run identifiers the decision rests on. So "why is this model first in this policy" is
answerable from the audit trail, and a promotion with no cited run is visible as such.

### How to run a comparison

**Through the administrative API**, which is the supported path — bounded, audited, and accounted
as internal usage attributed to the initiating administrator rather than to any plan:

```
POST /api/v1/admin/lab/comparisons
{"catalog_keys": ["standard-general", "economy-free-primary"], "category": "analysis"}
```

Exactly one of `question` (one ad-hoc question, its retrieval replayed to every candidate) or a
dataset selection (`category` or `case_id`). Not both: a run that did an ad-hoc question *and* a
dataset subset would produce two incomparable halves under one run identifier and a reader could
not tell which half a figure came from. `GET /api/v1/admin/lab/comparisons/{run_id}` reads the run
and its per-model results, and stays readable after a compared model is disabled.

Three bounds are refused **before anything runs**, naming the bound: `MODEL_LAB_MAX_MODELS`
candidates, `MODEL_LAB_MAX_CASES` cases per candidate, and `MODEL_LAB_TIME_BUDGET_SECONDS` of wall
clock. The time budget stops the run *between* candidates and returns a partial result naming what
completed — never a truncated candidate scored as though it had finished, which would be a
fabricated measurement. One candidate failing does not abort the comparison: its outcome carries
the failure classification and the others still produce results.

**Offline**, for the metric definitions and the plumbing rather than for a model choice:
`compare_candidates(settings, candidates, mode=EvaluationMode.OFFLINE)` runs every candidate
against `FakeLLMClient` over the same fixtures. It makes no gateway call, spends no allowance, and
is recorded as offline — so its numbers are about the harness, not about the models.

**Scored against the dataset, and recorded as evidence**, which is the comparison a promotion may
cite:

```
weathra-compare --candidates economy-free-primary,economy-free-secondary \
                --category analysis --mode live --persist
```

A command rather than a route, and not by preference: the evaluation runner builds an application,
and a request must not, so `api/` may not reach that package. The administrative route above runs
the *agent path* per model and records latency, tokens, cost and success; this runs the **evaluation
runner** per model and is therefore the path that produces the five criteria at all. It asks
`LabRunner.plan` for the same three bounds first, and requires a `--category` or `--case`, so a bare
invocation cannot become a full forty-case comparison across four candidates by accident.

`--persist` writes one `model_comparison_runs` row, one `model_evaluations` row per candidate
carrying that candidate's five criteria, and one `model_comparison_results` cell per candidate and
case whose `evaluation_id` points at that candidate's evaluation. That chain — run, cell, evaluation
— is how a policy's cited comparison run is followed back to the measurements it rested on, and it
is what `criteria.promotion_blockers` is read from when the promotion gate refuses a candidate.

Two refusals are deliberate. **An offline comparison is not persisted**: its gates describe
`FakeLLMClient`, which always returns valid JSON, so recording them would let a stand-in promote a
model. And **a candidate that scored no case gets no evaluation row** rather than a row of nulls —
a candidate stopped by the pre-flight has not scored badly, it has not been measured, and the
difference is the whole point of recording criteria in the first place. Both appear in the run's
`unevidenced` map, naming which candidate and why.

Each candidate's run is **pinned to that candidate by catalog key**, validated against the database
rather than the cached snapshot for the same reason an administrative override is, and its
resolution is recorded as `__lab_comparison__` rather than as a policy resolution — a pinned
candidate did not resolve a policy, and an aggregate counting it as one would report a model as
serving a plan it has never been mapped to.

## Comparing runs

Run records are persisted (`evaluation_runs`, `evaluation_case_results`) and can be compared. A
comparison flags a differing dataset version or mode rather than presenting the numbers side by
side as though they were commensurable: an offline run and a live run measure different things, and
so do two runs over different datasets.
