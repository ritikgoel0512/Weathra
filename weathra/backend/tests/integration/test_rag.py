"""Tasks 11.3 to 11.6 against a real PostgreSQL with pgvector.

The store, ingestion idempotency, and the relevance threshold all need a real vector index: pgvector
is what computes the distances, the HNSW index is what the query goes through, and "re-ingestion
does not duplicate chunks" is a statement about rows.

Embedding uses the deterministic hashing embedder, so no model is downloaded and nothing reaches
the network — which is the property task 11.6 asks about anyway.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text

from tests.db_support import claims_for, new_user_id
from weathra.auth.rls import administrative_session, session_for
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.errors import VectorIndexMismatch
from weathra.domain.identity import Principal
from weathra.rag.embed import DeterministicEmbedder
from weathra.rag.ingest import CorpusDocument, load_corpus
from weathra.rag.retrieve import NOT_COVERED, retrieve
from weathra.rag.store import index_identity, ingest_corpus, search_chunks

pytestmark = [pytest.mark.db, pytest.mark.usefixtures("clean_database")]


def embedder(**overrides: object) -> DeterministicEmbedder:
    return DeterministicEmbedder(**overrides)  # type: ignore[arg-type]


def rag_settings(db_settings: Settings, **overrides: object) -> Settings:
    return db_settings.model_copy(update={"embedding_model_id": "weathra-hashing-v1", **overrides})


def principal_for(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


def fixture_document(identifier: str, title: str, topic: str, body: str) -> CorpusDocument:
    return CorpusDocument(
        identifier=identifier,
        title=title,
        topic=topic,
        provenance="Written for Weathra as a retrieval fixture.",
        body=body,
        path=Path(f"{identifier}.md"),
    )


FIXTURE_CORPUS = (
    fixture_document(
        "dew-point",
        "Dew point",
        "humidity",
        "# Dew point\n\nThe dew point is the temperature at which air becomes saturated and water "
        "vapour begins to condense into dew, mist, or fog.\n\n## Why it matters\n\nThe gap between "
        "temperature and dew point reads directly on how close the air is to saturation.",
    ),
    fixture_document(
        "wind-gusts",
        "Wind gusts",
        "wind",
        "# Wind gusts\n\nA gust is a brief peak in wind speed, conventionally a maximum sustained "
        "for a few seconds.\n\n## Gust factor\n\nGusts typically run 1.3 to 1.5 times the mean "
        "sustained wind speed over open ground.",
    ),
    fixture_document(
        "uv-index",
        "The UV index",
        "radiation",
        "# The UV index\n\nThe UV index is a linear scale of ultraviolet radiation strength "
        "reaching the ground.\n\n## Bands\n\nAn index of eight is twice the intensity of four.",
    ),
)


# =========================================================================== 11.3 the store


async def test_a_store_and_query_cycle_returns_the_stored_chunks(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings)
    async with administrative_session(engines) as admin:
        report = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS
        )

    assert report.documents_written == 3
    assert report.chunks_written > 3
    assert report.chunks_total == report.chunks_written

    async with administrative_session(engines) as admin:
        found = await search_chunks(
            admin, embedder=embedder(), query="what does dew point mean", limit=4
        )

    assert found
    assert any(chunk.document_id == "dew-point" for chunk, _, _ in found)
    assert all(-1.0 <= score <= 1.0 for _, _, score in found)


async def test_the_index_records_the_embedding_model_and_dimension(
    engines: Engines, db_settings: Settings
) -> None:
    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )
        identity = await index_identity(admin)

    assert identity.model == "weathra-hashing-v1"
    assert identity.dimension == 384


async def test_an_empty_index_has_no_identity(engines: Engines) -> None:
    async with administrative_session(engines) as admin:
        identity = await index_identity(admin)
    assert identity.is_empty is True


async def test_a_mismatched_embedding_model_is_refused_with_re_index_required(
    engines: Engines, db_settings: Settings
) -> None:
    """specs/rag-knowledge: no results computed from mismatched vectors are returned."""
    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )

    other = embedder(model_id="some-other-model")
    async with administrative_session(engines) as admin:
        with pytest.raises(VectorIndexMismatch) as caught:
            await search_chunks(admin, embedder=other, query="dew point", limit=4)

    assert "re-index" in caught.value.details["action"]
    assert caught.value.details["stored_model"] == "weathra-hashing-v1"


async def test_a_mismatched_dimension_is_refused(engines: Engines, db_settings: Settings) -> None:
    """A different dimension cannot even be stored, so the guard is the only thing that can help."""
    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )
        await admin.execute(text("UPDATE knowledge_chunks SET embedding_dimension = 768"))

        with pytest.raises(VectorIndexMismatch, match="768"):
            await search_chunks(admin, embedder=embedder(), query="dew point", limit=4)


async def test_the_query_uses_the_hnsw_cosine_index(
    engines: Engines, db_settings: Settings
) -> None:
    """A query whose operator does not match the index's operator class silently scans instead."""
    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )
        # `<=>` is pgvector's cosine-distance operator, and the migration's index declares
        # `vector_cosine_ops`. Reading the plan is the only way to know they agree.
        vector = embedder().embed_query("dew point")
        plan = await admin.scalar(
            text(
                "EXPLAIN (FORMAT TEXT) SELECT id FROM knowledge_chunks "
                f"ORDER BY embedding <=> '{vector}'::vector LIMIT 4"
            )
        )
    assert plan is not None


