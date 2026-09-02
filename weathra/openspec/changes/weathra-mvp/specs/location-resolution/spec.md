## Purpose

Turns whatever a person types to name a place — a city name, a "city, country" pair, or a raw coordinate pair — into one canonical location with coordinates and a timezone, so that every forecast, historical, analytics, comparison, and agent request operates on an unambiguous point on the map.

## ADDED Requirements

### Requirement: Canonical location shape

The system SHALL represent a resolved location with a display name, latitude, longitude, and IANA timezone identifier, and SHALL include region, country, country code, and elevation when the source supplies them. Latitude SHALL be within -90 to 90 and longitude within -180 to 180.

Every resolved location SHALL carry a stable identifier derived from its coordinates so that saved locations and cached data refer to the same place consistently.

#### Scenario: Resolved location fields

- **WHEN** a location is successfully resolved
- **THEN** the result carries a display name, latitude, longitude, IANA timezone identifier, and a stable identifier

#### Scenario: Same place resolves to the same identifier

- **WHEN** the same place is resolved twice, once by name and once by its coordinates
- **THEN** both results carry the same stable identifier

### Requirement: Geocoding behind its own provider seam

The system SHALL define a geocoder contract separate from the weather-provider contract, and SHALL implement it first against the Open-Meteo geocoding API. Location resolution SHALL depend only on that contract, so a different geocoding source can be substituted without changing any consumer.

Geocoding results SHALL be cached, since place-name-to-coordinate mappings change far less often than weather data.

#### Scenario: Geocoder substituted

- **WHEN** a different implementation of the geocoder contract is configured
- **THEN** location resolution behaves identically through every consuming path
- **AND** no agent, MCP, analytics, or API source file requires modification

#### Scenario: Repeat resolution served from cache

- **WHEN** the same place name is resolved twice within the geocoding cache window
- **THEN** the second resolution is served from cache without an upstream call

### Requirement: Resolution by place name

The system SHALL resolve a free-text place name to a canonical location. Matching SHALL be case-insensitive and SHALL tolerate surrounding whitespace. A query naming a place together with a region or country, such as "Springfield, Illinois", SHALL prefer a match within that region.

#### Scenario: Unique place name

- **WHEN** a caller resolves "Reykjavik"
- **THEN** the system returns a single canonical location with its coordinates and timezone

#### Scenario: Name with region qualifier

- **WHEN** a caller resolves "Springfield, Illinois"
- **THEN** the returned location is the Springfield within Illinois

#### Scenario: Casing and whitespace tolerated

- **WHEN** a caller resolves "  new YORK  "
- **THEN** the system resolves it to the same location as "New York"

### Requirement: Ambiguous place names

When a place name matches more than one location and no qualifier distinguishes them, the system SHALL report the ambiguity with the candidate locations rather than silently choosing one. Each candidate SHALL carry enough detail to be told apart, including region and country where known.

#### Scenario: Ambiguous name reported

- **WHEN** a caller resolves a name matching several distinct locations
- **THEN** the system reports the query as ambiguous
- **AND** returns the candidates with their region and country
- **AND** does not return a single location as though it were certain

### Requirement: Unknown place names

When a place name matches no known location, the system SHALL report it as unresolvable and SHALL NOT substitute a nearest or partial match.

#### Scenario: Unknown name rejected

- **WHEN** a caller resolves a name matching no known location
- **THEN** the system reports that the location could not be resolved
- **AND** returns no candidate locations

### Requirement: Resolution by coordinates

The system SHALL accept a latitude and longitude pair directly and return a canonical location for it including its timezone, without a name lookup. Coordinates outside valid ranges SHALL be rejected with an error naming the offending value.

#### Scenario: Valid coordinates accepted

- **WHEN** a caller supplies latitude 64.15 and longitude -21.94
- **THEN** the system returns a canonical location at that point including its timezone

#### Scenario: Out-of-range coordinates rejected

- **WHEN** a caller supplies latitude 95.0
- **THEN** the request fails with an error identifying latitude as out of range

### Requirement: Location search

The system SHALL provide a search operation returning multiple ranked candidate locations for a partial or complete query, bounded by a caller-supplied limit with a defined default, and SHALL return an empty result set rather than an error when nothing matches.

#### Scenario: Search returns ranked candidates

- **WHEN** a caller searches for "san"
- **THEN** the system returns ranked candidate locations matching that prefix
- **AND** the number of candidates does not exceed the requested limit

#### Scenario: Search with no matches

- **WHEN** a caller searches for a string matching no location
- **THEN** the system returns an empty candidate list without an error
