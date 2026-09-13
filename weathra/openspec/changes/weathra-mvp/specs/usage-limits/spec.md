## Purpose

Server-side allowances on language model usage, enforced by plan: how many agent requests and how many tokens a Free, Pro, or Premium subscriber may consume in a window, checked in the backend before a call is made and accounted from recorded usage. It keeps a free tier affordable and leaves room for daily, monthly, and future cost-budget dimensions without introducing payment processing.

Allowances are counted from the events in `specs/llm-telemetry` and the plan mapping in `specs/model-policy`. Plan membership always comes from backend-held state keyed by the validated token subject; see `specs/authentication`.

## ADDED Requirements

### Requirement: Subscription plans are persisted server-side data

The system SHALL persist subscription plans as records, with at least Free, Pro, and Premium in the initial set, each declaring a stable plan code, a display name, its policy mappings, and its usage allowances. Every principal SHALL have exactly one effective plan at any time, defaulting to Free where no assignment exists.

A principal's plan SHALL be derived from backend-held state keyed by the validated token subject. A plan named in a request body, query parameter, header, cookie, or token claim not issued by the backend's own plan store SHALL NOT determine the effective plan.

Changing a plan's allowances SHALL take effect for subsequent requests without a code change.

#### Scenario: Plans present with allowances

- **WHEN** the plan records are inspected
- **THEN** Free, Pro, and Premium are present, each with a plan code, display name, policy mappings, and allowances

#### Scenario: Default plan applied

- **WHEN** an authenticated principal has no plan assignment
- **THEN** their effective plan is Free
- **AND** Free's allowances apply

#### Scenario: Client-asserted plan ignored

- **WHEN** a request carries a field or header claiming a higher plan than the backend holds
- **THEN** the backend-held plan is used for both policy resolution and quota accounting

#### Scenario: Allowance changed without code

- **WHEN** an administrator raises the Pro plan's monthly request allowance
- **THEN** subsequent requests from Pro callers are accounted against the new allowance with no code change

### Requirement: Quotas are enforced in the backend before the call

The system SHALL check the acting principal's remaining allowance in the backend before making a language model call, and SHALL refuse the call when the allowance is exhausted. Enforcement SHALL NOT depend on the frontend, and a caller bypassing the frontend and calling the API directly SHALL receive the same outcome.

The check SHALL be applied on every path that consumes a principal's allowance, including the agent ask endpoint and the streaming endpoint. A stream SHALL be refused before it opens rather than terminated mid-answer where the allowance is already exhausted at the start.

#### Scenario: Call refused when exhausted

- **WHEN** a caller whose allowance is exhausted asks a question
- **THEN** the request is refused with the quota error before any language model call is made
- **AND** no usage event for a language model call is recorded for it

#### Scenario: Direct API call cannot bypass the quota

- **WHEN** a caller with an exhausted allowance calls the API directly rather than through the frontend
- **THEN** the outcome is identical

#### Scenario: Stream refused up front

- **WHEN** a caller with an exhausted allowance opens the streaming endpoint
- **THEN** the stream is refused before it opens with the quota error

#### Scenario: Within allowance proceeds

- **WHEN** a caller has remaining allowance
- **THEN** the request proceeds and consumes from that allowance

### Requirement: Allowances differ by plan and are expressed in stated dimensions

The system SHALL support allowances in at least these dimensions, each optional per plan and each enforceable independently:

- agent requests per calendar day
- agent requests per calendar month
- total tokens per calendar month
- concurrent in-flight agent runs

Free, Pro, and Premium SHALL be able to carry different values in every dimension, and a plan MAY leave a dimension unlimited. The architecture SHALL admit a future estimated-cost budget dimension for paid models, expressed per plan and per window, without restructuring the allowance model.

Where several dimensions apply, the most restrictive binding dimension SHALL determine the outcome, and the response SHALL name which dimension bound.

#### Scenario: Daily and monthly dimensions both enforced

- **WHEN** a plan declares both a daily and a monthly request allowance and the daily one is exhausted
- **THEN** the request is refused naming the daily dimension
- **AND** the monthly allowance is unaffected by the refusal

#### Scenario: Token dimension enforced

- **WHEN** a plan declares a monthly token allowance and the caller's recorded tokens for the month have reached it
- **THEN** further agent requests are refused naming the token dimension

#### Scenario: Unlimited dimension

- **WHEN** a plan leaves a dimension unset
- **THEN** that dimension does not bind for callers on that plan

#### Scenario: Concurrency dimension enforced

- **WHEN** a caller already has the maximum permitted concurrent runs in flight
- **THEN** a further run is refused naming the concurrency dimension

#### Scenario: Cost budget dimension representable

- **WHEN** the allowance model is inspected
- **THEN** an estimated-cost budget per plan and window can be expressed and enforced by the same mechanism without restructuring

### Requirement: Windows are explicit and reset predictably

