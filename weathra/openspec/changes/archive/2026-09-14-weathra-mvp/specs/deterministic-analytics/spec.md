## Purpose

The single place where every meteorological number Weathra reports is calculated — pure Python statistics over normalized weather series, producing structured results that agents may explain but never compute, so that no figure a person reads was ever estimated by a language model.

## ADDED Requirements

### Requirement: Stated assumptions applied to a retrieved series

The system SHALL support applying caller-stated assumptions to a retrieved weather series and returning the result, computed deterministically and without any language model. The same series and the same assumptions SHALL produce the same result.

The result SHALL be labelled as hypothetical and SHALL NOT be presented as a forecast, a prediction or an observation. It SHALL carry the unmodified baseline alongside the adjusted series, the assumptions as stated, and per adjusted measure: the arithmetic applied in words, the mean either side, the difference, the points used, the points excluded because the provider reported nothing, and the number of points where a physical bound was reached.

An assumption SHALL only address a measure the system declares adjustable. A value the provider did not report SHALL remain absent rather than becoming the assumption. Where an adjustment would carry a value outside a physical bound — a relative humidity outside 0–100, a negative precipitation or wind speed — the bound SHALL be applied and the occurrence counted rather than absorbed silently.

#### Scenario: An assumption is applied

- **WHEN** assumptions are applied to a retrieved series
- **THEN** the adjusted series carries the same instants, granularity and units as the baseline
- **AND** both series are returned, with the arithmetic stated per adjusted measure

#### Scenario: An absent value stays absent

- **WHEN** the provider reported no value for a measure at an instant
- **THEN** the adjusted series reports none at that instant
- **AND** the point is counted as excluded rather than treated as zero

#### Scenario: A physical bound is reached

- **WHEN** an assumption would carry a value past a physical bound
- **THEN** the value is bounded
- **AND** the number of points bounded is reported

#### Scenario: The result is not a forecast

- **WHEN** a scenario result is inspected
- **THEN** it is labelled hypothetical
- **AND** it states that it is neither a forecast nor an official warning

### Requirement: Analytics are pure, deterministic, and free of language models

Every analytics function SHALL be a pure function of its arguments: the same inputs SHALL always produce identical outputs. Analytics functions SHALL perform no network access, no database access, no clock reads, and SHALL NOT invoke a language model. The analysed window and units SHALL be passed in as arguments rather than derived from ambient state.

No component outside this capability SHALL compute a reported meteorological statistic.

#### Scenario: Repeated computation is identical

- **WHEN** the same series and parameters are analysed twice
- **THEN** the two results are byte-for-byte identical

#### Scenario: Analytics run without external services

- **WHEN** analytics functions are exercised with no network, no database, and no language-model credential available
- **THEN** every function computes its result successfully

#### Scenario: Language model does not compute statistics

- **WHEN** an agent reports a meteorological statistic to a caller
- **THEN** that value was produced by an analytics function and appears unchanged in the structured analytics result

### Requirement: Descriptive temperature statistics

The system SHALL compute, over a requested window and series: minimum temperature, maximum temperature, mean temperature, and temperature range, each reported with the timestamp at which any extreme occurred and the unit in which it is expressed.

#### Scenario: Temperature statistics computed

- **WHEN** a temperature series over a window is analysed
- **THEN** the result reports minimum, maximum, mean, and range
- **AND** the minimum and maximum each carry the timestamp at which they occur
- **AND** each value carries its unit

#### Scenario: Extremes tie

- **WHEN** two entries share the maximum temperature
- **THEN** the result reports the earliest of the tied timestamps and records that the extreme was tied

### Requirement: Precipitation statistics and probability analysis

The system SHALL compute total precipitation over a window, per-day precipitation totals, the count of entries exceeding a wet threshold, and — where the provider supplies precipitation probability — the maximum, mean, and the entries whose probability exceeds a requested level.

Precipitation probability SHALL be reported as a probability from the provider, never as a probability inferred from precipitation amount.

#### Scenario: Precipitation totals computed

- **WHEN** a precipitation series over a window is analysed
- **THEN** the result reports the window total and per-day totals with units

#### Scenario: Probability analysis computed

- **WHEN** the series carries precipitation probability and a level of 60 percent is requested
- **THEN** the result reports the maximum and mean probability and every entry at or above that level

#### Scenario: Probability unavailable

- **WHEN** the provider supplies no precipitation probability for the series
- **THEN** the result reports probability analysis as unavailable with the reason
- **AND** reports no inferred probability derived from precipitation amount

### Requirement: Humidity, pressure, and wind statistics

The system SHALL compute mean and range for relative humidity, dew point, and surface pressure, and for wind SHALL compute mean speed, maximum sustained speed, maximum gust with its timestamp, and the prevailing direction expressed as a compass sector.

#### Scenario: Wind statistics computed

- **WHEN** a series carrying wind speed, gust, and direction is analysed
- **THEN** the result reports mean speed, maximum sustained speed, maximum gust with its timestamp, and the prevailing direction sector

#### Scenario: Humidity statistics computed

