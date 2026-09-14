## Purpose

The measurement apparatus that decides whether Weathra actually works: a fixed dataset of representative questions with known expectations, a runner that executes them and scores ten metrics by stated definitions, and acceptance thresholds that make "good enough" a fact rather than an opinion.

## ADDED Requirements

### Requirement: Evaluation dataset

The system SHALL maintain a versioned evaluation dataset of approximately 40 cases, stored in the repository as structured data rather than embedded in test code, covering these categories with at least four cases each:

- current-conditions and forecast questions
- historical questions
- multi-location comparison questions
- deterministic analytics questions
- RAG / conceptual knowledge questions
- memory and multi-turn questions

Each case SHALL declare: a stable case identifier, its category, the question or ordered sequence of questions, the expected tools or agents, any forbidden tools, the expected answer characteristics, and — where the case asserts a number — the reference value or the deterministic computation that produces it. Multi-turn cases SHALL declare the expected resolution of each turn's references.

#### Scenario: Dataset composition

- **WHEN** the dataset is inspected
- **THEN** it contains approximately 40 cases with at least four in each of the six required categories

#### Scenario: Case declares its expectations

- **WHEN** any case is inspected
- **THEN** it declares an identifier, a category, its question or questions, expected tools or agents, forbidden tools, expected answer characteristics, and any reference value

#### Scenario: Dataset is versioned data, not code

- **WHEN** the dataset is located
- **THEN** it is structured data files in the repository and not literals inside test code

#### Scenario: Multi-turn case declares per-turn resolution

- **WHEN** a memory or multi-turn case is inspected
- **THEN** it declares what each turn's references are expected to resolve to

### Requirement: Metric definitions

The system SHALL compute these ten metrics with exactly these definitions. Each per-case judgment is binary unless stated otherwise, and each rate is the count of passing applicable cases over the count of applicable cases.

| Metric | Definition |
|---|---|
| Tool-selection accuracy | A case passes when every tool in its `expected_tools` was called at least once and no tool in its `forbidden_tools` was called. |
| Numerical calculation accuracy | For cases asserting a number, a case passes when every asserted figure in the answer equals the deterministic reference computed over the same fixture data — exactly for integers and counts, and within a relative tolerance of 1e-6 for floating-point values. |
| Groundedness | A case passes when every numeric weather figure appearing in the answer text is present in that run's evidence record within a stated rounding tolerance, and no figure is present that the evidence does not support. |
| Source attribution coverage | Applies to cases whose answers contain weather data. A case passes when the response carries the source provider, the location, the period or timestamp, and the retrieval time in structured fields. |
| RAG retrieval quality | Applies to conceptual cases. A case passes when at least one retrieved chunk comes from a document the case declares relevant, and the answer cites at least one retrieved document identifier. |
| Memory correctness | Applies to multi-turn cases. A case passes when every turn's resolved entities — locations, units, window, criterion — match the case's declared expected resolution. |
| Multi-turn contextual correctness | Applies to multi-turn cases. A case passes when its final answer satisfies the case's expected answer characteristics given the prior turns, and passes memory correctness. |
| Hallucination rate | The proportion of all cases whose answer contains at least one numeric weather figure absent from the evidence record, or at least one weather claim contradicted by the evidence record. Lower is better. |
| Unsupported weather claim rate | The proportion of all cases whose answer asserts the presence, severity, or likelihood of a severe weather event without a supporting field in the evidence record. Lower is better. |
| Latency | Wall-clock duration from request start to final answer, reported as median and 95th percentile per category and overall. Reported, not pass/fail. |
| Backend successful-response rate | The proportion of evaluation HTTP requests returning a non-5xx, schema-valid response. |

Every metric result SHALL report its numerator, denominator, and the identifiers of the cases that failed it.

#### Scenario: Metric reports its basis

- **WHEN** any metric is computed
- **THEN** the result reports the numerator, the denominator, and the identifiers of failing cases

#### Scenario: Inapplicable cases excluded from a metric

- **WHEN** a metric applies only to a subset of categories
- **THEN** cases outside that subset are excluded from its denominator rather than counted as passes

#### Scenario: Latency reported as a distribution

- **WHEN** latency is reported
- **THEN** the median and 95th percentile are reported per category and overall

### Requirement: Acceptance thresholds

