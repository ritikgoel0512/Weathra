"""Task 3.1 — every table in decision 10 exists, with the primary key and the ownership
classification that decision states. No database is needed: this reads the mapped metadata.

The classification is checked exhaustively and in both directions, because a table quietly gaining
or losing a ``user_id`` is precisely the change that would break the authorization boundary while
every other test kept passing.
"""

from __future__ import annotations

import pytest

from weathra.db.models import (
    USER_ID_COLUMN,
    Base,
    Ownership,
    ownership_column,
    ownership_of,
    user_owned_tables,
)

# design.md decision 10's table, transcribed. Table name -> (ownership, primary key columns).
DECISION_10: dict[str, tuple[Ownership, tuple[str, ...]]] = {
    "profiles": (Ownership.USER, ("user_id",)),
    "preferences": (Ownership.USER, ("user_id",)),
    "saved_locations": (Ownership.USER, ("id",)),
    "threads": (Ownership.USER, ("id",)),
    "agent_runs": (Ownership.USER, ("id",)),
    "forecast_snapshots": (Ownership.SHARED, ("id",)),
    "knowledge_documents": (Ownership.SHARED, ("id",)),
    "knowledge_chunks": (Ownership.SHARED, ("id",)),
    "evaluation_runs": (Ownership.OPERATIONAL, ("id",)),
    "evaluation_case_results": (Ownership.OPERATIONAL, ("id",)),
    # The SaaS-ready layer. Three of these are user-owned and get the same owner-restricting
    # treatment as the five above, from migration 0006 rather than from 0002 — the classification
    # is what decides that, which is why they are transcribed here alongside the rest.
    "subscription_plans": (Ownership.OPERATIONAL, ("plan_code",)),
    "model_catalog": (Ownership.OPERATIONAL, ("catalog_key",)),
    "model_policies": (Ownership.OPERATIONAL, ("policy_id",)),
    "usage_limits": (Ownership.OPERATIONAL, ("id",)),
    "user_plans": (Ownership.USER, ("user_id",)),
    "usage_counters": (Ownership.USER, ("subject", "dimension", "window_key")),
    "llm_usage_events": (Ownership.USER, ("event_id",)),
    "model_evaluations": (Ownership.OPERATIONAL, ("id",)),
    "model_comparison_runs": (Ownership.OPERATIONAL, ("id",)),
    "model_comparison_results": (Ownership.OPERATIONAL, ("id",)),
    "admin_audit": (Ownership.OPERATIONAL, ("id",)),
}


def test_every_decision_10_table_is_mapped() -> None:
    assert set(Base.metadata.tables) == set(DECISION_10), {
        "unmapped": sorted(set(DECISION_10) - set(Base.metadata.tables)),
        "undeclared": sorted(set(Base.metadata.tables) - set(DECISION_10)),
    }


@pytest.mark.parametrize("table_name", sorted(DECISION_10))
def test_primary_key_matches_the_decision(table_name: str) -> None:
    _, expected = DECISION_10[table_name]
    actual = tuple(column.name for column in Base.metadata.tables[table_name].primary_key)
    assert actual == expected


@pytest.mark.parametrize("table_name", sorted(DECISION_10))
def test_ownership_matches_the_decision(table_name: str) -> None:
    expected, _ = DECISION_10[table_name]
    assert ownership_of(table_name) is expected


# The column each user-owned table's Row Level Security policy compares against, and whether it may
# be null. Six of the eight are the plain case — a non-nullable `user_id`, where a nullable one
# would be a row that escapes every policy. The two exceptions are not laxity; each is a documented
# decision, and spelling them out here is what stops a *third* one being added by accident.
OWNERSHIP_COLUMN: dict[str, tuple[str, bool]] = {
    "profiles": (USER_ID_COLUMN, False),
    "preferences": (USER_ID_COLUMN, False),
    "saved_locations": (USER_ID_COLUMN, False),
    "threads": (USER_ID_COLUMN, False),
    "agent_runs": (USER_ID_COLUMN, False),
    "user_plans": (USER_ID_COLUMN, False),
    # Keyed by `subject`, not `user_id`: internal traffic is accounted against a reserved
    # non-UUID subject (design.md decision 25), which has no profile and must not acquire one.
    # Still non-nullable — it is part of the primary key.
    "usage_counters": ("subject", False),
    # The one table with two ownership shapes (design.md decision 27). A call made with no
    # principal is recorded with a null user id and never a placeholder, which `specs/llm-telemetry`
    # requires explicitly. The nullability is safe because it is *classified* rather than loose:
    # see the generated-column test below.
    "llm_usage_events": (USER_ID_COLUMN, True),
}


def test_every_user_owned_table_is_listed_with_its_ownership_column() -> None:
    """A new user-owned table must decide what its policy compares against, here, on purpose."""
    user_owned = {
        name for name, (ownership, _) in DECISION_10.items() if ownership is Ownership.USER
    }
    assert set(OWNERSHIP_COLUMN) == user_owned


@pytest.mark.parametrize("table_name", sorted(OWNERSHIP_COLUMN))
def test_every_user_owned_table_carries_the_ownership_column(table_name: str) -> None:
    column_name, may_be_null = OWNERSHIP_COLUMN[table_name]
    table = Base.metadata.tables[table_name]
    assert ownership_column(table_name) == column_name, (
        f"{table_name} declares a different ownership column than this test expects; the "
        "declaration is what every policy and every iterating test reads"
    )
    assert column_name in table.columns, f"{table_name} is user-owned but has no {column_name}"
    assert table.columns[column_name].nullable is may_be_null, (
        f"{table_name}.{column_name} nullability is not what the classification says. A user-owned "
        "row with no owner escapes every policy unless something else classifies it."
    )


