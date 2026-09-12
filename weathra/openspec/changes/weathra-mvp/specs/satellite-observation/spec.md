## Purpose

Satellite imagery as **observational evidence** in an answer — a picture of a region at a stated time, retrieved from a public service, attributed, and deliberately never interpreted. It is the only capability that retrieves something Weathra cannot turn into a figure, and the requirements below exist mostly to keep it that way.

## ADDED Requirements

### Requirement: A real, open, credential-free source

The satellite capability SHALL retrieve from a real, publicly documented Earth-observation service that requires no API key, no registration and no new deployment secret. The chosen service, the product used, its coverage, its freshness, its licence and its known limitations SHALL be recorded in `docs/satellite-source.md`, together with the candidates rejected and why. No imagery SHALL be generated, simulated, cached-and-presented-as-live, or scraped from a page not offered as a service.

#### Scenario: No credential is introduced

- **WHEN** the satellite capability retrieves an observation
- **THEN** it uses no API key, token or secret, and no new environment variable is required in any deployment

#### Scenario: The source decision is recorded

- **WHEN** `docs/satellite-source.md` is read
- **THEN** it names the chosen service, the product, the coverage, the freshness, the attribution required, the known limitations and the fallback behaviour

### Requirement: A normalized observation carrying no measurement

A retrieved observation SHALL be normalized into a domain model carrying the location, the region covered, the provider, the product, the UTC day observed, the retrieval time, an image reference, the attribution the source requires, and notes stating the region covered and the freshness. The model SHALL NOT carry any meteorological quantity — no cloud amount, temperature, precipitation, pressure, severity or classification — because the source supplies none.

#### Scenario: No field exists for an invented figure

- **WHEN** the satellite observation model's fields are inspected
- **THEN** none of them names a meteorological measurement, a detection or a classification

#### Scenario: The region is stated, not the point

- **WHEN** an observation is returned for a location
- **THEN** it states the bounding box it covers and says in words that the imagery covers the region rather than the place

### Requirement: A tool on the existing MCP boundary

The capability SHALL be reached through an MCP tool, `weather_satellite`, taking a location on the same terms as the other weather tools and returning the normalized observation together with its attribution block. It SHALL NOT return the provider's raw response, and it SHALL NOT return image bytes.

#### Scenario: The tool is in the catalog

- **WHEN** the MCP server's catalog is listed
- **THEN** `weather_satellite` appears with a declared input schema and a description stating that it returns observational imagery and no measurement

#### Scenario: The tool returns a reference rather than an image

- **WHEN** `weather_satellite` answers successfully
- **THEN** the response carries an image URL, its media type and its size, and does not carry the image itself

### Requirement: Routed only where imagery was asked for

The supervisor SHALL be able to route to a `satellite` capability, and SHALL do so only where the question asks for satellite or observational imagery, or asks to see evidence alongside a forecast. A forecast question, a historical question and a concept question SHALL NOT cause satellite retrieval. The deterministic fallback router SHALL apply the same restraint from the question's vocabulary.

#### Scenario: An explicit request routes to satellite

- **WHEN** somebody asks to be shown the latest satellite observation for a place
- **THEN** the plan contains a satellite step

#### Scenario: An ordinary forecast question does not

- **WHEN** somebody asks what the temperature will be tomorrow
- **THEN** the plan contains no satellite step and no satellite tool is called

#### Scenario: A historical question does not

- **WHEN** somebody asks for a past period's average
- **THEN** the plan contains no satellite step and no satellite tool is called

### Requirement: Observation is not inference

An answer MAY state that imagery was retrieved, name the provider and product, and say which day it covers, and MAY set it beside a forecast as a separate signal. An answer SHALL NOT draw any meteorological claim from imagery — no cloud amount, rainfall, storm, front, pressure system, convection, instability, severity or model behaviour — unless that claim is supported by structured evidence retrieved by another capability.

#### Scenario: The synthesis layer is instructed and constrained

- **WHEN** the synthesis prompt is inspected
- **THEN** it states that satellite imagery is observational evidence only and enumerates the meteorological claims that may not be drawn from it

#### Scenario: Separate signals stay separate

- **WHEN** an answer carries both a forecast figure and a satellite observation
- **THEN** each is attributed to the capability that produced it and neither is presented as evidence for the other

### Requirement: No claim of image interpretation

Weathra SHALL NOT state or imply that it has looked at, analysed, examined or detected anything in an image unless a vision-capable process has actually run. While none exists, the image SHALL NOT be given to a language model — neither as bytes nor as a fetchable reference — so that no such claim can be produced even if the instruction is ignored, and every observation SHALL carry a statement that it was not interpreted.

#### Scenario: The model is given metadata, not the picture

- **WHEN** the synthesis request is assembled for a run carrying a satellite observation
- **THEN** it contains the provider, the product, the day and the coverage, and contains neither the image nor its URL

#### Scenario: No answer claims to have seen anything

- **WHEN** an answer carrying a satellite observation is produced
- **THEN** it contains no claim of having analysed, examined, detected or seen anything in the imagery

### Requirement: Provenance in the evidence record

A run that retrieves satellite imagery SHALL record the capability, the agent, the tool call, the provider, the product, the observation day and the retrieval time in the evidence record, and SHALL carry the observation and its attribution in the answer envelope. A surface listing the sources a run used SHALL list the satellite source only where that run actually retrieved one, and SHALL name the provider that served it.

#### Scenario: The record names the real provider

- **WHEN** a satellite-assisted run's evidence is read
- **THEN** it names the actual provider and product rather than a generic label

#### Scenario: A run without satellite lists none

- **WHEN** a run that retrieved no imagery is displayed
- **THEN** no satellite source is listed

### Requirement: Optional, and honest when unavailable

Satellite retrieval SHALL be optional. Where it fails, the other capabilities SHALL answer as they would have, and the failure SHALL be recorded and reported rather than smoothed over. Where somebody explicitly asked for satellite evidence and none could be retrieved, the answer SHALL say so. No substitute, stale-as-fresh or invented imagery SHALL ever be produced.

#### Scenario: A failed satellite step does not cost the forecast

- **WHEN** a run asks for imagery and a forecast, and the imagery cannot be retrieved
- **THEN** the forecast figures are still answered and the satellite step is recorded as failed

#### Scenario: An explicit request that fails says so

- **WHEN** somebody asks to be shown satellite imagery and none can be retrieved
- **THEN** the run records that it could not be retrieved and that nothing was substituted for it
