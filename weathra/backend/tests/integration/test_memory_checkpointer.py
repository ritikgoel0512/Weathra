"""Task 12.1 — the LangGraph checkpointer, its composed key, and what that key does and does not do.

Marked `db` throughout: the whole point of the library checkpointer is that state lands in
PostgreSQL and survives the process, and an in-memory saver would let every assertion here pass
while proving none of it.
"""

from __future__ import annotations

import pytest

from tests.db_support import new_user_id, principal_for
from tests.graph_support import one_turn_graph
from weathra.config import Settings
from weathra.memory.checkpointer import (
    THREAD_SCOPED_CHECKPOINT_TABLES,
    Checkpointer,
    checkpoint_config,
    owner_of_checkpoint_key,
)

pytestmark = pytest.mark.db

THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


# =========================================================================== the composed key


def test_the_key_is_the_owner_and_the_thread() -> None:
    principal = principal_for("11111111-1111-4111-8111-111111111111")
    config = checkpoint_config(principal, THREAD)
    assert config["configurable"]["thread_id"] == f"{principal.user_id}:{THREAD}"


def test_two_users_naming_the_same_thread_id_get_different_keys() -> None:
    """The raw thread id is not the address. The owner is half of it."""
    first = principal_for(new_user_id())
    second = principal_for(new_user_id())
    assert (
        checkpoint_config(first, THREAD)["configurable"]["thread_id"]
        != checkpoint_config(second, THREAD)["configurable"]["thread_id"]
    )


def test_the_owner_can_be_read_back_out_of_a_key() -> None:
    principal = principal_for(new_user_id())
    key = checkpoint_config(principal, THREAD)["configurable"]["thread_id"]
    assert owner_of_checkpoint_key(key) == principal.user_id


@pytest.mark.parametrize("key", ["", ":", "no-separator", ":thread-only", "owner-only:"])
def test_a_key_without_both_halves_names_no_owner(key: str) -> None:
    assert owner_of_checkpoint_key(key) is None


# =========================================================================== persistence


