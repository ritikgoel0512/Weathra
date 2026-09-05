"""What the restricted role can actually do to the shared tables (migration 0004).

``0002`` granted ``weathra_request`` SELECT on the corpus and SELECT/INSERT on the snapshots and
wrote no policies, because it did not enable Row Level Security on those tables. Supabase does
enable it — an ``ensure_rls`` event trigger fires for every table created in ``public`` — and RLS
with no applicable policy denies every row to a role that is neither the table owner nor
``BYPASSRLS``. The grants stayed exactly as intended and the reads returned nothing.

So these tests assert behaviour rather than catalog entries. A test that reads ``pg_policies``
would have passed against the broken database just as happily as against the fixed one: the policy
rows it would have looked for did not exist in either, and the ACL it would have checked was
correct throughout. Every assertion here runs a real statement as ``weathra_request``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import new_user_id, session_as
from weathra.db.engine import Engines
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

RESTRICTED_ROLE = "weathra_request"
LOGIN_ROLE = "weathra_api"

READ_ONLY_TABLES = ("knowledge_documents", "knowledge_chunks")
READ_APPEND_TABLES = ("forecast_snapshots",)
SHARED_TABLES = READ_ONLY_TABLES + READ_APPEND_TABLES


async def _insert_snapshot(session: AsyncSession, *, location_id: str = "loc:52.52,13.41") -> str:
    """A snapshot row, written with the columns `weather/snapshots.py` writes."""
    row_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    await session.execute(
        text(
            "INSERT INTO forecast_snapshots (id, location_id, location, window_start, window_end, "
            "provider, unit_system, retrieved_at, daily_series) VALUES (:id, :location_id, "
            ":location, :window_start, :window_end, :provider, :unit_system, :retrieved_at, "
            ":daily_series)"
        ),
        {
            "id": row_id,
            "location_id": location_id,
            "location": '{"display_name": "Berlin"}',
            "window_start": now,
            "window_end": now + timedelta(days=3),
            "provider": "open-meteo",
            "unit_system": "metric",
            "retrieved_at": now,
            "daily_series": '{"days": []}',
        },
    )
    return row_id


async def _insert_corpus(session: AsyncSession) -> tuple[str, str]:
    """A document and one chunk, as the privileged ingestion routine would write them."""
    document_id = f"doc-{uuid.uuid4().hex[:8]}"
    chunk_id = str(uuid.uuid4())
    await session.execute(
        text(
            "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
            "VALUES (:id, :title, :topic, :provenance, :content_hash)"
        ),
        {
            "id": document_id,
            "title": "How forecasts are made",
            "topic": "forecasting",
            "provenance": "test fixture",
            "content_hash": "0" * 64,
        },
    )
    await session.execute(
        text(
            "INSERT INTO knowledge_chunks (id, document_id, position, text, token_count, "
            "embedding_model, embedding_dimension, embedding) VALUES (:id, :document_id, "
            ":position, :text, :token_count, :model, :dimension, :embedding)"
        ),
        {
            "id": chunk_id,
            "document_id": document_id,
            "position": 0,
            "text": "A forecast is a model output, not an observation.",
            "token_count": 10,
            "model": "weathra-hashing-v1",
            "dimension": 384,
            "embedding": str([0.0] * 384),
        },
    )
    return document_id, chunk_id


# =========================================================================== forecast_snapshots


async def test_the_request_role_can_read_a_shared_snapshot(
    engines: Engines, clean_database: None
) -> None:
    """`weather/snapshots.py::previous_snapshot` runs on the request session. Before 0004 this
    returned nothing on Supabase — no error, just an empty result."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        row_id = await _insert_snapshot(session)

    async with session_as(engines, new_user_id()) as session:
        found = await session.scalar(
            text("SELECT id::text FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
        )
    assert found == row_id, "the request path cannot read the snapshot it is granted SELECT on"


async def test_the_request_role_can_append_a_snapshot(
    engines: Engines, clean_database: None
) -> None:
    """`capture()` writes on the request session, inside a savepoint."""
    async with session_as(engines, new_user_id()) as session:
        row_id = await _insert_snapshot(session)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        stored = await session.scalar(
            text("SELECT id::text FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
        )
    assert stored == row_id, "the request path could not append the snapshot it just retrieved"


async def test_a_snapshot_is_not_owned_by_the_user_who_captured_it(
    engines: Engines, clean_database: None
) -> None:
    """The design's reason for the table: one person's request improves everyone's history, and no
    browsing trail is stored. A per-user policy here would be wrong, not merely stricter."""
    async with session_as(engines, new_user_id()) as session:
        row_id = await _insert_snapshot(session)

    async with session_as(engines, new_user_id()) as other:
        found = await other.scalar(
            text("SELECT id::text FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
        )
    assert found == row_id


async def test_the_request_role_cannot_update_a_snapshot(
    engines: Engines, clean_database: None
) -> None:
    """No UPDATE grant and no UPDATE policy. Both say it, which is the point."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        row_id = await _insert_snapshot(session)

    with pytest.raises(DBAPIError):
        async with session_as(engines, new_user_id()) as session:
            await session.execute(
                text("UPDATE forecast_snapshots SET provider = 'tampered' WHERE id = :id"),
                {"id": row_id},
            )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        provider = await session.scalar(
            text("SELECT provider FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
        )
    assert provider == "open-meteo", "the row was modified despite the refusal"


async def test_the_request_role_cannot_delete_a_snapshot(
    engines: Engines, clean_database: None
) -> None:
    """Retention deletes expired snapshots under the privileged connection, never a request."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        row_id = await _insert_snapshot(session)

    with pytest.raises(DBAPIError):
        async with session_as(engines, new_user_id()) as session:
            await session.execute(
                text("DELETE FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
            )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        survives = await session.scalar(
            text("SELECT id::text FROM forecast_snapshots WHERE id = :id"), {"id": row_id}
        )
    assert survives == row_id, "a request session deleted shared data"


# =========================================================================== the corpus


async def test_the_request_role_can_read_the_corpus(engines: Engines, clean_database: None) -> None:
    """`rag/retrieve.py` searches chunks and joins documents, both on the request session. This is
    the read that silently returned nothing, which reads as an empty knowledge base."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        document_id, chunk_id = await _insert_corpus(session)

    async with session_as(engines, new_user_id()) as session:
        joined = await session.scalar(
            text(
                "SELECT c.id::text FROM knowledge_chunks c "
                "JOIN knowledge_documents d ON d.id = c.document_id WHERE c.id = :id"
            ),
            {"id": chunk_id},
        )
        document = await session.scalar(
            text("SELECT id FROM knowledge_documents WHERE id = :id"), {"id": document_id}
        )
    assert joined == chunk_id, "vector search cannot reach the chunks"
    assert document == document_id, "the corpus join cannot reach the documents"


@pytest.mark.parametrize("table", READ_ONLY_TABLES)
async def test_the_request_role_cannot_write_to_the_corpus(
    engines: Engines, clean_database: None, table: str
) -> None:
    """Ingestion is privileged (`rag/store.py::ingest_corpus` says so in its own docstring), so a
    request-serving connection must not be able to alter what the assistant cites."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        document_id, chunk_id = await _insert_corpus(session)

    identifier = document_id if table == "knowledge_documents" else chunk_id
    column = "title" if table == "knowledge_documents" else "text"

    for statement in (
        f"UPDATE {table} SET {column} = 'tampered' WHERE id = :id",
        f"DELETE FROM {table} WHERE id = :id",
    ):
        with pytest.raises(DBAPIError):
            async with session_as(engines, new_user_id()) as session:
                await session.execute(text(statement), {"id": identifier})

    async with privileged_session(engines.privileged_sessionmaker) as session:
        survives = await session.scalar(
            text(f"SELECT id::text FROM {table} WHERE id = :id"), {"id": identifier}
        )
    assert survives == identifier, f"a request session altered {table}"


async def test_the_request_role_cannot_insert_into_the_corpus(
    engines: Engines, clean_database: None
) -> None:
    with pytest.raises(DBAPIError):
        async with session_as(engines, new_user_id()) as session:
            await _insert_corpus(session)


# =========================================================================== the shape of it


async def test_every_new_policy_is_scoped_to_the_restricted_role(
    privileged: AsyncSession,
) -> None:
    """Not PUBLIC, not ``anon``, not ``authenticated``.

    Supabase exposes ``public`` through PostgREST under its own roles, so a policy written for
    PUBLIC would hand the corpus and the snapshot history to anyone holding an anon key. Scoping
    every policy to ``weathra_request`` means the only way in is the request path's role switch.
    """
    rows = await privileged.execute(
        text(
            "SELECT tablename, policyname, roles::text[] FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = ANY(:tables)"
        ),
        {"tables": list(SHARED_TABLES)},
    )
    policies = rows.all()
    assert policies, "migration 0004 created no policies on the shared tables"
    for table, name, roles in policies:
        assert roles == [RESTRICTED_ROLE], (
            f"{table}.{name} is granted to {roles}; shared data must reach only {RESTRICTED_ROLE}"
        )


async def test_row_level_security_is_enabled_on_the_shared_tables(
    privileged: AsyncSession,
) -> None:
    """Enabled by 0004 rather than left to the platform, so a stock PostgreSQL and a real project
    agree on the property these tests exercise."""
    rows = await privileged.execute(
        text(
            "SELECT c.relname, c.relrowsecurity FROM pg_class c "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relname = ANY(:tables)"
        ),
        {"tables": list(SHARED_TABLES)},
    )
    for table, enabled in rows.all():
        assert enabled is True, f"row level security is not enabled on {table}"


async def test_the_shared_tables_are_not_forced(privileged: AsyncSession) -> None:
    """Forcing would apply these policies to the table owner, which is the privileged connection
    that ingests the corpus and expires snapshots — both of which legitimately touch every row."""
    rows = await privileged.execute(
        text(
            "SELECT c.relname, c.relforcerowsecurity FROM pg_class c "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relname = ANY(:tables)"
        ),
        {"tables": list(SHARED_TABLES)},
    )
    for table, forced in rows.all():
        assert forced is False, f"{table} is FORCE'd, which locks out the privileged routines"


async def test_no_granted_table_is_left_without_an_applicable_policy(
    privileged: AsyncSession,
) -> None:
    """The audit that generalises the defect.

    Any table where row level security is on, ``weathra_request`` holds a privilege, and no policy
    admits that role is a table the request path can reach in the ACL and not in practice. That
    combination is what made the corpus look empty, and it must never be reachable again — for a
    table added later just as much as for these three.
    """
    rows = await privileged.execute(
        text(
            """
            SELECT DISTINCT g.table_name
              FROM information_schema.role_table_grants g
              JOIN pg_class c ON c.relname = g.table_name
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             WHERE g.grantee = :role
               AND g.table_schema = 'public'
               AND c.relrowsecurity
               AND NOT EXISTS (
                     SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public'
                        AND p.tablename = g.table_name
                        AND ('public' = ANY(p.roles) OR :role = ANY(p.roles))
                   )
             ORDER BY 1
            """
        ),
        {"role": RESTRICTED_ROLE},
    )
    stranded = [row[0] for row in rows.all()]
    assert stranded == [], (
        f"{stranded} grant {RESTRICTED_ROLE} access that row level security then denies, because "
        "no policy admits the role. Add a policy or revoke the grant — never leave both."
    )


async def test_the_login_role_still_reaches_nothing_directly(privileged: AsyncSession) -> None:
    """0004 adds policies for the assumed role, not for the role that connects. If a policy ever
    named ``weathra_api``, skipping the role switch would stop being harmless."""
    rows = await privileged.execute(
        text(
            "SELECT count(*) FROM information_schema.role_table_grants "
            "WHERE grantee = :role AND table_schema = 'public'"
        ),
        {"role": LOGIN_ROLE},
    )
    assert rows.scalar() == 0

    named = await privileged.scalar(
        text("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND :role = ANY(roles)"),
        {"role": LOGIN_ROLE},
    )
    assert named == 0, f"a policy names {LOGIN_ROLE}; the role switch is what must grant access"


async def test_the_role_switch_is_still_what_grants_the_access(engines: Engines) -> None:
    """A session that has not assumed the restricted role is not covered by these policies — it is
    the owner, and reaches the data by ownership. The policies are what constrain the request path,
    so the switch has to remain the thing that puts a request under them."""
    async with session_as(engines, new_user_id()) as session:
        assert await session.scalar(text("SELECT current_user")) == RESTRICTED_ROLE

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT current_user")) != RESTRICTED_ROLE


async def test_user_owned_isolation_is_untouched_by_the_new_policies(
    engines: Engines, clean_database: None
) -> None:
    """0004 adds policies to shared tables only. The user-owned gate is the one that matters most,
    so it is re-checked here rather than assumed from the fact that nothing edited 0002."""
    from tests.db_support import insert_profile, insert_saved_location

    owner, intruder = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, owner)
        row_id = await insert_saved_location(session, owner)

    async with session_as(engines, intruder) as session:
        visible = await session.scalar(
            text("SELECT id::text FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
    assert visible is None, "another user's saved location is visible"

    async with session_as(engines, owner) as session:
        own = await session.scalar(
            text("SELECT id::text FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
    assert own == row_id, "the owner cannot see their own row"
