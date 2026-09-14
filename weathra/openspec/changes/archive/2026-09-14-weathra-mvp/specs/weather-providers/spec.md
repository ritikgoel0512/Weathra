## Purpose

Defines how Weathra obtains weather data from interchangeable upstream sources and the vendor-neutral shape that data takes once inside the system, so every agent, analytics function, MCP tool, and API route reads one consistent model and no component above this layer ever sees a provider payload.

## ADDED Requirements

### Requirement: Normalized weather data model

The system SHALL expose weather data in a single normalized shape independent of any upstream provider's payload format, covering current conditions, an hourly series, and a daily series. Each entry SHALL carry an explicit timestamp in the location's local time alongside its UTC instant.

The normalized model SHALL define these measures: temperature, apparent temperature, precipitation amount, precipitation probability, wind speed, wind gust, wind direction, relative humidity, dew point, surface pressure, cloud cover, and UV index. Daily entries SHALL additionally define per-measure aggregates where the provider supplies them.

Every numeric value SHALL be resolvable to a unit. A measure the selected provider does not supply SHALL be reported as absent, never as zero and never as a substituted default.

#### Scenario: Forecast returned in normalized shape

- **WHEN** a caller requests a forecast for a resolved location
- **THEN** the response contains current conditions, an hourly series, and a daily series in the normalized shape
- **AND** every entry carries both a local timestamp and a UTC instant
- **AND** every numeric value is resolvable to a unit

#### Scenario: Provider omits a supported measure

- **WHEN** the upstream provider's response omits a measure the normalized model defines
- **THEN** that measure is reported as absent in the normalized result
- **AND** no substitute or zero value is reported in its place

#### Scenario: No provider payload escapes the layer

- **WHEN** any component above the provider layer receives weather data
- **THEN** it receives only normalized model instances
- **AND** no raw upstream payload or provider-specific field name is present in what it receives

#### Scenario: Units requested explicitly

- **WHEN** a caller requests imperial units
- **THEN** all numeric values are expressed in imperial units
- **AND** the units reported for each measure reflect that choice

#### Scenario: Units not specified

- **WHEN** a caller requests a forecast without specifying units
- **THEN** the response is expressed in metric units

### Requirement: Provider interface and registry

The system SHALL define a provider contract that any weather data source can implement, covering current conditions, forecast retrieval over a requested horizon, and historical observation retrieval over a requested past range. Each provider SHALL declare its capabilities: maximum forecast horizon, earliest available historical date, and which measures it supplies at which granularities.

The system SHALL maintain a registry resolving a provider by a stable string name and SHALL report which providers are registered. A caller SHALL be able to select a provider by name per request; absent a name, the configured default SHALL serve it.

Adding a new provider SHALL require implementing the contract and registering it, and SHALL NOT require changes to agent, analytics, MCP, or API code.

#### Scenario: Default provider used

- **WHEN** a caller requests a forecast without naming a provider
- **THEN** the configured default provider serves the request
- **AND** the response identifies which provider served it

#### Scenario: Provider selected by name

- **WHEN** a caller requests a forecast naming a registered provider
- **THEN** that provider serves the request
- **AND** the response identifies that provider as the source

#### Scenario: Unknown provider requested

- **WHEN** a caller names a provider that is not registered
- **THEN** the request fails with an error identifying the unknown name
- **AND** the error lists the registered provider names

#### Scenario: Capabilities enumerated

- **WHEN** a caller asks which providers are available
- **THEN** the system returns each registered provider's name, maximum forecast horizon, earliest historical date, and supplied measures

#### Scenario: Second provider added without touching consumers

- **WHEN** a further provider implementing the contract is registered
- **THEN** it is selectable by name through every consuming path
- **AND** no agent, analytics, MCP, or API source file requires modification for it to be used

### Requirement: Open-Meteo provider implementation

The system SHALL ship an Open-Meteo provider as the default implementation, requiring no API key. It SHALL use the Open-Meteo forecast API for current and forecast data and the Open-Meteo historical/archive API for observations, and SHALL declare its real horizon and archive limits through the capability descriptor.

