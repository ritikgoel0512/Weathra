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
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

__all__ = [
    "MAX_HORIZON_PREFERENCE_DAYS",
    "USER_ID_COLUMN",
    "AdminAudit",
    "AgentRun",
    "Base",
    "EvaluationCaseResult",
    "EvaluationRun",
    "ForecastSnapshot",
    "KnowledgeChunk",
    "KnowledgeDocument",
    "LlmUsageEvent",
    "ModelCatalogEntry",
    "ModelComparisonResult",
    "ModelComparisonRun",
    "ModelEvaluation",
    "ModelPolicy",
    "Ownership",
    "Preference",
    "Profile",
    "SavedLocation",
    "SubscriptionPlan",
    "Thread",
    "UsageCounter",
    "UsageLimit",
    "UserPlan",
    "ownership_column",
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


def ownership_column(table_name: str) -> str:
    """The column a user-owned table's Row Level Security policy compares against.

    ``user_id`` for almost every table, and declared per table rather than assumed because
    ``usage_counters`` is keyed by ``subject`` — a column that holds either an auth subject or the
    reserved internal one, so internal consumption is accounted separately by construction. Code
    that iterates the user-owned tables asking "who owns this row" needs to be told which column to
    ask, rather than discovering the exception as an ``UndefinedColumn`` at runtime.
    """
    table = Base.metadata.tables[table_name]
    if ownership_of(table_name) is not Ownership.USER:
        raise LookupError(f"{table_name!r} is not user-owned, so it has no ownership column.")
    return str(table.info.get("owner_column", USER_ID_COLUMN))


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
    weather_watches: Mapped[list[WeatherWatch]] = relationship(
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


class WeatherWatch(Base):
    """A condition somebody asked Weathra to check at a place they saved.

    **Evaluated when it is looked at, and the row says when.** There is no scheduler in this
    system, so there is nothing that could notice a threshold being crossed at three in the
    morning. `last_evaluated_at` is therefore not decoration: it is the difference between "the wind
    is above your threshold" and "the wind was above your threshold when you last looked", and a
    surface that showed the first while meaning the second would be the failure this whole feature
    has to avoid.

    Unique per (user, location, measure) so the same question about the same place is one row that
    gets updated rather than a list that accumulates duplicates.
    """

    __tablename__ = "weather_watches"
    __table_args__ = (
        UniqueConstraint(
            USER_ID_COLUMN, "location_id", "measure", name="uq_weather_watches_user_place_measure"
        ),
        Index("ix_weather_watches_user", USER_ID_COLUMN),
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
    location: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, doc="The canonical resolved location, as saved locations store it."
    )
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    measure: Mapped[str] = mapped_column(
        String(64), nullable=False, doc="The measure watched. Only measures the provider reports."
    )
    comparison: Mapped[str] = mapped_column(
        String(8), nullable=False, doc="'above' or 'below'. The direction that counts as met."
    )
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    last_evaluated_at: Mapped[datetime | None] = _timestamp_column(nullable=True)
    last_value: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
        doc="The reading at the last evaluation. Null where none was reported.",
    )
    last_met: Mapped[bool | None] = mapped_column(
        Boolean,
        nullable=True,
        doc="Whether the condition was met at the last evaluation. Null before the first one, and "
        "null again where the provider reported nothing — which is not the same as 'not met'.",
    )

    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )

    profile: Mapped[Profile] = relationship(back_populates="weather_watches")


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


# =========================================================================== SaaS: operational
#
# The model policy layer's own data (design.md decisions 22 to 25). Every table below is operational
# rather than user-owned: it is read to serve a request and written only through the administrative
# path, so an owner predicate on it would have nothing to compare against. That is a different
# statement from "unprotected" — the migrations grant the request-serving role read access to
# exactly the three tables a resolution needs, and nothing at all on the rest.


