## Purpose

The per-call record of what every language model invocation cost in tokens, money, and time, and whether it succeeded — the measurement substrate that makes model policy decisions, quota enforcement, and model comparison factual rather than anecdotal. It records metadata about calls, deliberately not the content of conversations.

Cost is estimated from the pricing held in `specs/model-catalog`. Quota accounting in `specs/usage-limits` and model comparison in `specs/model-lab` both read from these records.

## ADDED Requirements

### Requirement: Every language model call emits a usage event

The system SHALL record exactly one usage event for every language model call it makes, on every path — agent orchestration, evaluation runs, and the internal model lab alike. Each event SHALL carry at minimum:

| Field | Content |
|---|---|
| `event_id` | stable identifier for the event |
| `user_id` | the acting principal's authentication subject, where a principal exists; explicitly null for a call with no principal, never a placeholder |
| `agent_run_id` | the run the call belongs to, where the call belongs to a run |
| `request_id` | the request correlation identifier, where one exists |
| `model_id` | the catalog reference and the gateway model identifier actually used |
| `policy_id` | the resolved policy identifier, or the recorded fallback indicator |
| `plan` | the acting principal's effective plan at the time of the call, or the internal classification |
| `call_role` | the role the call served — structured decision, prose synthesis, or lab comparison |
| `prompt_tokens` | prompt/input tokens |
| `completion_tokens` | completion/output tokens |
| `total_tokens` | total tokens |
| `estimated_cost` | estimated cost with its currency |
| `latency_ms` | wall-clock duration of the call in milliseconds |
| `status` | success or failure, with a failure reason classification where it failed |
| `created_at` | timestamp of the call |

An event SHALL be written whether the call succeeded or failed. No language model call SHALL be made on a path that does not emit an event.

#### Scenario: Successful call recorded

- **WHEN** a language model call completes successfully
- **THEN** a usage event is recorded carrying every field above
- **AND** its status is success

#### Scenario: Every path instrumented

- **WHEN** the source paths that invoke the language model client are inspected
- **THEN** each is instrumented so that a usage event is emitted for its calls
- **AND** a test fails if a language model call is made without emitting an event

#### Scenario: Unauthenticated call recorded without a subject

- **WHEN** a permitted call is made with no acting principal
- **THEN** the event is recorded with a null user identifier
- **AND** no placeholder or shared identifier is substituted

#### Scenario: Event linked to its run and request

- **WHEN** a call is made within an agent run
- **THEN** its event carries that run's identifier and the request correlation identifier
- **AND** the run's events can be listed from the run identifier

### Requirement: Failures, timeouts, and refusals are recorded

The system SHALL record a usage event for a call that fails, times out, is rejected by the gateway, or returns output that fails schema validation, classifying the failure at minimum as a transport failure, a timeout, a rate limit from the gateway, an authentication or configuration failure, a schema-validation failure, or an unclassified failure. Where the gateway reported token counts for a failed or partial call, they SHALL be recorded; where it reported none, the token fields SHALL be null rather than zero.

A retry SHALL be recorded as its own event, carrying the attempt number and the identifier of the event it retried.

#### Scenario: Timeout recorded

- **WHEN** a call exceeds the configured timeout
- **THEN** an event is recorded with a failure status classified as a timeout and the elapsed latency

#### Scenario: Gateway rate limit recorded

- **WHEN** the gateway returns a rate-limit response
- **THEN** an event is recorded with a failure status classified as a gateway rate limit

#### Scenario: Schema-validation failure recorded

- **WHEN** a structured-output call returns output that fails schema validation
- **THEN** an event is recorded with a failure status classified as a schema-validation failure

#### Scenario: Unknown token counts are null

- **WHEN** a failed call returns no token counts
- **THEN** the token fields are null
- **AND** they are not recorded as zero

#### Scenario: Retry recorded separately

- **WHEN** a call is retried after a schema-validation failure and the retry succeeds
- **THEN** two events exist, the first a failure and the second a success
- **AND** the second carries its attempt number and the identifier of the event it retried

### Requirement: Cost estimation is deterministic and labelled as an estimate

The system SHALL compute estimated cost in Python from the recorded token counts and the catalog pricing in effect at the time of the call, SHALL record the currency and the pricing basis used, and SHALL label the figure as an estimate everywhere it is surfaced. Cost SHALL NOT be produced by a language model and SHALL NOT be presented as a billed amount.

Where token counts are unknown, estimated cost SHALL be null rather than zero. Re-pricing a catalog entry SHALL NOT alter cost already recorded on past events.

#### Scenario: Cost computed from tokens and pricing

- **WHEN** a call records 1,200 prompt tokens and 400 completion tokens on a model with known pricing
- **THEN** estimated cost equals the deterministic computation over those counts and that pricing
- **AND** the currency and pricing basis are recorded

#### Scenario: Cost labelled as an estimate

- **WHEN** cost is surfaced in any response, screen, or report
- **THEN** it is labelled an estimate rather than a billed amount

#### Scenario: Cost null when tokens are unknown

- **WHEN** token counts are unknown for a call
- **THEN** estimated cost is null rather than zero

