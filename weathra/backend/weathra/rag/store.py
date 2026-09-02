"""The pgvector-backed knowledge store, and the ingestion writes that fill it.

pgvector rather than a second datastore: Postgres is already required for memory, so ChromaDB would
add an operational dependency for no capability gain (design.md decision 12). The retrieval
interface lives in ``retrieve.py`` and does not name pgvector, so an alternative store can be
substituted behind it.

Cosine distance, through the HNSW index the migration created. Cosine rather than L2 because the
embeddings are normalized and cosine is what the model was trained against; the index's operator
class must match the query's operator or Postgres will ignore the index and scan.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.models import KnowledgeChunk, KnowledgeDocument
from weathra.rag.embed import EmbeddingProvider, check_compatibility
from weathra.rag.ingest import (
    Chunk,
    CorpusDocument,
    IngestionReport,
    chunk_document,
    load_corpus,
)

__all__ = ["IndexIdentity", "index_identity", "ingest_corpus", "search_chunks"]

logger = logging.getLogger("weathra.rag.store")


class IndexIdentity:
    """The embedding model and dimension the stored index was built with."""

    __slots__ = ("dimension", "model")

    def __init__(self, model: str | None, dimension: int | None) -> None:
        self.model = model
        self.dimension = dimension

    @property
    def is_empty(self) -> bool:
        return self.model is None


async def index_identity(session: AsyncSession) -> IndexIdentity:
    """What model built the stored vectors, read from the rows themselves.

    Read from the data rather than from a metadata table on purpose: a separate table could drift
    out of step with the vectors it describes, and the whole point of recording the identity is to
    catch exactly that kind of drift.
    """
    row = (
        await session.execute(
            select(KnowledgeChunk.embedding_model, KnowledgeChunk.embedding_dimension).limit(1)
        )
    ).one_or_none()
    if row is None:
        return IndexIdentity(None, None)
    return IndexIdentity(row[0], row[1])


async def ingest_corpus(
    session: AsyncSession,
    *,
    embedder: EmbeddingProvider,
    settings: Settings,
    documents: Sequence[CorpusDocument] | None = None,
    prune: bool = True,
) -> IngestionReport:
    """Ingest the corpus, replacing changed documents and leaving unchanged ones alone.

    Must be called with the **privileged** session: the restricted request role has no write grant
    on the corpus tables at all.
    """
    corpus = tuple(documents) if documents is not None else load_corpus()

    rows = (
        await session.execute(select(KnowledgeDocument.id, KnowledgeDocument.content_hash))
    ).all()
    stored: dict[str, str] = {row[0]: row[1] for row in rows}

    identity = await index_identity(session)
    model_changed = not identity.is_empty and (
        identity.model != embedder.model_id or identity.dimension != embedder.dimension
    )
    if model_changed:
        # The whole index has to be rebuilt: a mixed-model index cannot be queried at all, so
        # "unchanged" no longer means "leave it alone".
        logger.info(
            "embedding model changed from %s(%s) to %s(%s); rebuilding the whole index",
            identity.model,
            identity.dimension,
            embedder.model_id,
            embedder.dimension,
        )

    written = 0
    unchanged = 0
    chunks_written = 0

    for document in corpus:
        if not model_changed and stored.get(document.identifier) == document.content_hash:
            unchanged += 1
            continue

        chunks = chunk_document(document, settings)
        await _write_document(session, document, chunks, embedder)
        written += 1
        chunks_written += len(chunks)

    removed = 0
    if prune:
        current = {document.identifier for document in corpus}
        stale = set(stored) - current
        for identifier in sorted(stale):
            # The chunks go with it: the foreign key cascades, so a removed document cannot leave
            # orphaned passages that an answer could still cite.
            await session.execute(
                delete(KnowledgeDocument).where(KnowledgeDocument.id == identifier)
            )
            removed += 1

    total = await session.scalar(select(func.count()).select_from(KnowledgeChunk)) or 0

    report = IngestionReport(
        documents_seen=len(corpus),
        documents_written=written,
        documents_unchanged=unchanged,
        documents_removed=removed,
        chunks_written=chunks_written,
        chunks_total=int(total),
        embedding_model=embedder.model_id,
        embedding_dimension=embedder.dimension,
    )
    logger.info(
        "ingested %d/%d documents (%d unchanged, %d removed), %d chunks written, %d total",
        report.documents_written,
        report.documents_seen,
        report.documents_unchanged,
        report.documents_removed,
        report.chunks_written,
        report.chunks_total,
    )
    return report


async def _write_document(
    session: AsyncSession,
    document: CorpusDocument,
    chunks: Sequence[Chunk],
    embedder: EmbeddingProvider,
) -> None:
    """Upsert a document and replace its chunks wholesale.

    Replace rather than merge: chunk positions shift when a document is edited, so matching old
    chunks to new ones would be guesswork, and a partial update would leave passages from the
    previous version in the index.
    """
    await session.execute(
        pg_insert(KnowledgeDocument)
        .values(
            id=document.identifier,
            title=document.title,
            topic=document.topic,
            provenance=document.provenance,
            content_hash=document.content_hash,
        )
        .on_conflict_do_update(
            index_elements=[KnowledgeDocument.id],
            set_={
                "title": document.title,
                "topic": document.topic,
                "provenance": document.provenance,
                "content_hash": document.content_hash,
                "ingested_at": func.now(),
            },
        )
    )

    await session.execute(
        delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document.identifier)
    )

    vectors = embedder.embed_documents([chunk.text for chunk in chunks])
    for chunk, vector in zip(chunks, vectors, strict=True):
        session.add(
            KnowledgeChunk(
                document_id=chunk.document_id,
                position=chunk.position,
                heading=chunk.heading,
                text=chunk.text,
                token_count=chunk.token_count,
                embedding_model=embedder.model_id,
                embedding_dimension=embedder.dimension,
                embedding=vector,
            )
        )
    await session.flush()


async def search_chunks(
    session: AsyncSession,
    *,
    embedder: EmbeddingProvider,
    query: str,
    limit: int,
) -> list[tuple[KnowledgeChunk, KnowledgeDocument, float]]:
    """The nearest chunks to a query, with their similarity scores.

    Refuses outright when the stored index was built by a different model — comparing vectors
    across embedding spaces produces a number that looks like a similarity and is not one.

    Returns *similarity* (1 - cosine distance), not distance, so a caller's threshold reads the
    intuitive way: higher is more relevant.
    """
    identity = await index_identity(session)
    check_compatibility(embedder, stored_model=identity.model, stored_dimension=identity.dimension)
    if identity.is_empty:
        return []

    vector = embedder.embed_query(query)
    distance = KnowledgeChunk.embedding.cosine_distance(vector)

    rows = (
        await session.execute(
            select(KnowledgeChunk, KnowledgeDocument, distance.label("distance"))
            .join(KnowledgeDocument, KnowledgeChunk.document_id == KnowledgeDocument.id)
            .order_by(distance)
            .limit(limit)
        )
    ).all()

    return [(chunk, document, 1.0 - float(value)) for chunk, document, value in rows]
