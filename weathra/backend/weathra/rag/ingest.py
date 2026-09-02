"""Reading the corpus, chunking it, and ingesting it.

**Chunking is heading-aware and token-bounded.** A chunk that starts mid-explanation is a chunk a
reader cannot use, so splits land on headings first and only fall back to sentence boundaries when
a section exceeds the token bound. Each chunk carries its heading, which does double duty: it gives
a retrieved fragment context, and it gives the embedding a topic sentence to work with.

**Re-ingestion is idempotent, by content hash.** Running ingestion twice over unchanged documents
leaves the chunk count where it was; a document whose content changed has its chunks *replaced*
rather than added to, so the index never holds two versions of the same passage
(``specs/rag-knowledge``).

**Ingestion runs under the privileged connection.** The corpus is shared, read-only to users, so
the restricted request role has no write grant on it at all — which is what makes "a user cannot
inject a knowledge chunk" a database fact rather than a code convention.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.domain.errors import ValidationFailed

__all__ = [
    "CORPUS_ROOT",
    "REQUIRED_TOPICS",
    "Chunk",
    "CorpusDocument",
    "IngestionReport",
    "chunk_document",
    "estimate_tokens",
    "load_corpus",
    "main",
    "read_document",
]

logger = logging.getLogger("weathra.rag.ingest")

CORPUS_ROOT = Path(__file__).resolve().parent / "corpus"

# Every topic ``specs/rag-knowledge`` requires the corpus to cover. A test asserts the corpus
# covers all of them, so a topic cannot be dropped without noticing.
REQUIRED_TOPICS: tuple[str, ...] = (
    "humidity",
    "pressure",
    "precipitation",
    "wind",
    "radiation",
    "uncertainty",
    "terminology",
    "data-classes",
)

_FRONT_MATTER = re.compile(r"\A---\n(?P<yaml>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)
_HEADING = re.compile(r"^(#{1,6})\s+(?P<title>.+)$", re.MULTILINE)

# ~4 characters per token is the usual rule of thumb for English text. Deliberately an estimate:
# the real tokenizer belongs to the embedding model, and loading it just to measure a chunk would
# undo the lazy-loading the design asks for.
_CHARACTERS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARACTERS_PER_TOKEN)


class CorpusDocument(BaseModel):
    """One corpus document, with the front-matter every document must carry."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    identifier: str = Field(min_length=1)
    title: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    provenance: str = Field(
        min_length=1, description="Where the content came from. Every document carries one."
    )
    body: str = Field(min_length=1)
    path: Path

    @property
    def content_hash(self) -> str:
        """Drives idempotent re-ingestion: unchanged content, unchanged hash, no rewrite."""
        return hashlib.sha256(self.body.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Chunk:
    """One embeddable passage, with its position and the heading it sits under."""

    document_id: str
    position: int
    heading: str | None
    text: str
    token_count: int


class IngestionReport(BaseModel):
    """What an ingestion run did. Reported, because "it worked" is not a useful answer."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    documents_seen: int = Field(ge=0)
    documents_written: int = Field(ge=0, description="Newly ingested or replaced.")
    documents_unchanged: int = Field(ge=0)
    documents_removed: int = Field(
        default=0, ge=0, description="In the index but no longer in the corpus."
    )
    chunks_written: int = Field(ge=0)
    chunks_total: int = Field(ge=0, description="In the index after the run.")
    embedding_model: str = Field(min_length=1)
    embedding_dimension: int = Field(ge=1)


def _parse_front_matter(raw: str, path: Path) -> tuple[dict[str, str], str]:
    """Read the front-matter without a YAML dependency.

    The corpus front-matter is a flat mapping with optional folded (``>``) values, which is a small
    enough subset to read directly — and one fewer dependency for a format Weathra itself defines.
    """
    match = _FRONT_MATTER.match(raw)
    if match is None:
        raise ValidationFailed(
            f"{path.name} has no front-matter block. Every corpus document must declare its "
            "identifier, title, topic, and provenance.",
            details={"document": path.name},
        )

    fields: dict[str, str] = {}
    key: str | None = None
    for line in match.group("yaml").splitlines():
        if not line.strip():
            continue
        if line.startswith((" ", "\t")) and key is not None:
            fields[key] = f"{fields[key]} {line.strip()}".strip()
            continue
        if ":" not in line:
            raise ValidationFailed(
                f"{path.name} has a front-matter line that is not a key-value pair: {line!r}",
                details={"document": path.name, "line": line},
            )
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        fields[key] = "" if value == ">" else value

    return fields, match.group("body")


def read_document(path: Path) -> CorpusDocument:
    """One document from disk, with its front-matter validated."""
    fields, body = _parse_front_matter(path.read_text(), path)

    missing = [name for name in ("id", "title", "topic", "provenance") if not fields.get(name)]
    if missing:
        raise ValidationFailed(
            f"{path.name} is missing required front-matter: {', '.join(missing)}.",
            details={"document": path.name, "missing": missing},
        )

    return CorpusDocument(
        identifier=fields["id"],
        title=fields["title"],
        topic=fields["topic"],
        provenance=fields["provenance"],
        body=body.strip(),
        path=path,
    )


def load_corpus(root: Path = CORPUS_ROOT) -> tuple[CorpusDocument, ...]:
    """Every document in the corpus, in a stable order, with identifiers checked for collisions."""
    documents = tuple(read_document(path) for path in sorted(root.glob("*.md")))

    identifiers = [document.identifier for document in documents]
    duplicates = {name for name in identifiers if identifiers.count(name) > 1}
    if duplicates:
        raise ValidationFailed(
            f"Two corpus documents share an identifier: {', '.join(sorted(duplicates))}. "
            "Identifiers are what an answer cites, so they must be unique.",
            details={"duplicates": sorted(duplicates)},
        )
    return documents


def _sections(body: str) -> Iterator[tuple[str | None, str]]:
    """The document split at its headings, each section paired with the heading above it."""
    matches = list(_HEADING.finditer(body))
    if not matches:
        yield None, body.strip()
        return

    preamble = body[: matches[0].start()].strip()
    if preamble:
        yield None, preamble

    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        text = body[match.end() : end].strip()
        if text:
            yield match.group("title").strip(), text


def _split_long(text: str, *, max_tokens: int, overlap_tokens: int) -> list[str]:
    """Split an over-long section on paragraph and sentence boundaries, with overlap.

    Overlap exists so a passage split across two chunks is retrievable from either: a query whose
    answer straddles the boundary would otherwise match neither half well.
    """
    if estimate_tokens(text) <= max_tokens:
        return [text]

    units = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    if len(units) == 1:
        units = [part.strip() for part in re.split(r"(?<=[.!?])\s+", units[0]) if part.strip()]

    pieces: list[str] = []
    current: list[str] = []
    current_tokens = 0
    overlap_characters = overlap_tokens * _CHARACTERS_PER_TOKEN

    for unit in units:
        unit_tokens = estimate_tokens(unit)
        if current and current_tokens + unit_tokens > max_tokens:
            joined = "\n\n".join(current)
            pieces.append(joined)
            tail = joined[-overlap_characters:] if overlap_characters else ""
            current = [tail, unit] if tail else [unit]
            current_tokens = estimate_tokens("\n\n".join(current))
        else:
            current.append(unit)
            current_tokens += unit_tokens

    if current:
        pieces.append("\n\n".join(current))
    return pieces


def chunk_document(document: CorpusDocument, settings: Settings) -> tuple[Chunk, ...]:
    """A document as embeddable chunks: heading-aware, token-bounded, position-ordered.

    Each chunk's text is prefixed with the document title and its heading. That is not decoration:
    a retrieved fragment reaches a reader without the rest of the document, and a chunk reading
    "Around 1013 hPa is typical" is only useful if it says what it is about.
    """
    chunks: list[Chunk] = []
    position = 0

    for heading, section in _sections(document.body):
        for piece in _split_long(
            section,
            max_tokens=settings.rag_chunk_max_tokens,
            overlap_tokens=settings.rag_chunk_overlap_tokens,
        ):
            context = f"{document.title}" + (f" — {heading}" if heading else "")
            text = f"{context}\n\n{piece}".strip()
            chunks.append(
                Chunk(
                    document_id=document.identifier,
                    position=position,
                    heading=heading,
                    text=text,
                    token_count=estimate_tokens(text),
                )
            )
            position += 1

    if not chunks:
        raise ValidationFailed(
            f"{document.path.name} produced no chunks; the document body is empty.",
            details={"document": document.identifier},
        )
    return tuple(chunks)


def chunk_corpus(
    documents: Sequence[CorpusDocument], settings: Settings
) -> dict[str, tuple[Chunk, ...]]:
    return {document.identifier: chunk_document(document, settings) for document in documents}


def main() -> int:
    """Ingest the corpus from the command line, under the privileged connection.

    Exposed as ``weathra-ingest-corpus``. Runs in a process whose ``WEATHRA_RUNTIME_MODE`` is
    ``privileged``, because the corpus tables carry no write grant for the request-serving role —
    a deliberate consequence of the corpus being shared and read-only to users.
    """
    import argparse
    import asyncio

    parser = argparse.ArgumentParser(
        prog="weathra-ingest-corpus",
        description=(
            "Chunk, embed, and store the weather-knowledge corpus. Re-running over unchanged "
            "documents is a no-op; a changed document has its chunks replaced."
        ),
    )
    parser.add_argument(
        "--keep-removed",
        action="store_true",
        help="Leave index entries for documents no longer in the corpus. Off by default.",
    )
    arguments = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

    async def run() -> int:
        from weathra.config import Settings
        from weathra.db.engine import Engines
        from weathra.db.session import privileged_session
        from weathra.rag.embed import build_embedder
        from weathra.rag.store import ingest_corpus

        settings = Settings()
        if not settings.is_privileged:
            print(
                "Refusing to run: set WEATHRA_RUNTIME_MODE=privileged. Corpus ingestion writes "
                "to shared tables the request-serving role cannot write to.",
            )
            return 2

        engines = Engines.create(settings)
        try:
            async with privileged_session(engines.privileged_sessionmaker) as session:
                report = await ingest_corpus(
                    session,
                    embedder=build_embedder(settings),
                    settings=settings,
                    prune=not arguments.keep_removed,
                )
        finally:
            await engines.dispose()

        print(report.model_dump_json(indent=2))
        return 0

    return asyncio.run(run())