class SubscriptionPlan(Base):
    """A product tier as a row, so a plan's policies and allowances change without a deployment.

    ``plan_code`` is the stable identifier — ``free``, ``pro``, ``premium`` — and it is deliberately
    the primary key rather than a surrogate id: it is what `user_plans` rows and every recorded
    usage event carry, and a plan code that could be renamed under them would falsify history.

    ``external_subscription_ref`` is the room ``specs/usage-limits`` asks to be left for a later
    billing integration. It stays null in this change, nothing reads it, and no behaviour depends
    on it being populated.
    """

    __tablename__ = "subscription_plans"
    __table_args__ = (
        UniqueConstraint("rank", name="uq_subscription_plans_rank"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    plan_code: Mapped[str] = mapped_column(
        String(32), primary_key=True, doc="Canonical lowercase code. One of free, pro, premium."
    )
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    rank: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        doc="Ascending entitlement. What 'never escalate above the caller's plan' compares.",
    )
    policy_by_call_role: Mapped[dict[str, Any]] = mapped_column(
        JsonB,
        nullable=False,
        default=dict,
        doc="Call role -> policy id. A plan may map each role to a different policy.",
    )
    external_subscription_ref: Mapped[str | None] = mapped_column(
        String(200), nullable=True, doc="Unused. Where a billing provider's id would later land."
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ModelCatalogEntry(Base):
    """One model Weathra is allowed to use, with the metadata everything else reasons about.

    The split that carries the whole "no vendor identifier in business logic" requirement:
    ``catalog_key`` is the stable internal handle every policy, evaluation and comparison result
    references, and ``gateway_model`` is the vendor string, which is mutable. A gateway renaming a
    model is a one-row update that breaks nothing (design.md decision 23).
    """

    __tablename__ = "model_catalog"
    __table_args__ = (
        UniqueConstraint(
            "gateway_provider", "gateway_model", name="uq_model_catalog_gateway_identity"
        ),
        CheckConstraint("context_window > 0", name="ck_model_catalog_context_window"),
        CheckConstraint(
            "input_price_per_million >= 0 and output_price_per_million >= 0",
            name="ck_model_catalog_prices_non_negative",
        ),
        CheckConstraint(
            "cardinality(capability_roles) > 0", name="ck_model_catalog_has_capability_role"
        ),
        CheckConstraint("status in ('enabled', 'disabled')", name="ck_model_catalog_status"),
        Index("ix_model_catalog_status", "status"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    catalog_key: Mapped[str] = mapped_column(
        String(120), primary_key=True, doc="Kebab-case, internal, independent of any vendor naming."
    )
    gateway_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    gateway_model: Mapped[str] = mapped_column(
        String(200), nullable=False, doc="The vendor string, as the gateway expects it. Mutable."
    )
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    capability_roles: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, doc="The call roles this model is fit for."
    )
    capability_tier: Mapped[str] = mapped_column(
        String(32), nullable=False, doc="What policies order candidates by. Never a vendor name."
    )
    supports_structured_output: Mapped[bool] = mapped_column(nullable=False)
    context_window: Mapped[int] = mapped_column(Integer, nullable=False)
    input_price_per_million: Mapped[Decimal] = mapped_column(Numeric(14, 6), nullable=False)
    output_price_per_million: Mapped[Decimal] = mapped_column(Numeric(14, 6), nullable=False)
    price_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    pricing_recorded_on: Mapped[date] = mapped_column(
        Date, nullable=False, doc="The pricing basis. Copied onto each usage event at write time."
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="enabled")
    is_free_tier: Mapped[bool] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ModelPolicy(Base):
    """A named, ordered candidate list — the unit a plan and a call role resolve to.

    ``candidate_catalog_keys`` is ordered and its order is the resolution: the first entry present
    in the catalog and enabled wins. ``failover_enabled`` exists for exactly one row, the fixed
    evaluation policy, where attempting a second candidate would silently change what a run
    measures (``specs/evaluation``).
    """

    __tablename__ = "model_policies"
    __table_args__ = (
        CheckConstraint(
            "cardinality(candidate_catalog_keys) > 0", name="ck_model_policies_has_candidate"
        ),
        CheckConstraint(
            "cardinality(applicable_call_roles) > 0", name="ck_model_policies_has_call_role"
        ),
        CheckConstraint(
            "fallback_policy_id is null or fallback_policy_id <> policy_id",
            name="ck_model_policies_no_self_fallback",
        ),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    policy_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    candidate_catalog_keys: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, doc="Ordered. The first enabled catalog entry wins."
    )
    applicable_call_roles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    eligibility: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        doc="Who may resolve this at all: public, plan, administrative, internal_evaluation.",
    )
    fallback_policy_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("model_policies.policy_id", ondelete="SET NULL"),
        nullable=True,
        doc="Tried when no candidate is available. Never a policy above the caller's entitlement.",
    )
    failover_enabled: Mapped[bool] = mapped_column(
        nullable=False, default=True, doc="False pins the policy to its single candidate."
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


class UsageLimit(Base):
    """One allowance: a plan (or the internal subject), a dimension, a window, a number.

    A row per (subject, dimension) rather than a column per dimension, so adding the estimated-cost
    budget ``specs/usage-limits`` asks to be representable is a row and not a schema change. A
    dimension a plan declares no row for is *unlimited* in that dimension, which is why absence has
    to mean absence — a default of zero here would silently refuse every request.
    """

    __tablename__ = "usage_limits"
    __table_args__ = (
        CheckConstraint(
            "(plan_code is null) <> (internal_subject is null)",
            name="ck_usage_limits_exactly_one_subject",
        ),
        CheckConstraint("allowance >= 0", name="ck_usage_limits_allowance_non_negative"),
        Index(
            "uq_usage_limits_plan_dimension",
            "plan_code",
            "dimension",
            unique=True,
            postgresql_where=text("plan_code is not null"),
        ),
        Index(
            "uq_usage_limits_internal_dimension",
            "internal_subject",
            "dimension",
            unique=True,
            postgresql_where=text("internal_subject is not null"),
        ),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    plan_code: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("subscription_plans.plan_code", ondelete="CASCADE"),
        nullable=True,
    )
    internal_subject: Mapped[str | None] = mapped_column(
        String(64), nullable=True, doc="The reserved internal subject, on the internal allowance."
    )
    dimension: Mapped[str] = mapped_column(String(48), nullable=False)
    window_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, doc="Named to avoid WINDOW, which PostgreSQL reserves."
    )
    allowance: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


# =========================================================================== SaaS: user-owned


class UserPlan(Base):
    """Which plan a person is on. **Read-only to the request path, by grant and by policy.**

    The one table here where the owner-restricting policy is not the whole story. An owner policy
    written ``FOR ALL`` would let a caller insert their own row naming ``premium`` — the row would
    pass the ownership check, because it *is* their row — and self-service entitlement is precisely
    what ``specs/model-policy`` says the backend must establish rather than accept. So the request
    role is granted ``SELECT`` and nothing else, and the policy is ``FOR SELECT``. Assignment is an
    administrative write on the privileged connection, recorded in ``admin_audit``.

    A person with no row here is on Free. Absence is the default rather than an error, so a new
    account needs no provisioning step to be able to ask a question.
    """

    __tablename__ = "user_plans"
    __table_args__ = (
        Index("ix_user_plans_plan_code", "plan_code"),
        {"info": {"ownership": Ownership.USER}},
    )

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("profiles.user_id", ondelete="CASCADE"),
        primary_key=True,
    )
    plan_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("subscription_plans.plan_code", ondelete="RESTRICT"), nullable=False
    )
    assigned_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), nullable=True, doc="The administrative principal. Null where seeded."
    )
    assigned_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


