## Purpose

The FastAPI surface the Next.js application and any other client consume: versioned typed REST endpoints for locations, weather, history, analytics, comparison, preferences, saved locations and evidence, plus SSE streams that carry agent progress and tool activity as a question is worked.

Identity and authorization behavior is specified in `specs/authentication`; this capability specifies how that boundary appears on the HTTP surface.

## ADDED Requirements

### Requirement: Authentication on the HTTP surface

Protected endpoints SHALL require a Supabase access token presented as a bearer token in the `Authorization` header, SHALL validate it, and SHALL act as its subject. The API SHALL NOT accept a user or profile identifier from a header, query parameter, or body field as identity.

An unauthenticated request to a protected endpoint SHALL return 401 with the standard error envelope. A request whose token is valid but which targets a record the acting user does not own SHALL return 404 or 403 without disclosing whether the record exists.

#### Scenario: Bearer token accepted

- **WHEN** a request to a protected endpoint presents a valid bearer token
- **THEN** it succeeds and acts as that token's subject

#### Scenario: Missing token returns 401

- **WHEN** a request to a protected endpoint presents no token
- **THEN** the response is 401 in the standard error envelope
- **AND** no user-owned data is read or written

#### Scenario: Expired token returns 401

- **WHEN** a request presents an expired token
- **THEN** the response is 401 with a code distinguishable from a malformed-token failure

#### Scenario: Foreign record not disclosed

- **WHEN** an authenticated user requests a record owned by another user
- **THEN** the response is 404 or 403
- **AND** does not reveal whether the record exists

#### Scenario: Identity header ignored

- **WHEN** a request presents a valid token for one user and a header naming another
- **THEN** the request acts as the token's subject

### Requirement: Public and protected endpoint classification

Every endpoint SHALL be classified public or protected, and the classification SHALL appear in the API documentation and the OpenAPI schema's security metadata. Public endpoints SHALL be limited to health, readiness, locations, current weather, forecast, history, analysis, and comparison. Protected endpoints SHALL include the agent ask endpoint, the agent stream, the forecast changes endpoint, preferences, saved locations, evidence, the current-user endpoint, and user data deletion.

#### Scenario: Classification published

- **WHEN** the OpenAPI schema and API documentation are read
- **THEN** every endpoint is marked public or protected

#### Scenario: Public weather endpoint without a token

- **WHEN** an unauthenticated client requests a forecast for a named location
- **THEN** the request succeeds

#### Scenario: Public endpoint applies preferences only when authenticated

- **WHEN** an authenticated client calls a public weather endpoint without specifying units
- **THEN** their preferred units are applied
- **AND** the same call without a token uses the documented defaults

### Requirement: Current-user endpoint

The API SHALL provide a protected endpoint returning the acting user's identity and application profile — the authentication subject, the email as reported by the token, the profile creation time, and their effective preferences — creating the profile on first authenticated use. It SHALL NOT return credential material.

#### Scenario: Current user returned

- **WHEN** an authenticated client calls the current-user endpoint
- **THEN** the response carries their authentication subject, email, profile creation time, and effective preferences

#### Scenario: Profile created on first call

- **WHEN** a newly verified user calls the current-user endpoint for the first time
- **THEN** an application profile exists for them afterwards

#### Scenario: Unauthenticated call refused

- **WHEN** an unauthenticated client calls the current-user endpoint
- **THEN** the response is 401

### Requirement: User data deletion endpoint

The API SHALL provide a protected endpoint deleting the acting user's Weathra application data — saved locations, preferences, threads and memory, and stored agent runs — and returning confirmation of what was removed. It SHALL delete only the acting user's records.

#### Scenario: User data deleted

- **WHEN** an authenticated user calls the deletion endpoint
- **THEN** their saved locations, preferences, threads, memory, and agent runs are removed
- **AND** the response confirms what was deleted

#### Scenario: Other users unaffected

- **WHEN** one user deletes their data
- **THEN** another user's records remain intact

### Requirement: Versioned, documented API surface

The API SHALL serve all data endpoints under a version prefix so later incompatible contracts can coexist, SHALL publish a machine-readable OpenAPI schema covering every endpoint and model, and SHALL serve interactive documentation. Every request and response body SHALL be a declared typed model.

#### Scenario: Endpoints under version prefix

