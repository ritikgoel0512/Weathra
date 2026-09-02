## Purpose

The LangGraph supervisor that turns a free-text weather question into a routed, multi-step plan across four specialized agents — Forecast, Historical, Analytics, and RAG — executes it through approved tools, records everything it did as evidence, and returns an answer in which the language model has interpreted results it never computed and figures it never invented.

## ADDED Requirements

### Requirement: Supervisor routing across specialized agents

The system SHALL implement a supervisor that inspects an incoming request and routes it to one or more specialized agent capabilities, each with an explicit and non-overlapping responsibility:

- **Forecast Agent** — current conditions and hourly, daily, and multi-day forecasts, covering precipitation, temperature, wind, humidity, and pressure.
- **Historical Agent** — historical retrieval, historical period comparison, historical baselines, and comparison of conditions against those baselines.
- **Analytics Agent** — deterministic Python calculation only, over data another agent retrieved.
- **RAG Agent** — retrieval of weather-domain knowledge to explain meteorological concepts and terminology.

The supervisor SHALL record which agents it selected and why. Agents MAY be implemented as LangGraph nodes or subgraphs within one deployed service, but their responsibilities SHALL remain separately identifiable in both the execution record and the code structure.

#### Scenario: Forecast question routed to the Forecast Agent

- **WHEN** a caller asks what the temperature will be tomorrow in a named city
- **THEN** the supervisor routes to the Forecast Agent
- **AND** the execution record names that agent and the reason for selecting it

#### Scenario: Historical question routed to the Historical Agent

- **WHEN** a caller asks how wet last March was in a named city
- **THEN** the supervisor routes to the Historical Agent
- **AND** does not route the question to the Forecast Agent

#### Scenario: Conceptual question routed to the RAG Agent

- **WHEN** a caller asks what dew point means
- **THEN** the supervisor routes to the RAG Agent
- **AND** no weather-measurement tool is called to answer it

#### Scenario: Statistical question routed through retrieval then analytics

- **WHEN** a caller asks for the mean temperature over the next week in a named city
- **THEN** the supervisor routes first to the Forecast Agent to retrieve the series and then to the Analytics Agent to compute the mean
- **AND** the execution record shows both agents in that order

### Requirement: Multi-step queries spanning several agents

The supervisor SHALL support a single request whose answer requires several agents in sequence or in parallel, SHALL pass each agent's structured output forward as input to the next, and SHALL compose one coherent answer covering every part of the question. A question with multiple parts SHALL NOT be answered by silently dropping a part.

#### Scenario: Question spanning forecast, historical, and analytics

- **WHEN** a caller asks whether the coming week will be warmer than the same week last year in a named city
- **THEN** the supervisor retrieves the forecast, retrieves the historical period, computes the comparison deterministically, and answers with both sides and the difference
- **AND** the execution record shows each agent that contributed

#### Scenario: Question with a conceptual and a numerical part

- **WHEN** a caller asks what precipitation probability means and what it is tomorrow in a named city
- **THEN** the answer explains the concept from retrieved knowledge and reports tomorrow's value from a weather tool
- **AND** labels which part came from which source

#### Scenario: No part of a multi-part question dropped

- **WHEN** a caller asks a question with three distinct parts
- **THEN** the answer addresses all three, or states explicitly which part could not be answered and why

### Requirement: Provider-agnostic language model abstraction

The system SHALL define an internal language model client contract covering a tool-capable conversation turn, and SHALL treat the inference provider and model as environment configuration — at minimum a provider identifier, a model identifier, and the provider's credential. No agent, supervisor, or graph node SHALL import or reference a specific model vendor's SDK or a specific model name.

The system SHALL ship OpenRouter as the first concrete implementation. Substituting another implementation of the contract SHALL NOT change any behavior required elsewhere in this capability. Every answer SHALL report which provider and model produced it.

#### Scenario: Provider and model come from configuration

- **WHEN** the configured provider is OpenRouter and the configured model is changed to a different OpenRouter model
- **THEN** requests are answered using the newly configured model with no code change
- **AND** the response reports the provider and model used

#### Scenario: No vendor coupling in agent code

- **WHEN** the agent and orchestration source files are inspected
- **THEN** none of them imports a model vendor's SDK or hard-codes a model identifier

#### Scenario: Alternative implementation substituted

- **WHEN** a different implementation of the language model contract is configured
- **THEN** routing, tool use, evidence capture, grounding, and streaming behave identically