def test_the_one_nullable_owner_column_is_classified_rather_than_merely_allowed() -> None:
    """Decision 27's resolution, asserted rather than trusted.

    `llm_usage_events.user_id` is nullable, which for any other user-owned table would be the bug
    this file exists to catch. What makes it safe is that the nullability is *derived into* a
    generated `is_internal` column, so every aggregate splits product from internal usage without
    each query remembering the rule, and an internal event can never be counted against a plan.
    Remove the generated column and the nullable owner really would be a hole.
    """
    events = Base.metadata.tables["llm_usage_events"]
    assert events.columns["user_id"].nullable
    is_internal = events.columns["is_internal"]
    assert is_internal.computed is not None, "is_internal must be a generated column, not a flag"
    assert not is_internal.nullable


@pytest.mark.parametrize(
    "table_name",
    sorted(name for name, (ownership, _) in DECISION_10.items() if ownership is not Ownership.USER),
)
def test_no_shared_or_operational_table_carries_a_user_column(table_name: str) -> None:
    """The other direction of the same rule.

    `forecast_snapshots` is the one this test exists for: a forecast for Berlin is not private, and
    a nullable user column here would both store a browsing trail and halve What Changed?'s
    coverage.
    """
    columns = set(Base.metadata.tables[table_name].columns.keys())
    assert USER_ID_COLUMN not in columns, (
        f"{table_name} is classified {ownership_of(table_name).value} but carries a user column"
    )


def test_forecast_snapshots_are_keyed_by_location_and_window_not_by_requester() -> None:
    columns = set(Base.metadata.tables["forecast_snapshots"].columns.keys())
    assert {"location_id", "window_start", "window_end", "provider", "retrieved_at"} <= columns
    assert not any("user" in name or "requester" in name for name in columns)


def test_the_user_owned_helper_agrees_with_the_decision() -> None:
    """The RLS migration iterates this helper, so it must not drift from the classification."""
    expected = {name for name, (ownership, _) in DECISION_10.items() if ownership is Ownership.USER}
    assert set(user_owned_tables()) == expected


def test_every_table_declares_an_ownership() -> None:
    for name in Base.metadata.tables:
        assert ownership_of(name) in set(Ownership)


def test_an_unclassified_table_is_refused_rather_than_defaulted() -> None:
    """A table added without a classification must fail loudly, not default to something."""
    from sqlalchemy import Column, String, Table

    Table("stray", Base.metadata, Column("id", String, primary_key=True))
    try:
        with pytest.raises(LookupError, match="declares no ownership"):
            ownership_of("stray")
    finally:
        Base.metadata.remove(Base.metadata.tables["stray"])


# --------------------------------------------------------------------------- data minimization


def test_no_table_holds_credential_or_duplicated_contact_data() -> None:
    """specs/authentication and specs/safety-grounding: credentials and contact data stay in
    Supabase Auth; application tables reference a user only by their authentication subject."""
    forbidden = {
        "password",
        "password_hash",
        "encrypted_password",
        "access_token",
        "refresh_token",
        "token",
        "session_secret",
        "api_key",
        "secret",
        "email",
        "phone",
        "full_name",
    }
    for table_name, table in Base.metadata.tables.items():
        offending = set(table.columns.keys()) & forbidden
        assert not offending, f"{table_name} holds {sorted(offending)}"


def test_the_evaluation_run_records_its_test_identity_without_a_credential() -> None:
    columns = set(Base.metadata.tables["evaluation_runs"].columns.keys())
    assert "test_user_id" in columns
    assert not any("password" in name or "token" in name or "secret" in name for name in columns)


# --------------------------------------------------------------------------- schema details


def test_user_owned_rows_cascade_from_the_profile() -> None:
    """Account data deletion removes the acting user's records and nothing else."""
    for table_name in ("preferences", "saved_locations", "threads", "agent_runs"):
        table = Base.metadata.tables[table_name]
        foreign_keys = [
            fk
            for column in table.columns
            for fk in column.foreign_keys
            if fk.column.table.name == "profiles"
        ]
        assert foreign_keys, f"{table_name} does not reference profiles"
        assert all(fk.ondelete == "CASCADE" for fk in foreign_keys)


def test_a_location_cannot_be_saved_twice_by_one_user() -> None:
    constraints = {
        constraint.name
        for constraint in Base.metadata.tables["saved_locations"].constraints
        if constraint.name
    }
    assert "uq_saved_locations_user_location" in constraints


def test_a_thread_carries_its_resolved_entity_projection_and_an_expiry() -> None:
    columns = Base.metadata.tables["threads"].columns
    assert "resolved_entities" in columns
    assert "expires_at" in columns
    assert not columns["expires_at"].nullable


def test_a_chunk_records_the_embedding_model_and_dimension_beside_its_vector() -> None:
    columns = set(Base.metadata.tables["knowledge_chunks"].columns.keys())
    assert {"embedding", "embedding_model", "embedding_dimension"} <= columns


def test_an_agent_run_stores_the_envelope_and_the_evidence() -> None:
    columns = Base.metadata.tables["agent_runs"].columns
    assert "envelope" in columns
    assert "evidence" in columns
    assert not columns["evidence"].nullable


def test_timestamps_are_timezone_aware() -> None:
    """A naive timestamp in a system that resolves windows per-location is a bug waiting to happen."""
    for table_name, table in Base.metadata.tables.items():
        for column in table.columns:
            if column.name.endswith(("_at", "_start", "_end")):
                assert getattr(column.type, "timezone", False), (
                    f"{table_name}.{column.name} is not timezone-aware"
                )