#### Scenario: Past events not re-priced

- **WHEN** a catalog entry's pricing is changed
- **THEN** previously recorded events retain the cost estimated at the time of their call

#### Scenario: Cost never model-generated

- **WHEN** the cost computation is inspected
- **THEN** it is a pure deterministic function with no language model involvement

### Requirement: Telemetry records metadata, not conversation content

Usage events SHALL NOT store prompt text, completion text, retrieved knowledge text, or any other conversation content. They SHALL store only the metadata fields this capability requires, plus identifiers that reference records held elsewhere under their own ownership and retention rules.

Where diagnosing a failure requires more than metadata, the event SHALL reference the agent run whose evidence record already holds what is retained, rather than duplicating content into telemetry.

#### Scenario: No content in the event

- **WHEN** a stored usage event is inspected
- **THEN** it contains no prompt text, completion text, or retrieved passage text

#### Scenario: Diagnosis by reference

- **WHEN** a failed call needs diagnosing
- **THEN** the event's run identifier locates the run whose evidence record holds the retained detail

#### Scenario: No token material or secret in telemetry

- **WHEN** stored usage events and their logs are inspected
- **THEN** they contain no access token, API key, or other credential material

### Requirement: Telemetry never degrades or blocks the answer path

Recording telemetry SHALL NOT change the answer a caller receives. A telemetry write failure SHALL be logged and SHALL NOT fail the request, SHALL NOT be reported to the caller as a weather or agent error, and SHALL NOT block or delay the response beyond a bounded write budget. Where the telemetry store is unavailable, the system SHALL continue serving requests and SHALL report the telemetry gap to operators.

Telemetry SHALL NOT be recorded in a way that changes the recorded latency of the call it measures; the recorded `latency_ms` SHALL measure the gateway call itself.

#### Scenario: Telemetry write failure does not fail the request

- **WHEN** the telemetry write fails while the language model call succeeded
- **THEN** the caller receives the answer
- **AND** the failure is logged for operators without surfacing as a caller-facing error

#### Scenario: Telemetry store unavailable

- **WHEN** the telemetry store is unavailable
- **THEN** requests continue to be served
- **AND** the gap is reported to operators

#### Scenario: Latency measures the call, not the recording

- **WHEN** an event's latency is inspected
- **THEN** it measures the gateway call's own wall-clock duration and excludes the telemetry write

### Requirement: Telemetry is owner-scoped and internal usage is separated

A usage event carrying a user identifier SHALL be owned by that user and subject to the same ownership and Row Level Security rules as every other user-owned record: a caller SHALL read only their own events, and a caller-supplied identifier SHALL NOT override the token subject as the scope.

Events from administrative, internal, evaluation, and model-lab activity SHALL be classified as internal and SHALL be distinguishable from product usage by a caller in every aggregate. An internal event SHALL NOT be attributed to an end user's plan usage.

An administrative reader SHALL be able to read aggregate usage across users; aggregates SHALL NOT expose another user's individual questions or content, since events hold no content.

#### Scenario: Caller reads only their own events

- **WHEN** an authenticated caller reads their usage
- **THEN** only their own events are returned

#### Scenario: Cross-user read denied

- **WHEN** a caller requests another user's usage events
- **THEN** the request fails without disclosing whether those events exist

#### Scenario: Internal usage distinguishable

- **WHEN** aggregate usage is computed
- **THEN** internal, evaluation, and lab events are reported separately from product usage
- **AND** an internal event is not counted against any end user's plan usage

#### Scenario: Administrative aggregate available

- **WHEN** an administrative reader requests aggregate usage
- **THEN** totals by model, policy, plan, status, and period are returned

#### Scenario: Supplied identifier does not override the token

- **WHEN** a usage read presents a valid token for one user and a field naming another
- **THEN** the read is scoped to the token's subject and the field is ignored

### Requirement: Telemetry is aggregatable and retained for a bounded period

The system SHALL support aggregation of usage events by model, policy, plan, call role, status, and time period, reporting at minimum call count, token totals, estimated cost total, failure rate, and latency as median and 95th percentile. Aggregation SHALL be efficient enough to serve an administrative screen over the retention window.

Raw events SHALL be retained for a bounded configured period and then removed or replaced by retained aggregates, and the retention policy SHALL be documented. A user's raw events SHALL be removed when that user's data is deleted, while non-attributable aggregates MAY be retained.

#### Scenario: Aggregate reports the required measures

- **WHEN** usage is aggregated for a period
- **THEN** call count, token totals, estimated cost total, failure rate, and median and 95th-percentile latency are reported per model, policy, plan, call role, and status

#### Scenario: Retention applied

- **WHEN** the retention period for raw events has elapsed
- **THEN** they are removed or replaced by retained aggregates by the retention process
- **AND** the retention policy is documented

#### Scenario: User deletion removes their events

- **WHEN** a user's account data is deleted
- **THEN** their raw usage events are removed
- **AND** aggregates that no longer attribute to them may be retained

#### Scenario: Aggregation serves a screen

- **WHEN** an administrative reader requests the usage summary over the retention window
- **THEN** the aggregate is returned within the documented response budget
