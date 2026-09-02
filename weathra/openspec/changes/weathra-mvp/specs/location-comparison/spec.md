## Purpose

Answers the "which one?" question — which of several places, or which day at one place, best fits a stated criterion such as warmest, driest, or best for being outdoors — and shows the per-candidate evidence behind the ranking so the answer can be checked rather than trusted.

All scoring inputs are deterministic analytics results; this capability ranks and explains, it does not compute statistics of its own.

## ADDED Requirements

### Requirement: Comparison across multiple locations

The system SHALL accept two or more locations with a shared window, units, and criterion, and SHALL return the candidates ranked against that criterion. Every candidate SHALL be included with its rank, its score, and the underlying analytics results that produced the score. Requests naming fewer than two locations SHALL be rejected, and the per-request location count SHALL be bounded with the limit stated in the error when exceeded.

#### Scenario: Locations ranked by criterion

- **WHEN** a caller compares three locations over the next 5 days by the warmest criterion
- **THEN** all three locations are returned ranked from warmest to coolest
- **AND** each carries its rank, its score, and the analytics results behind the score

#### Scenario: Single location rejected

- **WHEN** a caller requests a comparison naming only one location
- **THEN** the request fails with an error stating that at least two locations are required

#### Scenario: Too many locations rejected

- **WHEN** a caller names more locations than the per-request limit allows
- **THEN** the request fails with an error stating the limit

### Requirement: Comparison across days for one location

The system SHALL accept a single location and rank the days within its window against a stated criterion, so a caller can identify the best day rather than the best place.

#### Scenario: Best day identified

- **WHEN** a caller asks which day in the next week is driest at one location
- **THEN** the days in the window are returned ranked by dryness
- **AND** each carries the precipitation analytics behind its rank

### Requirement: Supported comparison criteria

The system SHALL support ranking by warmest, coolest, driest, wettest, least windy, and a composite outdoor-suitability criterion. The composite criterion SHALL combine temperature comfort, precipitation, and wind, and SHALL report which measures contributed to each candidate's score, in what direction, and with what weight. An unsupported criterion SHALL be rejected with an error listing the supported criteria.

The weights behind the composite criterion SHALL be disclosed in the result as Weathra's own heuristic, not as an authoritative index.

#### Scenario: Composite criterion explained

- **WHEN** a caller compares locations by outdoor suitability
- **THEN** each candidate's score reports the contributing measures, their direction, and their weight

#### Scenario: Composite criterion disclosed as a heuristic

- **WHEN** a composite score is returned
- **THEN** the result states that the weighting is Weathra's own heuristic

#### Scenario: Unsupported criterion rejected

- **WHEN** a caller requests a criterion the system does not support
- **THEN** the request fails with an error listing the supported criteria

### Requirement: Comparison fairness

All candidates in one comparison SHALL be evaluated over the same window, in the same units, from the same provider, and with the same statistics, and the comparison SHALL state that shared basis. When candidates fall in different timezones, the window SHALL be applied in each candidate's local time and the comparison SHALL state that local-time basis.

#### Scenario: Shared basis reported

- **WHEN** a comparison completes
- **THEN** the result states the window, units, provider, and statistics applied to every candidate

#### Scenario: Candidates in different timezones

- **WHEN** compared locations lie in different timezones
- **THEN** each candidate's window is evaluated in its own local time
- **AND** the result states that the window was applied in local time

### Requirement: Historical comparison mode

The system SHALL support comparing locations over a past period using historical observations instead of a forecast, and SHALL label which data class each comparison used. A comparison SHALL NOT mix forecast data for one candidate with historical data for another.

#### Scenario: Locations compared over a past period

- **WHEN** a caller compares two locations over a past month by the wettest criterion
- **THEN** the comparison is computed from historical observations
- **AND** the result labels the data class as historical

#### Scenario: Mixed data classes refused

- **WHEN** a comparison would require forecast data for one candidate and historical data for another
- **THEN** the request fails with an error stating that candidates must share a data class

### Requirement: Ties and partial failures

Candidates whose scores are equal within a defined tolerance SHALL be reported as tied at the same rank rather than ordered arbitrarily. When data for some candidates cannot be retrieved, the system SHALL rank those it did retrieve and list each unavailable candidate with the reason, failing the whole request only when fewer than two candidates remain.

#### Scenario: Tied candidates

- **WHEN** two candidates score equally within the tie tolerance
- **THEN** both are reported as tied at the same rank

#### Scenario: One candidate unavailable

- **WHEN** three locations are compared and data for one cannot be retrieved
- **THEN** the remaining two are ranked
- **AND** the unavailable location is listed with the reason it was excluded

#### Scenario: Too few candidates remain

- **WHEN** data can be retrieved for fewer than two of the requested locations
- **THEN** the request fails with an error stating that too few candidates could be evaluated
