"""initial schema, pgvector, and the chunk vector index

Creates every table in design.md decision 10, enables the ``vector`` extension, and adds the HNSW
index the knowledge retrieval path queries through. Row Level Security is established by the next
migration, so the policies are versioned separately from the shape they protect but still applied
by the same release step.

Index choice: HNSW with cosine distance. The corpus is small enough that build cost is irrelevant,
and recall matters more than write throughput (design.md decision 12).

Revision ID: 0001_initial_schema
Revises:
Create date: 2026-09-02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# JSONB on Postgres. Declared once so every column below reads the same.
JSONB = postgresql.JSONB(astext_type=sa.Text())

# Must match Settings.embedding_dimension. A mismatch between this and the configured model is
# refused at query time rather than compared across incompatible vectors (specs/rag-knowledge).
EMBEDDING_DIMENSION = 384


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # ------------------------------------------------------------------ user-owned

    op.create_table(
        "profiles",
        sa.Column(
            "user_id",
            sa.UUID(as_uuid=False),
            nullable=False,
            comment="The Supabase Auth subject. The ownership key for every user-owned table.",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_profiles"),
        comment=(
            "Application profile. Holds no credential and no contact data duplicated from Auth."
        ),
    )

    op.create_table(
        "preferences",
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("unit_system", sa.String(length=16), nullable=True),
        sa.Column("forecast_horizon_days", sa.Integer(), nullable=True),
        sa.Column("default_location_id", sa.String(length=64), nullable=True),
        sa.Column("default_location", JSONB, nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "unit_system in ('metric', 'imperial')", name="ck_preferences_unit_system"
        ),
        sa.CheckConstraint(
            "forecast_horizon_days is null or (forecast_horizon_days between 1 and 16)",
            name="ck_preferences_horizon",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.user_id"],
            name="fk_preferences_profile",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_preferences"),
        comment="Explicitly chosen, non-sensitive preferences. Never inferred from behavior.",
    )

    op.create_table(
        "saved_locations",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("location_id", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("location", JSONB, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.user_id"],
            name="fk_saved_locations_profile",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_saved_locations"),
        sa.UniqueConstraint("user_id", "location_id", name="uq_saved_locations_user_location"),
        comment="Canonical resolved locations a person kept, so they need no re-resolving.",
    )
    op.create_index("ix_saved_locations_user", "saved_locations", ["user_id"])

    op.create_table(
        "threads",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column(
            "resolved_entities",
            JSONB,
            nullable=False,
            comment=(
                "Locations, units, window, criterion, last data class — the follow-up "
                "projection a follow-up question resolves against."
            ),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_activity_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["profiles.user_id"], name="fk_threads_profile", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_threads"),
        comment=(
            "The thread rows Weathra owns beside the checkpointer's own state. The gate the API "
            "checks before the graph is invoked."
        ),
    )
    op.create_index("ix_threads_user", "threads", ["user_id"])
    op.create_index("ix_threads_expires_at", "threads", ["expires_at"])

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("thread_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer_prose", sa.Text(), nullable=True),
        sa.Column("envelope", JSONB, nullable=False),
        sa.Column("evidence", JSONB, nullable=False),
        sa.Column("llm_provider", sa.String(length=64), nullable=True),
        sa.Column("llm_model", sa.String(length=200), nullable=True),
        sa.Column("weather_provider", sa.String(length=64), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=False),
        sa.Column("partial", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["profiles.user_id"], name="fk_agent_runs_profile", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["threads.id"], name="fk_agent_runs_thread", ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_runs"),
        comment="One answered question with its evidence record, owned by the acting user.",
    )
    op.create_index("ix_agent_runs_user", "agent_runs", ["user_id"])
    op.create_index("ix_agent_runs_thread", "agent_runs", ["thread_id"])

    # ------------------------------------------------------------------ shared

    op.create_table(
        "forecast_snapshots",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("location_id", sa.String(length=64), nullable=False),
        sa.Column("location", JSONB, nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("unit_system", sa.String(length=16), nullable=False),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("daily_series", JSONB, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_forecast_snapshots"),
        comment=(
            "Shared by design: no user column. A forecast for Berlin is not private, and keying "
            "by location avoids storing a browsing trail while giving What Changed? far better "
            "coverage — one person's request improves everyone's history."
        ),
    )
    op.create_index(
        "ix_forecast_snapshots_lookup",
        "forecast_snapshots",
        ["location_id", "window_start", "window_end", "provider", "retrieved_at"],
    )

    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.String(length=120), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("topic", sa.String(length=120), nullable=False),
        sa.Column("provenance", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "ingested_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_knowledge_documents"),
        comment="Curated conceptual corpus. Shared and read-only to users.",
    )

    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("document_id", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("heading", sa.String(length=300), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column(
            "embedding_model",
            sa.String(length=200),
            nullable=False,
            comment=("Recorded beside the vector so a mismatched query is refused, not compared."),
        ),
        sa.Column("embedding_dimension", sa.Integer(), nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSION), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["knowledge_documents.id"],
            name="fk_knowledge_chunks_document",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_knowledge_chunks"),
        sa.UniqueConstraint(
            "document_id", "position", name="uq_knowledge_chunks_document_position"
        ),
    )
    op.create_index(
        "ix_knowledge_chunks_embedding_hnsw",
        "knowledge_chunks",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )

    # ------------------------------------------------------------------ operational

    op.create_table(
        "evaluation_runs",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("dataset_version", sa.String(length=64), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("llm_provider", sa.String(length=64), nullable=True),
        sa.Column("llm_model", sa.String(length=200), nullable=True),
        sa.Column("weather_provider", sa.String(length=64), nullable=False),
        sa.Column("embedding_model", sa.String(length=200), nullable=False),
        sa.Column("commit_sha", sa.String(length=40), nullable=True),
        sa.Column(
            "test_user_id",
            sa.UUID(as_uuid=False),
            nullable=True,
            comment="The evaluation test identity. Never its credential.",
        ),
        sa.Column("category_filter", sa.String(length=64), nullable=True),
        sa.Column("case_filter", sa.String(length=120), nullable=True),
        sa.Column("metrics", JSONB, nullable=False),
        sa.Column("thresholds", JSONB, nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("mode in ('offline', 'live')", name="ck_evaluation_runs_mode"),
        sa.PrimaryKeyConstraint("id", name="pk_evaluation_runs"),
        comment="Operational, not user-owned: an evaluation run belongs to the project.",
    )

    op.create_table(
        "evaluation_case_results",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("case_id", sa.String(length=120), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("evidence", JSONB, nullable=False),
        sa.Column("per_metric", JSONB, nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["evaluation_runs.id"],
            name="fk_evaluation_case_results_run",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_evaluation_case_results"),
        sa.UniqueConstraint("run_id", "case_id", name="uq_evaluation_case_results_run_case"),
    )


def downgrade() -> None:
    op.drop_table("evaluation_case_results")
    op.drop_table("evaluation_runs")
    op.drop_index("ix_knowledge_chunks_embedding_hnsw", table_name="knowledge_chunks")
    op.drop_table("knowledge_chunks")
    op.drop_table("knowledge_documents")
    op.drop_index("ix_forecast_snapshots_lookup", table_name="forecast_snapshots")
    op.drop_table("forecast_snapshots")
    op.drop_index("ix_agent_runs_thread", table_name="agent_runs")
    op.drop_index("ix_agent_runs_user", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index("ix_threads_expires_at", table_name="threads")
    op.drop_index("ix_threads_user", table_name="threads")
    op.drop_table("threads")
    op.drop_index("ix_saved_locations_user", table_name="saved_locations")
    op.drop_table("saved_locations")
    op.drop_table("preferences")
    op.drop_table("profiles")
    # The extension was created by this migration, so a clean downgrade removes it. RESTRICT rather
    # than CASCADE: if something outside this schema depends on it, that is worth failing on.
    op.execute("DROP EXTENSION IF EXISTS vector RESTRICT")