The system SHALL evaluate its metric results against these thresholds and SHALL report an explicit pass or fail per threshold and overall:

| Metric | Threshold |
|---|---|
| Tool-selection accuracy | at least 95% |
| Numerical calculation accuracy | 100% |
| Source attribution coverage | 100% of weather-data answers |
| RAG grounded answer rate | at least 90% |
| Multi-turn contextual correctness | at least 90% |
| Unsupported weather claim rate | below 2% |
| Backend successful-response rate | at least 95% |

A run failing any threshold SHALL be reported as failing, naming which thresholds were missed and by how much. Groundedness, memory correctness, hallucination rate, and latency SHALL be reported for every run whether or not they gate acceptance.

#### Scenario: Run passes

- **WHEN** every threshold is met
- **THEN** the run reports an overall pass with each metric's value

#### Scenario: Run fails a threshold

- **WHEN** numerical calculation accuracy is below 100%
- **THEN** the run reports an overall fail naming that threshold, its value, and the failing case identifiers

#### Scenario: Non-gating metrics still reported

- **WHEN** a run completes
- **THEN** groundedness, memory correctness, hallucination rate, and latency are reported regardless of the pass or fail outcome

### Requirement: Evaluation runner

The system SHALL provide a runner that executes the dataset, records per-case results, computes every metric, evaluates the thresholds, and writes a run record. The runner SHALL accept a category filter and a single-case filter so a subset can be re-run, and SHALL be invocable from the command line and from CI.

Each run record SHALL capture the dataset version, the configured inference provider and model, the weather provider, the embedding model, the commit under test, the start and end times, every per-case result with its evidence, and the computed metrics.

#### Scenario: Full dataset executed

- **WHEN** the runner is invoked over the whole dataset
- **THEN** it records a per-case result for every case and computes every metric

#### Scenario: Subset re-run

- **WHEN** the runner is invoked with a category or case filter
- **THEN** only the matching cases execute
- **AND** the run record states which filter was applied

#### Scenario: Run record captures configuration

- **WHEN** a run completes
- **THEN** its record states the dataset version, inference provider and model, weather provider, embedding model, commit, and timings

#### Scenario: Per-case evidence retained

- **WHEN** a case fails a metric
- **THEN** its evidence record is retained in the run record so the failure can be diagnosed

### Requirement: Deterministic metrics run without external services

The metrics that do not depend on a language model's judgment — numerical calculation accuracy, RAG retrieval quality, memory correctness, and backend successful-response rate — SHALL be executable with recorded weather fixtures and a fake inference provider, with no external network access. The runner SHALL state which mode a run used.

#### Scenario: Offline evaluation mode

- **WHEN** the runner is invoked in offline mode with recorded fixtures and a fake inference provider
- **THEN** the deterministic metrics are computed with no external network access
- **AND** the run record states that offline mode was used

#### Scenario: Live mode recorded

- **WHEN** the runner is invoked against the configured live inference provider
- **THEN** the run record states the provider and model used

#### Scenario: Fixture-backed weather data in evaluation

- **WHEN** a run uses recorded weather fixtures
- **THEN** every numerical reference value is computed over those same fixtures

### Requirement: Evaluation runs authenticate

The runner SHALL execute protected-endpoint cases as an authenticated test user, obtaining a real token for that user rather than bypassing authentication. Multi-turn and memory cases SHALL run under a single test user's identity and threads, and the run record SHALL state which test user identity was used without recording its credential.

Test user provisioning SHALL be repeatable and SHALL NOT depend on a human creating an account by hand before a run.

#### Scenario: Protected cases run authenticated

- **WHEN** the runner executes a case against a protected endpoint
- **THEN** it presents a valid token for the test user
- **AND** the run record names the test user identity without its credential

#### Scenario: Memory cases share one identity

- **WHEN** a multi-turn case executes
- **THEN** every turn runs as the same test user in the same thread

#### Scenario: Test user provisioned repeatably

- **WHEN** a run starts with no existing test user
- **THEN** the runner provisions one without manual intervention

### Requirement: Reproducibility and comparison across runs

Run records SHALL be persisted so that runs can be compared over time, and the runner SHALL report the difference in each metric against a named earlier run when asked. A change in the dataset version SHALL be reported when comparing runs across different dataset versions.

#### Scenario: Runs compared

