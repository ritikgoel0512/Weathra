## Purpose

The backend-controlled layer that decides which language model serves a given request, sitting between the LangGraph orchestrator and the language model client. It turns a subscription plan and a call role into a named policy and a resolved model identifier, server-side and auditably, so that entitlement to a stronger model is a fact the backend establishes rather than something a caller can ask for.

Identity and plan always come from the validated authentication token and backend-held state, never from a client-asserted field; see `specs/authentication`. The set of models a policy may resolve to is data, not code; see `specs/model-catalog`.

## ADDED Requirements

### Requirement: Model policy layer between orchestration and the language model client

The system SHALL resolve the model used for every language model call through a model policy layer that sits between agent orchestration and the language model client contract. No supervisor, capability node, synthesis node, or HTTP route SHALL choose a model identifier itself, and no such component SHALL construct a language model client bound to a model it selected.

The policy layer SHALL accept as input the acting principal (or the absence of one), the principal's effective plan, the call role — at minimum a routing/structured-decision role and a prose-synthesis role — and an optional administrative override, and SHALL return a resolution carrying the policy identifier, the resolved model identifier, and the reason for the resolution.

Substituting the resolved model SHALL NOT change any behavior required elsewhere: routing, tool execution, deterministic computation, evidence capture, grounding enforcement, and streaming SHALL be identical whichever model a policy resolves to.

#### Scenario: Model resolved by the policy layer

- **WHEN** the orchestrator begins a run for an authenticated caller
- **THEN** the model policy layer resolves a policy identifier and a model identifier before any language model call is made
- **AND** the run record states the policy identifier, the resolved model identifier, and the reason

#### Scenario: No component selects a model itself

- **WHEN** the orchestration, node, and HTTP route source files are inspected
- **THEN** none of them selects a model identifier or constructs a language model client for a model of its own choosing

#### Scenario: Different call roles resolve independently

- **WHEN** one run performs a structured routing decision and then a prose synthesis
- **THEN** the policy layer is consulted for each role
- **AND** each call's resolved policy and model are recorded separately

#### Scenario: Resolution does not change behavior

- **WHEN** the same request is served under two different policies resolving to two different models
- **THEN** tool selection, deterministic figures, evidence completeness, grounding enforcement, and stream event ordering are unchanged
- **AND** only the prose wording and the recorded model identity differ

### Requirement: Subscription-aware named policies

The system SHALL define model policies as named, persisted records rather than inline conditionals, and SHALL ship at least these policies:

- `free_default` — the default policy for the free plan and for unauthenticated or plan-less calls that are permitted to reach a model at all.
- `balanced` — a mid-tier policy trading cost against capability.
- `high_reasoning` — a policy favouring stronger structured-reasoning capability.
- `admin_experimental` — a policy reachable only by an administrative or internal principal, used for controlled testing.

Each policy SHALL declare an ordered list of candidate models by catalog reference, the call roles it applies to, and its eligibility condition. A policy SHALL NOT name a vendor model identifier inline in application logic; it SHALL reference catalog entries.

User-facing subscription plans SHALL map onto policies, with at least Free, Plus, and Premium as the initial plan set, and the mapping SHALL be persisted data that can change without a code change. A plan SHALL be able to map to different policies for different call roles.

#### Scenario: Shipped policies present

- **WHEN** the policy records are inspected
- **THEN** `free_default`, `balanced`, `high_reasoning`, and `admin_experimental` are present
- **AND** each declares its candidate models by catalog reference, its applicable call roles, and its eligibility condition

#### Scenario: Plan maps to a policy

- **WHEN** a caller on the Free plan makes a request
- **THEN** the policy layer resolves the policy that the Free plan maps to
- **AND** a caller on the Premium plan making the same request resolves the policy that the Premium plan maps to

#### Scenario: Plan-to-policy mapping changed without code

- **WHEN** the plan-to-policy mapping is changed so that the Plus plan maps to a different policy
- **THEN** subsequent requests from Plus callers resolve the new policy with no code change and no redeployment

#### Scenario: Per-role policy mapping

- **WHEN** a plan maps the routing role to one policy and the synthesis role to another
- **THEN** a single run resolves each role against its own mapped policy

#### Scenario: Administrative policy not reachable by a product plan

- **WHEN** a caller on any of the Free, Plus, or Premium plans makes a product request
- **THEN** `admin_experimental` is never resolved for that request

### Requirement: Entitlement is enforced server-side and never trusted from the client

The system SHALL derive the acting principal's effective plan from backend-held state keyed by the validated token subject. A plan, policy identifier, model identifier, entitlement, or role presented in a request body, query parameter, header, or cookie SHALL NOT grant access to a policy or model the backend has not established the principal is entitled to.

