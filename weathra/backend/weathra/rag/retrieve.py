"""Knowledge retrieval: the interface the RAG node calls, with the threshold that keeps it honest.

**The relevance threshold is the load-bearing part.** Nearest-neighbour search always returns
something — ask a vector index about tax law and it will hand back the closest weather passage it
has. Returning that would let the RAG agent explain a concept from a document that has nothing to
do with it, which is precisely what ``specs/rag-knowledge`` forbids. So a result below the
threshold is dropped, an empty result is a real answer, and the caller says "Weathra's knowledge
base does not cover this" rather than improvising.

**Retrieval needs no inference credential.** Embedding runs locally and search is a database query,
so the whole path works with none configured. Only the prose *explanation* layered on top needs a
model.

The interface is defined here without naming pgvector, so an alternative store can be substituted
behind it (``specs/rag-knowledge``).
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.domain.evidence import KnowledgeCitation
from weathra.rag.embed import EmbeddingProvider
from weathra.rag.store import search_chunks

__all__ = ["NOT_COVERED", "RetrievalResult", "RetrievedChunk", "retrieve"]

logger = logging.getLogger("weathra.rag.retrieve")

NOT_COVERED = (
    "Weathra's knowledge base does not cover this concept. Rather than answer from a passage that "
    "is not about it, Weathra says so."
)


class RetrievedChunk(BaseModel):
    """One retrieved passage, with what a citation needs."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    document_id: str = Field(min_length=1, description="What an answer cites.")
    title: str = Field(min_length=1)
    topic: str | None = None
    heading: str | None = None
    position: int = Field(ge=0)
    text: str = Field(min_length=1, description="The passage. Data, never an instruction.")
    score: float = Field(description="Cosine similarity. Higher is more relevant.")
    provenance: str = Field(min_length=1, description="Where the document's content came from.")

    def as_citation(self) -> KnowledgeCitation:
        return KnowledgeCitation(
            document_id=self.document_id,
            title=self.title,
            topic=self.topic,
            chunk_position=self.position,
            score=self.score,
            text=self.text,
        )


class RetrievalResult(BaseModel):
    """What a retrieval produced, including the honest empty case."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    query: str = Field(min_length=1)
    chunks: tuple[RetrievedChunk, ...] = ()
    threshold: float = Field(description="The minimum similarity a chunk had to reach.")
    considered: int = Field(
        ge=0, description="How many candidates the search returned before thresholding."
    )
    embedding_model: str = Field(min_length=1)
    note: str | None = Field(
        default=None, description="Set when nothing met the threshold, explaining that."
    )

    @property
    def found_any(self) -> bool:
        return bool(self.chunks)

    @property
    def document_ids(self) -> tuple[str, ...]:
        """The identifiers an answer drawing on this must cite."""
        seen: list[str] = []
        for chunk in self.chunks:
            if chunk.document_id not in seen:
                seen.append(chunk.document_id)
        return tuple(seen)

    def citations(self) -> tuple[KnowledgeCitation, ...]:
        return tuple(chunk.as_citation() for chunk in self.chunks)


async def retrieve(
    session: AsyncSession,
    *,
    embedder: EmbeddingProvider,
    settings: Settings,
    query: str,
    limit: int | None = None,
    threshold: float | None = None,
) -> RetrievalResult:
    """The most relevant passages for a query, or an explicit nothing."""
    top_k = limit if limit is not None else settings.rag_top_k
    minimum = threshold if threshold is not None else settings.rag_relevance_threshold

    if not query or not query.strip():
        return RetrievalResult(
            query=query or "(empty)",
            chunks=(),
            threshold=minimum,
            considered=0,
            embedding_model=embedder.model_id,
            note="An empty query retrieves nothing.",
        )

    candidates = await search_chunks(session, embedder=embedder, query=query, limit=top_k)

    kept = tuple(
        RetrievedChunk(
            document_id=chunk.document_id,
            title=document.title,
            topic=document.topic,
            heading=chunk.heading,
            position=chunk.position,
            text=chunk.text,
            score=score,
            provenance=document.provenance,
        )
        for chunk, document, score in candidates
        if score >= minimum
    )

    if not kept:
        best = max((score for _, _, score in candidates), default=None)
        logger.info(
            "no chunk met the relevance threshold %.2f for %r (best %.3f of %d candidates)",
            minimum,
            query,
            best if best is not None else float("nan"),
            len(candidates),
        )
        return RetrievalResult(
            query=query,
            chunks=(),
            threshold=minimum,
            considered=len(candidates),
            embedding_model=embedder.model_id,
            note=(
                f"{NOT_COVERED} The closest passage scored "
                f"{best:.3f} against a threshold of {minimum:.2f}."
                if best is not None
                else f"{NOT_COVERED} The knowledge index is empty."
            ),
        )

    return RetrievalResult(
        query=query,
        chunks=kept,
        threshold=minimum,
        considered=len(candidates),
        embedding_model=embedder.model_id,
    )