class UsageCounter(Base):
    """Consumption for one (subject, dimension, window). The row admission upserts against.

    Keyed naturally rather than by a surrogate id, because the composite key *is* the concurrency
    control: the check and the increment are one ``INSERT … ON CONFLICT … DO UPDATE … WHERE
    consumed < allowance``, and a row that does not come back means the allowance is exhausted
    (design.md decision 25). A surrogate key would leave the conflict target with nothing to
    conflict on.

    ``subject`` is text and not a foreign key to ``profiles`` on purpose: internal traffic counts
    against a reserved non-UUID subject, which has no profile and must not acquire one.
    """

    __tablename__ = "usage_counters"
    __table_args__ = (
        CheckConstraint("consumed >= 0", name="ck_usage_counters_consumed_non_negative"),
        CheckConstraint("length(window_key) > 0", name="ck_usage_counters_window_key_present"),
        Index("ix_usage_counters_window", "dimension", "window_key"),
        {"info": {"ownership": Ownership.USER, "owner_column": "subject"}},
    )

    subject: Mapped[str] = mapped_column(
        String(64), primary_key=True, doc="An auth subject, or the reserved internal subject."
    )
    dimension: Mapped[str] = mapped_column(String(48), primary_key=True)
    window_key: Mapped[str] = mapped_column(
        String(32), primary_key=True, doc="'2026-09-03', '2026-09', or 'current' for concurrency."
    )
    consumed: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = _timestamp_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


