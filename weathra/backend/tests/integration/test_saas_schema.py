"""Tasks 26.2 and 26.4 — the SaaS tables as PostgreSQL actually built them.

Two halves, and the difference between them is the substance:

* **26.2, the operational policy tables.** Every rejection ``specs/model-catalog`` requires is
  asserted against the *database*, not against a Python validator. A validator refuses a bad row
  from the handler it lives in; a constraint refuses it from the handler, from the seed migration,
  and from a hand-written ``UPDATE`` at two in the morning. Only the second is a guarantee.
* **26.4, the lab and audit tables.** The request-serving role must be able to do nothing at all
  with them, which is asserted by trying — both directions, read and write, as an ordinary user.

Columns, types, constraints, indexes and foreign keys are read out of the catalog rather than
assumed from the model definitions, because the model definitions are not what gets deployed: the
migrations are, and a column present in one and absent from the other is exactly the drift worth
catching here.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import insert_profile, new_user_id, session_as
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.usage import QuotaDimension, QuotaWindow

pytestmark = pytest.mark.db

OPERATIONAL_POLICY_TABLES = (
    "subscription_plans",
    "model_catalog",
    "model_policies",
    "usage_limits",
)
USER_OWNED_SAAS_TABLES = ("user_plans", "usage_counters", "llm_usage_events")
LAB_AND_AUDIT_TABLES = (
    "model_evaluations",
    "model_comparison_runs",
    "model_comparison_results",
    "admin_audit",
)

RESTRICTED_ROLE = "weathra_request"


async def _rejects(engines: Engines, statement: str, params: dict[str, object]) -> str:
    """Run *statement* privileged and return the error PostgreSQL raised.

    Its own session per attempt: a failed statement aborts its transaction, so sharing one would
    make every assertion after the first fail for the wrong reason.
    """
    with pytest.raises(DBAPIError) as caught:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(text(statement), params)
    return str(caught.value)


# =========================================================================== 26.2 the tables exist


async def test_every_saas_table_exists_after_migration(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    )
    present = {row[0] for row in rows}
    expected = set(OPERATIONAL_POLICY_TABLES + USER_OWNED_SAAS_TABLES + LAB_AND_AUDIT_TABLES)
    assert expected <= present, f"missing: {sorted(expected - present)}"


async def test_the_catalog_declares_every_column_the_spec_requires(
    privileged: AsyncSession,
) -> None:
    """`specs/model-catalog`'s "at minimum" list, transcribed and checked against the built table."""
    rows = await privileged.execute(
        text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'model_catalog'"
        )
    )
    columns = {row[0]: (row[1], row[2]) for row in rows}

    required = {
        "catalog_key": "character varying",
        "gateway_provider": "character varying",
        "gateway_model": "character varying",
        "display_name": "character varying",
        "capability_roles": "ARRAY",
        "capability_tier": "character varying",
        "supports_structured_output": "boolean",
        "context_window": "integer",
        "input_price_per_million": "numeric",
        "output_price_per_million": "numeric",
        "price_currency": "character varying",
        "pricing_recorded_on": "date",
        "status": "character varying",
        "is_free_tier": "boolean",
    }
    for name, data_type in required.items():
        assert name in columns, f"model_catalog has no {name}"
        assert columns[name][0] == data_type, f"model_catalog.{name} is {columns[name][0]}"
        assert columns[name][1] == "NO", f"model_catalog.{name} must not be nullable"


async def test_the_usage_event_records_every_provenance_field(privileged: AsyncSession) -> None:
    """`specs/llm-telemetry`'s field table. Provenance is the point of the row: which model, under
    which policy, for which plan and role, and what it cost."""
    rows = await privileged.execute(
        text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_usage_events'"
        )
    )
    columns = {row[0] for row in rows}
    assert {
        "event_id",
        "user_id",
        "subject_kind",
        "is_internal",
        "agent_run_id",
        "request_id",
        "catalog_key",
        "gateway_provider",
        "gateway_model",
        "policy_id",
        "plan",
        "call_role",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "estimated_cost",
        "cost_currency",
        "pricing_recorded_on",
        "latency_ms",
        "status",
        "failure_class",
        "attempt",
        "retried_event_id",
        "created_at",
    } <= columns


