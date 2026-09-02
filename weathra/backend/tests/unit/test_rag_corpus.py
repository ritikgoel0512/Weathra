"""Group 11 (offline part) — the corpus, its front-matter, chunking, and the embedder contract.

The store, ingestion, and retrieval halves need real pgvector and live in
``tests/integration/test_rag.py``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.provider_support import provider_settings
from weathra.domain.errors import ValidationFailed, VectorIndexMismatch
from weathra.rag.embed import (
    DeterministicEmbedder,
    EmbeddingProvider,
    FastEmbedEmbedder,
    build_embedder,
    check_compatibility,
)
from weathra.rag.ingest import (
    CORPUS_ROOT,
    REQUIRED_TOPICS,
    chunk_document,
    estimate_tokens,
    load_corpus,
    read_document,
)

SETTINGS = provider_settings()

# The topics specs/rag-knowledge names, mapped to the concept a document must actually explain.
REQUIRED_CONCEPTS = {
    "relative humidity": "relative-humidity",
    "dew point": "dew-point",
    "pressure": "atmospheric-pressure",
    "precipitation probability": "precipitation-probability",
    "precipitation intensity and accumulation": "precipitation-intensity",
    "wind speed and gusts": "wind-speed-and-gusts",
    "the UV index": "uv-index",
    "forecast uncertainty": "forecast-uncertainty",
    "forecast terminology": "forecast-terminology",
    "observations versus forecasts versus statistics": "data-classes",
}


# =========================================================================== 11.1 the corpus


def test_the_corpus_loads() -> None:
    documents = load_corpus()
    assert len(documents) >= 10
    assert len({document.identifier for document in documents}) == len(documents)


@pytest.mark.parametrize(
    ("concept", "identifier"), sorted(REQUIRED_CONCEPTS.items()), ids=lambda value: str(value)
)
def test_every_required_concept_has_a_document(concept: str, identifier: str) -> None:
    identifiers = {document.identifier for document in load_corpus()}
    assert identifier in identifiers, f"no document covers {concept}"


def test_every_required_topic_is_covered() -> None:
    topics = {document.topic for document in load_corpus()}
    missing = set(REQUIRED_TOPICS) - topics
    assert not missing, f"topics with no document: {sorted(missing)}"


def test_every_document_carries_complete_front_matter() -> None:
    for document in load_corpus():
        assert document.identifier
        assert document.title
        assert document.topic
        assert document.provenance, f"{document.identifier} has no provenance note"
        assert len(document.provenance) > 30, (
            f"{document.identifier}'s provenance is too terse to be a real note"
        )


def test_every_document_has_substantive_content() -> None:
    for document in load_corpus():
        assert estimate_tokens(document.body) > 100, f"{document.identifier} is a stub"
        assert "#" in document.body, f"{document.identifier} has no headings to chunk on"


def test_no_document_contains_a_location_specific_measurement() -> None:
    """specs/rag-knowledge: the corpus is conceptual, and a figure for a place would be a
    measurement masquerading as an explanation.

    Looks for a number next to a unit *in the same sentence as a place name*, which is the shape a
    smuggled measurement takes. Illustrative figures with no location — "1013 hPa is typical",
    "0.1 mm" — are the corpus's job and are allowed.
    """
    places = re.compile(
        r"\b(Berlin|London|Paris|New York|Tokyo|Reykjav|Munich|Lisbon|Sydney|Delhi|Madrid|Rome)",
        re.IGNORECASE,
    )
    figure = re.compile(r"\d+(\.\d+)?\s*(°C|°F|mm|hPa|km/h|mph|%)")

    for document in load_corpus():
        for sentence in re.split(r"(?<=[.!?])\s+", document.body):
            if places.search(sentence) and figure.search(sentence):
                raise AssertionError(
                    f"{document.identifier} appears to state a measurement for a place: "
                    f"{sentence.strip()[:160]}"
                )


def test_no_document_claims_to_be_an_official_source() -> None:
    """The corpus is authored by Weathra and its provenance says so."""
    for document in load_corpus():
        assert "Written for Weathra" in document.provenance


def test_a_document_with_no_front_matter_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "broken.md"
    path.write_text("# No front matter\n\nJust a body.\n")
    with pytest.raises(ValidationFailed, match="no front-matter"):
        read_document(path)


def test_a_document_missing_provenance_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "incomplete.md"
    path.write_text("---\nid: x\ntitle: X\ntopic: y\n---\n\n# X\n\nBody.\n")
    with pytest.raises(ValidationFailed, match="provenance"):
        read_document(path)


def test_duplicate_identifiers_are_refused(tmp_path: Path) -> None:
    """Identifiers are what an answer cites, so a collision would make a citation ambiguous."""
    for name in ("first.md", "second.md"):
        (tmp_path / name).write_text(
            "---\nid: same\ntitle: T\ntopic: t\nprovenance: p\n---\n\n# T\n\nBody.\n"
        )
    with pytest.raises(ValidationFailed, match="share an identifier"):
        load_corpus(tmp_path)


def test_the_corpus_directory_ships_with_the_package() -> None:
    assert CORPUS_ROOT.is_dir()
    assert list(CORPUS_ROOT.glob("*.md"))


# =========================================================================== chunking


def test_chunks_are_heading_aware() -> None:
    document = next(item for item in load_corpus() if item.identifier == "dew-point")
    chunks = chunk_document(document, SETTINGS)

    assert len(chunks) >= 3
    headings = [chunk.heading for chunk in chunks if chunk.heading]
    assert headings, "no chunk carries a heading"
    assert len(set(headings)) > 1, "every chunk landed under one heading"


def test_every_chunk_carries_its_document_title_for_context() -> None:
    """A retrieved fragment reaches a reader without the rest of the document."""
    document = next(item for item in load_corpus() if item.identifier == "uv-index")
    for chunk in chunk_document(document, SETTINGS):
        assert document.title in chunk.text


def test_chunks_are_positioned_in_order() -> None:
    for document in load_corpus():
        positions = [chunk.position for chunk in chunk_document(document, SETTINGS)]
        assert positions == list(range(len(positions)))


def test_every_chunk_respects_the_token_bound() -> None:
    settings = provider_settings(rag_chunk_max_tokens=200, rag_chunk_overlap_tokens=40)
    for document in load_corpus():
        for chunk in chunk_document(document, settings):
            # The heading prefix is added after the split, so allow a small margin for it.
            assert chunk.token_count <= 200 + 40, (
                f"{document.identifier}#{chunk.position} is {chunk.token_count} tokens"
            )


def test_a_long_section_is_split_with_overlap() -> None:
    """A passage spanning a split must be retrievable from either side of it."""
    from weathra.rag.ingest import CorpusDocument

    paragraphs = "\n\n".join(
        f"Paragraph {index} about pressure gradients and wind. " * 8 for index in range(12)
    )
    document = CorpusDocument(
        identifier="long",
        title="Long",
        topic="pressure",
        provenance="Written for Weathra as a chunking fixture.",
        body=f"# Long\n\n{paragraphs}",
        path=Path("long.md"),
    )
    settings = provider_settings(rag_chunk_max_tokens=120, rag_chunk_overlap_tokens=30)
    chunks = chunk_document(document, settings)

    assert len(chunks) > 1
    # The tail of one chunk reappears at the head of the next.
    assert any(
        chunks[index].text[-40:] in chunks[index + 1].text for index in range(len(chunks) - 1)
    )


def test_a_document_with_no_headings_still_chunks() -> None:
    from weathra.rag.ingest import CorpusDocument

    document = CorpusDocument(
        identifier="flat",
        title="Flat",
        topic="terminology",
        provenance="Written for Weathra as a chunking fixture.",
        body="A single paragraph with no headings at all.",
        path=Path("flat.md"),
    )
    chunks = chunk_document(document, SETTINGS)
    assert len(chunks) == 1
    assert chunks[0].heading is None


def test_chunking_is_deterministic() -> None:
    document = next(item for item in load_corpus() if item.identifier == "wind-speed-and-gusts")
    first = chunk_document(document, SETTINGS)
    second = chunk_document(document, SETTINGS)
    assert [chunk.text for chunk in first] == [chunk.text for chunk in second]


def test_a_content_hash_changes_only_with_the_content() -> None:
    documents = {item.identifier: item for item in load_corpus()}
    original = documents["dew-point"]
    assert original.content_hash == read_document(original.path).content_hash

    edited = original.model_copy(update={"body": original.body + "\n\nAn extra sentence."})
    assert edited.content_hash != original.content_hash


# =========================================================================== 11.2 embedding


def test_the_deterministic_embedder_satisfies_the_contract() -> None:
    assert isinstance(DeterministicEmbedder(), EmbeddingProvider)


def test_the_fastembed_embedder_satisfies_the_contract() -> None:
    """Checked without loading the model: the contract is the shape, not the weights."""
    embedder = FastEmbedEmbedder(model_id="BAAI/bge-small-en-v1.5", dimension=384)
    assert isinstance(embedder, EmbeddingProvider)
    assert embedder.model_id == "BAAI/bge-small-en-v1.5"
    assert embedder.dimension == 384


def test_a_vector_has_the_declared_dimension() -> None:
    embedder = DeterministicEmbedder(dimension=384)
    vector = embedder.embed_query("what does dew point mean")
    assert len(vector) == 384


def test_identical_input_gives_an_identical_vector() -> None:
    embedder = DeterministicEmbedder()
    assert embedder.embed_query("dew point") == embedder.embed_query("dew point")
    first, second = embedder.embed_documents(["dew point", "dew point"])
    assert first == second


def test_different_input_gives_a_different_vector() -> None:
    embedder = DeterministicEmbedder()
    assert embedder.embed_query("dew point") != embedder.embed_query("wind gusts")


def test_texts_sharing_words_are_closer_than_texts_that_do_not() -> None:
    """The one semantic property the deterministic embedder has, and the one tests rely on."""
    embedder = DeterministicEmbedder()

    def similarity(left: str, right: str) -> float:
        a = embedder.embed_query(left)
        b = embedder.embed_query(right)
        return sum(x * y for x, y in zip(a, b, strict=True))

    related = similarity("what does dew point mean", "the dew point is the temperature")
    unrelated = similarity("what does dew point mean", "corporation tax filing deadlines")
    assert related > unrelated


def test_an_empty_query_still_produces_a_valid_vector() -> None:
    vector = DeterministicEmbedder(dimension=384).embed_query("   ")
    assert len(vector) == 384


def test_a_vector_is_normalized() -> None:
    import math

    vector = DeterministicEmbedder().embed_query("precipitation probability explained")
    magnitude = math.sqrt(sum(value * value for value in vector))
    assert magnitude == pytest.approx(1.0)


def test_the_embedder_is_configuration() -> None:
    real = build_embedder(provider_settings())
    assert isinstance(real, FastEmbedEmbedder)
    assert real.model_id == "BAAI/bge-small-en-v1.5"

    fake = build_embedder(provider_settings(embedding_model_id="weathra-hashing-v1"))
    assert isinstance(fake, DeterministicEmbedder)


# =========================================================================== compatibility


def test_a_matching_index_is_compatible() -> None:
    embedder = DeterministicEmbedder(model_id="m", dimension=384)
    check_compatibility(embedder, stored_model="m", stored_dimension=384)


def test_an_empty_index_is_compatible_with_anything() -> None:
    check_compatibility(DeterministicEmbedder(), stored_model=None, stored_dimension=None)


def test_a_different_model_is_refused_with_re_index_required() -> None:
    embedder = DeterministicEmbedder(model_id="new-model", dimension=384)
    with pytest.raises(VectorIndexMismatch) as caught:
        check_compatibility(embedder, stored_model="old-model", stored_dimension=384)

    assert "re-index" in caught.value.details["action"]
    assert "old-model" in caught.value.message
    assert "new-model" in caught.value.message


def test_a_different_dimension_is_refused() -> None:
    embedder = DeterministicEmbedder(model_id="m", dimension=768)
    with pytest.raises(VectorIndexMismatch, match="768"):
        check_compatibility(embedder, stored_model="m", stored_dimension=384)


def test_the_model_is_not_loaded_until_it_is_used() -> None:
    """Cold-start latency is a named risk; a process that never embeds must not pay for it."""
    embedder = FastEmbedEmbedder(model_id="BAAI/bge-small-en-v1.5", dimension=384)
    assert embedder._model is None
    assert embedder.model_id
    assert embedder.dimension == 384
    assert embedder._model is None


@pytest.mark.live
def test_the_real_embedding_model_produces_the_declared_dimension() -> None:
    """The one test that downloads and runs the real ONNX model. `live`, so it is opt-in."""
    embedder = FastEmbedEmbedder(model_id="BAAI/bge-small-en-v1.5", dimension=384)
    vectors = embedder.embed_documents(["The dew point is a temperature.", "Gusts are peaks."])

    assert len(vectors) == 2
    assert all(len(vector) == 384 for vector in vectors)
    assert vectors[0] != vectors[1]
    assert embedder.embed_query("dew point") == embedder.embed_query("dew point")