- **WHEN** the runner is asked to compare the current run against a named earlier run
- **THEN** it reports each metric's change between them

#### Scenario: Dataset version change flagged

- **WHEN** two compared runs used different dataset versions
- **THEN** the comparison states that the dataset version differs

### Requirement: Evaluation results are documented

The system SHALL document the evaluation methodology — the dataset composition, each metric's definition, the thresholds, and how to run the suite — and SHALL record the latest run's results in the repository documentation.

#### Scenario: Methodology documented

- **WHEN** the evaluation documentation is read
- **THEN** it states the dataset composition, every metric definition, the thresholds, and how to run the suite

#### Scenario: Latest results recorded

- **WHEN** an evaluation run is accepted as current
- **THEN** its metric values and pass or fail outcome are recorded in the repository documentation

### Requirement: Candidate models are evaluated through this framework

The system SHALL evaluate a candidate model by running the existing dataset, runner, and metric definitions against it, rather than by any separate or ad-hoc procedure. A model evaluation run SHALL hold every variable but the model fixed: the same dataset version, the same recorded weather fixtures, the same knowledge corpus and embedding model, the same deterministic analytics, and the same commit.

The runner SHALL accept a set of candidate models, or a policy whose candidates are to be evaluated, and SHALL produce one scored result per model over the selected cases. A model that fails or times out SHALL NOT abort the comparison; its failure SHALL be recorded as that model's outcome for the affected cases.

#### Scenario: Candidate evaluated with the existing dataset and metrics

- **WHEN** a candidate model is evaluated
- **THEN** the existing dataset, runner, and metric definitions are used unchanged
- **AND** the result reports every metric the framework defines

#### Scenario: Only the model varies

- **WHEN** several candidate models are evaluated in one comparison
- **THEN** the dataset version, weather fixtures, knowledge corpus, embedding model, analytics, and commit are identical across them
- **AND** the run record states them once for the whole comparison

#### Scenario: Runner accepts models or a policy

- **WHEN** the runner is invoked with a set of candidate models, or with a policy whose candidate list is to be evaluated
- **THEN** it produces one scored result per model over the selected cases

#### Scenario: A failing model does not abort the comparison

- **WHEN** one candidate times out on several cases
- **THEN** the other candidates complete
- **AND** the timeouts are recorded as that model's outcome for those cases

### Requirement: Model selection is decided on measured criteria, not on model name

The system SHALL base a decision to promote a model into a policy on measured criteria, and SHALL NOT base it on the model's name, vendor, or reputation. The criteria SHALL cover at minimum:

| Criterion | Measured by |
|---|---|
| Structured JSON reliability | the proportion of structured-decision calls returning schema-valid output on the first attempt, and the mean attempts to a valid decision |
| Groundedness | the framework's groundedness metric, together with the hallucination rate and the unsupported weather claim rate |
| Latency | median and 95th-percentile latency per call role and overall |
| Tool and planning quality | the framework's tool-selection accuracy, plus multi-step plan correctness — whether the planned capabilities and their order match the case's expectation |
| Cost | estimated cost per case and per run, from the recorded token counts and catalog pricing |

Every model evaluation result SHALL report all five criteria. A model failing structured JSON reliability or groundedness SHALL NOT be promoted on the strength of latency or cost alone, and a promotion decision SHALL record which criteria were compared and the run identifiers relied upon.

Numerical calculation accuracy SHALL remain 100% for every candidate, since figures come from deterministic analytics and not from the model; a candidate whose result shows otherwise indicates a grounding defect rather than a model preference.

#### Scenario: All five criteria reported

- **WHEN** a model evaluation result is inspected
- **THEN** structured JSON reliability, groundedness, latency, tool and planning quality, and cost are all reported

#### Scenario: Structured output reliability measured

- **WHEN** a candidate is evaluated
- **THEN** the proportion of structured calls valid on the first attempt and the mean attempts to a valid decision are reported

#### Scenario: Plan correctness measured

- **WHEN** a multi-step case is evaluated
- **THEN** whether the planned capabilities and their order matched the case's expectation is recorded

#### Scenario: Cost measured from recorded usage

- **WHEN** a candidate's cost is reported
- **THEN** it is computed from that run's recorded token counts and the catalog pricing, and labelled an estimate

#### Scenario: Promotion refused on criteria

