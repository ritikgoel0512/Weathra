"""SQLAlchemy models for every table in design.md decision 10.

The ownership classification is the load-bearing part of this module, and it is deliberate rather
than uniform. "Scope everything to a user" would be wrong here:

* **User-owned** — ``profiles``, ``preferences``, ``saved_locations``, ``threads``, ``agent_runs``.
  Each carries ``user_id``, the Supabase Auth subject. Row Level Security is enabled on each with
  an owner-restricting policy (the migration in task 3.3), as a second gate behind the ownership
  predicate the repositories apply.
* **Shared** — ``forecast_snapshots`` carries *no user column at all*. A forecast for Berlin is not
  private, and keying snapshots by location rather than by requester both avoids storing a browsing
  trail and gives What Changed? far better coverage: every user's request improves everyone's
  history. ``knowledge_documents`` and ``knowledge_chunks`` are likewise shared and read-only to
  users.
* **Operational** — ``evaluation_runs`` and ``evaluation_case_results`` belong to the project, not
  to a person.

The LangGraph checkpoint tables are not defined here: the checkpointer library owns its own schema.
Ownership for them is established differently (design.md decision 11) — a composed
``{user_id}:{thread_id}`` key, plus the ``threads`` row below, which is the actual gate.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

__all__ = [
    "MAX_HORIZON_PREFERENCE_DAYS",
    "USER_ID_COLUMN",
    "AgentRun",
    "Base",
    "EvaluationCaseResult",
    "EvaluationRun",
    "ForecastSnapshot",
    "KnowledgeChunk",
    "KnowledgeDocument",
    "Ownership",
    "Preference",
    "Profile",
    "SavedLocation",
    "Thread",
    "ownership_of",
    "user_owned_tables",
]

# The column name every user-owned table carries. Named once so the migration that enables Row
# Level Security and the tests that check the classification agree with the models by construction.
USER_ID_COLUMN = "user_id"

# The widest forecast horizon a stored preference may hold. Declared here rather than in the
# preference store because the check constraint below is the real bound: a value the table would
# reject must not be accepted by the code that writes it.
MAX_HORIZON_PREFERENCE_DAYS = 16

# JSON columns are JSONB on Postgres and plain JSON elsewhere, so a model can still be inspected
# without a Postgres connection.
JsonB = JSON().with_variant(JSONB(), "postgresql")


class Ownership(StrEnum):
    """Decision 10's classification, attached to each table as declarative metadata."""

    USER = "user"
    SHARED = "shared"
    OPERATIONAL = "operational"


class Base(DeclarativeBase):
    """Declarative base. Every table declares its ownership in ``__table_args__['info']``."""

    type_annotation_map = {dict[str, Any]: JsonB}


def ownership_of(table_name: str) -> Ownership:
    """The declared ownership of a mapped table."""
    table = Base.metadata.tables[table_name]
    declared = table.info.get("ownership")
    if declared is None:
        raise LookupError(
            f"Table {table_name!r} declares no ownership. Decision 10 requires every table to be "
            "classified user-owned, shared, or operational."
        )
    return Ownership(declared)


def user_owned_tables() -> tuple[str, ...]:
    """Every user-owned table, in definition order. The RLS migration iterates this."""
    return tuple(
        name
        for name, table in Base.metadata.tables.items()
        if table.info.get("ownership") == Ownership.USER
    )


def _timestamp_column(**kwargs: Any) -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), **kwargs)


# =========================================================================== user-owned