async def test_the_internal_classification_is_generated_by_the_database(
    privileged: AsyncSession,
) -> None:
    """Decision 27. A flag each writer sets would be a flag somebody eventually forgets, and an
    internal call would then be counted against a person's plan."""
    generated = await privileged.scalar(
        text(
            "SELECT is_generated FROM information_schema.columns "
            "WHERE table_name = 'llm_usage_events' AND column_name = 'is_internal'"
        )
    )
    assert generated == "ALWAYS"


# =========================================================================== 26.2 constraints


async def test_a_duplicate_catalog_key_is_rejected(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "VALUES ('economy-free-primary', 'openrouter', 'other/model', 'Duplicate key', "
        "ARRAY['routing']::text[], 'economy', true, 1000, 0, 0, '2026-09-09', true)",
        {},
    )
    assert "model_catalog_pkey" in error


async def test_a_duplicate_gateway_provider_and_model_pair_is_rejected(engines: Engines) -> None:
    """Two catalog keys pointing at one upstream model would make "which entry served this call"
    unanswerable from a usage event."""
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "SELECT 'a-different-key', gateway_provider, gateway_model, 'Duplicate gateway identity', "
        "ARRAY['routing']::text[], 'economy', true, 1000, 0, 0, '2026-09-09', true "
        "FROM model_catalog WHERE catalog_key = 'economy-free-primary'",
        {},
    )
    assert "uq_model_catalog_gateway_identity" in error


@pytest.mark.parametrize(
    ("input_price", "output_price"), [("-0.01", "0"), ("0", "-1"), ("-5", "-5")]
)
async def test_a_negative_price_is_rejected(
    engines: Engines, input_price: str, output_price: str
) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "VALUES ('negative-price', 'openrouter', 'vendor/negative', 'Negative price', "
        "ARRAY['routing']::text[], 'economy', true, 1000, "
        f"{input_price}, {output_price}, '2026-09-09', true)",
        {},
    )
    assert "ck_model_catalog_prices_non_negative" in error


@pytest.mark.parametrize("context_window", [0, -1, -262144])
async def test_a_non_positive_context_window_is_rejected(
    engines: Engines, context_window: int
) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "VALUES ('bad-window', 'openrouter', 'vendor/window', 'Bad window', "
        f"ARRAY['routing']::text[], 'economy', true, {context_window}, 0, 0, '2026-09-09', true)",
        {},
    )
    assert "ck_model_catalog_context_window" in error


async def test_an_entry_declaring_no_capability_role_is_rejected(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "VALUES ('no-role', 'openrouter', 'vendor/norole', 'No role', "
        "ARRAY[]::text[], 'economy', true, 1000, 0, 0, '2026-09-09', true)",
        {},
    )
    assert "ck_model_catalog_capability_roles" in error


async def test_an_unknown_capability_role_is_rejected(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_catalog (catalog_key, gateway_provider, gateway_model, display_name, "
        "capability_roles, capability_tier, supports_structured_output, context_window, "
        "input_price_per_million, output_price_per_million, pricing_recorded_on, is_free_tier) "
        "VALUES ('bogus-role', 'openrouter', 'vendor/bogus', 'Bogus role', "
        "ARRAY['summarising']::text[], 'economy', true, 1000, 0, 0, '2026-09-09', true)",
        {},
    )
    assert "ck_model_catalog_capability_roles" in error


async def test_a_negative_allowance_is_rejected(engines: Engines) -> None:
    """`specs/usage-limits`: an allowance written with a negative value is refused."""
    error = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, plan_code, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'free', 'requests_per_day', 'day', -1)",
        {},
    )
    assert "ck_usage_limits_allowance_non_negative" in error


