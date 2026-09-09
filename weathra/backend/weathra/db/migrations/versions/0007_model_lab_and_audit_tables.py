"""the lab's result tables and the administrative audit log

``model_evaluations``, ``model_comparison_runs``, ``model_comparison_results`` and ``admin_audit``
(design.md decisions 26 and 10). All four are operational: they belong to the project rather than
to a person, they are written by administrative and internal routines, and no ordinary request
reads or writes any of them.

**The access model is "nothing", stated twice.** ``weathra_request`` gets no grant at all, and Row
Level Security is enabled with no policy. Either alone would deny the restricted role; together
they close the two ways a denial has previously been lost on this project. The grant would be
enough on a stock PostgreSQL — and ``0004`` is the record of the grant *not* being enough on
Supabase, whose ``ensure_rls`` event trigger enables RLS on every table created in ``public``. The
RLS-with-no-policy state would be enough on Supabase, and would be nothing at all on a platform
without that trigger. So both, deliberately, rather than picking the one that happens to work here.

This is the opposite arrangement from ``0005``, and the difference is the point: those four tables
carry a read policy because a resolution genuinely reads them on the request path. These four carry
none because nothing on the request path has any business reading a comparison run's provenance or
the audit trail of who changed which model.

**``admin_audit`` is append-only by intent and not by constraint.** Nothing here prevents the
privileged owner from updating a row, because nothing can: the owner is the migration credential
and a constraint it can drop is not a control over it. The control is that no other role can reach
the table at all, and that the routines which write it only ever insert.

Revision ID: 0007_model_lab_and_audit_tables
Revises: 0006_saas_user_owned_tables
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007_model_lab_and_audit_tables"
down_revision: str | None = "0006_saas_user_owned_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESTRICTED_ROLE = "weathra_request"

# Created in dependency order; the downgrade walks it in reverse.
TABLES = (
    "model_evaluations",
    "model_comparison_runs",
    "model_comparison_results",
    "admin_audit",
)


def upgrade() -> None:
    # ------------------------------------------------------------------ model_evaluations
    op.create_table(
        "model_evaluations",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("catalog_key", sa.String(120), nullable=False),
        # Recorded rather than inferred from the catalog: the catalog's gateway string is mutable,
        # and a result has to keep saying what actually answered even after a rename.
        sa.Column("gateway_model", sa.String(200), nullable=False),
        sa.Column("evaluation_run_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("dataset_version", sa.String(64), nullable=False),
        sa.Column("commit_sha", sa.String(40), nullable=True),
        sa.Column(
            "metrics", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "criteria", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column(
            "recorded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["catalog_key"],
            ["model_catalog.catalog_key"],
            name="fk_model_evaluations_catalog",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["evaluation_run_id"],
            ["evaluation_runs.id"],
            name="fk_model_evaluations_run",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_model_evaluations_catalog_key", "model_evaluations", ["catalog_key"])

    # ------------------------------------------------------------------ model_comparison_runs
    op.create_table(
        "model_comparison_runs",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("initiated_by", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("candidate_catalog_keys", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("dataset_version", sa.String(64), nullable=True),
        sa.Column("question", sa.Text(), nullable=True),
        # The catalog as it stood when the run executed. Without it, a comparison read six months
        # later cannot tell whether two runs were scored against the same set of models.
        sa.Column(
            "catalog_state",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("commit_sha", sa.String(40), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="running"),
        sa.Column(
            "started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        # A comparison is driven by a dataset or by an ad-hoc question. Neither would make the run
        # unreproducible, which is the one thing provenance exists to prevent.
        sa.CheckConstraint(
            "dataset_version is not null or question is not null",
            name="ck_model_comparison_runs_has_input",
        ),
        sa.CheckConstraint(
            "cardinality(candidate_catalog_keys) > 0",
            name="ck_model_comparison_runs_has_candidate",
        ),
        sa.CheckConstraint(
            "status in ('running', 'completed', 'partial', 'failed')",
            name="ck_model_comparison_runs_status",
        ),
    )

    # ------------------------------------------------------------------ model_comparison_results
    op.create_table(
        "model_comparison_results",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("catalog_key", sa.String(120), nullable=False),
        sa.Column("gateway_model", sa.String(200), nullable=False),
        sa.Column("case_id", sa.String(120), nullable=False),
        sa.Column("policy_id", sa.String(64), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("estimated_cost", sa.Numeric(16, 8), nullable=True),
        sa.Column("succeeded", sa.Boolean(), nullable=False),
        sa.Column("failure_class", sa.String(32), nullable=True),
        sa.Column("evaluation_id", postgresql.UUID(as_uuid=False), nullable=True),
        # The telemetry this cell produced, so a cost or latency figure here can be traced to the
        # calls it was computed from rather than taken on trust.
        sa.Column(
            "usage_event_ids",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column("agent_run_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("evidence_ref", sa.String(120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["model_comparison_runs.id"],
            name="fk_model_comparison_results_run",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["catalog_key"],
            ["model_catalog.catalog_key"],
            name="fk_model_comparison_results_catalog",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["evaluation_id"],
            ["model_evaluations.id"],
            name="fk_model_comparison_results_evaluation",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_model_comparison_results_agent_run",
            ondelete="SET NULL",
        ),
        # One cell per model per case per run. A comparison that recorded a model twice for one
        # case would make every aggregate over it quietly wrong.
        sa.UniqueConstraint(
            "run_id", "catalog_key", "case_id", name="uq_model_comparison_results_cell"
        ),
        sa.CheckConstraint(
            "succeeded or failure_class is not null",
            name="ck_model_comparison_results_failure_classified",
        ),
    )
    op.create_index("ix_model_comparison_results_run", "model_comparison_results", ["run_id"])

    # ------------------------------------------------------------------ admin_audit
    op.create_table(
        "admin_audit",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("acting_principal", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("subject_kind", sa.String(48), nullable=False),
        sa.Column("subject_id", sa.String(200), nullable=False),
        sa.Column("before", postgresql.JSONB(), nullable=True),
        sa.Column("after", postgresql.JSONB(), nullable=True),
        # What a promotion was decided on. Decision 26 makes promotion a separate administrative
        # write citing the comparison runs that justified it, so the citation lives on the audit
        # row rather than in whoever remembers the conversation.
        sa.Column(
            "cited_comparison_run_ids",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # A change records what it changed. An audit row with neither side is a note, not a record.
        sa.CheckConstraint(
            "before is not null or after is not null", name="ck_admin_audit_records_a_change"
        ),
    )
    op.create_index("ix_admin_audit_subject", "admin_audit", ["subject_kind", "subject_id"])
    op.create_index("ix_admin_audit_created_at", "admin_audit", ["created_at"])

    # ------------------------------------------------------------------ denied to the request path
    #
    # No grant, and RLS on with no policy. See the module docstring for why both.
    for table in TABLES:
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_admin_audit_created_at", table_name="admin_audit")
    op.drop_index("ix_admin_audit_subject", table_name="admin_audit")
    op.drop_table("admin_audit")
    op.drop_index("ix_model_comparison_results_run", table_name="model_comparison_results")
    op.drop_table("model_comparison_results")
    op.drop_table("model_comparison_runs")
    op.drop_index("ix_model_evaluations_catalog_key", table_name="model_evaluations")
    op.drop_table("model_evaluations")