- **WHEN** a client calls a data endpoint
- **THEN** the endpoint path carries the API version prefix

#### Scenario: OpenAPI schema published

- **WHEN** a client requests the OpenAPI document
- **THEN** it describes every endpoint, request model, and response model

#### Scenario: Interactive documentation served

- **WHEN** a person opens the documentation path
- **THEN** interactive API documentation is served

### Requirement: Location endpoints

The API SHALL provide location search by free-text query with a result limit, and single-location resolution from a name or a latitude and longitude pair. An ambiguous name SHALL return a successful response marked ambiguous with its candidates, distinguishable from a single resolution; an unresolvable name SHALL return a not-found error.

#### Scenario: Location search

- **WHEN** a client searches locations with a query and a limit
- **THEN** the response contains up to that many ranked candidates

#### Scenario: Ambiguous resolution

- **WHEN** a client resolves a name matching several locations
- **THEN** the response is successful, marked ambiguous, and lists the candidates
- **AND** is distinguishable from a single successful resolution

#### Scenario: Unresolvable location

- **WHEN** a client resolves a name matching no location
- **THEN** the response is a not-found error in the standard error shape

### Requirement: Current weather and forecast endpoints

The API SHALL provide a current-conditions endpoint and a forecast endpoint, each accepting a location as a name or coordinate pair with optional units and provider, the forecast additionally accepting a horizon. Both responses SHALL carry the location, provider, units, retrieval time, cache status, data class, and uncertainty statement.

#### Scenario: Current conditions retrieved

- **WHEN** a client requests current conditions for a location
- **THEN** the response carries the conditions, location, provider, units, retrieval time, cache status, and data class

#### Scenario: Forecast retrieved by name

- **WHEN** a client requests a forecast for a location name
- **THEN** the response carries hourly and daily series with the location, provider, units, retrieval time, cache status, and uncertainty statement

#### Scenario: Forecast retrieved by coordinates

- **WHEN** a client requests a forecast by latitude and longitude
- **THEN** the response carries the forecast for that point

#### Scenario: Unknown provider requested

- **WHEN** a client names a provider that is not registered
- **THEN** the response is a validation error listing the registered provider names

### Requirement: Forecast changes endpoint

The API SHALL provide a protected forecast-changes endpoint accepting a location as a name or
coordinate pair with optional units, provider, and horizon, returning the forecast-comparison result
the forecast-analysis capability produces for that location and window. The endpoint SHALL NOT
compute the comparison itself: it SHALL retrieve the forecast through the forecast service and
delegate to that capability, and the response SHALL carry the capability's own result unchanged —
the location, the window, the provider, the units, the data class, the retrieval times being
compared, the per-day signed deltas with their materiality, and the plain-language statement.

The response SHALL distinguish a populated comparison from a window with no earlier snapshot: a
populated comparison SHALL report the comparison as available with both retrieval times and its
per-day deltas, and a window with nothing earlier on record SHALL report the comparison as
unavailable with no previous retrieval time and no deltas rather than as an absence of movement. A
comparison that cannot be obtained at all SHALL be reported as an error in the standard error
envelope, distinguishable from both, and an unauthenticated request SHALL be refused with 401 before
any provider is called.

Retrieving a forecast through this endpoint SHALL record it as a snapshot for later comparisons, and
a failure to record SHALL NOT fail the response.

#### Scenario: Movement returned for a window with an earlier snapshot

- **WHEN** an authenticated client requests changes for a location and window an earlier snapshot
  covers
- **THEN** the response reports the comparison as available with both retrieval times, the per-day
  signed deltas, and the statement produced by the forecast-analysis capability

#### Scenario: No earlier snapshot reported as such

- **WHEN** an authenticated client requests changes for a location and window with nothing earlier
  on record
- **THEN** the response reports the comparison as unavailable with no previous retrieval time and no
  deltas
- **AND** does not present the current forecast as a change

#### Scenario: Comparison unavailable reported as an error

- **WHEN** the forecast the comparison needs cannot be retrieved
- **THEN** the response is an error in the standard error envelope
- **AND** is distinguishable from a successful response reporting no earlier snapshot

#### Scenario: Unauthenticated request refused

- **WHEN** an unauthenticated client requests changes
- **THEN** the response is 401 in the standard error envelope
- **AND** no provider is called

#### Scenario: Retrieval recorded for later comparison