Where a product request carries a model or policy preference, it SHALL be treated as advisory: the policy layer MAY honour it only when the resolved entitlement already permits it, and SHALL otherwise ignore it and resolve the entitled policy without failing the request.

A frontend hiding or disabling a control SHALL NOT be the mechanism that prevents premium model access.

#### Scenario: Client-asserted plan ignored

- **WHEN** a request from a Free-plan caller carries a body field or header claiming the Premium plan
- **THEN** the policy layer resolves the Free plan's policy
- **AND** the claimed field is ignored and does not appear in the resolution reason as an authority

#### Scenario: Client-requested premium model refused without entitlement

- **WHEN** a Free-plan caller names a model that only `high_reasoning` may resolve
- **THEN** the request is served with the entitled policy's model
- **AND** the response does not report the requested model as used

#### Scenario: Advisory preference honoured within entitlement

- **WHEN** a Premium-plan caller names a model that their entitled policy's candidate list already contains and that is enabled in the catalog
- **THEN** the policy layer may resolve that model
- **AND** the resolution reason records that a caller preference was honoured within entitlement

#### Scenario: Direct API call cannot bypass the UI

- **WHEN** a caller bypasses the frontend entirely and calls the API directly asking for a policy above their entitlement
- **THEN** the outcome is identical to the same attempt made through the frontend

#### Scenario: Unauthenticated call resolves no premium policy

- **WHEN** a request with no validated token reaches a path permitted to use a model
- **THEN** only `free_default` may be resolved
- **AND** no plan-derived or administrative policy is resolved

### Requirement: Administrative override is bounded by the allowlist

The system SHALL permit an administrative or internal principal to override model resolution for a call by naming a model, and SHALL accept such an override only when the named model is present in the model catalog and enabled. An override naming a model absent from the catalog or disabled SHALL be refused with a structured error naming the reason, and SHALL NOT fall through to an arbitrary model.

An administrative override SHALL be recorded as an override, naming the overriding principal, and SHALL NOT change the resolution for any other principal.

#### Scenario: Administrative override accepted

- **WHEN** an administrative principal names an enabled catalog model for a run
- **THEN** that model serves the run
- **AND** the record states that an administrative override was applied and by which principal

#### Scenario: Override outside the allowlist refused

- **WHEN** an administrative principal names a model absent from the catalog
- **THEN** the request is refused with a structured error naming the model as not allowlisted
- **AND** no language model call is made

#### Scenario: Override of a disabled model refused

- **WHEN** an administrative principal names a catalog model whose status is disabled
- **THEN** the request is refused with a structured error naming the disabled status

#### Scenario: Override does not leak to other callers

- **WHEN** an administrative override is applied to one run
- **THEN** a concurrent run by a non-administrative caller resolves that caller's entitled policy unaffected

#### Scenario: Non-administrative override refused

- **WHEN** a non-administrative caller supplies an override field naming any model
- **THEN** the field is ignored and the entitled policy is resolved
- **AND** the request is not failed on account of the field

### Requirement: Resolution is deterministic, ordered, and degrades honestly

Given the same principal, plan, call role, policy records, and catalog state, the policy layer SHALL resolve the same policy and model. Resolution SHALL walk the policy's candidate models in declared order and select the first that is present in the catalog and enabled.

When no candidate in the resolved policy is available, the policy layer SHALL fall back in this order: the policy's declared fallback policy where one is declared, then the default policy for the principal's plan, then the configured development fallback model. When none of these yields an available model, the system SHALL fail the language model call with a structured configuration error stating that no eligible model is available, and SHALL NOT silently substitute a model outside the entitled policy or fabricate an answer.

Every resolution and every failure to resolve SHALL be recorded with the policy identifier, the candidates considered, the outcome, and the reason.

#### Scenario: First available candidate selected

- **WHEN** a policy declares three candidate models and the first is disabled in the catalog
- **THEN** the second is resolved
- **AND** the reason records that the first was skipped as disabled

#### Scenario: Resolution is stable

- **WHEN** the same principal makes the same request twice with unchanged policy and catalog state
- **THEN** the same policy and model are resolved both times

#### Scenario: Fallback to the policy's declared fallback

- **WHEN** every candidate in the resolved policy is disabled and the policy declares a fallback policy
- **THEN** the fallback policy is resolved
- **AND** the reason records the fallback

#### Scenario: No eligible model available

- **WHEN** no candidate model, fallback policy, or development fallback yields an enabled catalog model
- **THEN** the language model call fails with a structured configuration error stating that no eligible model is available
- **AND** no answer is produced from an unentitled model and no figure is invented

#### Scenario: Escalation above entitlement never used as a fallback