class LlmUsageEvent(Base):
    """One language model call, as recorded (``specs/llm-telemetry``, design.md decisions 24, 27).

    The one table with two ownership shapes, resolved rather than shrugged at: ``user_id`` is
    nullable, ``is_internal`` is a *generated* column so no aggregate has to remember the rule, and
    the restricted role's read policy is owner-only — which makes an internal row invisible to every
    caller without a clause of its own, since ``NULL = anything`` is not true.

    It holds no prompt, no completion and no retrieved passage. That is what makes an administrative
    aggregate across users safe: a table with no content in it cannot disclose content.
    """

    __tablename__ = "llm_usage_events"
    __table_args__ = (
        CheckConstraint("status in ('success', 'failure')", name="ck_llm_usage_events_status"),
        CheckConstraint(
            "(status = 'failure') = (failure_class is not null)",
            name="ck_llm_usage_events_failure_class",
        ),
        CheckConstraint(
            "subject_kind <> 'user' or user_id is not null",
            name="ck_llm_usage_events_user_subject_has_owner",
        ),
        CheckConstraint(
            "(user_id is null or subject_kind = 'internal') = (plan is null)",
            name="ck_llm_usage_events_internal_has_no_plan",
        ),
        CheckConstraint(
            "prompt_tokens is null or completion_tokens is null or total_tokens is null "
            "or prompt_tokens + completion_tokens = total_tokens",
            name="ck_llm_usage_events_token_sum",
        ),
        CheckConstraint(
            "estimated_cost is null or total_tokens is not null",
            name="ck_llm_usage_events_cost_needs_tokens",
        ),
        CheckConstraint(
            "(estimated_cost is null) = (cost_currency is null)",
            name="ck_llm_usage_events_cost_currency_together",
        ),
        CheckConstraint(
            "retried_event_id is null or attempt >= 2", name="ck_llm_usage_events_retry_attempt"
        ),
        CheckConstraint(
            "retried_event_id is null or retried_event_id <> event_id",
            name="ck_llm_usage_events_no_self_retry",
        ),
        Index("ix_llm_usage_events_owner_time", USER_ID_COLUMN, "created_at"),
        Index("ix_llm_usage_events_internal_time", "is_internal", "created_at"),
        Index("ix_llm_usage_events_catalog_key", "catalog_key"),
        Index("ix_llm_usage_events_policy", "policy_id"),
        Index("ix_llm_usage_events_run", "agent_run_id"),
        {"info": {"ownership": Ownership.USER}},
    )

    event_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("profiles.user_id", ondelete="CASCADE"),
        nullable=True,
        doc="Null for a call with no principal. Never a placeholder.",
    )
    subject_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    is_internal: Mapped[bool] = mapped_column(
        Computed("user_id is null or subject_kind = 'internal'", persisted=True),
        nullable=False,
        doc="Decision 27's classification, generated so no aggregate can forget it.",
    )
    agent_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True
    )
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    catalog_key: Mapped[str] = mapped_column(
        String(120),
        ForeignKey("model_catalog.catalog_key", ondelete="RESTRICT"),
        nullable=False,
        doc="RESTRICT: disabling or replacing a model must not erase what it served.",
    )
    gateway_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    gateway_model: Mapped[str] = mapped_column(String(200), nullable=False)
    policy_id: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        doc="Not a foreign key: it may be the configured-fallback indicator, which is no policy.",
    )
    plan: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
        doc="Not a foreign key: history must outlive a plan being retired. Null on internal rows.",
    )
    call_role: Mapped[str] = mapped_column(String(16), nullable=False)

    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost: Mapped[Decimal | None] = mapped_column(
        Numeric(16, 8), nullable=True, doc="An estimate. Null when tokens are unknown, never zero."
    )
    cost_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    pricing_recorded_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    latency_ms: Mapped[float] = mapped_column(
        Float, nullable=False, doc="The gateway call itself, excluding the telemetry write."
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    failure_class: Mapped[str | None] = mapped_column(String(32), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    retried_event_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("llm_usage_events.event_id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


# =========================================================================== SaaS: lab and audit


class ModelEvaluation(Base):
    """One model's scored outcome for one evaluation run — the lab's comparable unit."""

    __tablename__ = "model_evaluations"
    __table_args__ = (
        Index("ix_model_evaluations_catalog_key", "catalog_key"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    catalog_key: Mapped[str] = mapped_column(
        String(120), ForeignKey("model_catalog.catalog_key", ondelete="RESTRICT"), nullable=False
    )
    gateway_model: Mapped[str] = mapped_column(
        String(200), nullable=False, doc="What actually served it, recorded rather than inferred."
    )
    evaluation_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("evaluation_runs.id", ondelete="CASCADE"), nullable=True
    )
    dataset_version: Mapped[str] = mapped_column(String(64), nullable=False)
    commit_sha: Mapped[str | None] = mapped_column(String(40), nullable=True)
    metrics: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    criteria: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False, default=dict)
    passed: Mapped[bool | None] = mapped_column(nullable=True)
    recorded_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


class ModelComparisonRun(Base):
    """One lab comparison, with the provenance that makes two runs comparable at all."""

    __tablename__ = "model_comparison_runs"
    __table_args__ = (
        CheckConstraint(
            "dataset_version is not null or question is not null",
            name="ck_model_comparison_runs_has_input",
        ),
        CheckConstraint(
            "status in ('running', 'completed', 'partial', 'failed')",
            name="ck_model_comparison_runs_status",
        ),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    initiated_by: Mapped[str] = mapped_column(
        UUID(as_uuid=False), nullable=False, doc="The administrative principal who ran it."
    )
    candidate_catalog_keys: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    dataset_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    question: Mapped[str | None] = mapped_column(
        Text, nullable=True, doc="The ad-hoc question, where the run was not a dataset run."
    )
    catalog_state: Mapped[dict[str, Any]] = mapped_column(
        JsonB, nullable=False, default=dict, doc="The catalog as it stood, so a rerun is checkable."
    )
    commit_sha: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    started_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = _timestamp_column(nullable=True)


class ModelComparisonResult(Base):
    """One model's outcome for one case within a comparison run."""

    __tablename__ = "model_comparison_results"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "catalog_key", "case_id", name="uq_model_comparison_results_cell"
        ),
        Index("ix_model_comparison_results_run", "run_id"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("model_comparison_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    catalog_key: Mapped[str] = mapped_column(
        String(120), ForeignKey("model_catalog.catalog_key", ondelete="RESTRICT"), nullable=False
    )
    gateway_model: Mapped[str] = mapped_column(String(200), nullable=False)
    case_id: Mapped[str] = mapped_column(String(120), nullable=False)
    policy_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, doc="The policy or lab context the cell ran under."
    )
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(16, 8), nullable=True)
    succeeded: Mapped[bool] = mapped_column(nullable=False)
    failure_class: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evaluation_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("model_evaluations.id", ondelete="SET NULL"), nullable=True
    )
    usage_event_ids: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, doc="The telemetry this cell produced."
    )
    agent_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("agent_runs.id", ondelete="SET NULL"),
        nullable=True,
        doc="Where the agent path ran, the run whose evidence record explains the answer.",
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