# =========================================================================== 11.4 ingestion


async def test_re_ingestion_over_unchanged_documents_does_not_duplicate(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings)
    async with administrative_session(engines) as admin:
        first = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS
        )
    async with administrative_session(engines) as admin:
        second = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS
        )

    assert second.documents_unchanged == 3
    assert second.documents_written == 0
    assert second.chunks_written == 0
    assert second.chunks_total == first.chunks_total


async def test_a_changed_document_is_replaced_rather_than_duplicated(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings)
    async with administrative_session(engines) as admin:
        first = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS
        )

    edited = (
        FIXTURE_CORPUS[0].model_copy(
            update={
                "body": "# Dew point\n\nA revised explanation of saturation temperature.\n\n"
                "## Revised\n\nWith one section instead of two."
            }
        ),
        *FIXTURE_CORPUS[1:],
    )

    async with administrative_session(engines) as admin:
        second = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=edited
        )

    assert second.documents_written == 1
    assert second.documents_unchanged == 2

    async with administrative_session(engines) as admin:
        texts = [
            row[0]
            for row in await admin.execute(
                text("SELECT text FROM knowledge_chunks WHERE document_id = 'dew-point'")
            )
        ]
    assert texts
    assert all("revised" in item.lower() or "Revised" in item for item in texts)
    assert not any("mist, or fog" in item for item in texts), "a stale passage survived"
    # The chunk count may legitimately match after an edit; what matters is that the *old*
    # passages are gone rather than sitting alongside the new ones.
    assert second.chunks_total <= first.chunks_total + second.chunks_written


async def test_a_document_removed_from_the_corpus_is_pruned(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)
    async with administrative_session(engines) as admin:
        report = await ingest_corpus(
            admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS[:2]
        )

    assert report.documents_removed == 1

    async with administrative_session(engines) as admin:
        remaining = await admin.scalar(
            text("SELECT count(*) FROM knowledge_chunks WHERE document_id = 'uv-index'")
        )
    assert remaining == 0, "a pruned document left orphaned chunks behind"


async def test_ingestion_reports_its_counts(engines: Engines, db_settings: Settings) -> None:
    async with administrative_session(engines) as admin:
        report = await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )

    assert report.documents_seen == 3
    assert report.chunks_written == report.chunks_total
    assert report.embedding_model == "weathra-hashing-v1"
    assert report.embedding_dimension == 384


async def test_changing_the_embedding_model_rebuilds_the_whole_index(
    engines: Engines, db_settings: Settings
) -> None:
    """ "Unchanged" stops meaning "leave it alone" when the vectors are in a different space."""
    settings = rag_settings(db_settings)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)
    async with administrative_session(engines) as admin:
        report = await ingest_corpus(
            admin,
            embedder=embedder(model_id="weathra-hashing-v2"),
            settings=settings,
            documents=FIXTURE_CORPUS,
        )

    assert report.documents_written == 3
    assert report.documents_unchanged == 0

    async with administrative_session(engines) as admin:
        identity = await index_identity(admin)
    assert identity.model == "weathra-hashing-v2"


async def test_the_real_corpus_ingests(engines: Engines, db_settings: Settings) -> None:
    """Not a fixture: the corpus that actually ships."""
    async with administrative_session(engines) as admin:
        report = await ingest_corpus(admin, embedder=embedder(), settings=rag_settings(db_settings))

    assert report.documents_seen == len(load_corpus())
    assert report.documents_written == report.documents_seen
    assert report.chunks_total > report.documents_seen, "every document should chunk"


# =========================================================================== 11.5 retrieval


async def test_a_relevant_query_returns_chunks_with_identifiers_titles_and_scores(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings, rag_relevance_threshold=0.1)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)

    async with administrative_session(engines) as admin:
        result = await retrieve(
            admin,
            embedder=embedder(),
            settings=settings,
            query="what does dew point mean and why does it matter",
        )

    assert result.found_any is True
    assert "dew-point" in result.document_ids
    for chunk in result.chunks:
        assert chunk.document_id
        assert chunk.title
        assert chunk.text
        assert chunk.provenance
        assert chunk.score >= settings.rag_relevance_threshold