- **WHEN** a series carrying relative humidity is analysed
- **THEN** the result reports mean and range humidity with units

#### Scenario: Measure absent from the series

- **WHEN** a requested statistic's measure is absent from the series
- **THEN** that statistic is reported unavailable with the reason
- **AND** every other requested statistic is still reported

### Requirement: Rolling averages, deltas, and percentiles

The system SHALL compute rolling averages over a caller-specified window length, period-over-period deltas between two aggregates, and arbitrary percentiles of a measure, stating for each result the method and window length used. A rolling window longer than the series SHALL be rejected with an error stating both lengths.

#### Scenario: Rolling average computed

- **WHEN** a 3-day rolling mean of daily maximum temperature is requested over a 7-day series
- **THEN** the result reports the rolling values, the window length used, and the method

#### Scenario: Percentile computed

- **WHEN** the 90th percentile of a measure is requested
- **THEN** the result reports that percentile and names the interpolation method used

#### Scenario: Delta computed

- **WHEN** the delta between two period aggregates is requested
- **THEN** the result reports the signed difference, both input aggregates, and the unit

#### Scenario: Rolling window exceeds series length

- **WHEN** a 10-day rolling window is requested over a 7-day series
- **THEN** the request fails with an error stating the requested window length and the available series length

### Requirement: Z-scores against a stated reference

The system SHALL compute z-scores for a value against an explicitly supplied reference mean and standard deviation, and SHALL report which reference was used. When the reference standard deviation is zero, the system SHALL report the z-score as undefined rather than dividing by zero.

#### Scenario: Z-score computed against a baseline

- **WHEN** a z-score is requested for a day's mean temperature against a historical baseline mean and standard deviation
- **THEN** the result reports the z-score and identifies the reference period it was computed against

#### Scenario: Zero-variance reference

- **WHEN** the reference standard deviation is zero
- **THEN** the z-score is reported as undefined with the reason
- **AND** no division-by-zero error is raised

### Requirement: Anomaly detection

The system SHALL identify anomalous entries in a series using a robust method that is not distorted by the very outlier it is meant to find, SHALL report each anomaly with its timestamp, value, deviation, and the method and threshold used, and SHALL always report the window extremes. A series whose entries do not deviate materially SHALL be reported as having no anomalies rather than forcing a selection.

#### Scenario: Outlier identified

- **WHEN** one day in a window is far warmer than every other day
- **THEN** the result reports that day as an anomaly with its value, deviation, method, and threshold

#### Scenario: Uniform series has no anomalies

- **WHEN** every entry sits close to the series' central tendency
- **THEN** the result reports no anomalies
- **AND** still reports the window extremes

#### Scenario: Single extreme does not mask itself

- **WHEN** a series of seven similar values contains one extreme value
- **THEN** that extreme is reported as an anomaly

### Requirement: Trend analysis

The system SHALL report the direction of change across a window for a requested measure as rising, falling, or steady, with the magnitude of change, the period spanned, and the method used. Variation within a defined per-measure insignificance margin SHALL be reported as steady. A single spike at either end of the window SHALL NOT by itself produce a trend.

#### Scenario: Rising trend reported

- **WHEN** daily maxima climb materially across the window
- **THEN** the result reports a rising trend with magnitude, period, and method

#### Scenario: Flat series reported steady

- **WHEN** a measure varies only within its insignificance margin
- **THEN** the trend is reported as steady

#### Scenario: End spike does not create a trend

- **WHEN** a series is flat except for a single spike on its final entry
- **THEN** the trend is not reported as rising

### Requirement: Insufficient data handling

Each statistic SHALL declare the minimum number of usable data points it requires. When a series has too few usable points for a statistic, that statistic SHALL be reported not-computable with the reason and the counts involved, while every other requested statistic is still computed. A series with no usable entries at all SHALL fail with an error stating there is nothing to analyse.

#### Scenario: Some statistics computable, others not

- **WHEN** a series carries two precipitation points and seven temperature points
- **THEN** precipitation statistics are reported not-computable with the required and available counts
- **AND** temperature statistics are reported normally

#### Scenario: Entirely empty series

- **WHEN** a series contains no usable entries
- **THEN** the request fails with an error stating there is no data to analyse

#### Scenario: Absent values do not count as zero

- **WHEN** a series contains entries whose values are absent
- **THEN** those entries are excluded from every computation rather than treated as zero
- **AND** the result reports how many entries were excluded

### Requirement: Structured, self-describing results

Every analytics result SHALL be a structured object stating the statistic computed, its value, its unit, the window and location it covers, the source provider of the underlying data, the count of points used, and the method applied. Results SHALL be serializable so that they can be attached to an agent answer as evidence and stored in an evaluation record.

#### Scenario: Result carries provenance

- **WHEN** any statistic is computed
- **THEN** its result states the statistic, value, unit, window, location, source provider, point count, and method

#### Scenario: Result serializes for evidence

- **WHEN** an analytics result is attached to an agent answer
- **THEN** it round-trips through serialization without loss of any provenance field
