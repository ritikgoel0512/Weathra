## Purpose

The persisted register of language models Weathra is allowed to use, together with the metadata the rest of the system reasons about — capability role, context window, structured-output support, pricing, and enable/disable status. It exists so that which models are available is operational data an administrator changes, not a constant compiled into application logic, and so that no business rule is ever coupled to a vendor model identifier.

The catalog is the allowlist the model policy layer resolves against; see `specs/model-policy`. Pricing here is what makes cost estimation in `specs/llm-telemetry` deterministic.

## ADDED Requirements

### Requirement: Model catalog as persisted data

The system SHALL maintain a model catalog as persisted records rather than code constants. Each entry SHALL declare at minimum:

- a stable internal catalog key, kebab-case and independent of any vendor naming
- the gateway provider identifier and the gateway model identifier as the gateway expects it
- a human-readable display name
- one or more capability roles the model is fit for — at minimum a structured-decision role and a prose-synthesis role
- a capability tier used by policies for ordering
- whether the model reliably returns schema-valid structured output
- the context window size
- input and output price per million tokens, with the currency and the date the pricing was recorded
- the status — at minimum enabled and disabled
- free-tier or paid classification

Entries SHALL be readable by the policy layer, the telemetry cost estimator, the quota accountant, and the administrative surface, and SHALL be seeded by migration so a fresh deployment has a working catalog.

#### Scenario: Catalog entry declares its metadata

- **WHEN** any catalog entry is inspected
- **THEN** it declares a catalog key, gateway provider and model identifier, display name, capability roles, capability tier, structured-output support, context window, input and output pricing with currency and pricing date, status, and free-or-paid classification

#### Scenario: Catalog is data, not code

- **WHEN** the catalog is located
- **THEN** it is persisted records administrable at runtime, not literals in application source

#### Scenario: Fresh deployment has a usable catalog

- **WHEN** a fresh deployment applies migrations
- **THEN** the catalog contains at least one enabled entry for each capability role a shipped policy requires

### Requirement: Model availability changes without a code change

The system SHALL allow a model to be added, re-priced, re-tiered, enabled, or disabled without a code change and without a redeployment. A change SHALL take effect for subsequent resolutions within a bounded and documented staleness window, and any caching of catalog state SHALL be invalidated or expired within that window.

#### Scenario: Model added at runtime

- **WHEN** an administrator adds a new enabled entry and appends it to a policy's candidate list
- **THEN** subsequent resolutions can select it with no code change and no redeployment

#### Scenario: Pricing updated at runtime

- **WHEN** an administrator updates an entry's input and output pricing
- **THEN** cost estimates for subsequent calls use the new pricing
- **AND** already-recorded usage events retain the cost estimated at the time of the call

#### Scenario: Change takes effect within the staleness window

- **WHEN** a catalog entry is changed
- **THEN** resolutions reflect the change within the documented staleness window

### Requirement: Enable and disable status is honoured at resolution time

The system SHALL treat a disabled entry as unavailable for resolution. A disabled model SHALL NOT be resolved by any policy, SHALL NOT be accepted as an administrative override, and SHALL NOT be selectable in the internal model lab. Disabling a model SHALL NOT delete its historical usage events or evaluation records, and SHALL NOT retroactively invalidate them.

A model MAY be disabled while a request using it is in flight; the in-flight request SHALL be allowed to complete or fail on its own terms, and the next resolution SHALL skip the model.

#### Scenario: Disabled model skipped

- **WHEN** a policy's first candidate is disabled
- **THEN** resolution skips it and considers the next candidate

#### Scenario: Disabled model refused for an override

- **WHEN** an administrative override or a lab selection names a disabled model
- **THEN** the request is refused with a structured error naming the disabled status

#### Scenario: History survives disabling

- **WHEN** a model with recorded usage events and evaluation records is disabled
- **THEN** those records remain readable and attributed to that model

#### Scenario: In-flight request unaffected

- **WHEN** a model is disabled while a call using it is in flight
- **THEN** that call completes or fails on its own terms and the next resolution skips the model

### Requirement: Business logic is decoupled from vendor model identifiers