The system SHALL define each allowance window explicitly — the calendar day and calendar month in a documented, configured time zone — and SHALL reset consumption at the window boundary without an operator action. A caller's remaining allowance and the time its window resets SHALL be readable by that caller.

A change to a plan's allowance mid-window SHALL apply to the remainder of the window against consumption already recorded, and SHALL NOT retroactively refuse requests already served.

#### Scenario: Window resets

- **WHEN** a daily window boundary passes for a caller who had exhausted their daily allowance
- **THEN** their daily allowance is available again with no operator action

#### Scenario: Remaining allowance readable

- **WHEN** an authenticated caller reads their usage
- **THEN** their plan, consumption, remaining allowance per dimension, and each window's reset time are returned

#### Scenario: Mid-window allowance change

- **WHEN** a plan's allowance is raised mid-window for a caller who had exhausted it
- **THEN** the caller may proceed for the remainder of the window
- **AND** requests already served are not re-evaluated

#### Scenario: Window time zone documented

- **WHEN** the quota configuration is inspected
- **THEN** the time zone in which day and month boundaries are computed is stated

### Requirement: Quota refusal is honest, structured, and non-destructive

A refusal for an exhausted allowance SHALL use the standard error model, SHALL be distinguishable from an authentication failure, an upstream weather failure, an agent-unconfigured failure, and a gateway rate limit, and SHALL state the bound dimension, the allowance, the consumption, and the window reset time. It SHALL NOT disclose another user's usage and SHALL NOT disclose internal pricing beyond what the caller's own plan states.

A quota refusal SHALL NOT damage or discard the caller's conversation thread, memory, preferences, or saved locations, and SHALL NOT be presented as a weather data error. Capabilities that consume no language model allowance — location resolution, current weather, forecast, history, analysis, comparison, and knowledge retrieval — SHALL continue to serve a caller whose language model allowance is exhausted.

#### Scenario: Refusal states the basis

- **WHEN** a request is refused for an exhausted allowance
- **THEN** the error names the bound dimension, the allowance, the consumption, and the window reset time

#### Scenario: Refusal distinguishable

- **WHEN** a caller receives a quota refusal
- **THEN** it is distinguishable from an authentication failure, an upstream failure, an agent-unconfigured failure, and a gateway rate limit

#### Scenario: Thread and preferences survive a refusal

- **WHEN** a caller is refused for an exhausted allowance
- **THEN** their thread, memory, preferences, and saved locations are unchanged

#### Scenario: Non-agent capabilities still serve

- **WHEN** a caller with an exhausted language model allowance requests a forecast, a historical comparison, an analysis, or a knowledge lookup that needs no model
- **THEN** the request succeeds

### Requirement: Accounting is consistent with recorded usage and safe under concurrency

Consumption SHALL be derived from, or reconcilable with, the recorded usage events, so that the counters and the event record do not disagree. Requests SHALL be counted once each; a retried language model call within one request SHALL count its tokens but SHALL NOT count as an additional request.

Concurrent requests from one principal SHALL NOT be able to exceed an allowance by racing: the check and the reservation SHALL be atomic, and a reservation for a request that fails before consuming SHALL be released. An accounting failure SHALL fail closed for a paid dimension rather than granting unlimited use, and SHALL be reported to operators.

#### Scenario: Counters reconcile with events

- **WHEN** consumption is reconciled against recorded usage events for a window
- **THEN** the counted requests and tokens agree with the events for that window

#### Scenario: Retry counts tokens but not a second request

- **WHEN** one request's structured call is retried once
- **THEN** the request count increases by one and the token count includes both attempts

#### Scenario: Concurrent requests cannot exceed the allowance

- **WHEN** a caller with one remaining request issues several requests simultaneously
- **THEN** exactly one is admitted and the others are refused with the quota error

#### Scenario: Reservation released on early failure

- **WHEN** a request reserves allowance and then fails before any language model call
- **THEN** the reservation is released and the caller's remaining allowance is unchanged

#### Scenario: Accounting failure fails closed

- **WHEN** the accounting store cannot be read or written for a bounded-allowance dimension
- **THEN** the request is refused rather than admitted without accounting
- **AND** the failure is reported to operators

### Requirement: Internal and administrative usage is tracked separately

Usage arising from administrative principals, internal model-lab runs, and evaluation runs SHALL be accounted against a separate internal allowance and SHALL NOT consume or be attributed to any end user's plan allowance. Internal allowances SHALL be independently configurable and SHALL be reportable separately from product usage.

An administrative principal acting on a product path as themselves SHALL still be accounted, against the internal allowance rather than a product plan.

#### Scenario: Lab run not charged to a user plan

- **WHEN** an administrator executes a model-lab comparison
- **THEN** its usage is accounted against the internal allowance
- **AND** no end user's plan consumption changes

#### Scenario: Evaluation run not charged to a user plan

- **WHEN** an evaluation run executes against a live gateway
- **THEN** its usage is accounted as internal and reported separately

#### Scenario: Internal allowance configurable and enforced