async def test_graph_state_persists_across_a_reinstantiated_checkpointer(
    db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    """The property design.md decision 11 chose the library checkpointer for.

    A *new* ``Checkpointer`` over a *new* pool stands in for a restarted process, or for the second
    backend instance the load balancer happens to route the follow-up to.
    """
    principal = principal_for(new_user_id())
    graph = one_turn_graph()

    first = Checkpointer(db_settings)
    await first.open()
    try:
        async with first.acting_as(principal.user_id):
            await graph.compile(checkpointer=first.saver).ainvoke(
                {"turns": ["hello"]}, config=first.config_for(principal, THREAD)
            )
    finally:
        await first.close()

    second = Checkpointer(db_settings)
    await second.open()
    try:
        values = await second.channel_values(principal, THREAD)
        assert values["turns"] == ["hello", "answered hello"]

        # And a follow-up run continues from that state rather than starting over.
        async with second.acting_as(principal.user_id):
            result = await graph.compile(checkpointer=second.saver).ainvoke(
                {"turns": ["and now?"]}, config=second.config_for(principal, THREAD)
            )
        assert result["turns"] == ["hello", "answered hello", "and now?", "answered and now?"]
    finally:
        await second.close()


async def test_a_thread_with_no_state_reads_as_empty(
    db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        principal = principal_for(new_user_id())
        assert await checkpointer.load(principal, THREAD) is None
        assert await checkpointer.channel_values(principal, THREAD) == {}
    finally:
        await checkpointer.close()


# =========================================================================== isolation


async def test_a_key_composed_for_one_user_cannot_address_anothers_checkpoint(
    db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    """Both users name the *same* raw thread id; only the owner reaches the state.

    Two things make that true, and this test only covers the first: the key is composed from the
    acting principal's own subject, so there is no code path by which the second user can build the
    first user's key. Since ``ensure_checkpoint_schema`` writes the policies, the database refuses
    the key even when it *is* known — ``test_checkpoint_policies.py`` covers that — and the
    ``threads`` ownership check in ``test_memory_threads.py`` is still what refuses the request.
    """
    owner = principal_for(new_user_id())
    other = principal_for(new_user_id())

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.acting_as(owner.user_id):
            await (
                one_turn_graph()
                .compile(checkpointer=checkpointer.saver)
                .ainvoke({"turns": ["secret"]}, config=checkpointer.config_for(owner, THREAD))
            )

        assert await checkpointer.load(other, THREAD) is None
        assert await checkpointer.channel_values(other, THREAD) == {}
        assert (await checkpointer.channel_values(owner, THREAD))["turns"][0] == "secret"
    finally:
        await checkpointer.close()


async def test_forget_removes_only_that_threads_checkpoints(
    db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    principal = principal_for(new_user_id())
    other_thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        compiled = one_turn_graph().compile(checkpointer=checkpointer.saver)
        async with checkpointer.acting_as(principal.user_id):
            for thread in (THREAD, other_thread):
                await compiled.ainvoke(
                    {"turns": ["hello"]}, config=checkpointer.config_for(principal, thread)
                )

        await checkpointer.forget(principal.user_id, THREAD)

        assert await checkpointer.load(principal, THREAD) is None
        assert await checkpointer.load(principal, other_thread) is not None
    finally:
        await checkpointer.close()


# =========================================================================== least privilege


async def test_the_checkpointer_connection_runs_as_the_restricted_role(
    db_settings: Settings, checkpointer_schema: str
) -> None:
    """Least privilege, asserted rather than asserted about.

    The checkpointer is request-path work: if its pool ran as the configured superuser, "no
    privileged connection on a request path" (design.md decision 5) would be false for the one
    connection nobody thinks to check.
    """
    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.connection() as connection:
            row = await (await connection.execute("SELECT current_role")).fetchone()
        assert row is not None
        assert row["current_role"] == db_settings.database_restricted_role
    finally:
        await checkpointer.close()


@pytest.mark.parametrize("table", THREAD_SCOPED_CHECKPOINT_TABLES)
async def test_the_restricted_role_can_write_each_thread_scoped_table(
    db_settings: Settings, checkpointer_schema: str, table: str
) -> None:
    """The deploy-time grant covers every table that holds thread state, not just the ones in use.

    ``checkpoint_migrations`` is excluded on purpose and asserted separately: it is the library's
    schema-version bookkeeping, written only by ``setup()`` under the privileged connection.
    """
    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.connection() as connection:
            row = await (
                await connection.execute(
                    "SELECT has_table_privilege(current_role, %s, 'INSERT') AS granted", (table,)
                )
            ).fetchone()
        assert row is not None
        assert row["granted"], f"the restricted role cannot write {table}"
    finally:
        await checkpointer.close()


async def test_the_restricted_role_cannot_write_the_bookkeeping_table(
    db_settings: Settings, checkpointer_schema: str
) -> None:
    """``checkpoint_migrations`` holds one integer and belongs to ``setup()``. An earlier version
    of the provisioning granted the request role full DML on it; that grant is revoked."""
    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.connection() as connection:
            row = await (
                await connection.execute(
                    "SELECT has_table_privilege(current_role, 'checkpoint_migrations', 'INSERT') "
                    "AS granted"
                )
            ).fetchone()
        assert row is not None
        assert not row["granted"], "the restricted role can write the library's bookkeeping table"
    finally:
        await checkpointer.close()


async def test_the_thread_scoped_tables_carry_an_owner_policy(
    checkpointer_schema: str, privileged: object
) -> None:
    """The composed key is row-level enforcement now, not only a name.

    ``ensure_checkpoint_schema`` writes one policy per thread-scoped table, comparing the key's
    owner against the acting subject. ``test_checkpoint_policies.py`` proves the behaviour; this
    records that the objects exist at all, and that the bookkeeping table has none.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    session: AsyncSession = privileged  # type: ignore[assignment]
    for table in THREAD_SCOPED_CHECKPOINT_TABLES:
        count = await session.scalar(
            text(
                "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' "
                "AND tablename = :table AND qual LIKE '%weathra_current_user_id%'"
            ),
            {"table": table},
        )
        assert count == 1, f"{table} carries {count} owner-restricting policies"

    bookkeeping = await session.scalar(
        text("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = :t"),
        {"t": "checkpoint_migrations"},
    )
    assert bookkeeping == 0