#### Scenario: Fake implementation used in tests

- **WHEN** the automated test suite runs with no inference credential and no network access
- **THEN** a fake implementation of the contract satisfies every orchestration test

### Requirement: Tool access only through the approved tool interface

Agents SHALL obtain weather data, geocoding, analytics, and knowledge exclusively through the approved tool interface exposed by the MCP weather server and the knowledge-retrieval tool. No agent SHALL call a weather provider directly, compute a statistic itself, or be given a tool that writes application data, executes arbitrary code, accesses the filesystem, or performs arbitrary network requests.

#### Scenario: Only approved tools offered

- **WHEN** the supervisor prepares a turn for the language model
- **THEN** the tools offered are limited to the approved weather, analytics, and knowledge tools
- **AND** none permits arbitrary code execution, filesystem access, arbitrary network access, or application writes

#### Scenario: Unknown tool requested

- **WHEN** the model requests a tool outside the catalog
- **THEN** an error result is returned to the model rather than anything being executed
- **AND** the request does not fail outright on that account

#### Scenario: Invalid tool arguments corrected

- **WHEN** the model calls a tool with arguments that fail validation
- **THEN** the validation error is returned to the model as the tool result
- **AND** the model may correct the call within the remaining step budget

#### Scenario: No direct provider access from an agent

- **WHEN** agent source files are inspected
- **THEN** none of them imports a weather provider client directly

### Requirement: The language model interprets but never calculates

The supervisor SHALL route every numerical meteorological question through retrieval followed by deterministic analytics, and the language model's role SHALL be limited to interpreting and explaining the structured results. A numerical figure in an answer SHALL be traceable to a tool result or analytics result in the evidence record.

#### Scenario: Statistic comes from analytics, not the model

- **WHEN** an answer reports a mean, maximum, total, percentile, or anomaly
- **THEN** that value appears unchanged in an analytics result in the evidence record

#### Scenario: Model asked to estimate refuses to invent

- **WHEN** a question requires a statistic that no tool was able to compute
- **THEN** the answer states that the figure is unavailable and why
- **AND** reports no estimated value in its place

### Requirement: Bounded execution

The supervisor SHALL run under a bounded number of graph steps and a bounded wall-clock duration, both configurable. When either bound is reached before an answer is complete, the system SHALL return a partial result stating that the question was not fully resolved, reporting what was retrieved and computed so far, rather than continuing or fabricating a conclusion.

#### Scenario: Answer within the budgets

- **WHEN** the graph resolves a question within its step and time budgets
- **THEN** the answer is returned with the full evidence record

#### Scenario: Step budget exhausted

- **WHEN** the graph reaches its maximum step count without a complete answer
- **THEN** a partial result is returned stating the question was not fully resolved
- **AND** the evidence gathered so far is reported

#### Scenario: Time budget exceeded

- **WHEN** execution exceeds its wall-clock bound
- **THEN** execution stops and a partial result is returned

### Requirement: Evidence record

Every answer SHALL carry a structured evidence record containing: the agents that ran and in what order, each tool call with its arguments, each tool result, each analytics result with its method, each retrieved knowledge chunk with its document identifier, the provider and model used, the data classes involved, and per-step timings. The record SHALL be sufficient for a reader to verify every figure and claim in the answer without re-running the question.

#### Scenario: Evidence accompanies every answer

- **WHEN** any question is answered
- **THEN** the response carries the evidence record with agents, tool calls, tool results, analytics results, knowledge chunks, provider and model, data classes, and timings

#### Scenario: Figure verifiable from evidence

- **WHEN** an answer states a weather figure
- **THEN** that figure is locatable in the evidence record's tool or analytics results

#### Scenario: Evidence retained for a partial answer

- **WHEN** a budget is exhausted and a partial result is returned
- **THEN** the evidence record still reports everything that ran before the bound was reached

### Requirement: Streaming progress

The system SHALL emit progress events as a question is worked, covering at minimum: routing decisions, each agent starting and finishing, each tool call starting and finishing, and the final answer. Events SHALL be ordered and each SHALL identify the request it belongs to. A consumer that disconnects mid-stream SHALL NOT cause the run to fail server-side beyond the abandoned request.

#### Scenario: Progress events emitted in order

- **WHEN** a question is streamed
- **THEN** the consumer receives routing, agent, and tool events in execution order followed by the final answer