class Profile(Base):
    """The application profile, keyed by the Supabase Auth subject.

    Holds only what Weathra needs. No password material, and no contact data duplicated from
    Supabase Auth — the email lives in Auth and arrives on each request inside the validated token.
    There is deliberately no separate internal profile id: a second identifier would only create a
    mapping to get wrong, and the auth subject is already stable and opaque.
    """

    __tablename__ = "profiles"
    __table_args__ = {"info": {"ownership": Ownership.USER}}

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        doc="The Supabase Auth subject. The ownership key every other user-owned table carries.",
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)

    preference: Mapped[Preference | None] = relationship(
        back_populates="profile", cascade="all, delete-orphan", uselist=False
    )
    saved_locations: Mapped[list[SavedLocation]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    threads: Mapped[list[Thread]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    agent_runs: Mapped[list[AgentRun]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class Preference(Base):
    """Explicitly chosen, non-sensitive preferences. Never inferred from behavior."""

    __tablename__ = "preferences"
    __table_args__ = (
        CheckConstraint("unit_system in ('metric', 'imperial')", name="ck_preferences_unit_system"),
        CheckConstraint(
            "forecast_horizon_days is null or "
            f"(forecast_horizon_days between 1 and {MAX_HORIZON_PREFERENCE_DAYS})",
            name="ck_preferences_horizon",
        ),
        {"info": {"ownership": Ownership.USER}},
    )

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("profiles.user_id", ondelete="CASCADE"),
        primary_key=True,
    )
    unit_system: Mapped[str | None] = mapped_column(String(16), nullable=True)
    forecast_horizon_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_location_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, doc="A Location.identifier, not a saved-location row id."
    )
    default_location: Mapped[dict[str, Any] | None] = mapped_column(
        JsonB, nullable=True, doc="The canonical resolved location, so it needs no re-resolving."
    )
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )

    profile: Mapped[Profile] = relationship(back_populates="preference")


class SavedLocation(Base):
    """A canonical resolved location a person chose to keep.

    Unique per (user, location identifier) so saving the same place twice does not duplicate it.
    """

    __tablename__ = "saved_locations"
    __table_args__ = (
        UniqueConstraint(USER_ID_COLUMN, "location_id", name="uq_saved_locations_user_location"),
        Index("ix_saved_locations_user", USER_ID_COLUMN),
        {"info": {"ownership": Ownership.USER}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("profiles.user_id", ondelete="CASCADE"), nullable=False
    )
    location_id: Mapped[str] = mapped_column(
        String(64), nullable=False, doc="The stable coordinate-derived Location.identifier."
    )
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    location: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, doc="The canonical location, stored rather than the raw query text."
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)

    profile: Mapped[Profile] = relationship(back_populates="saved_locations")


class Thread(Base):
    """A conversation thread we own, alongside the checkpointer's own state.

    Two jobs. First, it records the thread's *owner*, which is the actual authorization gate: the
    API checks it before the graph is ever invoked, so a caller presenting another user's thread id
    fails without the checkpointer being consulted. Second, ``resolved_entities`` is an explicit,
    queryable projection of what a follow-up needs — locations, units, window, criterion, last data
    class. Reconstructing "which cities did we just compare" by replaying a checkpoint would couple
    follow-up resolution to graph internals (design.md decision 11).
    """

    __tablename__ = "threads"
    __table_args__ = (
        Index("ix_threads_user", USER_ID_COLUMN),
        Index("ix_threads_expires_at", "expires_at"),
        {"info": {"ownership": Ownership.USER}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("profiles.user_id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    resolved_entities: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, default=dict, doc="Locations, units, window, criterion, data class."
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    last_activity_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = _timestamp_column(
        nullable=False, doc="Bounded retention. The retention routine removes expired threads."
    )

    profile: Mapped[Profile] = relationship(back_populates="threads")
    runs: Mapped[list[AgentRun]] = relationship(back_populates="thread")

    @property
    def checkpoint_key(self) -> str:
        """The composed checkpointer key, ``{user_id}:{thread_id}``."""
        return f"{self.user_id}:{self.id}"


class AgentRun(Base):
    """One completed agent request, with its evidence record, owned by the acting user."""

    __tablename__ = "agent_runs"
    __table_args__ = (
        Index("ix_agent_runs_user", USER_ID_COLUMN),
        Index("ix_agent_runs_thread", "thread_id"),
        {"info": {"ownership": Ownership.USER}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("profiles.user_id", ondelete="CASCADE"), nullable=False
    )
    thread_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("threads.id", ondelete="SET NULL"), nullable=True
    )
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer_prose: Mapped[str | None] = mapped_column(Text, nullable=True)
    envelope: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, doc="The assembled response envelope, including findings."
    )
    evidence: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, doc="The full evidence record — the audit trail for every figure."
    )
    llm_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    llm_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    weather_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_ms: Mapped[float] = mapped_column(Float, nullable=False)
    partial: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)

    profile: Mapped[Profile] = relationship(back_populates="agent_runs")
    thread: Mapped[Thread | None] = relationship(back_populates="runs")


# =========================================================================== shared