- **WHEN** an authenticated client requests changes for a location and window
- **THEN** the retrieved forecast is recorded as a snapshot
- **AND** a failure to record it does not fail the response

### Requirement: History endpoint

The API SHALL provide a history endpoint accepting a location, a past date range, optional units, and optional provider, returning observed data labelled as historical. It SHALL additionally support period-versus-period comparison, baseline computation over a requested number of years, and placing an observed past period against the baseline of the years before it.

The baseline-comparison response SHALL carry the baseline it was placed against — including the years actually used — the signed difference, the z-score, and a plain-language characterization, and SHALL NOT require a caller to derive any of them. Where the baseline has no spread, the z-score SHALL be reported as undefined with its reason and the signed difference SHALL still be reported.

#### Scenario: Observations retrieved

- **WHEN** a client requests observations for a past range
- **THEN** the response carries the observed series labelled as historical with its provider and retrieval time

#### Scenario: Period comparison requested

- **WHEN** a client requests a comparison of two past periods
- **THEN** the response carries both periods' aggregates, the deltas, and the shared basis

#### Scenario: Baseline requested

- **WHEN** a client requests a baseline over 10 years
- **THEN** the response carries the baseline statistics and the years actually used

#### Scenario: Period placed against its baseline

- **WHEN** a client places an observed past period against a baseline over 10 years
- **THEN** the response carries the baseline with the years actually used, the signed difference, the z-score, and a plain-language characterization
- **AND** both sides are labelled as observations rather than as a forecast-accuracy score

#### Scenario: Baseline comparison with no spread

- **WHEN** the baseline for a placed period has a standard deviation of zero
- **THEN** the z-score is reported as undefined with its reason
- **AND** the signed difference is still reported

#### Scenario: Range outside coverage

- **WHEN** a client requests a range beginning before the provider's earliest available date
- **THEN** the response is a validation error stating the earliest available date

### Requirement: Analysis endpoint

The API SHALL provide an analysis endpoint accepting a location, an optional window, optional units, optional threshold conditions, and a requested statistic set, returning the deterministic analytics results, trends, threshold crossings, anomalies, the plain-language summary, and the method and point count behind each figure.

#### Scenario: Analysis with thresholds

- **WHEN** a client requests analysis with a temperature threshold
- **THEN** the response carries the analytics results, the threshold outcome, anomalies, and a summary

#### Scenario: Analysis reports methods

- **WHEN** any analysis response is returned
- **THEN** each reported figure carries the method and point count behind it

#### Scenario: Statistic not computable

- **WHEN** a requested statistic cannot be computed from the retrieved series
- **THEN** the response reports that statistic unavailable with the reason
- **AND** returns the statistics that were computable

### Requirement: Comparison endpoint

The API SHALL provide a comparison endpoint accepting either two or more locations, or a single location with day-level comparison requested, plus a criterion, an optional window, optional units, and an optional historical mode. The response SHALL carry every candidate with its rank, score, and supporting analytics, and SHALL list candidates excluded for want of data with the reason.

#### Scenario: Multi-location comparison

- **WHEN** a client compares three locations by a supported criterion
- **THEN** the response ranks all three with their scores and supporting analytics

#### Scenario: Historical comparison mode

- **WHEN** a client compares two locations over a past period
- **THEN** the response is computed from historical observations and labelled as historical

#### Scenario: Comparison with an excluded candidate

- **WHEN** data for one compared location cannot be retrieved
- **THEN** the response ranks the remaining candidates and lists the excluded one with its reason

#### Scenario: Invalid comparison request

- **WHEN** a client requests a comparison with one location and no day-level comparison
- **THEN** the response is a validation error stating that at least two candidates are required

### Requirement: Agent ask endpoint

The API SHALL provide a protected request/response endpoint accepting a free-text question with an optional conversation thread identifier, default location, and units, returning the answer, the evidence record, the data-class labels, and the provider and model that produced it. The acting user SHALL come from the validated token, and a thread identifier SHALL be accepted only when the acting user owns that thread. When no inference credential is configured, it SHALL return a service-unavailable error naming the missing configuration while every public endpoint continues to serve.

#### Scenario: Question answered

- **WHEN** an authenticated client posts a weather question
- **THEN** the response carries the answer, the evidence record, the data-class labels, and the provider and model used

