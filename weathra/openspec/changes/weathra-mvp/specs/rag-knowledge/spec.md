## Purpose

The RAG Agent's knowledge base: a small curated corpus of weather-domain explanations — what precipitation probability actually means, how dew point relates to humidity, why forecast confidence decays — retrieved by meaning and cited by document, so Weathra can explain concepts without ever sourcing a measurement from prose.

## ADDED Requirements

### Requirement: Curated knowledge corpus

The system SHALL maintain a curated corpus of weather-domain knowledge documents covering at minimum: relative humidity, dew point, atmospheric and surface pressure, precipitation probability, precipitation intensity and accumulation, wind speed and gusts, the UV index, forecast uncertainty and how it changes with horizon, weather-model and forecast terminology, and the distinction between observations, forecasts, and historical statistics.

Every document SHALL carry a stable identifier, a title, a topic, and a provenance note stating where its content came from. The corpus SHALL contain only conceptual and explanatory content, and SHALL NOT contain current, forecast, or historical measurements for any location.

#### Scenario: Required topics present

- **WHEN** the corpus is inspected
- **THEN** it contains documents covering each of the required topics

#### Scenario: Documents carry provenance

- **WHEN** any corpus document is inspected
- **THEN** it carries a stable identifier, a title, a topic, and a provenance note

#### Scenario: No measurements in the corpus

- **WHEN** the corpus is checked for location-specific measurements
- **THEN** no document contains a current, forecast, or historical measurement for a location

### Requirement: Ingestion and chunking

The system SHALL provide a repeatable ingestion process that chunks corpus documents, embeds each chunk, and stores chunks with their embeddings, document identifier, title, topic, and position. Re-running ingestion over unchanged documents SHALL NOT duplicate chunks. Ingestion SHALL report how many documents and chunks it processed.

#### Scenario: Corpus ingested

- **WHEN** ingestion is run over the corpus
- **THEN** every document is chunked, embedded, and stored with its identifier, title, topic, and position
- **AND** the run reports the document and chunk counts

#### Scenario: Re-ingestion is idempotent

- **WHEN** ingestion is run twice over unchanged documents
- **THEN** the stored chunk count is the same after the second run as after the first

#### Scenario: Changed document re-indexed

- **WHEN** a document's content changes and ingestion is re-run
- **THEN** that document's chunks are replaced rather than duplicated

### Requirement: Embedding behind an abstraction

The system SHALL define an embedding provider contract and SHALL treat the concrete embedding implementation as configuration. The stored vector dimension and the embedding model identity SHALL be recorded alongside the index, and the system SHALL refuse to query with an embedding model whose identity or dimension does not match the stored index, reporting that re-indexing is required.

#### Scenario: Embedding model recorded

- **WHEN** ingestion completes
- **THEN** the embedding model identity and vector dimension are recorded with the index

#### Scenario: Mismatched embedding model refused

- **WHEN** a query is attempted with an embedding model whose identity or dimension differs from the stored index
- **THEN** the query fails with an error stating that re-indexing is required
- **AND** no results computed from mismatched vectors are returned

### Requirement: Semantic retrieval

The system SHALL retrieve the chunks most semantically relevant to a query, bounded by a configurable result count and a minimum relevance threshold, and SHALL return each chunk with its text, document identifier, title, and relevance score. When no chunk meets the threshold, the system SHALL return an empty result rather than the least-bad match.

#### Scenario: Relevant chunks retrieved

- **WHEN** a caller retrieves knowledge for "what does dew point mean"
- **THEN** chunks from the dew point document are returned with their identifiers, titles, and relevance scores

#### Scenario: Result count bounded

- **WHEN** a caller requests at most three chunks
- **THEN** no more than three chunks are returned

#### Scenario: Nothing relevant enough

- **WHEN** a query has no chunk meeting the relevance threshold
- **THEN** an empty result is returned
- **AND** no below-threshold chunk is returned as though it were relevant

### Requirement: Conceptual answers are cited

An answer drawing on retrieved knowledge SHALL cite the document identifiers of the chunks it used, and those chunks SHALL appear in the evidence record. A conceptual claim presented as coming from Weathra's knowledge base SHALL NOT be made when retrieval returned nothing.

#### Scenario: Concept explained with citation

- **WHEN** a conceptual question is answered from retrieved knowledge
- **THEN** the answer cites the document identifiers used
- **AND** those chunks appear in the evidence record

#### Scenario: Nothing retrieved, no knowledge claim

- **WHEN** retrieval returns no chunks for a conceptual question
- **THEN** the answer states that Weathra's knowledge base does not cover the concept
- **AND** does not present an uncited explanation as coming from the knowledge base

### Requirement: RAG is never a source of measurements

The system SHALL NOT use retrieved knowledge as the source of any current, forecast, or historical numerical weather value. A question asking for a measurement SHALL be answered from weather tools; retrieved knowledge MAY accompany it as explanation only, and the answer SHALL label which part is measurement and which is explanation.

#### Scenario: Measurement question not answered from the corpus

- **WHEN** a caller asks for a current temperature
- **THEN** the value comes from a weather tool
- **AND** no numerical value in the answer is sourced from a knowledge chunk

#### Scenario: Explanation accompanies a measurement

- **WHEN** a caller asks for tomorrow's precipitation probability and what it means
- **THEN** the value comes from a weather tool and the explanation from retrieved knowledge
- **AND** the answer labels which part came from which source

#### Scenario: Corpus figure not repurposed as local data

- **WHEN** a retrieved chunk contains an illustrative number used to explain a concept
- **THEN** that number is not reported as a measurement for the caller's location

### Requirement: Vector store selection and portability

The system SHALL store chunks and embeddings in PostgreSQL with the pgvector extension by default. The retrieval interface SHALL be defined independently of the store so that an alternative vector store may be substituted, and the configured store SHALL be reported by the readiness surface.

#### Scenario: pgvector store used by default

- **WHEN** the system runs with default configuration
- **THEN** chunks and embeddings are stored in PostgreSQL with pgvector
- **AND** readiness reports pgvector as the configured vector store

#### Scenario: Store substituted behind the interface

- **WHEN** an alternative vector store implementing the retrieval interface is configured
- **THEN** retrieval behaves identically through every consuming path
- **AND** no agent or API source file requires modification

### Requirement: Retrieval available without an inference credential

Retrieval SHALL function with no inference credential configured, since embedding and search do not require a chat model. Only the language-model explanation layered on top of retrieval SHALL be unavailable in that case.

#### Scenario: Retrieval works without a chat model

- **WHEN** knowledge retrieval is exercised with no inference credential configured
- **THEN** chunks are retrieved and returned with their scores and identifiers
