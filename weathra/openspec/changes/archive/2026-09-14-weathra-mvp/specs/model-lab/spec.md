## Purpose

The internal facility that lets an administrator run the same Weathra question across several allowlisted models and see what actually differed — latency, tokens, estimated cost, structured-output reliability, tool and planning quality, groundedness, and success or failure — so that promoting a model into a policy rests on recorded evidence rather than on a model's reputation.

It is an administrative tool with no privilege of its own: it selects only from the catalog in `specs/model-catalog`, records through `specs/llm-telemetry`, is accounted as internal in `specs/usage-limits`, and scores using the framework in `specs/evaluation`.

## ADDED Requirements

### Requirement: Internal model selection restricted to administrative principals and the allowlist

The system SHALL allow a principal holding the administrative or internal role to select a specific model for a controlled run, and SHALL restrict the selectable set to catalog entries that are enabled. A selection naming a model absent from the catalog or disabled SHALL be refused with a structured error naming the reason.

Every non-administrative caller SHALL be refused access to the model lab, and the refusal SHALL be identical whether the lab exists for them or not — no lab capability, catalog metadata, or model identifier SHALL be disclosed to a non-administrative caller. The role SHALL be established from backend-held state keyed by the validated token subject, never from a client-asserted field.

#### Scenario: Administrator selects an allowlisted model

- **WHEN** an administrative principal selects an enabled catalog model for a controlled run
- **THEN** the run executes against that model
- **AND** the record names the selected model and the selecting principal

#### Scenario: Selection outside the allowlist refused

- **WHEN** an administrative principal selects a model absent from the catalog or disabled
- **THEN** the run is refused with a structured error naming the reason
- **AND** no language model call is made

#### Scenario: Non-administrative access refused

- **WHEN** an ordinary authenticated caller invokes any model lab operation
- **THEN** the request is refused
- **AND** no model identifier, catalog metadata, or lab record is disclosed

#### Scenario: Client-asserted role ignored

- **WHEN** a request carries a body field, header, or unverified claim asserting the administrative role
- **THEN** the assertion is ignored and the request is treated as non-administrative

### Requirement: The same prompt or query compared across models

The system SHALL execute one prompt or one Weathra question across a set of selected models within a single comparison run, holding the input, the retrieved data, and the deterministic computation fixed so that only the model varies. Where a comparison exercises the full agent path, the weather data SHALL come from recorded fixtures or from one shared retrieval, so the models are compared on interpretation and planning rather than on differing upstream data.

A comparison SHALL be executable over a single ad-hoc question and over a named subset of the evaluation dataset. A model that fails SHALL NOT abort the comparison: the run SHALL continue with the remaining models and record the failure.

#### Scenario: One question across several models

- **WHEN** an administrator submits one question with three selected models
- **THEN** each model produces its own result within one comparison run
- **AND** the results are presented side by side against the same input

#### Scenario: Inputs held fixed

- **WHEN** a comparison exercises the agent path
- **THEN** every model sees the same question and the same retrieved weather data
- **AND** every reported figure comes from the same deterministic computation

#### Scenario: Comparison over an evaluation subset

- **WHEN** an administrator runs a comparison over a named category of the evaluation dataset
- **THEN** every case in that category executes against every selected model

#### Scenario: One model's failure does not abort the run

- **WHEN** one selected model times out
- **THEN** the remaining models still produce results
- **AND** the timeout is recorded as that model's outcome

### Requirement: Comparison runs are recorded with their measurements

The system SHALL persist a record for every comparison run and, within it, a result per model per case carrying at minimum: the model catalog reference and gateway model identifier, the policy or lab context, latency in milliseconds, prompt tokens, completion tokens, total tokens, estimated cost, success or failure with a failure classification, and the evaluation result where the case was scored. Each result SHALL reference the usage events it produced and, where the agent path ran, the agent run and its evidence record.

Run records SHALL state who initiated the run, when, the dataset or ad-hoc question used, the catalog state relied on, and the commit under test. Records SHALL be listable and comparable across runs, and a model's results SHALL remain readable after that model is disabled.

#### Scenario: Result record complete

- **WHEN** a comparison result is inspected
- **THEN** it states the model, the context, latency, prompt, completion and total tokens, estimated cost, success or failure with its classification, and the evaluation result where scored

