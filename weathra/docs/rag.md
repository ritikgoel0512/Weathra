# The knowledge base

Weathra answers "what does *dew point* mean?" from a small, written corpus rather than from the
model's memory. Ten documents, embedded locally, stored in pgvector, retrieved with a relevance
floor — and when the floor is not met, the answer says the knowledge base does not cover it.

## The corpus

Ten documents, each with an id, a title, a topic, and a provenance note stating where its content
comes from. They are Markdown files under `backend/weathra/rag/corpus/`, version-controlled and
reviewable like code.

| Document | Title | Topic |
|---|---|---|
| `atmospheric-pressure` | Atmospheric and surface pressure | pressure |
| `data-classes` | Observations, forecasts, and historical statistics | data-classes |
| `dew-point` | Dew point | humidity |
| `forecast-terminology` | Weather model and forecast terminology | terminology |
| `forecast-uncertainty` | Forecast uncertainty and the horizon | uncertainty |
| `precipitation-intensity` | Precipitation intensity and accumulation | precipitation |
| `precipitation-probability` | Precipitation probability | precipitation |
| `relative-humidity` | Relative humidity | humidity |
| `uv-index` | The UV index | radiation |
| `wind-speed-and-gusts` | Wind speed, gusts, and direction | wind |

**Why written rather than scraped.** A citation has to point at something a reader can check, and
its provenance has to be a fact rather than a URL that changed. These are written for Weathra from
standard meteorological definitions, each stating its sources, so a citation in an answer names a
document whose content and origin are both in the repository.

The corpus covers *concepts*, deliberately — what a term means, how to read a probability, why a
forecast gets less certain with distance. It holds no weather data: a figure never comes from here.

## Ingestion

```bash
WEATHRA_RUNTIME_MODE=privileged weathra-ingest-corpus
```

Under the **privileged** connection, because the corpus tables carry no write grant for the
request-serving role — the corpus is shared and read-only to users, and the request path has no
business writing it (see [`authentication.md`](authentication.md)).

Each document is chunked to `RAG_CHUNK_MAX_TOKENS` with `RAG_CHUNK_OVERLAP_TOKENS` of overlap. The
overlap is not decoration: a definition split across a chunk boundary would otherwise be retrievable
only as two halves, neither of which reads as an answer.

Every chunk is stored with its document id, its position, its embedding, **and the model id and
dimension the embedding was produced with**. That last part is what makes the next section possible.

Ingestion is idempotent: running it again replaces the corpus rather than appending a second copy.

## Embeddings

`fastembed` running locally — `BAAI/bge-small-en-v1.5` by default, 384 dimensions. Local for a
reason that matters at both ends: retrieval needs no inference credential, so the whole knowledge
path works with none configured, and no question text is sent to a third party to be embedded.

The offline test suite substitutes a deterministic hashing embedder (`weathra-hashing-v1`), which is
why the suite runs with no model download and no network.

### Changing the model requires a re-index, and the code knows it

The stored index records the model and dimension it was built with. On retrieval, the store compares
them against the configured embedder and raises `VectorIndexMismatch` when they differ.

That check exists because the failure it prevents is silent. Vectors from a different model live in
the same space arithmetically — cosine similarity returns a number, the query succeeds, and the
"nearest" chunks are noise. A mismatch has to be an error, and the fix is to re-ingest.

## Retrieval

```
question → embed locally → pgvector nearest neighbours (RAG_TOP_K)
         → drop everything below RAG_RELEVANCE_THRESHOLD
         → nothing left? say the corpus does not cover it
```

**The threshold is the load-bearing part.** Nearest-neighbour search always returns something: ask
a vector index about tax law and it hands back the closest weather passage it has. Returning that
would let the RAG agent explain a concept from a document that has nothing to do with it — exactly
what the spec forbids. So a result below `RAG_RELEVANCE_THRESHOLD` (0.35 cosine similarity by
default) is dropped, an empty result is a **real answer**, and the caller says "Weathra's knowledge
base does not cover this" rather than improvising.

Retrieved passages reach the answer as **citations**: document id, title, topic, chunk position, and
the passage text. They appear in the evidence record, and the answer's prose is expected to draw on
them rather than to restate the model's own knowledge of the term.

## What the model adds, and what it does not

The corpus provides the substance; the model provides the sentence that fits it to the question
asked. It is given the retrieved passages and instructed to explain from them. A concept question
that retrieves nothing gets no improvised definition — the hard grounding layer refuses prose when
nothing was retrieved (see [`agents.md`](agents.md)).

A knowledge answer is labelled `ai_interpretation` where it is interpretation, with its citations
visible, so a reader can tell an explanation drawn from a cited document from a weather figure
drawn from a provider.

## The store is an interface

The retrieval interface is defined without naming pgvector, and `VECTOR_STORE` selects the
implementation. ChromaDB behind the same interface is a post-MVP item on the roadmap; pgvector was
chosen for the MVP because the database is already there, an extra service is an extra thing to
deploy and secure, and a join between a chunk and its document is a join rather than two round
trips.
