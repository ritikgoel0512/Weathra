## Purpose

The Forecast Agent's domain: retrieving current and forecast conditions across every supported measure, and turning them into the derived facts a person actually asks about — when a threshold gets crossed, what stands out in the window, how the forecast has moved since it was last captured, and how much confidence the forecast deserves.

Every number reported here is computed by `deterministic-analytics`; this capability composes, frames, and labels those results rather than calculating them.

## ADDED Requirements

### Requirement: Current conditions retrieval

The system SHALL report current conditions for a resolved location covering temperature, apparent temperature, precipitation, wind speed and direction, humidity, and pressure where the provider supplies them, labelled as an observation-or-nowcast rather than as a forecast, and carrying the location, the observation time in local and UTC form, the source provider, and the retrieval time.

#### Scenario: Current conditions reported

- **WHEN** a caller requests current conditions for a resolved location
- **THEN** the result reports the supported measures with units, the observation time in local and UTC form, the source provider, and the retrieval time

#### Scenario: Current conditions labelled by data class

- **WHEN** current conditions are returned
- **THEN** they are labelled as current-conditions data and not as forecast data

### Requirement: Forecast retrieval across granularities and measures

The system SHALL provide hourly and daily forecasts over a requested window covering temperature, precipitation amount, precipitation probability, wind speed, wind gust, wind direction, humidity, and pressure where the provider supplies them. Requests SHALL accept a horizon, units, and a provider name, and the result SHALL state each of them.

#### Scenario: Hourly and daily forecast returned

- **WHEN** a caller requests a forecast for a resolved location over 5 days
- **THEN** the result contains an hourly series and a daily series covering the supported measures
- **AND** states the window, units, and provider used

#### Scenario: Measure unsupported by the provider

- **WHEN** the selected provider does not supply a requested measure
- **THEN** that measure is reported as unavailable for this provider
- **AND** the remaining measures are returned normally

### Requirement: Forecast window analysis

The system SHALL produce an analysis over a forecast window for a resolved location, composed from deterministic analytics results, reporting the window analysed, the location, and the source provider. The analysis SHALL be reproducible: the same retrieved series SHALL always yield the same analysis.

#### Scenario: Analysis produced for a window

- **WHEN** a caller requests forecast analysis over the next 5 days
- **THEN** the result reports the analysed window, the location, and the source provider
- **AND** includes temperature, precipitation, and wind findings

#### Scenario: Analysis is deterministic

- **WHEN** the same retrieved series is analysed twice
- **THEN** both analyses are identical

#### Scenario: Analysis figures trace to analytics results

- **WHEN** the analysis reports any statistic
- **THEN** that statistic is present in an attached deterministic analytics result with its method and point count

### Requirement: Threshold crossings

The system SHALL accept threshold conditions on forecast measures — a measure, a comparison direction, and a value — and SHALL report each crossing with the timestamp at which it occurs and the value at that point, in the location's local time. A threshold never crossed in the window SHALL be reported explicitly as not crossed rather than omitted. A threshold on a measure the series lacks SHALL be rejected with an error naming the measure.

#### Scenario: Threshold crossed

- **WHEN** a caller asks when temperature first exceeds 30 degrees within the window
- **THEN** the result reports the first crossing timestamp in local time and the value at that time

#### Scenario: Threshold never crossed

- **WHEN** a caller asks when precipitation first exceeds 20 mm and it never does within the window
- **THEN** the result reports that the threshold is not crossed in the window

#### Scenario: Threshold on an unavailable measure

- **WHEN** a caller supplies a threshold on a measure the series does not carry
- **THEN** the request fails with an error naming the unsupported measure

### Requirement: Forecast anomalies

The system SHALL report entries in the forecast window that stand out against the rest of the window, using the deterministic anomaly method, and SHALL state the method and threshold applied so a reader can judge the claim. A window with nothing standing out SHALL report no anomalies.

#### Scenario: Anomalous day surfaced

- **WHEN** one day in the forecast window deviates markedly from the others
- **THEN** the result reports it with its value, deviation, method, and threshold

#### Scenario: No anomalies in a uniform window