#### Scenario: Follow-up question in a thread

- **WHEN** an authenticated client posts a follow-up naming a thread it owns
- **THEN** the answer resolves references from that thread's context and states what it resolved to

#### Scenario: Foreign thread refused

- **WHEN** an authenticated client posts a question naming a thread owned by another user
- **THEN** the request fails without disclosing whether that thread exists

#### Scenario: Unauthenticated question refused

- **WHEN** an unauthenticated client posts a question
- **THEN** the response is 401
- **AND** no run begins

#### Scenario: Agent not configured

- **WHEN** an authenticated client posts a question while no inference credential is configured
- **THEN** the response is a service-unavailable error naming the missing configuration
- **AND** the forecast, history, analysis, and comparison endpoints continue to return successful responses

### Requirement: SSE streaming of agent progress

The API SHALL provide a protected server-sent-events stream for an agent question, emitting typed events for routing decisions, agent start and finish, tool call start and finish, partial answer content, the final answer, and terminal errors. Each event SHALL carry the request identifier and an ordering marker, and the stream SHALL terminate with an explicit completion or error event.

The stream SHALL require and validate a bearer token before any run begins, SHALL act as its subject throughout, and SHALL emit a terminal authentication error event if the session becomes invalid mid-stream. A client disconnecting mid-stream SHALL NOT produce an unhandled server error.

#### Scenario: Authenticated stream runs as the token subject

- **WHEN** an authenticated client opens the stream
- **THEN** the run acts as that user and applies their memory and preferences

#### Scenario: Unauthenticated stream refused

- **WHEN** an unauthenticated client opens the stream
- **THEN** the response is 401 and no run begins

#### Scenario: Session invalidated mid-stream

- **WHEN** the session becomes invalid while the stream is open
- **THEN** the stream emits a terminal authentication error event and closes

#### Scenario: Progress events streamed in order

- **WHEN** a client opens the stream for a question
- **THEN** it receives routing, agent, and tool events in execution order followed by the final answer and a completion event

#### Scenario: Events carry correlation and ordering

- **WHEN** any stream event is received
- **THEN** it carries the request identifier and an ordering marker

#### Scenario: Stream terminates on error

- **WHEN** the run fails partway
- **THEN** the stream emits a terminal error event describing the failure and closes

#### Scenario: Client disconnects mid-stream

- **WHEN** the client disconnects before completion
- **THEN** the server abandons the run without raising an unhandled error

### Requirement: Preferences and saved-locations endpoints

The API SHALL provide protected endpoints to read, update, and delete the acting user's preferences, and to list, add, and remove their saved locations, each scoped to the authenticated user derived from the validated token.

#### Scenario: Preferences read and updated

- **WHEN** an authenticated client updates its unit preference and then reads its preferences
- **THEN** the read reflects the updated preference

#### Scenario: Saved location added and listed

- **WHEN** an authenticated client adds a saved location and then lists saved locations
- **THEN** the added location appears in the list

#### Scenario: Saved location removed

- **WHEN** an authenticated client removes a saved location
- **THEN** it no longer appears in the list

#### Scenario: Unauthenticated access refused

- **WHEN** an unauthenticated client calls a preferences or saved-locations endpoint
- **THEN** the response is 401

#### Scenario: User isolation enforced

- **WHEN** two authenticated users list saved locations
- **THEN** each sees only their own

#### Scenario: Cross-user mutation refused

- **WHEN** an authenticated user attempts to remove a saved location owned by another user
- **THEN** the request fails and the other user's record is unchanged

### Requirement: Evidence endpoint

The API SHALL provide a protected endpoint returning the stored evidence record for one of the acting user's completed agent requests by its identifier, containing the agents that ran, the tool calls and results, the analytics results, the knowledge chunks cited, the data classes, the provider and model, and the timings. An identifier that is unknown, or that belongs to another user, SHALL return a not-found error in both cases.

#### Scenario: Evidence retrieved

- **WHEN** an authenticated client requests the evidence for its own completed agent request
- **THEN** the response carries the agents, tool calls and results, analytics results, cited knowledge chunks, data classes, provider and model, and timings

#### Scenario: Unknown evidence identifier

- **WHEN** a client requests evidence for an unknown identifier
- **THEN** the response is a not-found error in the standard error shape