- **WHEN** a Free-plan caller's policy has no available candidate and a stronger policy's model is available
- **THEN** the stronger policy's model is not resolved for that caller

### Requirement: Configured model remains the development and administrative fallback

The system SHALL retain the configured single model identifier — `LLM_MODEL` — as a development and administrative fallback only. It SHALL be used when no policy resolution is possible, when the policy store is unavailable, or when the system is explicitly run in a single-model development mode, and its use SHALL be recorded as a fallback rather than as a policy resolution.

`LLM_MODEL` SHALL NOT be treated as an entitlement grant: it SHALL NOT be used to serve a caller a model their plan does not entitle them to when policy resolution is available. The system SHALL start and serve every capability that does not require a model with `LLM_MODEL` unset.

#### Scenario: Development single-model mode

- **WHEN** the system runs in single-model development mode with `LLM_MODEL` set
- **THEN** every language model call uses that model
- **AND** each call is recorded as using the development fallback rather than a resolved policy

#### Scenario: Policy store unavailable

- **WHEN** the policy store cannot be read during a request
- **THEN** the configured fallback model serves the call if one is configured and enabled
- **AND** the record states that policy resolution was unavailable

#### Scenario: Fallback is not an entitlement grant

- **WHEN** policy resolution succeeds for a Free-plan caller and `LLM_MODEL` names a model above that entitlement
- **THEN** the resolved policy's model is used and `LLM_MODEL` is not

#### Scenario: Absent configuration does not break unrelated capabilities

- **WHEN** `LLM_MODEL` is unset
- **THEN** location resolution, current weather, forecast, history, analysis, comparison, and knowledge retrieval all serve normally

### Requirement: The policy layer stays provider-agnostic

The model policy layer SHALL express candidate models as catalog references and SHALL treat the inference gateway as configuration. No policy record, resolution rule, plan mapping, agent, node, route, or other application module SHALL hard-code a vendor model identifier or a vendor family name, and none SHALL import a model vendor's SDK.

OpenRouter SHALL be the shipped runtime gateway. Substituting another gateway implementing the same client contract SHALL require changing configuration and catalog data only, not policy logic.

#### Scenario: No vendor model identifier in application logic

- **WHEN** the application source is inspected
- **THEN** no module hard-codes a vendor model identifier or model family name
- **AND** the only place a gateway model identifier appears is catalog data and environment configuration

#### Scenario: Gateway substituted

- **WHEN** a different inference gateway implementing the client contract is configured and catalog entries are pointed at it
- **THEN** policy resolution, telemetry, quota accounting, and orchestration behave identically with no change to policy logic

#### Scenario: New model adopted without a code change

- **WHEN** a new gateway model is added to the catalog and appended to a policy's candidate list
- **THEN** it becomes resolvable with no code change and no redeployment

### Requirement: Model policy never affects deterministic computation or grounding

The resolved policy or model SHALL NOT influence any meteorological figure. Every number a caller sees SHALL continue to come from the deterministic analytics engine and retrieved provider data, and the grounding audit and evidence record SHALL apply identically under every policy. No policy SHALL be able to relax a grounding, attribution, or data-class requirement.

#### Scenario: Figures identical across policies

- **WHEN** the same question over the same fixture data is answered under `free_default` and under `high_reasoning`
- **THEN** every reported figure is identical
- **AND** only the interpretive prose differs

#### Scenario: Grounding applies under every policy

- **WHEN** a synthesis under any policy, including `admin_experimental`, introduces a figure absent from the evidence record
- **THEN** the grounding audit reports it exactly as it would under the default policy

#### Scenario: No policy relaxes attribution

- **WHEN** the policy records are inspected
- **THEN** none carries a field capable of disabling grounding, attribution, data-class labelling, or evidence capture

### Requirement: Policy administration is privileged and auditable

Creating, editing, enabling, and disabling model policies and plan-to-policy mappings SHALL require an administrative principal, SHALL be refused for every other caller, and SHALL be recorded with the acting principal and a timestamp. A policy referencing a model absent from the catalog SHALL be refused at write time with a structured error naming the missing reference.

#### Scenario: Non-administrative write refused

- **WHEN** an ordinary authenticated caller attempts to create or edit a policy or a plan mapping
- **THEN** the request is refused
- **AND** no policy record is written

#### Scenario: Administrative write recorded

- **WHEN** an administrative principal changes a policy's candidate list
- **THEN** the change takes effect for subsequent resolutions
- **AND** the acting principal and the time of the change are recorded

#### Scenario: Dangling model reference refused

- **WHEN** a policy is written referencing a catalog entry that does not exist
- **THEN** the write is refused with a structured error naming the missing reference