async def test_an_unknown_allowance_dimension_is_rejected(engines: Engines) -> None:
    """The other half of the same requirement: an unknown dimension is refused."""
    error = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, plan_code, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'free', 'requests_per_fortnight', 'day', 10)",
        {},
    )
    assert "ck_usage_limits_dimension" in error


async def test_an_allowance_must_belong_to_a_plan_or_the_internal_subject_and_not_both(
    engines: Engines,
) -> None:
    both = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, plan_code, internal_subject, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'free', 'internal', 'requests_per_day', 'day', 10)",
        {},
    )
    assert "ck_usage_limits_exactly_one_subject" in both

    neither = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'requests_per_day', 'day', 10)",
        {},
    )
    assert "ck_usage_limits_exactly_one_subject" in neither


async def test_an_allowance_window_must_match_its_dimension(engines: Engines) -> None:
    """A daily request limit recorded against a monthly window would enforce something nobody
    intended, and would look entirely plausible in a listing."""
    error = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, plan_code, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'pro', 'requests_per_day', 'month', 10)",
        {},
    )
    assert "ck_usage_limits_window_matches_dimension" in error


async def test_a_policy_cannot_declare_itself_as_its_own_fallback(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_policies (policy_id, display_name, candidate_catalog_keys, "
        "applicable_call_roles, eligibility, fallback_policy_id) "
        "VALUES ('loop', 'Loop', ARRAY['economy-free-primary']::text[], "
        "ARRAY['routing']::text[], 'plan', 'loop')",
        {},
    )
    assert "ck_model_policies_no_self_fallback" in error


async def test_a_policy_with_failover_disabled_must_be_genuinely_pinned(engines: Engines) -> None:
    """`specs/evaluation`: a fixed-model run attempts no candidate other than the pinned one. A row
    claiming failover off while declaring two candidates would be a contradiction the resolver
    would have to arbitrate, so the table refuses it instead."""
    error = await _rejects(
        engines,
        "INSERT INTO model_policies (policy_id, display_name, candidate_catalog_keys, "
        "applicable_call_roles, eligibility, failover_enabled) "
        "VALUES ('not_really_pinned', 'Not really pinned', "
        "ARRAY['economy-free-primary', 'standard-general']::text[], "
        "ARRAY['routing']::text[], 'plan', false)",
        {},
    )
    assert "ck_model_policies_pinned_is_singular" in error


async def test_a_plan_may_not_map_a_call_role_that_does_not_exist(engines: Engines) -> None:
    error = await _rejects(
        engines,
        'UPDATE subscription_plans SET policy_by_call_role = \'{"summarising": "balanced"}\'::jsonb '
        "WHERE plan_code = 'free'",
        {},
    )
    assert "ck_subscription_plans_known_call_roles" in error


# =========================================================================== 26.2 keys and indexes


async def test_the_declared_foreign_keys_exist(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text(
            "SELECT tc.table_name, kcu.column_name, ccu.table_name, rc.delete_rule "
            "FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name "
            "JOIN information_schema.constraint_column_usage ccu "
            "  ON ccu.constraint_name = tc.constraint_name "
            "JOIN information_schema.referential_constraints rc "
            "  ON rc.constraint_name = tc.constraint_name "
            "WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'"
        )
    )
    keys = {(row[0], row[1], row[2]): row[3] for row in rows}

    # A plan assignment hangs off a profile and is removed with it; the plan itself is RESTRICT,
    # because retiring a tier people are on should fail loudly rather than default them to Free.
    assert keys[("user_plans", "user_id", "profiles")] == "CASCADE"
    assert keys[("user_plans", "plan_code", "subscription_plans")] == "RESTRICT"
    # Account deletion removes a person's raw usage alongside their threads and preferences.
    assert keys[("llm_usage_events", "user_id", "profiles")] == "CASCADE"
    # Disabling or replacing a model must not erase what it served.
    assert keys[("llm_usage_events", "catalog_key", "model_catalog")] == "RESTRICT"
    assert keys[("model_evaluations", "catalog_key", "model_catalog")] == "RESTRICT"
    assert keys[("model_comparison_results", "catalog_key", "model_catalog")] == "RESTRICT"
    assert keys[("model_comparison_results", "run_id", "model_comparison_runs")] == "CASCADE"
    assert keys[("usage_limits", "plan_code", "subscription_plans")] == "CASCADE"


async def test_the_indexes_the_hot_paths_need_exist(privileged: AsyncSession) -> None:
    """Not decoration. Resolution filters the catalog by status on nearly every agent request, and
    the usage aggregate groups by owner, by internal classification and by period."""
    rows = await privileged.execute(
        text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
    )
    indexes = {row[0] for row in rows}
    assert {
        "ix_model_catalog_status",
        "uq_usage_limits_plan_dimension",
        "uq_usage_limits_internal_dimension",
        "ix_user_plans_plan_code",
        "ix_usage_counters_window",
        "ix_llm_usage_events_owner_time",
        "ix_llm_usage_events_internal_time",
        "ix_llm_usage_events_catalog_key",
        "ix_llm_usage_events_policy",
        "ix_llm_usage_events_run",
        "ix_model_evaluations_catalog_key",
        "ix_model_comparison_results_run",
        "ix_admin_audit_subject",
        "ix_admin_audit_created_at",
    } <= indexes


async def test_one_allowance_per_plan_and_dimension(engines: Engines) -> None:
    """The partial unique index, which a plain UNIQUE could not express: one of the two subject
    columns is always NULL, and PostgreSQL does not treat two NULLs as duplicates."""
    error = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, plan_code, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'free', 'requests_per_day', 'day', 99)",
        {},
    )
    assert "uq_usage_limits_plan_dimension" in error