#### Scenario: Result linked to telemetry and evidence

- **WHEN** a comparison result is inspected
- **THEN** it references the usage events it produced and, where the agent path ran, the agent run and its evidence record

#### Scenario: Run provenance recorded

- **WHEN** a comparison run record is inspected
- **THEN** it states the initiating principal, the time, the dataset or question, the catalog state, and the commit under test

#### Scenario: Runs comparable over time

- **WHEN** an administrator compares two comparison runs
- **THEN** the difference in each recorded measure per model is reported

#### Scenario: Results survive a model being disabled

- **WHEN** a compared model is later disabled
- **THEN** its recorded results remain readable and attributed to it

### Requirement: The lab bypasses no security control and no data isolation

A model lab run SHALL execute under the same authentication, authorization, ownership, and Row Level Security rules as any other request. It SHALL NOT read, aggregate, or expose another user's questions, threads, memory, preferences, saved locations, evidence records, or usage events, and SHALL NOT use the privileged database connection to reach user-owned rows.

Where a comparison needs realistic input, it SHALL use the evaluation dataset, recorded fixtures, or the administrator's own data — never another person's conversation content. Lab runs SHALL NOT write to another user's threads, memory, preferences, or saved locations, and SHALL NOT alter any end user's plan, allowance, or consumption.

#### Scenario: No access to another user's data

- **WHEN** a lab run is executed
- **THEN** no other user's question, thread, memory, preference, saved location, evidence record, or usage event is read or exposed

#### Scenario: Lab runs under normal isolation

- **WHEN** a lab run touches user-owned tables
- **THEN** it does so under the request-serving restricted role with the same policies as any request
- **AND** it does not use the privileged connection to reach user-owned rows

#### Scenario: Realistic input from permitted sources only

- **WHEN** a comparison needs a realistic question
- **THEN** it uses the evaluation dataset, a recorded fixture, or the administrator's own data

#### Scenario: No write into another user's state

- **WHEN** a lab run completes
- **THEN** no other user's thread, memory, preference, saved location, plan, allowance, or consumption has changed

### Requirement: Lab usage is internal, bounded, and attributed

Every language model call a lab run makes SHALL emit a usage event classified as internal, attributed to the initiating administrative principal, and accounted against the internal allowance rather than any product plan. Lab runs SHALL be bounded — a maximum number of models per comparison, a maximum number of cases per run, and a wall-clock budget — and SHALL report a partial result naming what completed when a bound is reached, rather than running unbounded.

A lab run SHALL be refused when the internal allowance is exhausted, with the standard quota error.

#### Scenario: Lab calls classified as internal

- **WHEN** a lab run makes language model calls
- **THEN** each emits a usage event classified as internal and attributed to the initiating principal
- **AND** no product plan's consumption changes

#### Scenario: Bounds enforced

- **WHEN** a comparison requests more models or cases than the configured bounds allow
- **THEN** the request is refused naming the exceeded bound

#### Scenario: Wall-clock budget exhausted

- **WHEN** a comparison exceeds its wall-clock budget
- **THEN** it returns a partial result naming which model-and-case results completed

#### Scenario: Lab refused when the internal allowance is exhausted

- **WHEN** the internal allowance is exhausted
- **THEN** a new lab run is refused with the standard quota error

### Requirement: The lab does not change production policy implicitly

A model lab run SHALL NOT change which model any other caller receives. Promoting a compared model into a policy candidate list, enabling it in the catalog, or changing a plan mapping SHALL require an explicit, separately authorized administrative action, and SHALL be recorded with the acting principal, the change made, and the comparison run identifiers cited as its basis where one is cited.

#### Scenario: Lab run leaves policy unchanged

- **WHEN** a lab run completes
- **THEN** the policy records, catalog statuses, and plan mappings are unchanged
- **AND** concurrent product requests resolve exactly as before

#### Scenario: Promotion is an explicit action

- **WHEN** an administrator promotes a compared model into a policy's candidate list
- **THEN** it is a separate authorized administrative write
- **AND** it is recorded with the acting principal, the change, and the cited comparison run

#### Scenario: Promotion of a disabled model refused

- **WHEN** an administrator attempts to promote a model that is not enabled in the catalog
- **THEN** the write is refused with a structured error naming the status