class ForecastSnapshot(Base):
    """A forecast as it stood at one retrieval, for What Changed?.

    **Deliberately carries no user column.** See the module docstring: keying by location rather
    than by requester avoids storing a browsing trail and means one person's request improves
    everyone's history. Where a snapshot genuinely needs to be associated with a person — a future
    per-user watch — that association goes in a user-owned table of its own rather than a nullable
    column here.
    """

    __tablename__ = "forecast_snapshots"
    __table_args__ = (
        Index(
            "ix_forecast_snapshots_lookup",
            "location_id",
            "window_start",
            "window_end",
            "provider",
            "retrieved_at",
        ),
        {"info": {"ownership": Ownership.SHARED}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    location_id: Mapped[str] = mapped_column(String(64), nullable=False)
    location: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False)
    window_start: Mapped[datetime] = _timestamp_column(nullable=False)
    window_end: Mapped[datetime] = _timestamp_column(nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    unit_system: Mapped[str] = mapped_column(String(16), nullable=False)
    retrieved_at: Mapped[datetime] = _timestamp_column(nullable=False)
    daily_series: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, doc="The normalized daily series as retrieved."
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


class KnowledgeDocument(Base):
    """A corpus document. Shared, read-only to users, conceptual content only."""

    __tablename__ = "knowledge_documents"
    __table_args__ = {"info": {"ownership": Ownership.SHARED}}

    id: Mapped[str] = mapped_column(
        String(120), primary_key=True, doc="The stable identifier from the document front-matter."
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    topic: Mapped[str] = mapped_column(String(120), nullable=False)
    provenance: Mapped[str] = mapped_column(
        Text, nullable=False, doc="Where the content came from. Every document carries one."
    )
    content_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, doc="Drives idempotent re-ingestion and change detection."
    )
    ingested_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)

    chunks: Mapped[list[KnowledgeChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class KnowledgeChunk(Base):
    """One embedded chunk of a corpus document.

    ``embedding_model`` and ``embedding_dimension`` are recorded alongside the vector so a query
    with a different model is *refused* rather than silently producing meaningless similarity
    (``specs/rag-knowledge``). The HNSW index is added by migration — a corpus this small makes
    build cost irrelevant and recall matters more than write throughput.
    """

    __tablename__ = "knowledge_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "position", name="uq_knowledge_chunks_document_position"),
        {"info": {"ownership": Ownership.SHARED}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    document_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    heading: Mapped[str | None] = mapped_column(String(300), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(200), nullable=False)
    embedding_dimension: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(384), nullable=False)

    document: Mapped[KnowledgeDocument] = relationship(back_populates="chunks")


# =========================================================================== operational


class EvaluationRun(Base):
    """One evaluation run's configuration and computed metrics."""

    __tablename__ = "evaluation_runs"
    __table_args__ = {"info": {"ownership": Ownership.OPERATIONAL}}

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    dataset_version: Mapped[str] = mapped_column(String(64), nullable=False)
    mode: Mapped[str] = mapped_column(
        String(16), nullable=False, doc="'offline' or 'live'. Recorded on every run."
    )
    llm_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    llm_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    weather_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(200), nullable=False)
    commit_sha: Mapped[str | None] = mapped_column(String(40), nullable=True)
    test_user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), nullable=True, doc="The identity used. Never its credential."
    )
    category_filter: Mapped[str | None] = mapped_column(String(64), nullable=True)
    case_filter: Mapped[str | None] = mapped_column(String(120), nullable=True)
    metrics: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    thresholds: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    passed: Mapped[bool | None] = mapped_column(nullable=True)
    started_at: Mapped[datetime] = _timestamp_column(nullable=False)
    completed_at: Mapped[datetime | None] = _timestamp_column(nullable=True)

    case_results: Mapped[list[EvaluationCaseResult]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class EvaluationCaseResult(Base):
    """One case's outcome within a run, with its evidence retained for diagnosis."""

    __tablename__ = "evaluation_case_results"
    __table_args__ = (
        UniqueConstraint("run_id", "case_id", name="uq_evaluation_case_results_run_case"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("evaluation_runs.id", ondelete="CASCADE"), nullable=False
    )
    case_id: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    passed: Mapped[bool] = mapped_column(nullable=False)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    per_metric: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)

    run: Mapped[EvaluationRun] = relationship(back_populates="case_results")