async def test_one_internal_allowance_per_dimension(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO usage_limits (id, internal_subject, dimension, window_kind, allowance) "
        "VALUES (gen_random_uuid(), 'internal', 'requests_per_day', 'day', 99)",
        {},
    )
    assert "uq_usage_limits_internal_dimension" in error


# =========================================================================== the vocabularies agree


async def test_the_database_and_the_domain_agree_on_every_vocabulary(
    privileged: AsyncSession,
) -> None:
    """The enums and the CHECK constraints are written in two languages and must say one thing.

    Read out of ``pg_constraint`` rather than probed by inserting, so the assertion is about what
    the database will *ever* accept and not about what one row happened to do. A value the enum
    admits and the constraint refuses would be a row the application builds and the database
    rejects — which, for telemetry written on a background task, is a failure nobody is watching.
    """

    async def definition(name: str) -> str:
        found = await privileged.scalar(
            text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :name"),
            {"name": name},
        )
        assert found is not None, f"constraint {name} does not exist"
        return str(found)

    plan_codes = await definition("ck_subscription_plans_canonical_code")
    for plan in PlanCode:
        assert f"'{plan.value}'" in plan_codes, f"{plan.value} is a PlanCode the table would refuse"
    assert "'plus'" not in plan_codes, "the retired tier is writable again"

    call_roles = await definition("ck_llm_usage_events_call_role")
    for role in CallRole:
        assert f"'{role.value}'" in call_roles, f"{role.value} is a CallRole the table would refuse"

    dimensions = await definition("ck_usage_limits_dimension")
    counter_dimensions = await definition("ck_usage_counters_dimension")
    for dimension in QuotaDimension:
        assert f"'{dimension.value}'" in dimensions, (
            f"{dimension.value} is not an allowed allowance"
        )
        assert f"'{dimension.value}'" in counter_dimensions, (
            f"{dimension.value} can be allowed but never counted, so it could never be enforced"
        )

    windows = await definition("ck_usage_limits_window")
    for window in QuotaWindow:
        assert f"'{window.value}'" in windows, f"{window.value} is not an allowed window"


# =========================================================================== 26.4 lab and audit


@pytest.mark.parametrize("table", LAB_AND_AUDIT_TABLES)
async def test_the_request_role_cannot_read_a_lab_or_audit_table(
    engines: Engines, clean_database: None, table: str
) -> None:
    """`specs/model-lab` and design.md decision 10: these belong to the project, and nothing a
    browser does has any business reading a comparison's provenance or the administrative trail."""
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, user_id) as session:
            await session.execute(text(f"SELECT count(*) FROM {table}"))
    assert "permission denied" in str(caught.value)


