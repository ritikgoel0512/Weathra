"""the model policy layer's operational tables

The four tables a resolution reads (design.md decisions 22, 23 and 25): which plans exist, which
models we are allowed to use, which ordered candidate list each policy declares, and how much of
each dimension a plan allows. None of them is user-owned — they are read to serve a request and
written only through the administrative path, so an owner predicate on them would have nothing to
compare against.

**Why the constraints are here rather than only in Python.** ``specs/model-catalog`` requires a
duplicate catalog key, a duplicate gateway provider-and-model pair, a missing or negative price, a
non-positive context window, and an entry declaring no capability role to be refused. A validator
in the administrative handler would refuse them from the handler; a constraint refuses them from
the seed migration, from a hand-written ``UPDATE`` during an incident, and from the handler, which
is the difference between a rule and a guarantee. The same applies to the allowance: a negative one
is refused by the table.

**The plan code is pinned to the canonical three.** ``free``, ``pro``, ``premium`` and nothing else.
This is deliberately stricter than "plans are data": a plan's *allowances* and *policy mappings*
change without a code change, which is what ``specs/usage-limits`` actually requires, but the set of
plan codes reaches recorded usage events, `user_plans` rows, support conversations and — later — an
external billing product. A fourth tier should be a migration somebody wrote on purpose. It also
makes one thing structurally true rather than merely tested: **there is no `plus` tier**, and none
can be introduced by an ``INSERT``. An earlier draft of the specs named the middle tier that way;
the product decision of 2026-09-09 settled on Free / Pro / Premium, the specs were reconciled, and
no alias exists in either direction.

**Row Level Security is enabled with an explicit read policy**, following ``0004``'s lesson rather
than repeating its bug: Supabase's ``ensure_rls`` event trigger turns RLS on for every table created
in ``public``, and RLS enabled with no policy denies every row to ``weathra_request``. So each table
states its access instead of relying on a grant that a platform default would silently defeat. Not
``FORCE``: the owner is the privileged connection that seeds and administers these rows, and it
legitimately touches all of them.

Revision ID: 0005_saas_operational_tables
Revises: 0004_shared_read_policies
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_saas_operational_tables"
down_revision: str | None = "0004_shared_read_policies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# The canonical product tiers, ascending. Mirrors weathra.domain.entitlements.PlanCode, and a test
# asserts the two agree so the enum and the constraint cannot drift.
PLAN_CODES = ("free", "pro", "premium")

# Mirrors weathra.domain.entitlements.CallRole.
CALL_ROLES = ("routing", "synthesis", "lab")

# Mirrors weathra.domain.usage.QuotaDimension and QuotaWindow. The column holding a window is
# named `window_kind` and not `window`, because WINDOW is a reserved word in PostgreSQL and a
# bare `window` in a CHECK expression is a syntax error — quoting it at every use site would be a
# permanent papercut in exchange for one word.
QUOTA_DIMENSIONS = (
    "requests_per_day",
    "requests_per_month",
    "tokens_per_month",
    "concurrent_runs",
    "estimated_cost_per_month",
)
QUOTA_WINDOWS = ("day", "month", "concurrent")

# Which window each dimension is counted over. Enforced by the table so an incoherent allowance —
# a daily request limit recorded against a monthly window — cannot be written at all.
DIMENSION_WINDOW = {
    "requests_per_day": "day",
    "requests_per_month": "month",
    "tokens_per_month": "month",
    "concurrent_runs": "concurrent",
    "estimated_cost_per_month": "month",
}

# Every table this migration owns, newest-dependency-last so the downgrade can walk it in reverse.
TABLES = ("subscription_plans", "model_catalog", "model_policies", "usage_limits")


def _in_list(column: str, values: Sequence[str]) -> str:
    rendered = ", ".join(f"'{value}'" for value in values)
    return f"{column} in ({rendered})"


def _subset_of(column: str, values: Sequence[str]) -> str:
    """A text[] whose every element is one of *values*, and which is not empty."""
    rendered = ", ".join(f"'{value}'" for value in values)
    return f"cardinality({column}) > 0 and {column} <@ array[{rendered}]::text[]"


def upgrade() -> None:
    # ------------------------------------------------------------------ subscription_plans
    op.create_table(
        "subscription_plans",
        sa.Column("plan_code", sa.String(32), primary_key=True),
        sa.Column("display_name", sa.String(64), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column(
            "policy_by_call_role",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        # Stays null in this change. `specs/usage-limits` asks for somewhere a later billing
        # integration can land, and explicitly for nothing to depend on it being populated.
        sa.Column("external_subscription_ref", sa.String(200), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("rank", name="uq_subscription_plans_rank"),
        sa.CheckConstraint(
            _in_list("plan_code", PLAN_CODES), name="ck_subscription_plans_canonical_code"
        ),
        sa.CheckConstraint("rank >= 0", name="ck_subscription_plans_rank_non_negative"),
        # Every key in the mapping must name a call role we have. A mapping keyed by a role that
        # does not exist resolves to nothing at request time, which reads as "no policy" and is
        # much harder to diagnose than a refused write.
        #
        # Expressed as "delete the known keys and nothing is left" because a CHECK constraint may
        # not contain a subquery, which rules out the obvious `select jsonb_object_keys(...)`.
        sa.CheckConstraint(
            "policy_by_call_role - array["
            + ", ".join(f"'{role}'" for role in CALL_ROLES)
            + "]::text[] = '{}'::jsonb",
            name="ck_subscription_plans_known_call_roles",
        ),
    )

    # ------------------------------------------------------------------ model_catalog
    op.create_table(
        "model_catalog",
        sa.Column("catalog_key", sa.String(120), primary_key=True),
        sa.Column("gateway_provider", sa.String(64), nullable=False),
        sa.Column("gateway_model", sa.String(200), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("capability_roles", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("capability_tier", sa.String(32), nullable=False),
        sa.Column("supports_structured_output", sa.Boolean(), nullable=False),
        sa.Column("context_window", sa.Integer(), nullable=False),
        sa.Column("input_price_per_million", sa.Numeric(14, 6), nullable=False),
        sa.Column("output_price_per_million", sa.Numeric(14, 6), nullable=False),
        sa.Column("price_currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("pricing_recorded_on", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="enabled"),
        sa.Column("is_free_tier", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # The gateway identity is unique as a pair: two catalog keys pointing at the same upstream
        # model would make "which one served this" unanswerable from a usage event.
        sa.UniqueConstraint(
            "gateway_provider", "gateway_model", name="uq_model_catalog_gateway_identity"
        ),
        sa.CheckConstraint("context_window > 0", name="ck_model_catalog_context_window"),
        sa.CheckConstraint(
            "input_price_per_million >= 0 and output_price_per_million >= 0",
            name="ck_model_catalog_prices_non_negative",
        ),
        sa.CheckConstraint(
            _subset_of("capability_roles", CALL_ROLES), name="ck_model_catalog_capability_roles"
        ),
        sa.CheckConstraint(
            _in_list("capability_tier", ("economy", "standard", "frontier")),
            name="ck_model_catalog_capability_tier",
        ),
        sa.CheckConstraint(
            _in_list("status", ("enabled", "disabled")), name="ck_model_catalog_status"
        ),
        sa.CheckConstraint("length(price_currency) = 3", name="ck_model_catalog_currency"),
    )
    op.create_index("ix_model_catalog_status", "model_catalog", ["status"])

    # ------------------------------------------------------------------ model_policies
    op.create_table(
        "model_policies",
        sa.Column("policy_id", sa.String(64), primary_key=True),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("candidate_catalog_keys", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("applicable_call_roles", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("eligibility", sa.String(32), nullable=False),
        sa.Column("fallback_policy_id", sa.String(64), nullable=True),
        sa.Column("failover_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["fallback_policy_id"],
            ["model_policies.policy_id"],
            name="fk_model_policies_fallback",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "cardinality(candidate_catalog_keys) > 0", name="ck_model_policies_has_candidate"
        ),
        sa.CheckConstraint(
            _subset_of("applicable_call_roles", CALL_ROLES), name="ck_model_policies_call_roles"
        ),
        sa.CheckConstraint(
            _in_list("eligibility", ("public", "plan", "administrative", "internal_evaluation")),
            name="ck_model_policies_eligibility",
        ),
        # A policy that falls back to itself would loop; a policy id is the natural thing to paste
        # into the wrong column, so the table refuses it rather than the resolver having to.
        sa.CheckConstraint(
            "fallback_policy_id is null or fallback_policy_id <> policy_id",
            name="ck_model_policies_no_self_fallback",
        ),
        # A pinned policy is pinned: exactly one candidate and no fallback, or failover is on.
        # This is what makes `specs/evaluation`'s "no candidate other than the pinned model is
        # attempted for any reason" a property of the row rather than of the resolver.
        sa.CheckConstraint(
            "failover_enabled "
            "or (cardinality(candidate_catalog_keys) = 1 and fallback_policy_id is null)",
            name="ck_model_policies_pinned_is_singular",
        ),
    )

    # ------------------------------------------------------------------ usage_limits
    op.create_table(
        "usage_limits",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("plan_code", sa.String(32), nullable=True),
        sa.Column("internal_subject", sa.String(64), nullable=True),
        sa.Column("dimension", sa.String(48), nullable=False),
        sa.Column("window_kind", sa.String(16), nullable=False),
        sa.Column("allowance", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["plan_code"],
            ["subscription_plans.plan_code"],
            name="fk_usage_limits_plan",
            ondelete="CASCADE",
        ),
        # An allowance belongs to a plan or to the internal subject, never to both and never to
        # neither — the whole point of the internal allowance is that it is not a plan's.
        sa.CheckConstraint(
            "(plan_code is null) <> (internal_subject is null)",
            name="ck_usage_limits_exactly_one_subject",
        ),
        sa.CheckConstraint("allowance >= 0", name="ck_usage_limits_allowance_non_negative"),
        sa.CheckConstraint(
            _in_list("dimension", QUOTA_DIMENSIONS), name="ck_usage_limits_dimension"
        ),
        sa.CheckConstraint(_in_list("window_kind", QUOTA_WINDOWS), name="ck_usage_limits_window"),
        sa.CheckConstraint(
            " or ".join(
                f"(dimension = '{dimension}' and window_kind = '{window}')"
                for dimension, window in DIMENSION_WINDOW.items()
            ),
            name="ck_usage_limits_window_matches_dimension",
        ),
    )
    # Partial unique indexes rather than a table-level constraint: one of the two subject columns
    # is always NULL, and PostgreSQL does not consider two rows with a NULL to be duplicates, so a
    # plain UNIQUE(plan_code, dimension) would let the internal allowance be recorded twice.
    op.create_index(
        "uq_usage_limits_plan_dimension",
        "usage_limits",
        ["plan_code", "dimension"],
        unique=True,
        postgresql_where=sa.text("plan_code is not null"),
    )
    op.create_index(
        "uq_usage_limits_internal_dimension",
        "usage_limits",
        ["internal_subject", "dimension"],
        unique=True,
        postgresql_where=sa.text("internal_subject is not null"),
    )

    # ------------------------------------------------------------------ access
    #
    # Read-only to the request path, every table. The resolver reads the plan, its policy and the
    # catalog on the way to a model; the quota accountant reads the allowance. Nothing on the
    # request path writes any of them — administration is a privileged write recorded in
    # `admin_audit`, which is why no INSERT, UPDATE or DELETE is granted here.
    for table in TABLES:
        op.execute(f"GRANT SELECT ON {table} TO {RESTRICTED_ROLE}")
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY {table}_request_read ON {table}
            FOR SELECT
            TO {RESTRICTED_ROLE}
            USING (true)
            """
        )


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f"DROP POLICY IF EXISTS {table}_request_read ON {table}")
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")

    op.drop_index("uq_usage_limits_internal_dimension", table_name="usage_limits")
    op.drop_index("uq_usage_limits_plan_dimension", table_name="usage_limits")
    op.drop_table("usage_limits")
    op.drop_table("model_policies")
    op.drop_index("ix_model_catalog_status", table_name="model_catalog")
    op.drop_table("model_catalog")
    op.drop_table("subscription_plans")