#### Scenario: Another user's evidence not disclosed

- **WHEN** an authenticated client requests evidence belonging to another user
- **THEN** the response is the same not-found error as for an unknown identifier

### Requirement: Request validation

The API SHALL validate every request against its declared model and SHALL reject an invalid request with a validation error naming each offending field and why it failed, without calling a provider, a language model, or the database.

#### Scenario: Missing required field

- **WHEN** a client omits a required field
- **THEN** the response is a validation error naming that field
- **AND** no provider, model, or database call is made

#### Scenario: Out-of-range value

- **WHEN** a client supplies a horizon of zero days
- **THEN** the response is a validation error naming the horizon and stating the permitted range

### Requirement: Consistent error model

Every error response SHALL use one shape carrying a stable machine-readable code, a human-readable message, optional field-level detail, and the request identifier. Error responses SHALL NOT contain stack traces, credentials, tokens, or raw upstream payloads. HTTP status SHALL distinguish validation errors, unauthenticated requests, forbidden requests, not-found, upstream failure, upstream timeout, upstream rate-limiting, unavailable dependencies, and unexpected internal failure.

#### Scenario: Error shape

- **WHEN** any request fails
- **THEN** the response body carries a stable code, a message, any field detail, and the request identifier

#### Scenario: Upstream failure surfaced

- **WHEN** the weather provider is unreachable
- **THEN** the response reports an upstream failure with a status distinguishable from a validation error
- **AND** contains no stack trace, credential, or raw upstream payload

#### Scenario: Unexpected internal failure

- **WHEN** an unhandled internal failure occurs
- **THEN** the response is a generic internal error in the standard shape
- **AND** internal details are recorded in logs rather than returned

#### Scenario: Authentication failures distinguishable

- **WHEN** a request fails for want of a token and another fails for want of ownership
- **THEN** the first returns an unauthenticated status and the second a forbidden or not-found status
- **AND** neither body contains token material

### Requirement: Health and readiness

The API SHALL report a health endpoint stating that the service is running, and a readiness report naming each dependency — the default weather provider, the database, the vector store, the MCP server, and the inference provider — with whether it is configured and reachable. The report SHALL disclose no credential values, SHALL name the configured model and vector store, and SHALL report the service healthy when only the inference provider is unconfigured.

#### Scenario: Health reported

- **WHEN** a client calls the health endpoint
- **THEN** the response states that the service is running

#### Scenario: Readiness enumerates dependencies

- **WHEN** a client calls the readiness endpoint
- **THEN** the report names the weather provider, database, vector store, MCP server, and inference provider with their configured and reachable status

#### Scenario: Readiness with unconfigured inference provider

- **WHEN** readiness is called while no inference credential is configured
- **THEN** the report marks the inference provider not configured
- **AND** the service still reports itself healthy
- **AND** no credential value appears in the response

### Requirement: Evidence records are discoverable by their owner

The HTTP API SHALL expose an endpoint returning the acting person's own stored evidence records, newest first, so a person can find a run without already knowing its identifier.

Each row SHALL carry enough to recognise a run and open it — its identifier, when it was created, the question asked, how long it took, whether it was partial, and the places it resolved by display name — and SHALL NOT carry coordinates as a place's label.

The listing SHALL be owner-scoped by an explicit predicate in the query and by Row Level Security behind it. A caller SHALL see their own records or none, and the response SHALL disclose nothing about whether any other person's records exist.

#### Scenario: A person finds their own runs

- **WHEN** a signed-in person asks for their evidence records
- **THEN** their own stored runs are returned, newest first
- **AND** each row carries its identifier, its question, and the places it resolved by name

#### Scenario: One person's runs are not another's

- **WHEN** a person asks for their evidence records
- **THEN** no record belonging to anybody else appears
- **AND** the response says nothing about whether such records exist

### Requirement: Travel intelligence endpoint

The HTTP API SHALL expose an endpoint that analyses one trip — a destination, a departure date and a return date, with an optional origin — and returns the whole analysis in a single typed response: the trip and its resolved locations, a hero summary, a travel viability index, analytical metrics, the destination's daily outlook, a packing strategy, a comparison against other travel windows, any forecast change, a synthesis, the historical baseline, a grounding evidence bundle, and the sections that could not be produced.