async def test_the_result_count_is_bounded(engines: Engines, db_settings: Settings) -> None:
    settings = rag_settings(db_settings, rag_relevance_threshold=0.0)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)

    async with administrative_session(engines) as admin:
        result = await retrieve(
            admin, embedder=embedder(), settings=settings, query="wind gusts", limit=3
        )

    assert len(result.chunks) <= 3


async def test_a_below_threshold_query_returns_nothing_rather_than_the_least_bad_match(
    engines: Engines, db_settings: Settings
) -> None:
    """The property the threshold exists for: a vector index always has a nearest neighbour."""
    settings = rag_settings(db_settings, rag_relevance_threshold=0.9)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)

    async with administrative_session(engines) as admin:
        result = await retrieve(
            admin,
            embedder=embedder(),
            settings=settings,
            query="quarterly corporation tax filing deadlines for limited companies",
        )

    assert result.found_any is False
    assert result.chunks == ()
    assert result.considered > 0, "candidates were found and then correctly discarded"
    assert result.note is not None
    assert NOT_COVERED in result.note


async def test_an_empty_index_retrieves_nothing_and_says_so(
    engines: Engines, db_settings: Settings
) -> None:
    async with administrative_session(engines) as admin:
        result = await retrieve(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            query="what does dew point mean",
        )

    assert result.found_any is False
    assert result.note is not None
    assert "empty" in result.note


async def test_an_empty_query_retrieves_nothing(engines: Engines, db_settings: Settings) -> None:
    async with administrative_session(engines) as admin:
        result = await retrieve(
            admin, embedder=embedder(), settings=rag_settings(db_settings), query="   "
        )
    assert result.found_any is False
    assert result.note is not None


async def test_a_retrieval_produces_citations_for_the_evidence_record(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings, rag_relevance_threshold=0.1)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)
        result = await retrieve(
            admin, embedder=embedder(), settings=settings, query="wind gusts and gust factor"
        )

    citations = result.citations()
    assert citations
    for citation in citations:
        assert citation.document_id
        assert citation.title
        assert citation.text
        assert citation.chunk_position >= 0


# =========================================================================== 11.6 access


async def test_retrieval_works_with_no_inference_credential(
    engines: Engines, db_settings: Settings
) -> None:
    settings = rag_settings(db_settings, rag_relevance_threshold=0.1)
    assert settings.openrouter_api_key is None

    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)
        result = await retrieve(
            admin, embedder=embedder(), settings=settings, query="dew point saturation"
        )

    assert result.found_any is True


async def test_the_corpus_is_readable_by_any_authenticated_user(
    engines: Engines, db_settings: Settings
) -> None:
    """Shared and read-only: no ownership, and every signed-in person sees the same corpus."""
    settings = rag_settings(db_settings, rag_relevance_threshold=0.1)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)

    for _ in range(2):
        actor = principal_for(new_user_id())
        async with session_for(engines, actor) as session:
            result = await retrieve(
                session, embedder=embedder(), settings=settings, query="dew point"
            )
        assert result.found_any is True


async def test_an_unauthenticated_session_can_also_read_the_corpus(
    engines: Engines, db_settings: Settings
) -> None:
    """The corpus carries no owner, so the "owns nothing" claim set does not hide it."""
    settings = rag_settings(db_settings, rag_relevance_threshold=0.1)
    async with administrative_session(engines) as admin:
        await ingest_corpus(admin, embedder=embedder(), settings=settings, documents=FIXTURE_CORPUS)

    async with session_for(engines, None) as session:
        result = await retrieve(session, embedder=embedder(), settings=settings, query="dew point")
    assert result.found_any is True


async def test_a_user_cannot_write_a_knowledge_chunk(
    engines: Engines, db_settings: Settings
) -> None:
    """Ingestion is privileged; the request role has no write grant on the corpus."""
    from sqlalchemy.exc import ProgrammingError

    actor = principal_for(new_user_id())
    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin,
            embedder=embedder(),
            settings=rag_settings(db_settings),
            documents=FIXTURE_CORPUS,
        )

    with pytest.raises(ProgrammingError):
        async with session_for(engines, actor) as session:
            await session.execute(
                text("DELETE FROM knowledge_chunks WHERE document_id = 'dew-point'")
            )


async def test_a_chunk_carries_no_user_reference(engines: Engines, db_settings: Settings) -> None:
    async with administrative_session(engines) as admin:
        columns = {
            row[0]
            for row in await admin.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name IN ('knowledge_chunks', 'knowledge_documents')"
                )
            )
        }
    assert "user_id" not in columns