- **WHEN** a candidate is cheaper and faster but fails structured JSON reliability or groundedness
- **THEN** it is not promoted on cost or latency alone
- **AND** the decision record names the criteria it failed

#### Scenario: Decision records its basis

- **WHEN** a model is promoted into a policy
- **THEN** the decision records the criteria compared and the evaluation run identifiers relied upon

#### Scenario: Numerical accuracy independent of the model

- **WHEN** any candidate is evaluated over the same fixtures
- **THEN** numerical calculation accuracy is 100%

### Requirement: Model evaluation results are persisted and comparable

The system SHALL persist a model evaluation record per model per run, carrying the model catalog reference and gateway model identifier, the policy context where one applies, the dataset version, every metric and criterion value, the per-case outcomes, the recorded usage the run produced, and the commit under test. Records SHALL be comparable across runs and across models, and SHALL remain readable after a model is disabled or removed from a policy.

Comparing runs that used different dataset versions SHALL state that the dataset version differs, exactly as it does for any other comparison.

#### Scenario: Evaluation record persisted

- **WHEN** a model evaluation completes
- **THEN** a record is persisted carrying the model, policy context, dataset version, metric and criterion values, per-case outcomes, recorded usage, and commit

#### Scenario: Models compared

- **WHEN** two models' evaluation records for the same dataset version are compared
- **THEN** the difference in each metric and criterion is reported

#### Scenario: Records survive a model being retired

- **WHEN** a model is disabled or removed from every policy
- **THEN** its evaluation records remain readable and attributed to it

#### Scenario: Dataset version difference flagged

- **WHEN** two compared model evaluations used different dataset versions
- **THEN** the comparison states that the dataset version differs

### Requirement: Evaluation runs are internal usage

An evaluation run against a live inference gateway SHALL emit a usage event per language model call, classified as internal, attributed to the run rather than to any end user's plan, and accounted against the internal allowance. An evaluation run SHALL NOT consume any end user's allowance and SHALL NOT alter any end user's plan, consumption, threads, memory, preferences, or saved locations.

Offline runs using a fake inference provider SHALL make no gateway call and SHALL be recorded as offline, consuming no allowance.

#### Scenario: Live run accounted as internal

- **WHEN** an evaluation run executes against a live gateway
- **THEN** each language model call emits a usage event classified as internal
- **AND** no end user's plan consumption changes

#### Scenario: Evaluation refused when the internal allowance is exhausted

- **WHEN** the internal allowance is exhausted
- **THEN** a live evaluation run is refused with the quota error
- **AND** product traffic on user plans is unaffected

#### Scenario: Offline run consumes no allowance

- **WHEN** the runner executes in offline mode with a fake inference provider
- **THEN** no gateway call is made and no allowance is consumed
- **AND** the run record states that offline mode was used

#### Scenario: Evaluation leaves user state untouched

- **WHEN** an evaluation run completes
- **THEN** no end user's threads, memory, preferences, saved locations, plan, or consumption have changed

### Requirement: A live evaluation run is pinned to one named model

A live evaluation run SHALL execute against exactly one named inference model for every call role, SHALL NOT vary that model across cases within the run, and SHALL NOT substitute a different model for any reason during the run — including a provider or infrastructure failure. The pinned model SHALL be stated in the run record alongside every distinct model the run observed to have actually served a call, so that a run claiming a model can be checked against what answered.

Where a model policy layer exists, a live evaluation run SHALL resolve its pinned model through a fixed-model evaluation policy rather than through the evaluation test user's subscription plan, so that a change to a plan, a policy, or a candidate pool cannot change what an evaluation run measures.

Comparing several models SHALL be done by executing several pinned runs, one per model, rather than by allowing one run to vary its model.

#### Scenario: One model across the whole run

- **WHEN** a live run executes the dataset
- **THEN** every language model call in every case uses the pinned model
- **AND** the run record states the pinned model

#### Scenario: No substitution on provider failure

- **WHEN** the pinned model fails during a live run
- **THEN** no other model is substituted
- **AND** the run reports the failure rather than continuing against a different model

#### Scenario: Served models recorded against the pinned model

- **WHEN** a live run completes
- **THEN** the run record states every distinct model observed to have served a call
- **AND** a model differing from the pinned one is visible rather than hidden