The endpoint SHALL compute every section from a **single** destination forecast retrieval. It SHALL NOT retrieve the same forecast more than once to serve different sections of one response.

The viability index SHALL be derived from the deterministic scoring the backend already defines, expressed on a 0-100 scale, and SHALL carry the disclosure that its weighting is Weathra's own heuristic. No figure in the response SHALL be fabricated: a statistic that cannot be computed SHALL be returned as unavailable with its reason.

A failure in a secondary section — the archive, or the forecast snapshot history — SHALL be reported in the response's partial failures and SHALL NOT fail the request. A failure to retrieve the destination forecast SHALL fail the request, because there is no trip weather without it.

#### Scenario: A trip is analysed from one retrieval

- **WHEN** a trip is submitted
- **THEN** one response carries every section the screen renders
- **AND** the destination forecast was retrieved once

#### Scenario: A secondary source fails

- **WHEN** the archive cannot answer for the trip's calendar period
- **THEN** the historical baseline is null and the reason appears in partial failures
- **AND** the rest of the response is returned with a success status

#### Scenario: The forecast cannot be retrieved

- **WHEN** the provider cannot serve the destination forecast
- **THEN** the request fails rather than returning a response with no trip weather in it

### Requirement: Request correlation and observability

Every request SHALL be assigned a correlation identifier, accepted from the client when supplied and generated otherwise, returned in the response and in error bodies, and present in that request's log records and stream events. Logs SHALL record the endpoint, outcome, duration, provider used, cache status, and — for agent requests — the agents and tools invoked, and SHALL contain no credentials.

#### Scenario: Correlation identifier returned

- **WHEN** a client makes any request
- **THEN** the response carries a correlation identifier
- **AND** log records for that request carry the same identifier

#### Scenario: Failure traceable

- **WHEN** a request fails
- **THEN** the error body carries the correlation identifier that appears in the logs

#### Scenario: Agent activity logged

- **WHEN** an agent request completes
- **THEN** its log records name the agents and tools invoked

### Requirement: Cross-origin access for the frontend

The API SHALL permit browser clients from the configured allowed origins, with the allowed origins configurable and covering local development and the deployed frontend origin. Configuration SHALL NOT require a wildcard origin in deployed environments, and the `Authorization` header SHALL be permitted so authenticated browser requests and streams succeed.

#### Scenario: Frontend calls the API

- **WHEN** the Next.js frontend running on a configured allowed origin calls the API with a bearer token
- **THEN** the request succeeds, including for SSE streams

#### Scenario: Disallowed origin

- **WHEN** a browser client from an origin outside the configured list calls the API
- **THEN** the browser is not granted cross-origin access

#### Scenario: No wildcard required

- **WHEN** the deployed configuration is inspected
- **THEN** the allowed origins are explicit and contain no wildcard

### Requirement: Model selection is not caller-selectable on product endpoints

The agent ask and streaming endpoints SHALL NOT accept a model or policy identifier as an authoritative input. Where such a field is accepted at all it SHALL be advisory: the backend SHALL honour it only within the caller's established entitlement, SHALL otherwise ignore it and serve the request under the entitled policy, and SHALL NOT fail the request on account of the field.

Every agent response and stream SHALL report the provider, the model that actually ran, and the resolving policy, so a caller can see what served them without being able to choose it.

#### Scenario: Advisory field above entitlement ignored

- **WHEN** a Free-plan caller posts a question with a field naming a premium model
- **THEN** the request succeeds under the Free plan's policy
- **AND** the response reports the model that actually ran, not the requested one

#### Scenario: Advisory field within entitlement honoured

- **WHEN** a Pro-plan caller names a model their entitled policy already permits and the catalog has enabled
- **THEN** the response may report that model as used

#### Scenario: Response reports what served it

- **WHEN** an agent request or stream completes
- **THEN** the provider, the model used, and the resolving policy are reported

#### Scenario: Unknown model field does not fail the request

- **WHEN** a caller posts a question naming a model identifier that does not exist
- **THEN** the request still succeeds under the entitled policy
- **AND** the field is reported as ignored rather than raising a validation error

### Requirement: Quota enforcement on the HTTP surface

The API SHALL refuse an agent request or stream whose caller has exhausted their allowance, using HTTP 429 with the standard error model, and SHALL include the bound dimension, the allowance, the consumption, the window reset time, and a retry-after indication. The refusal SHALL be distinguishable from an authentication failure, an upstream weather failure, an agent-unconfigured failure, and a gateway rate limit.

