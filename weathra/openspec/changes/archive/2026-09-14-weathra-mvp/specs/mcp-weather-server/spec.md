## Purpose

The Model Context Protocol server that is Weathra's single approved gateway to weather data and analytics for any agent or client — a stable, self-describing tool boundary with its own implementation, its own tests, and no knowledge of the graph that calls it.

## ADDED Requirements

### Requirement: Server boundary and independence

The MCP weather server SHALL be implemented as its own component with its own module boundary and its own test suite, depending on the provider, analytics, and location capabilities but not on the agent graph, the HTTP API, or the frontend. It SHALL be startable and exercisable independently of the agent surface, and SHALL require no inference credential to operate.

#### Scenario: Server runs without the agent surface

- **WHEN** the MCP server is started with no inference credential configured
- **THEN** it starts successfully and its tools respond to calls

#### Scenario: No dependency on the agent graph

- **WHEN** the MCP server's source files are inspected
- **THEN** none of them imports the agent graph, the HTTP routers, or the frontend

#### Scenario: Tools exercised without the graph

- **WHEN** the test suite calls each MCP tool directly
- **THEN** every tool can be exercised without constructing the agent graph

### Requirement: Tool catalog

The server SHALL expose these tools, each with a declared input schema, a declared output shape, and a description stating what it returns and what data class that is:

| Tool | Purpose |
|---|---|
| `geocode_location` | Resolve a place name or coordinates to a canonical location |
| `weather_current` | Current conditions for a location |
| `weather_forecast` | Hourly and daily forecast over a horizon |
| `weather_history` | Observed weather over a past range |
| `weather_compare` | Compare locations, days, or periods against a criterion |
| `weather_statistics` | Deterministic statistics over a retrieved series |
| `weather_anomaly` | Deterministic anomaly detection over a retrieved series |

The catalog SHALL be discoverable through MCP's own listing mechanism, and each tool's schema SHALL be sufficient for a client to call it correctly without out-of-band documentation.

#### Scenario: Catalog discoverable

- **WHEN** a client lists the server's tools
- **THEN** all seven tools are returned with their input schemas, output shapes, and descriptions

#### Scenario: Tool description states its data class

- **WHEN** a client reads the description of `weather_history`
- **THEN** it states that the tool returns historical observations

#### Scenario: Every tool callable from its schema alone

- **WHEN** a client constructs a call from a tool's declared input schema
- **THEN** the call is accepted and validated against that schema

### Requirement: Tools return normalized, attributed results

Every tool result SHALL be structured, SHALL carry the location it concerns, the time period it covers, the units used, the source provider, the retrieval time, and its data class — current conditions, forecast, historical observation, or computed statistic. No tool SHALL return a raw upstream provider payload.

#### Scenario: Result carries attribution

- **WHEN** any weather tool returns successfully
- **THEN** the result states the location, period, units, source provider, retrieval time, and data class

#### Scenario: No raw payload returned

- **WHEN** a tool result is inspected
- **THEN** it contains only normalized model fields and no provider-specific field names

### Requirement: Statistics and anomaly tools are deterministic

`weather_statistics` and `weather_anomaly` SHALL compute their results through the deterministic analytics capability and SHALL NOT invoke a language model. Each result SHALL state the method applied, the number of points used, and the parameters supplied.

#### Scenario: Statistics computed deterministically

- **WHEN** `weather_statistics` is called twice with identical arguments over the same series
- **THEN** both calls return identical results

#### Scenario: Method disclosed

- **WHEN** `weather_anomaly` returns anomalies
- **THEN** the result states the detection method, threshold, and point count

#### Scenario: No language model involved

- **WHEN** `weather_statistics` or `weather_anomaly` is called with no inference credential configured
- **THEN** the call succeeds

### Requirement: Input validation

Every tool SHALL validate its arguments against its declared schema before doing any work, and SHALL reject an invalid call with an error naming each offending argument and why it failed, without calling a provider or performing a computation.

#### Scenario: Missing required argument

- **WHEN** a tool is called without a required argument
- **THEN** the call fails with an error naming that argument
- **AND** no upstream provider call is made

#### Scenario: Out-of-range argument

- **WHEN** `weather_forecast` is called with a horizon of zero days
- **THEN** the call fails with an error naming the horizon and stating the permitted range

#### Scenario: Unknown tool name

- **WHEN** a client calls a tool name the server does not expose
- **THEN** the server returns a tool-not-found error listing the available tool names

### Requirement: Error semantics

Tool errors SHALL be returned as structured tool errors distinguishing invalid input, location not resolvable, no data for the requested period, provider unavailable, provider timeout, and provider rate-limited. A tool error SHALL NOT be returned as a successful result containing empty or zeroed weather values, and SHALL NOT leak credentials or raw upstream payloads.

#### Scenario: Provider failure surfaced as a tool error

- **WHEN** the upstream provider is unreachable during a tool call
- **THEN** the tool returns a provider-unavailable error
- **AND** does not return a success result with empty or zero values

#### Scenario: Error classes distinguishable

- **WHEN** a caller receives a tool error
- **THEN** invalid input, unresolvable location, no data, unavailability, timeout, and rate-limiting are distinguishable from one another

#### Scenario: No credential leakage

- **WHEN** any tool error is returned
- **THEN** it contains no credential material and no raw upstream payload

### Requirement: Transport and configuration

The server SHALL support a transport suitable for in-process or co-deployed use by the backend, and its address, timeouts, and enabled tool set SHALL be configuration rather than compiled-in constants. The backend SHALL fail fast at startup with a clear message when the MCP server is configured but unreachable.

#### Scenario: Configured transport used

- **WHEN** the backend starts with the MCP server configured
- **THEN** it connects over the configured transport and lists the available tools

#### Scenario: Unreachable server reported at startup

- **WHEN** the MCP server is configured but unreachable at backend startup
- **THEN** the backend reports the failure with a message naming the MCP server and its configured address