@pytest.mark.parametrize("table", LAB_AND_AUDIT_TABLES)
async def test_the_request_role_cannot_write_a_lab_or_audit_table(
    engines: Engines, clean_database: None, table: str
) -> None:
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, user_id) as session:
            await session.execute(text(f"DELETE FROM {table}"))
    assert "permission denied" in str(caught.value)


@pytest.mark.parametrize("table", LAB_AND_AUDIT_TABLES)
async def test_a_lab_or_audit_table_has_row_level_security_on_and_no_policy(
    privileged: AsyncSession, table: str
) -> None:
    """The denial stated twice. The grant alone was enough until Supabase's ``ensure_rls`` trigger
    made it not enough (see ``0004``); RLS-with-no-policy alone would be enough only on a platform
    that has such a trigger. Both, so the property does not depend on which platform this is."""
    enabled = await privileged.scalar(
        text("SELECT relrowsecurity FROM pg_class WHERE relname = :table"), {"table": table}
    )
    assert enabled, f"{table} does not have row level security enabled"

    policies = await privileged.scalar(
        text("SELECT count(*) FROM pg_policy WHERE polrelid = to_regclass(:table)"),
        {"table": table},
    )
    assert policies == 0, f"{table} carries a policy; it is meant to be unreachable, not scoped"


async def test_the_privileged_path_can_still_write_the_lab_and_audit_tables(
    engines: Engines, clean_database: None
) -> None:
    """The other half of 26.4: denied to requests, and fully functional for the routines that own
    them. A migration that locked everybody out would pass every test above."""
    run_id = str(uuid.uuid4())
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO model_comparison_runs (id, initiated_by, candidate_catalog_keys, "
                "dataset_version, catalog_state, status) "
                "VALUES (:id, :who, ARRAY['economy-free-primary']::text[], 'v1', '{}'::jsonb, "
                "'completed')"
            ),
            {"id": run_id, "who": new_user_id()},
        )
        await session.execute(
            text(
                "INSERT INTO model_comparison_results (id, run_id, catalog_key, gateway_model, "
                "case_id, succeeded) VALUES (:id, :run, 'economy-free-primary', 'vendor/m', "
                "'case-1', true)"
            ),
            {"id": str(uuid.uuid4()), "run": run_id},
        )
        await session.execute(
            text(
                "INSERT INTO admin_audit (id, acting_principal, action, subject_kind, subject_id, "
                "after, cited_comparison_run_ids) "
                "VALUES (:id, :who, 'promote_model', 'model_policy', 'balanced', "
                '\'{"candidates": ["standard-general"]}\'::jsonb, ARRAY[:run]::text[])'
            ),
            {"id": str(uuid.uuid4()), "who": new_user_id(), "run": run_id},
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        cited = await session.scalar(
            text(
                "SELECT cited_comparison_run_ids[1] FROM admin_audit WHERE action = 'promote_model'"
            )
        )
    assert cited == run_id, "a promotion must be traceable to the comparison it cited"


async def test_an_audit_row_must_record_a_change(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO admin_audit (id, acting_principal, action, subject_kind, subject_id) "
        "VALUES (gen_random_uuid(), gen_random_uuid(), 'noted', 'model_policy', 'balanced')",
        {},
    )
    assert "ck_admin_audit_records_a_change" in error


async def test_a_comparison_run_must_say_what_it_compared_over(engines: Engines) -> None:
    error = await _rejects(
        engines,
        "INSERT INTO model_comparison_runs (id, initiated_by, candidate_catalog_keys, catalog_state) "
        "VALUES (gen_random_uuid(), gen_random_uuid(), ARRAY['economy-free-primary']::text[], "
        "'{}'::jsonb)",
        {},
    )
    assert "ck_model_comparison_runs_has_input" in error
