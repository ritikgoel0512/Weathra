"""the three user-owned SaaS tables, with their Row Level Security in the same migration

``user_plans``, ``usage_counters`` and ``llm_usage_events``. They follow ``0002``'s pattern — RLS
enabled, ``FORCE``d so the policies bind even where migrations and requests share a database user,
and an owner-restricting policy per table — and they depart from it in three places that are the
substance of this migration rather than exceptions to it.

**1. ``user_plans`` is readable and not writable, and that is a security property, not a tidiness
one.** ``0002``'s policies are ``FOR ALL`` with ``USING`` and ``WITH CHECK``, which is right for a
saved location: a caller may create their own and may not touch anyone else's. Writing the same
policy here would let a caller ``INSERT`` their own row naming ``premium`` — and it would pass,
because it *is* their row. ``specs/model-policy`` requires entitlement to be something the backend
establishes rather than something a caller can assert, so the request role gets ``SELECT`` and
nothing else, the policy is ``FOR SELECT``, and assignment is an administrative write on the
privileged connection.

**2. ``usage_counters`` is keyed by ``subject``, not ``user_id``.** Internal traffic — the lab,
evaluation runs, administrative work — is accounted against a reserved non-UUID subject
(design.md decision 25), so the column holds either an auth subject or the literal ``internal``.
The owner policy compares ``subject`` against the acting user's id, which means the internal rows
are denied to every caller by arithmetic rather than by a clause: no UUID equals ``internal``.

**3. ``llm_usage_events`` has two ownership shapes and gets two policies** (design.md decision 27).
Reading is owner-only, so an internal row — whose ``user_id`` is null — is invisible to every
caller, since ``NULL = anything`` is not true. Writing is owner-only *plus* the anonymous case:
``specs/llm-telemetry`` requires a call made with no principal to be recorded with a null user id
and never a placeholder, and a session that binds no claims must therefore be able to write exactly
that row and no other. The administrative aggregate is a separate privileged read that returns
counts and sums rather than rows, which is safe precisely because this table holds no content.

**Retention and deletion.** ``llm_usage_events.user_id`` cascades from ``profiles``, so account
deletion removes a person's raw events alongside their threads and preferences without a second
routine remembering to. ``catalog_key`` is ``RESTRICT`` in the other direction: disabling or
replacing a model must not erase what it served.

Revision ID: 0006_saas_user_owned_tables
Revises: 0005_saas_operational_tables
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_saas_user_owned_tables"
down_revision: str | None = "0005_saas_operational_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# The accessor 0002 created. Every policy below tests the same function, so the claims binding the
# request-scoped session performs is the single source of "who is acting".
CURRENT_USER = "weathra_current_user_id()"

# The user-owned tables *this* migration adds. 0002 owns the original five and is left untouched:
# `weathra.db.models.user_owned_tables()` now returns all eight, and the correspondence a reader
# should check is between the models and the union of the two migrations, not either one alone.
USER_OWNED_TABLES = ("user_plans", "usage_counters", "llm_usage_events")

CALL_ROLES = ("routing", "synthesis", "lab")
QUOTA_DIMENSIONS = (
    "requests_per_day",
    "requests_per_month",
    "tokens_per_month",
    "concurrent_runs",
    "estimated_cost_per_month",
)
FAILURE_CLASSES = (
    "transport",
    "timeout",
    "gateway_rate_limit",
    "auth_config",
    "schema_validation",
    "unclassified",
)


def _in_list(column: str, values: Sequence[str]) -> str:
    rendered = ", ".join(f"'{value}'" for value in values)
    return f"{column} in ({rendered})"


def upgrade() -> None:
    # ------------------------------------------------------------------ user_plans
    op.create_table(
        "user_plans",
        sa.Column("user_id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("plan_code", sa.String(32), nullable=False),
        # Null where the row was seeded or migrated rather than assigned by a person.
        sa.Column("assigned_by", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column(
            "assigned_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["profiles.user_id"], name="fk_user_plans_profile", ondelete="CASCADE"
        ),
        # RESTRICT rather than CASCADE: removing a plan that people are on should fail loudly
        # rather than silently dropping their assignment and defaulting them to Free.
        sa.ForeignKeyConstraint(
            ["plan_code"],
            ["subscription_plans.plan_code"],
            name="fk_user_plans_plan",
            ondelete="RESTRICT",
        ),
    )
    op.create_index("ix_user_plans_plan_code", "user_plans", ["plan_code"])

    # ------------------------------------------------------------------ usage_counters
    op.create_table(
        "usage_counters",
        # The composite key *is* the concurrency control: admission is one INSERT ... ON CONFLICT
        # ... DO UPDATE ... WHERE consumed < allowance, and this is what it conflicts on. A
        # surrogate id would leave that statement with no conflict target (decision 25).
        sa.Column("subject", sa.String(64), primary_key=True),
        sa.Column("dimension", sa.String(48), primary_key=True),
        sa.Column("window_key", sa.String(32), primary_key=True),
        sa.Column("consumed", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("consumed >= 0", name="ck_usage_counters_consumed_non_negative"),
        sa.CheckConstraint("length(window_key) > 0", name="ck_usage_counters_window_key_present"),
        sa.CheckConstraint(
            _in_list("dimension", QUOTA_DIMENSIONS), name="ck_usage_counters_dimension"
        ),
    )
    op.create_index("ix_usage_counters_window", "usage_counters", ["dimension", "window_key"])

    # ------------------------------------------------------------------ llm_usage_events
    op.create_table(
        "llm_usage_events",
        sa.Column("event_id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("subject_kind", sa.String(16), nullable=False, server_default="user"),
        # Decision 27's classification, generated so that every aggregate splits product from
        # internal usage without each query remembering the rule.
        sa.Column(
            "is_internal",
            sa.Boolean(),
            sa.Computed("user_id is null or subject_kind = 'internal'", persisted=True),
            nullable=False,
        ),
        sa.Column("agent_run_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("catalog_key", sa.String(120), nullable=False),
        sa.Column("gateway_provider", sa.String(64), nullable=False),
        sa.Column("gateway_model", sa.String(200), nullable=False),
        # Deliberately not a foreign key: it may hold the configured-fallback indicator, which is
        # not a policy, and a retired policy must not erase the history of what it resolved.
        sa.Column("policy_id", sa.String(64), nullable=False),
        # Likewise not a foreign key: history outlives a plan being retired, and it is null on an
        # internal row, where the internal classification stands in its place.
        sa.Column("plan", sa.String(32), nullable=True),
        sa.Column("call_role", sa.String(16), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("estimated_cost", sa.Numeric(16, 8), nullable=True),
        sa.Column("cost_currency", sa.String(3), nullable=True),
        sa.Column("pricing_recorded_on", sa.Date(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("failure_class", sa.String(32), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("retried_event_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.user_id"],
            name="fk_llm_usage_events_profile",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_llm_usage_events_agent_run",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["catalog_key"],
            ["model_catalog.catalog_key"],
            name="fk_llm_usage_events_catalog",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["retried_event_id"],
            ["llm_usage_events.event_id"],
            name="fk_llm_usage_events_retried",
            ondelete="SET NULL",
        ),
        # ---- the coherence rules, mirroring weathra.domain.usage.UsageEvent's validators ----
        #
        # Each of these is here because the wrong version of it is plausible rather than absurd,
        # and because a usage event is written on a background task outside the answer path: a
        # malformed one raises nothing at the call site and surfaces weeks later as an aggregate
        # nobody can explain.
        sa.CheckConstraint(
            _in_list("status", ("success", "failure")), name="ck_llm_usage_events_status"
        ),
        sa.CheckConstraint(
            _in_list("subject_kind", ("user", "internal")), name="ck_llm_usage_events_subject_kind"
        ),
        sa.CheckConstraint(_in_list("call_role", CALL_ROLES), name="ck_llm_usage_events_call_role"),
        sa.CheckConstraint(
            f"failure_class is null or {_in_list('failure_class', FAILURE_CLASSES)}",
            name="ck_llm_usage_events_failure_class_known",
        ),
        # A failure is classified and a success is not. "It failed somehow" is `unclassified`,
        # which says so explicitly rather than by leaving the column empty.
        sa.CheckConstraint(
            "(status = 'failure') = (failure_class is not null)",
            name="ck_llm_usage_events_failure_class",
        ),
        # An event with no principal is internal, not a user event with a missing owner.
        sa.CheckConstraint(
            "subject_kind <> 'user' or user_id is not null",
            name="ck_llm_usage_events_user_subject_has_owner",
        ),
        # Internal usage is never attributed to a product plan, and product usage always records
        # the plan in effect. Written from the base columns rather than from `is_internal`, so the
        # constraint does not depend on the generated column's evaluation order.
        sa.CheckConstraint(
            "(user_id is null or subject_kind = 'internal') = (plan is null)",
            name="ck_llm_usage_events_internal_has_no_plan",
        ),
        sa.CheckConstraint(
            "prompt_tokens is null or prompt_tokens >= 0", name="ck_llm_usage_events_prompt_tokens"
        ),
        sa.CheckConstraint(
            "completion_tokens is null or completion_tokens >= 0",
            name="ck_llm_usage_events_completion_tokens",
        ),
        sa.CheckConstraint(
            "total_tokens is null or total_tokens >= 0", name="ck_llm_usage_events_total_tokens"
        ),
        sa.CheckConstraint(
            "prompt_tokens is null or completion_tokens is null or total_tokens is null "
            "or prompt_tokens + completion_tokens = total_tokens",
            name="ck_llm_usage_events_token_sum",
        ),
        # Null is a measurement and zero is a claim: where the gateway reported no token counts,
        # there is no basis for a cost and the column stays null.
        sa.CheckConstraint(
            "estimated_cost is null or total_tokens is not null",
            name="ck_llm_usage_events_cost_needs_tokens",
        ),
        sa.CheckConstraint(
            "estimated_cost is null or estimated_cost >= 0", name="ck_llm_usage_events_cost_sign"
        ),
        sa.CheckConstraint(
            "(estimated_cost is null) = (cost_currency is null)",
            name="ck_llm_usage_events_cost_currency_together",
        ),
        sa.CheckConstraint("latency_ms >= 0", name="ck_llm_usage_events_latency"),
        sa.CheckConstraint("attempt >= 1", name="ck_llm_usage_events_attempt"),
        sa.CheckConstraint(
            "retried_event_id is null or attempt >= 2", name="ck_llm_usage_events_retry_attempt"
        ),
        sa.CheckConstraint(
            "retried_event_id is null or retried_event_id <> event_id",
            name="ck_llm_usage_events_no_self_retry",
        ),
    )
    op.create_index("ix_llm_usage_events_owner_time", "llm_usage_events", ["user_id", "created_at"])
    op.create_index(
        "ix_llm_usage_events_internal_time", "llm_usage_events", ["is_internal", "created_at"]
    )
    op.create_index("ix_llm_usage_events_catalog_key", "llm_usage_events", ["catalog_key"])
    op.create_index("ix_llm_usage_events_policy", "llm_usage_events", ["policy_id"])
    op.create_index("ix_llm_usage_events_run", "llm_usage_events", ["agent_run_id"])

    # ------------------------------------------------------------------ access and policies
    for table in USER_OWNED_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # FORCE for 0002's reason: on a managed Postgres the migration and request credentials can
        # be the same database user, and a table's owner is otherwise exempt from its own policies.
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    # `user_plans` — read your own, write nothing. The grant and the policy say the same thing
    # twice on purpose: either alone would be enough, and neither alone is worth relying on for
    # the one table where a permissive write is a self-service upgrade.
    op.execute(f"GRANT SELECT ON user_plans TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY user_plans_owner_read ON user_plans
        FOR SELECT
        TO {RESTRICTED_ROLE}
        USING (user_id::text = {CURRENT_USER})
        """
    )

    # `usage_counters` — the request path reads and upserts its own subject's rows. No DELETE:
    # retention removes closed windows under the privileged connection.
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON usage_counters TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY usage_counters_owner_only ON usage_counters
        FOR ALL
        TO {RESTRICTED_ROLE}
        USING (subject = {CURRENT_USER})
        WITH CHECK (subject = {CURRENT_USER})
        """
    )

    # `llm_usage_events` — owner-only reads, and appends only. An event is never updated or
    # deleted on the request path: it is a record of something that already happened.
    op.execute(f"GRANT SELECT, INSERT ON llm_usage_events TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY llm_usage_events_owner_read ON llm_usage_events
        FOR SELECT
        TO {RESTRICTED_ROLE}
        USING (user_id::text = {CURRENT_USER})
        """
    )
    # The write policy admits one row shape the read policy deliberately does not return: an
    # anonymous call's event, whose user id is null. `specs/llm-telemetry` requires such a call to
    # be recorded with a null subject and never a placeholder, and a session that binds no claims
    # must be able to write exactly that and nothing else — it cannot name another user, because
    # `weathra_current_user_id()` is null for it and no user id equals null.
    op.execute(
        f"""
        CREATE POLICY llm_usage_events_owner_append ON llm_usage_events
        FOR INSERT
        TO {RESTRICTED_ROLE}
        WITH CHECK (
            user_id::text = {CURRENT_USER}
            OR (user_id IS NULL AND {CURRENT_USER} IS NULL)
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS llm_usage_events_owner_append ON llm_usage_events")
    op.execute("DROP POLICY IF EXISTS llm_usage_events_owner_read ON llm_usage_events")
    op.execute("DROP POLICY IF EXISTS usage_counters_owner_only ON usage_counters")
    op.execute("DROP POLICY IF EXISTS user_plans_owner_read ON user_plans")
    for table in USER_OWNED_TABLES:
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")

    op.drop_table("llm_usage_events")
    op.drop_table("usage_counters")
    op.drop_table("user_plans")
