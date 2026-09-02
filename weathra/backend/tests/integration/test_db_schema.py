"""Tasks 3.2, 3.3, and 3.4 against a real PostgreSQL.

Every test here is `db`-marked and deselected by default. They exercise the things that only exist
in a real database: the migrations, the ``vector`` extension, the HNSW index, the Row Level Security
policies, and the claims binding the request-scoped session performs.

The RLS tests deliberately omit the ownership predicate. That is the point: the data path's
``AND user_id = :actor`` is the primary gate, and this asserts the *second* gate holds on its own,
so a handler that forgets the predicate returns nothing rather than another user's row.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import (
    insert_profile,
    insert_saved_location,
    new_user_id,
    session_as,
)
from weathra.db.engine import Engines
from weathra.db.models import Ownership, ownership_of, user_owned_tables
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

USER_OWNED = ("profiles", "preferences", "saved_locations", "threads", "agent_runs")
SHARED = ("forecast_snapshots", "knowledge_documents", "knowledge_chunks")
OPERATIONAL = ("evaluation_runs", "evaluation_case_results")


# =========================================================================== 3.2 migrations


async def test_every_table_exists_after_migration(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    )
    present = {row[0] for row in rows}
    assert set(USER_OWNED + SHARED + OPERATIONAL) <= present


async def test_the_vector_extension_is_enabled(privileged: AsyncSession) -> None:
    version = await privileged.scalar(
        text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
    )
    assert version, "the vector extension was not enabled by the migration"


async def test_the_chunk_vector_carries_an_hnsw_cosine_index(privileged: AsyncSession) -> None:
    definition = await privileged.scalar(
        text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE tablename = 'knowledge_chunks' AND indexname = 'ix_knowledge_chunks_embedding_hnsw'"
        )
    )
    assert definition is not None
    assert "USING hnsw" in definition
    assert "vector_cosine_ops" in definition


async def test_the_chunk_vector_has_the_configured_dimension(
    privileged: AsyncSession, db_settings: object
) -> None:
    declared = await privileged.scalar(
        text(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
            "WHERE attrelid = to_regclass('knowledge_chunks') AND attname = 'embedding'"
        )
    )
    assert declared == f"vector({db_settings.embedding_dimension})"  # type: ignore[attr-defined]


async def test_timestamps_are_stored_with_a_timezone(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text(
            "SELECT table_name, column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND (column_name LIKE '%\\_at' "
            "OR column_name LIKE '%\\_start' OR column_name LIKE '%\\_end')"
        )
    )
    naive = [(table, column) for table, column, kind in rows if kind != "timestamp with time zone"]
    assert not naive, f"naive timestamp columns: {naive}"


# =========================================================================== 3.3 policies


@pytest.mark.parametrize("table", USER_OWNED)
async def test_row_level_security_is_enabled_on_each_user_owned_table(
    privileged: AsyncSession, table: str
) -> None:
    row = (
        await privileged.execute(
            text(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                "WHERE oid = to_regclass(:table)"
            ),
            {"table": table},
        )
    ).one()
    enabled, forced = row
    assert enabled, f"row level security is not enabled on {table}"
    assert forced, (
        f"{table} does not FORCE row level security, so the table owner would bypass the policy"
    )


@pytest.mark.parametrize("table", USER_OWNED)
async def test_each_user_owned_table_has_an_owner_restricting_policy(
    privileged: AsyncSession, table: str
) -> None:
    rows = await privileged.execute(
        text(
            "SELECT policyname, qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = :table"
        ),
        {"table": table},
    )
    policies = rows.all()
    assert policies, f"{table} has no policy"
    for _, using, with_check in policies:
        assert "weathra_current_user_id()" in (using or "")
        assert "weathra_current_user_id()" in (with_check or ""), (
            "a policy with no WITH CHECK would let a write place a row under another owner"
        )


@pytest.mark.parametrize("table", SHARED)
async def test_shared_tables_are_not_restricted_by_owner(
    privileged: AsyncSession, table: str
) -> None:
    """specs/authentication requires exactly this asymmetry, so it is asserted, not assumed."""
    enabled = await privileged.scalar(
        text("SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(:table)"),
        {"table": table},
    )
    assert enabled is False, f"{table} is shared but carries row level security"

    count = await privileged.scalar(
        text("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = :table"),
        {"table": table},
    )
    assert count == 0, f"{table} is shared but carries {count} owner-restricting policies"


async def test_the_policy_set_matches_the_models_classification(
    privileged: AsyncSession,
) -> None:
    """The migration and ``user_owned_tables()`` must not drift apart."""
    rows = await privileged.execute(
        text("SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'")
    )
    with_policies = {row[0] for row in rows}
    assert with_policies == set(user_owned_tables())
    for table in with_policies:
        assert ownership_of(table) is Ownership.USER


async def test_the_restricted_role_exists_and_cannot_bypass_policies(
    privileged: AsyncSession, db_settings: object
) -> None:
    role = db_settings.database_restricted_role  # type: ignore[attr-defined]
    row = (
        await privileged.execute(
            text("SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = :role"),
            {"role": role},
        )
    ).one_or_none()
    assert row is not None, f"the migration did not create the {role} role"
    bypass, can_login, is_super = row
    assert bypass is False, "the request role must not be able to bypass row level security"
    assert can_login is False, "the request role is assumed, never connected as"
    assert is_super is False


# =========================================================================== 3.4 sessions


async def test_a_request_session_binds_the_acting_users_claims(engines: Engines) -> None:
    user_id = new_user_id()
    async with session_as(engines, user_id) as session:
        bound = await session.scalar(text("SELECT weathra_current_user_id()"))
        assert bound == user_id


async def test_a_request_session_runs_under_the_restricted_role(engines: Engines) -> None:
    async with session_as(engines, new_user_id()) as session:
        current = await session.scalar(text("SELECT current_user"))
        assert current == engines.settings.database_restricted_role


async def test_a_session_with_no_principal_binds_no_owner(engines: Engines) -> None:
    async with session_as(engines, None) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) is None


@pytest.mark.usefixtures("clean_database")
async def test_a_session_with_no_principal_reads_no_user_owned_row(engines: Engines) -> None:
    """A handler that opens a session without a principal must see nothing, not everything."""
    owner = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, owner)
        await insert_saved_location(admin, owner)

    async with session_as(engines, None) as session:
        rows = await session.scalar(text("SELECT count(*) FROM saved_locations"))
        assert rows == 0


@pytest.mark.usefixtures("clean_database")
async def test_the_policy_hides_another_users_row_with_the_predicate_omitted(
    engines: Engines,
) -> None:
    """The second gate, on its own.

    The query below deliberately has no ``WHERE user_id = ...``. If the policy were dropped, it
    would return the other user's row — which is exactly what task 18.9 asks to be proved.
    """
    first, second = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, first)
        await insert_profile(admin, second)
        await insert_saved_location(admin, second, location_id="loc:48.14,11.58")

    async with session_as(engines, first) as session:
        visible = (
            await session.execute(text("SELECT id::text, user_id::text FROM saved_locations"))
        ).all()
        assert visible == [], "the policy did not hide another user's row"


@pytest.mark.usefixtures("clean_database")
async def test_each_user_sees_only_their_own_rows(engines: Engines) -> None:
    first, second = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        for user_id in (first, second):
            await insert_profile(admin, user_id)
            await insert_saved_location(admin, user_id)

    for user_id in (first, second):
        async with session_as(engines, user_id) as session:
            rows = (await session.execute(text("SELECT user_id::text FROM saved_locations"))).all()
            assert [row[0] for row in rows] == [user_id]


@pytest.mark.usefixtures("clean_database")
async def test_a_write_cannot_place_a_row_under_another_owner(engines: Engines) -> None:
    """The WITH CHECK half of the policy."""
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)

    with pytest.raises(DBAPIError):
        async with session_as(engines, actor) as session:
            await insert_saved_location(session, victim)


@pytest.mark.usefixtures("clean_database")
async def test_a_cross_user_update_changes_nothing(engines: Engines) -> None:
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)
        row_id = await insert_saved_location(admin, victim)

    async with session_as(engines, actor) as session:
        result = await session.execute(
            text("UPDATE saved_locations SET label = 'hijacked' WHERE id = :id RETURNING id"),
            {"id": row_id},
        )
        assert result.all() == []

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        label = await admin.scalar(
            text("SELECT label FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
        assert label == "Berlin"


@pytest.mark.usefixtures("clean_database")
async def test_a_cross_user_delete_removes_nothing(engines: Engines) -> None:
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)
        row_id = await insert_saved_location(admin, victim)

    async with session_as(engines, actor) as session:
        result = await session.execute(
            text("DELETE FROM saved_locations WHERE id = :id RETURNING id"), {"id": row_id}
        )
        assert result.all() == []

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        assert await admin.scalar(
            text("SELECT count(*) FROM saved_locations WHERE id = :id"), {"id": row_id}
        )


@pytest.mark.usefixtures("clean_database")
async def test_a_users_own_write_and_read_succeed(engines: Engines) -> None:
    user_id = new_user_id()
    async with session_as(engines, user_id) as session:
        await session.execute(
            text("INSERT INTO profiles (user_id) VALUES (:user_id)"), {"user_id": user_id}
        )
        row_id = await insert_saved_location(session, user_id)

    async with session_as(engines, user_id) as session:
        found = await session.scalar(
            text("SELECT label FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
        assert found == "Berlin"


@pytest.mark.usefixtures("clean_database")
async def test_the_shared_corpus_is_readable_under_any_principal(engines: Engines) -> None:
    """The corpus is readable by any authenticated user without being user-owned."""
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await admin.execute(
            text(
                "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                "VALUES ('dew-point', 'Dew point', 'humidity', 'Authored for Weathra', 'abc')"
            )
        )

    for user_id in (new_user_id(), new_user_id()):
        async with session_as(engines, user_id) as session:
            assert await session.scalar(text("SELECT count(*) FROM knowledge_documents")) == 1


@pytest.mark.usefixtures("clean_database")
async def test_the_restricted_role_cannot_write_the_corpus(engines: Engines) -> None:
    """Read-only to users: ingestion runs under the privileged connection."""
    with pytest.raises(ProgrammingError):
        async with session_as(engines, new_user_id()) as session:
            await session.execute(
                text(
                    "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                    "VALUES ('injected', 'x', 'y', 'z', 'h')"
                )
            )


@pytest.mark.usefixtures("clean_database")
async def test_snapshots_are_visible_to_every_principal(engines: Engines) -> None:
    """One user's request improves everyone's What Changed? history."""
    async with session_as(engines, new_user_id()) as session:
        await session.execute(
            text(
                "INSERT INTO forecast_snapshots "
                "(id, location_id, location, window_start, window_end, provider, unit_system, "
                " retrieved_at, daily_series) VALUES "
                "(gen_random_uuid(), 'loc:52.52,13.41', '{}', now(), now() + interval '7 days', "
                " 'open-meteo', 'metric', now(), '{}')"
            )
        )

    async with session_as(engines, new_user_id()) as other:
        assert await other.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 1


async def test_the_privileged_connection_is_distinct_from_the_request_one(
    engines: Engines,
) -> None:
    assert engines.privileged() is not engines.request_engine
    assert engines.privileged().pool.__class__.__name__ == "NullPool"

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        as_admin = await admin.scalar(text("SELECT current_user"))
    async with session_as(engines, new_user_id()) as session:
        as_request = await session.scalar(text("SELECT current_user"))

    assert as_admin != as_request
    assert as_request == engines.settings.database_restricted_role


async def test_the_role_does_not_leak_to_the_next_use_of_a_pooled_connection(
    engines: Engines,
) -> None:
    """SET LOCAL ends with the transaction; this asserts it, because a leak would be cross-user."""
    async with session_as(engines, new_user_id()):
        pass
    async with engines.request_sessionmaker() as plain:
        current = await plain.scalar(text("SELECT current_user"))
        assert current != engines.settings.database_restricted_role
        assert await plain.scalar(text("SELECT weathra_current_user_id()")) is None


async def test_claims_are_reset_between_requests(engines: Engines) -> None:
    first, second = new_user_id(), new_user_id()
    async with session_as(engines, first) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) == first
    async with session_as(engines, second) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) == second


async def test_a_failing_request_rolls_back_and_still_resets(engines: Engines) -> None:
    user_id = new_user_id()
    with pytest.raises(RuntimeError, match="handler blew up"):
        async with session_as(engines, user_id) as session:
            await session.execute(
                text("INSERT INTO profiles (user_id) VALUES (:user_id)"), {"user_id": user_id}
            )
            raise RuntimeError("handler blew up")

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        assert (
            await admin.scalar(
                text("SELECT count(*) FROM profiles WHERE user_id = :user_id"),
                {"user_id": user_id},
            )
            == 0
        )