#### Scenario: Forecast served without credentials

- **WHEN** the system runs with no weather-provider credentials configured
- **THEN** the Open-Meteo provider serves forecast requests successfully

#### Scenario: Historical observations retrieved from the archive API

- **WHEN** a caller requests observations for a past date range at a resolved location
- **THEN** the provider returns observed values for that range in the normalized shape
- **AND** the result identifies the archive API as the source

### Requirement: Forecast horizon bounds

The system SHALL accept a requested forecast horizon in days, defaulting to 7 when none is given, and SHALL provide hourly detail for at least the first 48 hours. A horizon beyond the selected provider's declared maximum SHALL be rejected with an error stating that maximum, never silently truncated.

#### Scenario: Default horizon

- **WHEN** a caller requests a forecast without specifying a horizon
- **THEN** the daily series covers 7 days
- **AND** the hourly series covers at least the first 48 hours

#### Scenario: Horizon exceeds provider support

- **WHEN** a caller requests a horizon longer than the provider's declared maximum
- **THEN** the request fails with an error stating that maximum
- **AND** no partial forecast is returned as though it satisfied the request

### Requirement: Historical range bounds

The system SHALL reject a historical request whose range starts before the provider's declared earliest available date, or whose range is inverted or extends into the future, with an error naming the offending bound.

#### Scenario: Range precedes archive coverage

- **WHEN** a caller requests observations beginning before the provider's earliest available date
- **THEN** the request fails with an error stating the earliest available date

#### Scenario: Inverted range

- **WHEN** a caller requests a range whose end precedes its start
- **THEN** the request fails with an error naming the offending bound

### Requirement: Response caching

The system SHALL cache upstream responses keyed by provider, location, request kind, requested range, and units, and SHALL serve a cached response within its freshness window instead of calling upstream again. Every retrieval SHALL report the time the data was obtained from upstream and whether it was served from cache.

#### Scenario: Repeat request served from cache

- **WHEN** the same forecast request is made twice within the freshness window
- **THEN** the second response is served from cache without an upstream call
- **AND** the response reports that it came from cache and when the data was retrieved

#### Scenario: Stale entry refreshed

- **WHEN** a request matches a cache entry whose freshness window has passed
- **THEN** the system calls upstream again and returns fresh data
- **AND** the response reports that it was not served from cache

#### Scenario: Differing units cached separately

- **WHEN** the same location and range are requested first in metric and then in imperial units
- **THEN** the second request is not served the metric cache entry

#### Scenario: Historical data cached longer than forecast data

- **WHEN** a historical observation and a forecast are both cached
- **THEN** the historical entry's freshness window is longer than the forecast entry's
- **AND** both report their own retrieval time

### Requirement: Upstream failure handling

The system SHALL surface upstream failures as distinguishable conditions: provider unreachable, provider timed out, provider rejected the request, provider rate-limited the caller, and no data for the requested location or range. Provider errors SHALL NOT be presented as valid weather data and SHALL NOT leak credentials or raw upstream payloads.

Transient failures SHALL be retried a bounded number of times before being reported, and a request timeout SHALL be enforced so a hanging provider cannot block a caller indefinitely.

#### Scenario: Provider unreachable

- **WHEN** the upstream provider cannot be reached after the permitted retries
- **THEN** the request fails with an error identifying the provider as unavailable
- **AND** the error contains no raw upstream payload or credential material

#### Scenario: Provider times out

- **WHEN** the upstream provider does not respond within the configured timeout
- **THEN** the request fails with a timeout error rather than waiting indefinitely

#### Scenario: Provider rate-limits the request

- **WHEN** the upstream provider reports the caller rate-limited
- **THEN** the request fails with an error distinguishable from an unavailability error

#### Scenario: No data for the requested range

- **WHEN** the provider has no data covering the requested location or range
- **THEN** the request fails with an error stating that no data covers the request
- **AND** the error is distinguishable from a provider outage

#### Scenario: Transient failure recovers on retry

- **WHEN** the upstream provider fails once transiently and then succeeds
- **THEN** the system returns the successful result without surfacing an error
