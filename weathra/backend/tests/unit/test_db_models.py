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


@pytest.mark.parametrize(
    "table_name",
    sorted(name for name, (ownership, _) in DECISION_10.items() if ownership is Ownership.USER),
)
def test_every_user_owned_table_carries_the_ownership_column(table_name: str) -> None:
    table = Base.metadata.tables[table_name]
    assert USER_ID_COLUMN in table.columns, f"{table_name} is user-owned but has no user_id"
    assert not table.columns[USER_ID_COLUMN].nullable, (
        f"{table_name}.user_id must not be nullable; an unowned row would escape every policy"
    )


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