#### Scenario: Consumer disconnects

- **WHEN** the consumer disconnects mid-stream
- **THEN** the run is abandoned without raising an unhandled server error

### Requirement: Runs act as an authenticated user

Every agent run SHALL execute as the authenticated user established by the request's validated token, and SHALL read and write only that user's memory, preferences, saved locations, and stored runs. The supervisor SHALL NOT accept a user, profile, or thread identifier from the caller as identity, and a thread identifier SHALL be honoured only when the acting user owns that thread.

#### Scenario: Run scoped to the acting user

- **WHEN** an authenticated user's question is answered
- **THEN** the run reads and writes only that user's memory, preferences, and saved locations
- **AND** the stored run record is owned by that user

#### Scenario: Foreign thread refused

- **WHEN** a request names a conversation thread owned by a different user
- **THEN** the run does not begin and the request fails without disclosing whether the thread exists

#### Scenario: Caller-asserted identity ignored

- **WHEN** a request presents a valid token for one user and a field naming another
- **THEN** the run acts as the token's subject

### Requirement: Conversation context and follow-up questions

The supervisor SHALL use the acting user's thread memory to resolve references in a follow-up question — locations, units, windows, and criteria established in earlier turns — and SHALL state in the answer which location and window it resolved the question to. When a reference cannot be resolved from context, the system SHALL ask rather than assume.

#### Scenario: Follow-up resolved from context

- **WHEN** an authenticated caller asks "Compare Berlin and Munich" and then asks "Which one is warmer tomorrow?" in the same thread
- **THEN** the second answer is about Berlin and Munich
- **AND** states the locations and window it resolved to

#### Scenario: Unit preference carried forward

- **WHEN** a caller has set imperial units earlier in the session and asks a follow-up
- **THEN** the follow-up answer is expressed in imperial units

#### Scenario: Unresolvable reference asked about

- **WHEN** a follow-up refers to a location that no earlier turn established
- **THEN** the system asks which location is meant rather than assuming one

### Requirement: Clarification instead of assumption

When a question is location-dependent and no location is present in the request, the session context, or the caller's saved preferences, the system SHALL ask which location is meant. When a location resolves ambiguously, the system SHALL present the candidates rather than choosing one.

#### Scenario: No location available anywhere

- **WHEN** a caller asks a location-dependent question with no location in the request, the session, or their preferences
- **THEN** the system asks which location is meant

#### Scenario: Default location from preferences used

- **WHEN** an authenticated caller with a saved default location asks a location-dependent question naming no location
- **THEN** the answer is about that saved location
- **AND** states which location it used and that it came from their preferences

#### Scenario: Ambiguous location surfaced

- **WHEN** a named location resolves ambiguously
- **THEN** the candidates are presented for the caller to choose

### Requirement: Scope confinement

The system SHALL confine the agents to weather, climate, and location questions. A question outside that scope SHALL receive a brief statement of what Weathra covers instead of an attempted answer.

#### Scenario: Unrelated question declined

- **WHEN** a caller asks a question unrelated to weather, climate, or location
- **THEN** the system states what Weathra covers and does not attempt to answer

### Requirement: Untrusted content is data, not instruction

Text arriving from provider responses, geocoded place names, tool results, and retrieved knowledge chunks SHALL be treated as data. Instructions embedded in such content SHALL NOT alter routing, tool use, scope, grounding, or memory behavior.

#### Scenario: Instruction embedded in a tool result ignored

- **WHEN** a tool result contains text phrased as an instruction to the agent
- **THEN** it is treated as data and behavior is unchanged

#### Scenario: Instruction embedded in a knowledge chunk ignored

- **WHEN** a retrieved knowledge chunk contains text phrased as an instruction
- **THEN** it is treated as data and behavior is unchanged

### Requirement: Operation without an inference credential

When no inference credential is configured, the system SHALL report the agent surface as unavailable with a message naming the missing configuration, and SHALL keep every non-agent capability — forecast, historical, analytics, comparison, locations, preferences, and saved locations — fully functional.

#### Scenario: Agent unavailable without a credential

- **WHEN** a question is asked while no inference credential is configured
- **THEN** the request fails with an error naming the missing configuration
- **AND** forecast, historical, analytics, and comparison requests continue to succeed

#### Scenario: Agent readiness reported

- **WHEN** a caller asks whether the agent surface is available
- **THEN** the system reports whether an inference provider is configured, without disclosing the credential