- **WHEN** the window is uniform
- **THEN** the result reports no anomalies

### Requirement: Forecast snapshot capture

The system SHALL record a snapshot of each retrieved forecast — location, window, provider, units, retrieval time, and the daily series — so that later retrievals can be compared against it. Snapshot capture SHALL NOT block or fail the retrieval it accompanies: a storage failure SHALL be logged and the forecast still returned.

#### Scenario: Snapshot recorded on retrieval

- **WHEN** a forecast is retrieved for a location and window
- **THEN** a snapshot of it is recorded with its retrieval time, provider, and units

#### Scenario: Snapshots carry no user reference

- **WHEN** a snapshot is recorded
- **THEN** it is keyed by location, window, provider, and retrieval time
- **AND** carries no reference to the user whose request triggered it

#### Scenario: Snapshot storage failure does not fail the request

- **WHEN** snapshot storage is unavailable during a forecast retrieval
- **THEN** the forecast is still returned successfully
- **AND** the storage failure is logged

### Requirement: What Changed?

The system SHALL report how the forecast for a location and window has moved since the most recent earlier snapshot of that location and window, giving per-day signed deltas for temperature and precipitation, the two retrieval times being compared, and a plain-language statement of the material changes. Deltas within a per-measure insignificance margin SHALL be reported as unchanged.

When no earlier snapshot exists, the system SHALL say so plainly and SHALL NOT present the current forecast as though it were a change.

#### Scenario: Forecast movement reported

- **WHEN** a forecast is retrieved for a location and window for which an earlier snapshot exists
- **THEN** the result reports per-day signed deltas for temperature and precipitation
- **AND** states both retrieval times being compared

#### Scenario: No earlier snapshot

- **WHEN** What Changed? is requested for a location and window with no earlier snapshot
- **THEN** the result states that no prior forecast is available for comparison
- **AND** reports no deltas

#### Scenario: Immaterial movement reported as unchanged

- **WHEN** the forecast has moved only within the insignificance margin
- **THEN** the result reports the forecast as unchanged for that measure

### Requirement: Confidence and uncertainty communication

Every forecast result SHALL carry an uncertainty statement covering how far into the horizon each figure sits, and, where the provider supplies a spread or ensemble range, that range. The system SHALL state plainly that confidence decreases with horizon distance, and SHALL NOT present a far-horizon figure with the same assurance as a near-term one.

Because the MVP reads a single provider, the system SHALL state that its confidence signal is derived from horizon distance and provider-supplied spread only, and is not a multi-provider consensus.

#### Scenario: Uncertainty accompanies a forecast

- **WHEN** a forecast is returned
- **THEN** it carries an uncertainty statement including each figure's distance into the horizon

#### Scenario: Far-horizon figure qualified

- **WHEN** a figure 7 days out is reported
- **THEN** it is qualified as lower-confidence than a near-term figure

#### Scenario: Confidence basis disclosed

- **WHEN** a confidence or uncertainty statement is produced
- **THEN** it states that the basis is horizon distance and provider-supplied spread from a single provider

### Requirement: Plain-language forecast summary without a language model

The system SHALL produce a plain-language summary of a forecast analysis without invoking a language model, stating only figures present in the underlying analytics results and naming the location and window it describes. This summary SHALL remain available when no language-model credential is configured.

#### Scenario: Summary generated without a language model

- **WHEN** forecast analysis is requested while no language-model credential is configured
- **THEN** a plain-language summary is still returned
- **AND** every figure it states appears in the underlying analytics results

### Requirement: Insufficient forecast data

When the retrieved series has too few usable points for a finding, the system SHALL report that finding as unavailable with the reason while still returning the findings that do have enough data, and SHALL fail only when the retrieved series is entirely empty.

#### Scenario: Partial findings returned

- **WHEN** the retrieved series carries too few precipitation points to analyse
- **THEN** precipitation findings are reported unavailable with the reason
- **AND** temperature findings are still reported

#### Scenario: Empty series

- **WHEN** the retrieved series contains no usable entries
- **THEN** the request fails with an error stating there is no data to analyse
