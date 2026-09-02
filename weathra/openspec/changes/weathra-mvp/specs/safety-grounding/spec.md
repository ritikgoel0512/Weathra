## Purpose

The rules that make Weathra trustworthy rather than merely fluent: every measurement comes from an approved tool, every calculation is deterministic, every answer says what kind of data it rests on and where it came from, uncertainty is stated rather than smoothed over, and Weathra never positions itself as a forecaster or as a substitute for official warnings.

These requirements bind every answer-producing path — the agent surface, the REST endpoints, and the frontend's rendering of both.

## ADDED Requirements

### Requirement: No fabricated weather measurements

The system SHALL NOT report a numerical weather measurement that did not come from an approved weather tool or provider during the request that produced it. Values from a language model's own knowledge, values estimated to fill a gap, and values carried over from an unrelated location or period SHALL NOT appear in an answer.

#### Scenario: Answer with figures but no retrieval

- **WHEN** an answer would contain a numerical weather figure and no weather tool was called during the request
- **THEN** the answer is withheld and the system states that it could not answer from retrieved data
- **AND** no figure is reported

#### Scenario: Gap not filled by estimation

- **WHEN** a requested measure is absent from the retrieved data
- **THEN** the answer states that the measure is unavailable
- **AND** reports no estimated value in its place

#### Scenario: Figure traceable to a tool result

- **WHEN** an answer reports a weather measurement
- **THEN** that measurement is present in a tool result in the request's evidence record

### Requirement: Numerical analytics are deterministic

The system SHALL compute every reported statistic — extremes, means, ranges, totals, percentiles, deltas, rolling values, z-scores, anomalies, and trends — through the deterministic analytics capability. A language model SHALL NOT produce, adjust, round differently, or re-derive a reported statistic.

#### Scenario: Statistic matches the analytics result

- **WHEN** an answer reports a statistic
- **THEN** the reported value matches the corresponding deterministic analytics result in the evidence record

#### Scenario: Model-computed statistic rejected

- **WHEN** an answer contains a statistic with no corresponding analytics result
- **THEN** the discrepancy is recorded and the figure is reported as unverified rather than presented as computed

### Requirement: Data classes are labelled and never conflated

Every reported value SHALL be labelled with its data class: current conditions, forecast, historical observation, historical statistic computed by Weathra, or AI interpretation. An answer combining classes SHALL label each part. AI interpretation SHALL be visually and structurally distinguishable from retrieved data in both the API response and the frontend.

#### Scenario: Mixed-class answer labelled

- **WHEN** an answer combines a forecast figure, a historical baseline, and an interpretation
- **THEN** each part is labelled with its data class

#### Scenario: Interpretation distinguishable

- **WHEN** an answer contains AI interpretation
- **THEN** it is structurally distinguishable in the response and visually distinguishable in the frontend from retrieved data

#### Scenario: Historical statistic not presented as observation

- **WHEN** a Weathra-computed baseline is reported
- **THEN** it is labelled a computed historical statistic and not a raw observation

### Requirement: Source attribution on every weather answer

Every answer containing weather data SHALL state the source provider, the location the data concerns, and the time period or timestamp it covers, together with the time the data was retrieved. Attribution SHALL be present in the API response, not only in prose.

#### Scenario: Attribution present

- **WHEN** an answer contains weather data
- **THEN** it states the source provider, the location, the period or timestamp, and the retrieval time

#### Scenario: Attribution machine-readable

- **WHEN** an API response contains weather data
- **THEN** the attribution appears in structured response fields and not only inside prose text

#### Scenario: Multiple sources attributed separately

- **WHEN** an answer draws on both forecast and historical data
- **THEN** each part carries its own provider, period, and retrieval time

### Requirement: Uncertainty is communicated

Every forecast figure SHALL be accompanied by an uncertainty indication covering its distance into the horizon and any provider-supplied spread. The system SHALL NOT present a forecast as a certainty, and SHALL state plainly that forecast confidence decreases with horizon distance.

#### Scenario: Forecast carries uncertainty

- **WHEN** a forecast figure is reported
- **THEN** it is accompanied by its horizon distance and any provider-supplied spread

#### Scenario: Certainty language avoided

- **WHEN** a forecast is described in prose
- **THEN** it is not stated as a certainty

#### Scenario: Confidence basis stated

