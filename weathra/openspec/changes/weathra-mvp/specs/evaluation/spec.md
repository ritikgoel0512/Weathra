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
