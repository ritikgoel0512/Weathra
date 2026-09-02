"""Embeddings, behind an abstraction (design.md decision 12).

OpenRouter is an inference *gateway* and is not relied on for embeddings, so embedding runs
in-process: ``fastembed`` with BGE-small-en-v1.5, 384 dimensions, ONNX, no credential, deterministic
output. That keeps the whole RAG path keyless, which is what lets retrieval work with no inference
credential configured at all.

Two things are recorded alongside every vector: the **model identity** and the **dimension**. A
query embedded by a different model produces numbers on a different scale in a different space, and
comparing them yields a similarity that looks plausible and means nothing. So a mismatch is refused
with "re-indexing required" rather than silently returning nonsense
(``specs/rag-knowledge``).

The model is loaded **lazily**, on first use. Importing an ONNX runtime and materialising a
transformer costs real time, and the design names cold-start latency as a risk: a process that
never answers a conceptual question should never pay for it.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from weathra.config import Settings
from weathra.domain.errors import VectorIndexMismatch

__all__ = [
    "DeterministicEmbedder",
    "EmbeddingProvider",
    "FastEmbedEmbedder",
    "build_embedder",
    "check_compatibility",
]

logger = logging.getLogger("weathra.rag.embed")


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Turns text into vectors, and says which model and dimension it is."""

    @property
    def model_id(self) -> str:
        """The model identity recorded alongside every vector it produces."""
        ...

    @property
    def dimension(self) -> int:
        """The vector length. Recorded with the index; a mismatch is refused."""
        ...

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed corpus chunks, in the order given."""
        ...

    def embed_query(self, text: str) -> list[float]:
        """Embed one query.

        Separate from ``embed_documents`` because some models use different prefixes or
        instructions for the two, and an abstraction that conflated them would prevent using one.
        """
        ...


def check_compatibility(
    embedder: EmbeddingProvider, *, stored_model: str | None, stored_dimension: int | None
) -> None:
    """Refuse to query across an embedding-model change.

    ``None`` for either means an empty index — nothing to be incompatible with, so ingestion is
    simply pending.
    """
    if stored_model is None or stored_dimension is None:
        return

    if stored_model != embedder.model_id:
        raise VectorIndexMismatch(
            f"The knowledge index was built with embedding model {stored_model!r} but the "
            f"configured model is {embedder.model_id!r}. Similarity across two embedding spaces "
            "is meaningless, so the query is refused. Re-ingest the corpus to rebuild the index.",
            details={
                "stored_model": stored_model,
                "configured_model": embedder.model_id,
                "action": "re-index required",
            },
        )

    if stored_dimension != embedder.dimension:
        raise VectorIndexMismatch(
            f"The knowledge index holds {stored_dimension}-dimensional vectors but the configured "
            f"model produces {embedder.dimension}. Re-ingest the corpus to rebuild the index.",
            details={
                "stored_dimension": stored_dimension,
                "configured_dimension": embedder.dimension,
                "action": "re-index required",
            },
        )


class FastEmbedEmbedder:
    """BGE-small-en-v1.5 through ``fastembed``: local, ONNX, keyless, deterministic."""

    def __init__(self, *, model_id: str, dimension: int) -> None:
        self._model_id = model_id
        self._dimension = dimension
        self._model: object | None = None

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def dimension(self) -> int:
        return self._dimension

    def _loaded(self) -> object:
        """The model, loaded on first use.

        The import is inside the method as well as the instantiation: ``fastembed`` pulls in an
        ONNX runtime and tokenizers, and a process that never embeds anything should not pay that
        import cost at startup.
        """
        if self._model is None:
            from fastembed import TextEmbedding

            logger.info("loading embedding model %s", self._model_id)
            self._model = TextEmbedding(model_name=self._model_id)
        return self._model

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        model = self._loaded()
        vectors = [
            [float(value) for value in vector]
            for vector in model.embed(list(texts))  # type: ignore[attr-defined]
        ]
        self._verify(vectors)
        return vectors

    def embed_query(self, text: str) -> list[float]:
        model = self._loaded()
        vectors = [
            [float(value) for value in vector]
            for vector in model.query_embed([text])  # type: ignore[attr-defined]
        ]
        self._verify(vectors)
        return vectors[0]

    def _verify(self, vectors: Sequence[Sequence[float]]) -> None:
        """Catch a configured dimension that disagrees with what the model actually produces.

        Better here, once, than as a database error on every insert — and it is the exact
        misconfiguration that would otherwise produce a corrupt index.
        """
        for vector in vectors:
            if len(vector) != self._dimension:
                raise VectorIndexMismatch(
                    f"Embedding model {self._model_id!r} produced a {len(vector)}-dimensional "
                    f"vector but EMBEDDING_DIMENSION is set to {self._dimension}.",
                    details={
                        "model": self._model_id,
                        "produced": len(vector),
                        "configured": self._dimension,
                    },
                )


class DeterministicEmbedder:
    """A hashing embedder: deterministic, dependency-free, and offline.

    Not a pretend language model — it has no semantics beyond term overlap — but that is exactly
    what most tests need. It lets the whole store, ingestion, and retrieval path be exercised with
    no model download, no ONNX runtime, and no network, which is what
    ``specs/rag-knowledge``'s "retrieval works with no inference credential" needs to be checkable
    in CI. The real model is exercised by a ``live``-marked test.

    Its one real property is that identical text always yields an identical vector, and that texts
    sharing words are closer than texts that share none.
    """

    def __init__(self, *, model_id: str = "weathra-hashing-v1", dimension: int = 384) -> None:
        self._model_id = model_id
        self._dimension = dimension

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vector(text)

    def _vector(self, text: str) -> list[float]:
        """A bag-of-words hash projected onto the unit sphere.

        Each token lands in a bucket by a stable digest, so overlap in words means overlap in
        buckets means a higher cosine similarity. Normalized so cosine distance behaves the way
        pgvector's operators expect.
        """
        buckets = [0.0] * self._dimension
        tokens = [token for token in _tokenize(text) if token]
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self._dimension
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            buckets[index] += sign

        magnitude = math.sqrt(sum(value * value for value in buckets))
        if magnitude == 0.0:
            # An empty or unusable query still needs a valid vector; a fixed unit vector keeps the
            # store's dimension invariant and simply matches nothing in particular.
            buckets[0] = 1.0
            return buckets
        return [value / magnitude for value in buckets]


def _tokenize(text: str) -> list[str]:
    return [
        "".join(character for character in word if character.isalnum())
        for word in text.lower().split()
    ]


def build_embedder(settings: Settings) -> EmbeddingProvider:
    """The configured embedder. The concrete implementation is configuration."""
    if settings.embedding_model_id == "weathra-hashing-v1":
        return DeterministicEmbedder(dimension=settings.embedding_dimension)
    return FastEmbedEmbedder(
        model_id=settings.embedding_model_id, dimension=settings.embedding_dimension
    )