A stream whose caller is already over allowance SHALL be refused before the stream opens rather than terminated mid-answer. Endpoints that consume no language model allowance SHALL continue to serve a caller whose allowance is exhausted.

#### Scenario: Quota refusal returns 429 with its basis

- **WHEN** a caller with an exhausted allowance posts a question
- **THEN** the response is 429 in the standard error shape naming the bound dimension, the allowance, the consumption, the reset time, and a retry-after

#### Scenario: Quota refusal distinguishable from other failures

- **WHEN** a caller inspects the error code
- **THEN** it distinguishes an exhausted allowance from a 401, an upstream failure, an unconfigured agent, and a gateway rate limit

#### Scenario: Stream refused before opening

- **WHEN** a caller with an exhausted allowance opens the stream endpoint
- **THEN** the request is refused with 429 before any stream event is sent

#### Scenario: Non-agent endpoints unaffected

- **WHEN** a caller with an exhausted allowance requests locations, current weather, forecast, history, analysis, or comparison
- **THEN** the requests succeed

### Requirement: Plan and usage endpoint for the signed-in person

The API SHALL expose a protected endpoint returning the acting principal's own plan and usage: the plan code and display name, consumption and remaining allowance per applicable dimension, each window's reset time, and a bounded recent usage summary. It SHALL NOT expose another user's usage, internal usage, aggregate cost across users, or catalog pricing beyond what the caller's own plan states.

An unauthenticated call SHALL be refused. A caller-supplied user identifier SHALL be ignored in favour of the token subject.

#### Scenario: Own plan and usage returned

- **WHEN** an authenticated caller reads their plan and usage
- **THEN** the plan code and display name, per-dimension consumption and remaining allowance, and each window's reset time are returned

#### Scenario: Another user's usage not disclosed

- **WHEN** a caller supplies a user identifier for someone else
- **THEN** the response covers the token subject only

#### Scenario: Unauthenticated call refused

- **WHEN** the endpoint is called with no validated token
- **THEN** the request is refused as unauthenticated

#### Scenario: Internal usage not exposed

- **WHEN** an ordinary caller reads their plan and usage
- **THEN** no internal, administrative, evaluation, or lab usage appears

### Requirement: Administrative model, usage, and lab endpoints

The API SHALL expose administrative endpoints, all protected and all refused for any principal without the administrative role, covering at minimum: listing and administering the model catalog including enable and disable; listing and administering model policies and plan-to-policy mappings; listing and administering subscription plans, allowances, and a principal's plan assignment; reading aggregate usage by model, policy, plan, call role, status, and period with internal usage reported separately; and initiating and reading model lab comparison runs and their recorded results.

These endpoints SHALL sit under the versioned prefix, SHALL appear in the published OpenAPI schema, SHALL be classified as protected and administrative in the published endpoint classification, and SHALL use the standard error model. A refusal for a non-administrative caller SHALL disclose nothing about the endpoint's contents.

#### Scenario: Administrative endpoints classified and documented

- **WHEN** the endpoint classification and the OpenAPI schema are read
- **THEN** every administrative model, usage, and lab endpoint is present and classified as protected and administrative

#### Scenario: Non-administrative caller refused

- **WHEN** an ordinary authenticated caller calls any administrative model, usage, or lab endpoint
- **THEN** the request is refused
- **AND** no catalog, policy, plan, usage, or lab content is returned

#### Scenario: Catalog administered

- **WHEN** an administrative caller disables a catalog entry
- **THEN** the change is applied and reported, and subsequent resolutions skip that model

#### Scenario: Aggregate usage read

- **WHEN** an administrative caller reads aggregate usage for a period
- **THEN** call counts, token totals, estimated cost totals, failure rates, and median and 95th-percentile latency are returned by model, policy, plan, call role, and status, with internal usage separated

#### Scenario: Lab comparison initiated and read

- **WHEN** an administrative caller initiates a comparison across selected enabled models and then reads the run
- **THEN** the run's per-model results with latency, tokens, estimated cost, status, and evaluation result are returned

#### Scenario: Unauthenticated administrative call refused

- **WHEN** an administrative endpoint is called with no validated token
- **THEN** the request is refused as unauthenticated