- **WHEN** the internal allowance is exhausted
- **THEN** further internal calls are refused with the quota error naming the internal allowance
- **AND** product traffic on user plans is unaffected

#### Scenario: Internal usage reported separately

- **WHEN** usage is reported for a period
- **THEN** internal usage is reported separately from each product plan's usage

### Requirement: Quota administration is privileged and auditable

Creating and editing plans, allowances, internal allowances, and **another principal's** plan assignment SHALL require an administrative principal, SHALL be refused for every other caller, and SHALL record the acting principal, the affected subject, the before and after values, and a timestamp. An allowance write with a negative value or an unknown dimension SHALL be refused.

A caller changing **their own** tier is the one exception, and it is governed by *Tiers are selectable by the account they apply to* below rather than by this requirement. Every other write here stays administrative: nothing a caller does to their own plan may create, edit or raise an allowance, reach another subject's record, or touch an internal allowance.

#### Scenario: Non-administrative change refused

- **WHEN** an ordinary authenticated caller attempts to change another principal's plan, or any allowance including their own
- **THEN** the request is refused
- **AND** no plan or allowance record changes

#### Scenario: Plan assignment recorded

- **WHEN** an administrative principal assigns a caller to the Pro plan
- **THEN** the assignment takes effect for subsequent requests
- **AND** the acting principal, the subject, the before and after values, and the time are recorded

#### Scenario: Invalid allowance refused

- **WHEN** an allowance is written with a negative value or an unknown dimension
- **THEN** the write is refused with a structured error naming the invalid field

### Requirement: No payment processing in this change

The system SHALL NOT implement payment processing, checkout, card handling, invoicing, dunning, proration, or a billing provider integration as part of this change. Plans SHALL be assignable administratively, and estimated cost SHALL be reported as an estimate for operational insight only, never as a charge.

The schema and the plan model SHALL leave room for a later billing integration — a plan code stable enough to map to an external product, and an external subscription reference field that stays null — without that integration existing now.

#### Scenario: No payment integration present

- **WHEN** the implementation is inspected
- **THEN** no payment provider integration, checkout flow, card handling, or invoicing exists

#### Scenario: Plans changed without a payment step

- **WHEN** a caller is placed on the Pro plan, whether by their own selection or by administrative assignment
- **THEN** it happens with no payment step, no price, and no charge

#### Scenario: Cost is never presented as a charge

- **WHEN** estimated cost is surfaced anywhere
- **THEN** it is labelled an operational estimate and is not presented as an amount owed

#### Scenario: Room left for a later billing integration

- **WHEN** the plan model is inspected
- **THEN** it carries a stable plan code and an unused external subscription reference
- **AND** no behavior depends on either being populated

### Requirement: Tiers are selectable by the account they apply to

An authenticated caller SHALL be able to move **their own** account between the published subscription tiers, in either direction, through an endpoint that takes no subject and acts only on the validated token's principal. The change SHALL be persisted, SHALL take effect for subsequent requests, and SHALL record who made it and when. It SHALL NOT require an administrative principal, SHALL NOT involve a payment step, and SHALL NOT be presented as a purchase — no price is published and no charge occurs.

The tier SHALL be validated against the stored plan catalogue, and an unknown tier SHALL be refused with a structured error naming the field. The write SHALL be refused by the database for any row that is not the caller's own, so that ownership is enforced beneath the endpoint rather than only within it. Changing tier SHALL NOT reset, delete or forgive any recorded consumption, usage event, conversation, saved location or watch: consumption already counted in a window remains counted, and a caller whose consumption exceeds the new tier's allowance SHALL be reported as over it rather than as reset.

**This supersedes the previous position**, under which a tier above the default was an administrative assignment only. The product decision of 2026-09-13 made tiers self-selectable. Creating and editing the tiers themselves, and every allowance, remain administrative.

#### Scenario: A caller moves themselves to a higher tier

- **WHEN** an authenticated caller on the Free plan selects the Premium plan
- **THEN** the change is persisted and takes effect for subsequent requests
- **AND** no administrative principal is involved and no payment is taken

#### Scenario: A caller moves themselves back down

- **WHEN** an authenticated caller on the Premium plan selects the Free plan
- **THEN** the change is persisted and takes effect for subsequent requests

#### Scenario: A caller cannot move anybody else

- **WHEN** a request attempts to change a tier for a subject other than the validated principal
- **THEN** no other subject's plan record changes

#### Scenario: An unknown tier is refused

- **WHEN** a tier that is not in the plan catalogue is selected
- **THEN** the request is refused with a structured error naming the field
- **AND** the caller's existing tier is unchanged

#### Scenario: Consumption survives a tier change

- **WHEN** a caller who has consumed part of a window's allowance changes tier
- **THEN** the consumed figure is unchanged and the allowance is the new tier's
- **AND** where consumption exceeds the new allowance it is reported as exceeded rather than reset

#### Scenario: The resolved model class follows the tier

- **WHEN** a caller changes tier and makes a subsequent request
- **THEN** the model policy resolves against the new tier