- **WHEN** confidence is characterized
- **THEN** the basis of that characterization is stated, including that it derives from a single provider

### Requirement: Weathra does not present itself as a forecaster

The system SHALL NOT imply that Weathra or its language model performs meteorological forecasting or numerical weather prediction. Answers SHALL attribute forecasts to the upstream provider's model output, and Weathra's role SHALL be described as retrieval, deterministic analysis, and explanation.

#### Scenario: Forecast attributed to the provider

- **WHEN** an answer reports a forecast
- **THEN** the forecast is attributed to the upstream provider rather than to Weathra or its model

#### Scenario: Asked whether it forecasts

- **WHEN** a caller asks whether Weathra produces its own forecasts
- **THEN** the system states that it retrieves provider forecasts, analyses them deterministically, and explains them

### Requirement: Not a replacement for official warnings

The system SHALL NOT position itself as a source of emergency weather warnings or as a substitute for official meteorological authorities. When a question concerns severe weather, danger to life or property, or emergency decisions, the answer SHALL direct the caller to their official local meteorological authority alongside whatever data it can honestly report.

#### Scenario: Severe-weather question answered with a referral

- **WHEN** a caller asks whether it is safe to travel through a storm
- **THEN** the answer directs them to their official local meteorological authority
- **AND** reports only the retrieved data it can attribute

#### Scenario: No emergency-warning framing

- **WHEN** any answer concerns hazardous conditions
- **THEN** it does not present itself as an official warning or alert

### Requirement: No unsupported severe-weather claims

The system SHALL NOT assert the presence, severity, or likelihood of a severe weather event unless the retrieved provider data contains the fields supporting that assertion. Where the data does not support such a claim, the system SHALL say what the data does show and state that it cannot characterize severity.

#### Scenario: Severity claim without supporting fields

- **WHEN** the retrieved data contains no severity or alert field
- **THEN** the answer does not assert that a severe event will occur
- **AND** states what the retrieved measures do show

#### Scenario: Supported claim reported with attribution

- **WHEN** the retrieved data contains provider fields describing a severe condition
- **THEN** the answer may report it with the provider attributed and the fields named

### Requirement: Honest handling of unavailable data

When data cannot be retrieved — the location is unresolvable, the period is outside coverage, the provider fails, or a measure is not supplied — the system SHALL state the specific reason and SHALL NOT substitute an answer from another source, another period, another location, or the language model's own knowledge.

#### Scenario: Provider failure stated

- **WHEN** the provider fails during a request
- **THEN** the answer states that data could not be retrieved and why
- **AND** contains no substituted figures

#### Scenario: Period outside coverage stated

- **WHEN** a requested period lies outside the provider's coverage
- **THEN** the answer states that the period is outside coverage
- **AND** reports no figures for it

#### Scenario: Partial availability reported precisely

- **WHEN** part of a requested period or measure set is available and part is not
- **THEN** the answer reports what was retrieved and names precisely what was not

### Requirement: Data minimization in persistence

The system SHALL persist only what its capabilities require: explicitly chosen non-sensitive preferences, saved locations, bounded session context, forecast snapshots, the knowledge corpus, and evaluation records, each owned by the authenticated user where it is user-owned data. Credential and contact data SHALL remain in Supabase Auth; application tables SHALL reference a user only by their authentication subject and SHALL NOT duplicate passwords, tokens, or contact details beyond what a feature requires. The system SHALL NOT persist arbitrary conversation content beyond the bounded session retention, and SHALL NOT persist credentials or tokens in application data or logs.

#### Scenario: Only declared data persisted

- **WHEN** persisted application data is inspected
- **THEN** it contains only the declared categories

#### Scenario: No credentials in logs

- **WHEN** logs are inspected
- **THEN** they contain no credential or token material

#### Scenario: Credential data stays in Supabase Auth

- **WHEN** the application tables are inspected
- **THEN** they hold no password, token, or contact data beyond what a feature requires
- **AND** reference a user only by their authentication subject

#### Scenario: User data removable on request

- **WHEN** an authenticated user requests deletion of their Weathra data
- **THEN** their user-owned records are removed and the deletion is confirmed

#### Scenario: Conversation content bounded

- **WHEN** the session retention period has elapsed
- **THEN** the session's conversation content is no longer persisted