#### Scenario: Plan changes cannot change what is evaluated

- **WHEN** the evaluation test user's plan or its mapped policy is changed
- **THEN** a live evaluation run still resolves its pinned model

### Requirement: Live runs distinguish provider failure from model quality

A live evaluation run SHALL determine, for every case, whether the pinned model materially served that case, meaning every language model call attempt the case made was served by that model. A case not served by the model SHALL be excluded from every metric numerator and every metric denominator, SHALL NOT be counted as a pass, and SHALL NOT be counted as a failure.

A run SHALL be classified as a provider failure when the proportion of served cases falls below a configured representativeness floor, or when excluding unserved cases leaves any gated threshold with no applicable cases. A run classified as a provider failure SHALL NOT report its metrics as model-quality metrics, SHALL NOT report a threshold verdict, SHALL retain every case's diagnostic evidence, SHALL be persisted with no pass-or-fail verdict rather than as a failure, and SHALL return a result distinguishable from both success and a missed threshold.

Output that failed schema validation SHALL be counted as the model having served the call, and SHALL be scored as a quality outcome rather than classified as a provider failure.

A live run SHALL verify that the pinned model can serve a call before executing the dataset, and SHALL abort as a provider failure without executing any case when it cannot.

An offline run SHALL be classified as not applicable to this judgement rather than as a provider failure, and SHALL continue to compute and gate on every deterministic metric.

#### Scenario: Fully unserved run classified as a provider failure

- **WHEN** every case in a live run falls back because the pinned model is unavailable
- **THEN** the run is classified as a provider failure
- **AND** no threshold verdict is reported and the metrics are not presented as model-quality metrics

#### Scenario: Rate limiting is not a quality failure

- **WHEN** a live run's cases are rate-limited by the gateway
- **THEN** the run is classified as a provider failure rather than as a missed threshold

#### Scenario: Unserved case quarantined from the metrics

- **WHEN** one case in a live run is answered by the deterministic fallback
- **THEN** that case appears in no metric numerator and no metric denominator
- **AND** it is counted neither as a pass nor as a failure

#### Scenario: Invalid model output is scored, not quarantined

- **WHEN** the pinned model returns output failing schema validation
- **THEN** the case is scored as a quality outcome and the run remains eligible to be scored

#### Scenario: Provider failure retains its diagnostics

- **WHEN** a run is classified as a provider failure
- **THEN** every case's evidence is retained and the failure classification and its counts are recorded

#### Scenario: Provider failure persisted without a verdict

- **WHEN** a provider-failure run is stored
- **THEN** it is persisted with no pass-or-fail verdict rather than as a failing run
- **AND** a later comparison reports it as not scored

#### Scenario: Pre-flight aborts before spending the dataset

- **WHEN** the pinned model cannot serve a call at the start of a live run
- **THEN** the run aborts as a provider failure with no case executed

#### Scenario: Offline run unaffected

- **WHEN** an offline run executes
- **THEN** it is classified as not applicable to the served-model judgement
- **AND** every deterministic metric is computed and gated as before

### Requirement: Live runs are paced and bounded against provider limits

A live evaluation run SHALL be able to pace its requests so that executing the dataset does not issue its language model calls as an unbounded burst, and the pacing SHALL be configuration rather than a fixed constant. Retrying a rate-limited call SHALL be bounded, SHALL honour a delay the gateway states where it states one, and SHALL be capped by a configured maximum wait. A run SHALL NOT retry indefinitely, and SHALL NOT resolve a provider limit by lowering a threshold, by excluding a recorded failure from the record, or by substituting another model.

#### Scenario: Pacing configurable

- **WHEN** a minimum interval between cases is configured
- **THEN** a live run honours it and does not issue the dataset's calls as a single burst

#### Scenario: Bounded retry honouring the stated delay

- **WHEN** the gateway rate-limits a call and states a retry delay within the configured maximum wait
- **THEN** the call is retried after that delay

#### Scenario: Retry ceiling respected

- **WHEN** the gateway states a retry delay beyond the configured maximum wait
- **THEN** the call is not retried further and the rate limit is reported

#### Scenario: Provider limits never resolved by adjusting measurement

- **WHEN** a run encounters a provider limit
- **THEN** no threshold is adjusted, no recorded failure is omitted, and no other model is substituted
