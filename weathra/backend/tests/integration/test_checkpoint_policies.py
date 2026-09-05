"""Whether one user's conversation memory is reachable by another.

The checkpoint tables belong to LangGraph, so ownership could never be a column Weathra adds. What
they do carry is ``thread_id``, and Weathra only ever writes the composed key ``{user_id}:{thread}``
into it — so ``split_part(thread_id, ':', 1)`` recovers the owner, and a policy can compare that
against the acting subject exactly as the user-owned tables do. ``ensure_checkpoint_schema``
installs those policies, because nothing else can: the tables do not exist until the library makes
them, which is why no Alembic revision owns them.

Two things make these tests worth more than a reading of ``pg_policies``:

* a policy is only as strong as the identity bound on the connection, and the checkpointer does not
  use the request session's — it has its own psycopg pool. So every assertion here drives real SQL
  through that pool, under the restricted role, with a subject bound the way the saver binds it.
* the failure this guards against is silent in both directions. Too little access and conversation
  memory reads as empty; too much and one user's conversation is another's to read.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager

import pytest
from langchain_core.runnables import RunnableConfig
from psycopg import AsyncConnection
from psycopg.errors import InsufficientPrivilege
from psycopg.rows import DictRow
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import new_user_id, principal_for
from tests.graph_support import one_turn_graph
from weathra.config import Settings
from weathra.db.session import CLAIMS_SETTING
from weathra.domain.identity import compose_thread_key
from weathra.memory.checkpointer import (
    CHECKPOINT_TABLES,
    THREAD_SCOPED_CHECKPOINT_TABLES,
    Checkpointer,
    ensure_checkpoint_schema,
)

pytestmark = pytest.mark.db

RESTRICTED_ROLE = "weathra_request"
LOGIN_ROLE = "weathra_api"
BOOKKEEPING_TABLE = "checkpoint_migrations"
DML = ("SELECT", "INSERT", "UPDATE", "DELETE")

# Supabase ships these two for PostgREST. Created here when absent so the assertion that they reach
# no checkpoint data is made against the cluster shape a real project has, rather than skipped.
SUPABASE_API_ROLES = ("anon", "authenticated")


@pytest.fixture
async def checkpointer(
    checkpointer_schema: str, db_settings: Settings
) -> AsyncIterator[Checkpointer]:
    """An open checkpointer on the request-serving credential, as the API holds one."""
    opened = Checkpointer(db_settings)
    await opened.open()
    try:
        yield opened
    finally:
        await opened.close()


async def _write_a_turn(checkpointer: Checkpointer, user_id: str, thread_id: str) -> None:
    """Run a real graph turn as one user, which is what puts rows in all three tables."""
    principal = principal_for(user_id)
    async with checkpointer.acting_as(user_id):
        await (
            one_turn_graph()
            .compile(checkpointer=checkpointer.saver)
            .ainvoke({"turns": ["hello"]}, config=checkpointer.config_for(principal, thread_id))
        )


async def _as(
    checkpointer: Checkpointer, subject: str | None
) -> tuple[AbstractAsyncContextManager[AsyncConnection[DictRow]], AsyncConnection[DictRow]]:
    """A pooled connection under the restricted role with one subject bound, as the saver binds it."""
    connection = checkpointer.connection()
    conn = await connection.__aenter__()
    await conn.execute(
        "SELECT set_config(%s, %s, false)",
        (CLAIMS_SETTING, json.dumps({"sub": subject}) if subject else ""),
    )
    return connection, conn


async def _count_rows(checkpointer: Checkpointer, subject: str | None, key: str) -> int:
    connection, conn = await _as(checkpointer, subject)
    try:
        row = await (
            await conn.execute("SELECT count(*) AS n FROM checkpoints WHERE thread_id = %s", (key,))
        ).fetchone()
        assert row is not None
        return int(row["n"])
    finally:
        await connection.__aexit__(None, None, None)


# =========================================================================== the owner


async def test_a_user_can_read_back_its_own_turn(checkpointer: Checkpointer) -> None:
    user, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, user, thread)

    assert await checkpointer.load(principal_for(user), thread) is not None
    values = await checkpointer.channel_values(principal_for(user), thread)
    assert "hello" in values.get("turns", []), "the owner cannot read back its own turn"


async def test_a_user_can_continue_its_own_thread(checkpointer: Checkpointer) -> None:
    """A second turn updates state written by the first — the UPDATE half of the policy."""
    user, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, user, thread)
    after_one = list((await checkpointer.channel_values(principal_for(user), thread))["turns"])

    await _write_a_turn(checkpointer, user, thread)
    after_two = list((await checkpointer.channel_values(principal_for(user), thread))["turns"])

    assert len(after_two) > len(after_one), "the second turn did not update the stored state"
    assert after_two[: len(after_one)] == after_one, "the first turn's state was lost"


async def test_a_user_can_delete_its_own_thread(checkpointer: Checkpointer) -> None:
    user, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, user, thread)

    await checkpointer.forget(user, thread)
    assert await checkpointer.load(principal_for(user), thread) is None
    assert await _count_rows(checkpointer, user, compose_thread_key(user, thread)) == 0


# =========================================================================== the other user


async def test_another_user_cannot_read_the_rows(checkpointer: Checkpointer) -> None:
    """Addressed by the exact composed key, not by guessing — the policy is what refuses."""
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    key = compose_thread_key(owner, thread)

    assert await _count_rows(checkpointer, owner, key) > 0, "the owner cannot see its own rows"
    assert await _count_rows(checkpointer, new_user_id(), key) == 0


async def test_another_user_cannot_update_the_rows(checkpointer: Checkpointer) -> None:
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    key = compose_thread_key(owner, thread)

    connection, conn = await _as(checkpointer, new_user_id())
    try:
        cursor = await conn.execute(
            "UPDATE checkpoints SET metadata = '{\"tampered\": true}' WHERE thread_id = %s", (key,)
        )
        assert cursor.rowcount == 0, "another user's checkpoint was modified"
    finally:
        await connection.__aexit__(None, None, None)

    connection, conn = await _as(checkpointer, owner)
    try:
        row = await (
            await conn.execute(
                "SELECT metadata FROM checkpoints WHERE thread_id = %s LIMIT 1", (key,)
            )
        ).fetchone()
        assert row is not None, "the owner lost sight of its own row"
        assert "tampered" not in row["metadata"], "the row was modified despite the refusal"
    finally:
        await connection.__aexit__(None, None, None)


async def test_another_user_cannot_delete_the_rows(checkpointer: Checkpointer) -> None:
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    key = compose_thread_key(owner, thread)

    connection, conn = await _as(checkpointer, new_user_id())
    try:
        for table in THREAD_SCOPED_CHECKPOINT_TABLES:
            cursor = await conn.execute(f"DELETE FROM {table} WHERE thread_id = %s", (key,))
            assert cursor.rowcount == 0, f"another user deleted from {table}"
    finally:
        await connection.__aexit__(None, None, None)

    assert await checkpointer.load(principal_for(owner), thread) is not None


async def test_another_user_cannot_attach_a_write_to_the_thread(
    checkpointer: Checkpointer,
) -> None:
    """The `WITH CHECK` half. Reading is refused by returning nothing; writing has to raise."""
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    key = compose_thread_key(owner, thread)

    connection, conn = await _as(checkpointer, new_user_id())
    try:
        with pytest.raises(InsufficientPrivilege):
            await conn.execute(
                "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, "
                "metadata) VALUES (%s, '', %s, '{}', '{}')",
                (key, str(uuid.uuid4())),
            )
    finally:
        await connection.__aexit__(None, None, None)


async def test_a_spoofed_thread_key_reaches_nothing(checkpointer: Checkpointer) -> None:
    """The composed key is not a secret, so the test is what happens when it is known.

    An attacker holding the request credential and a valid session addresses the victim's key
    directly through the saver. The policy compares the key's owner against the *bound* subject,
    which is the attacker's, so the rows are not theirs to see.
    """
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    spoofed: RunnableConfig = {"configurable": {"thread_id": compose_thread_key(owner, thread)}}

    async with checkpointer.acting_as(new_user_id()):
        assert await checkpointer.saver.aget_tuple(spoofed) is None

    async with checkpointer.acting_as(owner):
        assert await checkpointer.saver.aget_tuple(spoofed) is not None


async def test_an_unbound_session_reaches_nothing(checkpointer: Checkpointer) -> None:
    """A leaked request credential with no principal is the case the policies exist for.

    ``weathra_current_user_id()`` is NULL, so the comparison is NULL, so every row is denied — the
    same way an unbound request session reads no user-owned row.
    """
    owner, thread = new_user_id(), str(uuid.uuid4())
    await _write_a_turn(checkpointer, owner, thread)
    key = compose_thread_key(owner, thread)

    assert await _count_rows(checkpointer, None, key) == 0

    with pytest.raises(InsufficientPrivilege):
        connection, conn = await _as(checkpointer, None)
        try:
            await conn.execute(
                "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, "
                "metadata) VALUES (%s, '', %s, '{}', '{}')",
                (key, str(uuid.uuid4())),
            )
        finally:
            await connection.__aexit__(None, None, None)


async def test_a_graph_invoked_outside_acting_as_writes_nothing(
    checkpointer: Checkpointer,
) -> None:
    """Fail closed, loudly. A run that skipped the binding must not quietly write unscoped rows."""
    user, thread = new_user_id(), str(uuid.uuid4())
    principal = principal_for(user)

    with pytest.raises(Exception, match=r"row-level security|permission denied"):
        await (
            one_turn_graph()
            .compile(checkpointer=checkpointer.saver)
            .ainvoke({"turns": ["hello"]}, config=checkpointer.config_for(principal, thread))
        )

    assert await _count_rows(checkpointer, user, compose_thread_key(user, thread)) == 0


# =========================================================================== the shape of it


async def test_row_level_security_is_enabled_on_every_thread_scoped_table(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    for table in THREAD_SCOPED_CHECKPOINT_TABLES:
        enabled = await privileged.scalar(
            text("SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(:t)"), {"t": table}
        )
        assert enabled is True, f"row level security is not enabled on {table}"


async def test_every_thread_scoped_table_has_an_owner_restricting_policy(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    for table in THREAD_SCOPED_CHECKPOINT_TABLES:
        rows = await privileged.execute(
            text(
                "SELECT policyname, cmd, roles::text[], qual, with_check FROM pg_policies "
                "WHERE schemaname = 'public' AND tablename = :t"
            ),
            {"t": table},
        )
        policies = rows.all()
        assert policies, f"{table} carries no policy, so it is deny-all under RLS"
        for name, _cmd, roles, using, with_check in policies:
            assert roles == [RESTRICTED_ROLE], f"{table}.{name} is granted to {roles}"
            assert "weathra_current_user_id()" in (using or ""), f"{table}.{name} tests no owner"
            assert "weathra_current_user_id()" in (with_check or ""), (
                f"{table}.{name} has no WITH CHECK, so a write could place a row under another "
                "owner"
            )


async def test_the_bookkeeping_table_is_privileged_only(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    """``checkpoint_migrations`` holds one integer and is written only by ``setup()``. An earlier
    version of this code granted the request role full DML on it; the grant is now revoked."""
    granted = await privileged.scalar(
        text(
            "SELECT count(*) FROM information_schema.role_table_grants "
            "WHERE grantee = :role AND table_schema = 'public' AND table_name = :t"
        ),
        {"role": RESTRICTED_ROLE, "t": BOOKKEEPING_TABLE},
    )
    assert granted == 0, f"{RESTRICTED_ROLE} holds privileges on {BOOKKEEPING_TABLE}"


async def test_the_restricted_role_holds_only_the_privileges_it_needs(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    for table in THREAD_SCOPED_CHECKPOINT_TABLES:
        rows = await privileged.execute(
            text(
                "SELECT DISTINCT privilege_type FROM information_schema.role_table_grants "
                "WHERE grantee = :role AND table_schema = 'public' AND table_name = :t"
            ),
            {"role": RESTRICTED_ROLE, "t": table},
        )
        held = {row[0] for row in rows}
        assert held == set(DML), f"{table}: {RESTRICTED_ROLE} holds {sorted(held)}"


async def test_the_login_role_reaches_no_checkpoint_table_directly(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    """``weathra_api`` connects; ``weathra_request`` is what may read. The switch is the boundary."""
    for table in CHECKPOINT_TABLES:
        for privilege in DML:
            granted = await privileged.scalar(
                text("SELECT has_table_privilege(:role, :t, :p)"),
                {"role": LOGIN_ROLE, "t": table, "p": f"{privilege} WITH GRANT OPTION"},
            )
            assert granted is False, f"{LOGIN_ROLE} holds direct {privilege} on {table}"

    named = await privileged.scalar(
        text("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND :r = ANY(roles)"),
        {"r": LOGIN_ROLE},
    )
    assert named == 0


async def test_supabases_api_roles_reach_no_checkpoint_data(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    """anon and authenticated are Supabase's PostgREST identities, not Weathra's."""
    for role in SUPABASE_API_ROLES:
        await privileged.execute(
            text(
                f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
                f"THEN CREATE ROLE {role} NOLOGIN; END IF; END $$"
            )
        )
    await privileged.commit()

    for role in SUPABASE_API_ROLES:
        for table in CHECKPOINT_TABLES:
            for privilege in DML:
                granted = await privileged.scalar(
                    text("SELECT has_table_privilege(:role, :t, :p)"),
                    {"role": role, "t": table, "p": privilege},
                )
                assert granted is False, f"{role} holds {privilege} on {table}"

    # Scoped to the checkpoint tables: 0002's owner-restricting policies are deliberately
    # unscoped, which makes them apply to every role rather than exempting any.
    named = await privileged.scalar(
        text(
            "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' "
            "AND tablename = ANY(:t) "
            "AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles) OR 'public' = ANY(roles))"
        ),
        {"t": list(CHECKPOINT_TABLES)},
    )
    assert named == 0, "a checkpoint policy names a Supabase API role or PUBLIC"


async def test_public_holds_no_checkpoint_privilege(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    granted = await privileged.scalar(
        text(
            "SELECT count(*) FROM information_schema.role_table_grants "
            "WHERE grantee = 'PUBLIC' AND table_schema = 'public' AND table_name = ANY(:t)"
        ),
        {"t": list(CHECKPOINT_TABLES)},
    )
    assert granted == 0


# =========================================================================== provisioning


async def test_provisioning_is_idempotent(db_settings: Settings, checkpointer_schema: str) -> None:
    """A deploy runs this every time. Twice must be the same as once — not two policies, and not
    a wider grant."""
    await ensure_checkpoint_schema(db_settings)
    await ensure_checkpoint_schema(db_settings)

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        user, thread = new_user_id(), str(uuid.uuid4())
        await _write_a_turn(checkpointer, user, thread)
        assert await checkpointer.load(principal_for(user), thread) is not None
        assert await _count_rows(checkpointer, new_user_id(), compose_thread_key(user, thread)) == 0
    finally:
        await checkpointer.close()


async def test_provisioning_refuses_a_database_without_the_claims_accessor(
    database_url: str,
) -> None:
    """Step one of failure atomicity: never report memory ready over tables nothing can reach.

    ``weathra_current_user_id()`` comes from migration 0002, so a database without it has not been
    migrated and the policies cannot be written. Setup must say so rather than create the tables,
    grant nothing, and return happily.
    """
    import psycopg
    from sqlalchemy.engine import make_url

    from weathra.db.urls import libpq_url

    name = f"weathra_nomig_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(libpq_url(database_url), autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        url = make_url(database_url).set(database=name).render_as_string(hide_password=False)
        settings = Settings(
            supabase_url="https://test.supabase.co",
            database_url=url,
            database_url_privileged=url,
        )
        with pytest.raises(RuntimeError, match="weathra_current_user_id"):
            await ensure_checkpoint_schema(settings)

        # The library's tables may exist — setup() runs first — but nothing was granted, so the
        # restricted role reaches nothing rather than reaching everything.
        with psycopg.connect(libpq_url(url), autocommit=True) as conn:
            granted = conn.execute(
                "SELECT count(*) FROM information_schema.role_table_grants "
                "WHERE grantee = %s AND table_schema = 'public'",
                (RESTRICTED_ROLE,),
            ).fetchone()
            assert granted is not None and granted[0] == 0
    finally:
        with psycopg.connect(libpq_url(database_url), autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def test_the_supabase_auto_rls_condition_is_repaired_by_provisioning(
    db_settings: Settings, checkpointer_schema: str, privileged: AsyncSession
) -> None:
    """The regression test for the defect itself.

    Supabase's ``ensure_rls`` event trigger enables row level security on every table created in
    ``public``, so the checkpoint tables arrive with RLS on and no policy — and a ``GRANT`` does not
    survive that. Dropping the policies while leaving RLS and the grants in place reproduces exactly
    that state; the owner's own memory becomes unreadable. Re-running provisioning must repair it.

    This is what fails if the policies are ever removed.
    """
    user, thread = new_user_id(), str(uuid.uuid4())
    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        await _write_a_turn(checkpointer, user, thread)
        key = compose_thread_key(user, thread)
        assert await _count_rows(checkpointer, user, key) > 0

        for table in THREAD_SCOPED_CHECKPOINT_TABLES:
            await privileged.execute(text(f"DROP POLICY IF EXISTS {table}_owner_only ON {table}"))
        await privileged.commit()

        # Grants intact, RLS on, no policy: the owner now reaches none of their own rows.
        assert await _count_rows(checkpointer, user, key) == 0
    finally:
        await checkpointer.close()

    await ensure_checkpoint_schema(db_settings)

    repaired = Checkpointer(db_settings)
    await repaired.open()
    try:
        assert await _count_rows(repaired, user, compose_thread_key(user, thread)) > 0
        assert await _count_rows(repaired, new_user_id(), compose_thread_key(user, thread)) == 0
    finally:
        await repaired.close()


async def test_retention_still_clears_expired_state_under_the_privileged_connection(
    db_settings: Settings, checkpointer_schema: str
) -> None:
    """The policies bind the request role. Retention is not it, and must stay unaffected: it
    deletes every expired user's rows and could never satisfy an owner predicate."""
    from weathra.db.urls import ConnectionRole

    user, thread = new_user_id(), str(uuid.uuid4())
    writer = Checkpointer(db_settings)
    await writer.open()
    try:
        await _write_a_turn(writer, user, thread)
    finally:
        await writer.close()

    privileged_checkpointer = Checkpointer(db_settings, role=ConnectionRole.PRIVILEGED)
    await privileged_checkpointer.open()
    try:
        await privileged_checkpointer.forget(user, thread)
    finally:
        await privileged_checkpointer.close()

    reader = Checkpointer(db_settings)
    await reader.open()
    try:
        assert await reader.load(principal_for(user), thread) is None
    finally:
        await reader.close()


async def test_the_saver_override_still_matches_the_library(checkpointer: Checkpointer) -> None:
    """``_cursor`` is the library's own seam, and Weathra overrides it to bind the subject.

    A LangGraph upgrade that renames or re-shapes it would silently stop binding anything, and the
    policies would then deny every request rather than scope it. Better to fail here, on a name.
    """
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    assert hasattr(AsyncPostgresSaver, "_cursor"), (
        "AsyncPostgresSaver._cursor is gone; the subject binding has no seam to attach to"
    )
    assert type(checkpointer.saver)._cursor is not AsyncPostgresSaver._cursor, (
        "the checkpointer's saver is not binding the acting subject"
    )