class AdminRole(Base):
    """Which Weathra roles a subject holds. The backend state `specs/authentication` requires.

    **A row, not a claim.** An earlier build read the administrative role from the validated
    token's ``app_metadata``, which is server-controlled at Supabase and was a reasonable stand-in
    while there was nothing to read it from. It is not what the spec asks for: the role is
    "held as backend state keyed by the validated token subject", and "an unverified token claim
    asserting the role SHALL be ignored". A claim travels with the caller; a row does not, and the
    difference is the whole security property — an identity provider misconfiguration, a token
    minted by a compromised project, or a claim copied between environments cannot promote anyone
    here.

    **Not a foreign key to ``profiles``.** The role is grantable before its holder has ever signed
    in, which is what makes bootstrapping the first administrator possible without inventing an
    account. Deleting a profile therefore leaves a role row behind; that is deliberate, because a
    role is an operational fact about a subject rather than part of their personal data, and a
    person deleting their account should not be able to silently drop their own administrative
    grant out of the audit trail.

    Read-only to the request path, and only for the acting subject: the grant and the policy in
    ``0011`` between them mean a caller can discover whether *they* are an administrator and can
    learn nothing else, and can write nothing at all.
    """

    __tablename__ = "admin_roles"
    __table_args__ = (
        CheckConstraint("length(role) > 0", name="ck_admin_roles_role_present"),
        Index("ix_admin_roles_role", "role"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    # `subject_id`, not `user_id`, and the name is the classification. An operational table with a
    # `user_id` is a table storing something *about* a person — a trail — which is the thing
    # `test_no_shared_or_operational_table_carries_a_user_column` exists to prevent. This stores an
    # authorization fact keyed by an auth subject, which is what `admin_audit.subject_id` and
    # `usage_counters.subject` already call the same thing.
    subject_id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), primary_key=True)
    granted_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        nullable=True,
        doc="The administrator who granted it. Null for the bootstrap grant, which has no "
        "administrator to attribute it to and says so rather than naming a fiction.",
    )
    granted_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)


class AdminAudit(Base):
    """Who changed which operational record, when, and from what to what.

    Every administrative write to the catalog, a policy, a plan, an allowance or a plan assignment
    lands here. ``cited_comparison_run_ids`` is what makes a model promotion traceable to the
    evidence it was promoted on (design.md decision 26) rather than to somebody's recollection.
    """

    __tablename__ = "admin_audit"
    __table_args__ = (
        Index("ix_admin_audit_subject", "subject_kind", "subject_id"),
        Index("ix_admin_audit_created_at", "created_at"),
        {"info": {"ownership": Ownership.OPERATIONAL}},
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    acting_principal: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    subject_kind: Mapped[str] = mapped_column(
        String(48), nullable=False, doc="What kind of record changed — a catalog entry, a plan."
    )
    subject_id: Mapped[str] = mapped_column(String(200), nullable=False)
    before: Mapped[dict[str, Any] | None] = mapped_column(JsonB, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JsonB, nullable=True)
    cited_comparison_run_ids: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list
    )
    created_at: Mapped[datetime] = _timestamp_column(server_default=func.now(), nullable=False)