No requirement, policy rule, plan mapping, quota rule, agent, node, route, evaluation case, or user-facing string SHALL depend on a specific vendor model identifier or model family name. Rules that need to distinguish models SHALL do so by capability role, capability tier, structured-output support, free-or-paid classification, pricing, or catalog key.

The gateway model identifier SHALL appear only in catalog data, in environment configuration, in recorded telemetry and evaluation results describing what actually ran, and in the request the gateway adapter sends.

#### Scenario: Rules reference roles and tiers, not vendor names

- **WHEN** the policy records, plan mappings, and quota rules are inspected
- **THEN** none selects behavior by a vendor model identifier or model family name

#### Scenario: Vendor identifier confined

- **WHEN** the source is searched for a gateway model identifier
- **THEN** it appears only in catalog data, configuration, recorded results, and the gateway adapter's outbound request

#### Scenario: Renaming a vendor model breaks nothing

- **WHEN** a gateway renames a model and the catalog entry's gateway model identifier is updated while its catalog key is unchanged
- **THEN** every policy, mapping, quota rule, and recorded reference continues to resolve correctly

### Requirement: The catalog is the allowlist

The system SHALL refuse to send a language model request naming a model that is not present in the catalog with an enabled status, whatever the source of the request — a policy, an administrative override, a model lab selection, a caller preference, or configuration. A configured fallback model absent from the catalog or disabled SHALL be treated as unavailable rather than trusted.

#### Scenario: Off-catalog model never called

- **WHEN** a model identifier not present in the catalog reaches the gateway adapter by any path
- **THEN** the call is refused before any network request is made
- **AND** the refusal is recorded with the offending identifier and its source

#### Scenario: Configured fallback validated against the catalog

- **WHEN** the configured fallback model is absent from the catalog or disabled
- **THEN** it is treated as unavailable and the no-eligible-model path applies

### Requirement: Catalog administration is privileged and validated

Creating, editing, enabling, and disabling catalog entries SHALL require an administrative principal and SHALL be refused for every other caller. Each write SHALL record the acting principal and a timestamp. Writes SHALL be validated: a duplicate catalog key or duplicate gateway provider-and-model pair SHALL be refused, a missing or negative price SHALL be refused, a non-positive context window SHALL be refused, and an entry declaring no capability role SHALL be refused. Disabling the last enabled entry for a capability role that a shipped policy requires SHALL be refused unless the request explicitly acknowledges the resulting unavailability.

#### Scenario: Non-administrative write refused

- **WHEN** an ordinary authenticated caller attempts to create, edit, enable, or disable a catalog entry
- **THEN** the request is refused
- **AND** no catalog record changes

#### Scenario: Administrative write recorded

- **WHEN** an administrative principal disables an entry
- **THEN** the change takes effect and the acting principal and time are recorded

#### Scenario: Duplicate entry refused

- **WHEN** an entry is written with a catalog key or a gateway provider-and-model pair that already exists
- **THEN** the write is refused with a structured error naming the conflict

#### Scenario: Invalid metadata refused

- **WHEN** an entry is written with a missing price, a negative price, a non-positive context window, or no capability role
- **THEN** the write is refused with a structured error naming the invalid field

#### Scenario: Disabling the last model for a required role

- **WHEN** an administrator disables the last enabled entry for a capability role a shipped policy requires
- **THEN** the request is refused unless it explicitly acknowledges that the role will have no available model

### Requirement: Catalog state is observable

The system SHALL expose the catalog's current state to an administrative reader — every entry with its metadata, its status, and, where recorded, the outcome of the most recent health or evaluation observation for that model. The catalog SHALL be listable filtered by status and by capability role.

#### Scenario: Catalog listed with status

- **WHEN** an administrative reader lists the catalog
- **THEN** every entry is returned with its metadata and status

#### Scenario: Catalog filtered

- **WHEN** an administrative reader lists the catalog filtered by status or capability role
- **THEN** only matching entries are returned

#### Scenario: Non-administrative read refused

- **WHEN** an ordinary authenticated caller requests the administrative catalog listing
- **THEN** the request is refused and no catalog metadata is disclosed
