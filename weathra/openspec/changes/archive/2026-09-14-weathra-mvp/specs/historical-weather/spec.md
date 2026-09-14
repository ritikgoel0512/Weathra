## Purpose

The Historical Agent's domain: retrieving observed past weather, comparing one period against another, building baselines from multi-year history, and placing today's or this week's conditions against what is normal for the place and time of year — the context that turns a number into a judgment.

This capability is distinct from forecast-accuracy scoring, which compares past forecasts against what happened and is explicitly out of scope for the MVP. Every number reported here is computed by `deterministic-analytics`.

## ADDED Requirements

### Requirement: Historical observation retrieval

The system SHALL retrieve observed weather for a resolved location over a requested past date range, in the normalized shape, covering temperature, precipitation, wind, and humidity where the archive supplies them. Results SHALL be labelled as historical observations — not forecasts — and SHALL state the location, the range in the location's local time, the source provider, and the retrieval time.

#### Scenario: Observations retrieved for a range

- **WHEN** a caller requests observations for a past date range at a resolved location
- **THEN** the result returns the observed series with units, the range in local time, the source provider, and the retrieval time

#### Scenario: Observations labelled by data class

- **WHEN** historical observations are returned
- **THEN** they are labelled as historical observations and not as forecast or current-conditions data

#### Scenario: Range outside archive coverage

- **WHEN** a caller requests a range beginning before the provider's earliest available date
- **THEN** the request fails with an error stating the earliest available date

#### Scenario: Recent range not yet in the archive

- **WHEN** a caller requests a range whose end falls inside the archive's reporting lag
- **THEN** the system returns the portion that is available
- **AND** states which part of the requested range is not yet available

### Requirement: Period-versus-period comparison

The system SHALL compare two explicitly supplied past periods for a location, reporting each period's aggregates, the signed deltas between them, and the percentage change where meaningful. Both periods SHALL be evaluated in the same units, from the same provider, and using the same statistics, and the result SHALL state that basis. Periods of unequal length SHALL be permitted, and the result SHALL state that their lengths differ.

#### Scenario: Two months compared

- **WHEN** a caller compares one month against the same month a year earlier
- **THEN** the result reports both periods' aggregates, the signed deltas, and the shared units and provider

#### Scenario: Unequal period lengths

- **WHEN** the two compared periods differ in length
- **THEN** the comparison is still produced
- **AND** the result states that the period lengths differ

#### Scenario: One period unavailable

- **WHEN** the archive covers one requested period but not the other
- **THEN** the request fails with an error naming which period is unavailable
- **AND** does not report a one-sided comparison as though it were a comparison

### Requirement: Historical baselines

The system SHALL compute a baseline for a location and a calendar period from a requested number of past years, reporting the baseline mean, standard deviation, minimum, maximum, and the years actually included. The system SHALL state the number of years used, and SHALL report a baseline built from fewer years than requested as such rather than silently narrowing.

A baseline SHALL be labelled a historical statistic, not a forecast or a climate normal published by a meteorological authority.

#### Scenario: Baseline computed over multiple years

- **WHEN** a caller requests a 10-year baseline for a location and a calendar week
- **THEN** the result reports the mean, standard deviation, minimum, maximum, and the years included

#### Scenario: Fewer years available than requested

- **WHEN** the archive covers only 6 of the 10 requested years
- **THEN** the baseline is computed over the 6 available years
- **AND** the result states that 6 of 10 requested years were used

#### Scenario: Baseline labelled honestly

- **WHEN** a baseline is returned
- **THEN** it is labelled a historical statistic computed by Weathra
- **AND** is not presented as an official climate normal

### Requirement: Comparison against baseline

The system SHALL compare current conditions or a forecast window against a historical baseline for the same location and calendar period, reporting the signed difference, the z-score against the baseline where its standard deviation permits, and a plain-language characterization such as warmer or wetter than the baseline. The result SHALL name the baseline period and the number of years behind it.

When comparing a forecast against a baseline, the result SHALL state that one side is a forecast and therefore uncertain.

#### Scenario: Forecast week compared against baseline

- **WHEN** a caller compares the coming week's forecast against a 10-year baseline for that calendar week
- **THEN** the result reports the signed difference, the z-score, and a plain-language characterization
- **AND** names the baseline period and the number of years used

#### Scenario: Forecast side qualified

- **WHEN** a forecast is compared against a historical baseline
- **THEN** the result states that the forecast side is uncertain and the baseline side is observed

#### Scenario: Baseline with zero variance

- **WHEN** the baseline standard deviation is zero
- **THEN** the z-score is reported as undefined with the reason
- **AND** the signed difference is still reported

### Requirement: Historical requests are separable from accuracy scoring

The system SHALL NOT present any historical result as a measure of how accurate a past forecast was. A request for forecast-accuracy or forecast-skill scoring SHALL be answered by stating that Weathra does not yet offer it.

#### Scenario: Accuracy scoring requested

- **WHEN** a caller asks how accurate Weathra's past forecasts have been
- **THEN** the system states that forecast-accuracy scoring is not available
- **AND** does not offer a historical comparison as a substitute for it
