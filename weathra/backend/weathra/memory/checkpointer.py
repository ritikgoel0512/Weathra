"""Short-term conversation state, held in LangGraph's own Postgres checkpointer.

Design.md decision 11 chose the library's checkpointer over a hand-rolled store: graph state —
including an interrupted run mid-flight — persists correctly across instances and restarts without
reimplementing LangGraph's serialization, which is the part that would quietly rot.

**Scoping a table we do not own.** The checkpointer owns its schema, so ownership cannot be a
column we add. Two mechanisms combine instead, and the docstrings here are careful about which is
which:

* the checkpointer's ``thread_id`` is the composed key ``{user_id}:{thread_id}``, built only ever
  from the acting principal's own subject, so a caller cannot *address* another user's checkpoint
  without already knowing that user's subject — and even then the ownership check below refuses;
* the ``threads`` row in ``memory/threads.py``, which we do own and which Row Level Security does
  cover, records the owner and is checked *before the graph is invoked at all*.

The first is obscurity. The second is the gate. Neither alone would be enough, which is why
``Checkpointer`` will not build a config from a bare string: every entry point here takes a
``Principal``, so there is no code path that composes a key for a user other than the caller.

**Its own connections, deliberately.** The checkpointer speaks psycopg, not SQLAlchemy, so it
cannot share the request engine's pool. It gets a small pool of its own on the *request-serving*
credential, and each connection assumes the restricted role the moment it is opened — this is
request-path work, and it must not run privileged. The checkpoint tables carry no RLS policy (there
is no ownership column to write one against), so ``ensure_checkpoint_schema`` grants the restricted
role plain DML on them at deploy time; least privilege is all that connection gets.

The one exception is the retention job, which passes ``role=ConnectionRole.PRIVILEGED``. That job
runs privileged from end to end and has no ``DATABASE_URL`` at all, so making it resolve the
request credential just to clear expired graph state would force a privileged-only process to hold
a request-serving one. It is the same reason ``Engines`` builds each of its two engines lazily.

**Unavailability is reported, never guessed around.** Every connection failure becomes
``MemoryUnavailable``, which ``memory/degradation.py`` turns into "conversation context is
unavailable" rather than an answer that silently had no context (``specs/memory``).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointTuple
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection, OperationalError
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout

from weathra.config import Settings
from weathra.db.session import validated_role_name
from weathra.db.urls import ConnectionRole, libpq_url, resolve_url
from weathra.domain.errors import MemoryUnavailable
from weathra.domain.identity import Principal, compose_thread_key
from weathra.memory.availability import reporting_unavailable

__all__ = [
    "CHECKPOINT_TABLES",
    "Checkpointer",
    "checkpoint_config",
    "ensure_checkpoint_schema",
    "owner_of_checkpoint_key",
]

logger = logging.getLogger("weathra.memory.checkpointer")

# The tables LangGraph's saver creates. Named here only so the deploy-time grant and the retention
# routine have something to iterate; nothing in this package writes their columns directly.
CHECKPOINT_TABLES = (
    "checkpoint_migrations",
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
)

# psycopg connection settings the saver requires: dict rows because its own SQL reads by name, and
# no prepared-statement threshold because a pooler in front of Postgres may not support them.
_CONNECTION_KWARGS: dict[str, Any] = {
    "autocommit": True,
    "prepare_threshold": 0,
    "row_factory": dict_row,
}


def checkpoint_config(principal: Principal, thread_id: str) -> RunnableConfig:
    """The LangGraph config addressing one of *this* principal's threads.

    Takes a principal rather than a user id on purpose: the owner half of the composed key is
    always the acting subject, so this function cannot be used to address someone else's
    checkpoint even by a caller trying to.
    """
    return {"configurable": {"thread_id": principal.thread_key(thread_id)}}


def owner_of_checkpoint_key(key: str) -> str | None:
    """The user id inside a composed checkpoint key, or ``None`` if it carries none.

    Used by the retention routine to report what it removed, and by tests asserting that a key
    minted for one user does not address another's. Never an authorization decision: reading an
    owner out of a key the caller supplied would be trusting the caller.
    """
    owner, separator, thread = key.partition(":")
    if not separator or not owner or not thread:
        return None
    return owner


async def ensure_checkpoint_schema(settings: Settings) -> tuple[str, ...]:
    """Create the checkpointer's tables and grant the restricted role access to them.

    Runs under the **privileged** connection, at deploy time, alongside the Alembic migrations —
    the library creates its own tables, so this cannot be an Alembic revision without duplicating
    LangGraph's schema and having to track its migrations by hand.

    The grant is the second half, and it has to happen here rather than in a migration: the tables
    do not exist until the library makes them, so a grant written earlier would have nothing to
    grant on. There is no RLS policy — these tables have no ownership column to write one against,
    which is exactly why the composed key and the ``threads`` row both exist.

    Returns the tables it granted on, so a caller can report them.
    """
    conninfo = libpq_url(resolve_url(settings, ConnectionRole.PRIVILEGED))
    role = settings.database_restricted_role

    async with AsyncPostgresSaver.from_conn_string(conninfo) as saver:
        await saver.setup()
        for table in CHECKPOINT_TABLES:
            # A plain identifier, validated by the same rule the session role switch uses.
            await saver.conn.execute(  # type: ignore[union-attr]
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {validated_role_name(role)}"
            )

    logger.info("checkpointer schema ready; granted %s on %s", role, ", ".join(CHECKPOINT_TABLES))
    return CHECKPOINT_TABLES


class Checkpointer:
    """The process-wide checkpointer, owned by the application lifespan.

    Opened once and shared: LangGraph's saver is safe to use concurrently over a pool, and opening
    one per request would mean a connection handshake on every turn.
    """

    __slots__ = ("_pool", "_role", "_saver", "_settings")

    def __init__(
        self, settings: Settings, *, role: ConnectionRole = ConnectionRole.REQUEST
    ) -> None:
        self._settings = settings
        self._role = role
        self._pool: AsyncConnectionPool[AsyncConnection[DictRow]] | None = None
        self._saver: AsyncPostgresSaver | None = None

    # ---------------------------------------------------------------- lifecycle

    async def open(self, *, connect_timeout: float = 10.0) -> None:
        """Open the pool. Raises ``MemoryUnavailable`` if the store cannot be reached.

        A caller that wants the process to start anyway — the API, whose stateless capabilities must
        keep serving through a memory outage (``specs/memory``) — catches that and carries on.
        """
        if self._pool is not None:
            return

        conninfo = libpq_url(resolve_url(self._settings, self._role))
        role = validated_role_name(self._settings.database_restricted_role)

        async def assume_restricted_role(connection: AsyncConnection[DictRow]) -> None:
            """Drop every pooled connection to the restricted role as it is opened.

            Plain ``SET`` rather than ``SET LOCAL``: this pool belongs to the checkpointer alone,
            so the role should hold for the connection's whole life rather than one transaction.
            It is what makes "the checkpointer runs with no privilege beyond the request role" a
            property of the connection instead of a claim in a comment.
            """
            await connection.execute(f"SET ROLE {role}")

        pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
            conninfo,
            # One connection kept warm, rather than zero. With no minimum, ``open(wait=True)``
            # has nothing to wait *for* and returns happily against a database that is not there —
            # so an outage would first be noticed by a request instead of at startup.
            min_size=1,
            max_size=max(1, self._settings.database_pool_size),
            kwargs=_CONNECTION_KWARGS,
            # No role switch on the privileged connection: that pool exists for the retention job,
            # which is privileged work by definition, and dropping it to the request role would
            # only make it look constrained while the credential behind it was not.
            configure=(assume_restricted_role if self._role is ConnectionRole.REQUEST else None),
            open=False,
        )
        try:
            await pool.open(wait=True, timeout=connect_timeout)
        except (OperationalError, PoolTimeout) as exc:
            await pool.close()
            raise MemoryUnavailable(
                "The conversation memory store could not be reached.",
                details={"store": "checkpointer"},
            ) from exc

        self._pool = pool
        self._saver = AsyncPostgresSaver(conn=pool)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
        self._pool = None
        self._saver = None

    @property
    def is_open(self) -> bool:
        return self._saver is not None

    @property
    def saver(self) -> AsyncPostgresSaver:
        """The saver a graph is compiled against.

        Raises rather than returning ``None``: a graph compiled with no checkpointer would run and
        silently forget, which is precisely the dishonest degradation ``specs/memory`` forbids.
        """
        if self._saver is None:
            raise MemoryUnavailable(
                "The conversation memory store is not open, so no thread state can be read or "
                "written.",
                details={"store": "checkpointer"},
            )
        return self._saver

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[AsyncConnection[DictRow]]:
        """A raw pooled connection, already dropped to the restricted role.

        Not for reading checkpoints — the saver does that. It exists so the privilege the
        checkpointer actually holds can be inspected rather than assumed.
        """
        if self._pool is None:
            raise MemoryUnavailable(
                "The conversation memory store is not open.", details={"store": "checkpointer"}
            )
        async with reporting_unavailable("checkpointer"), self._pool.connection() as connection:
            yield connection

    # ---------------------------------------------------------------- scoped access

    def config_for(self, principal: Principal, thread_id: str) -> RunnableConfig:
        """The config a graph invocation for this principal's thread runs under."""
        return checkpoint_config(principal, thread_id)

    async def load(self, principal: Principal, thread_id: str) -> CheckpointTuple | None:
        """The latest checkpoint of one of this principal's threads, or ``None``.

        ``None`` for a thread that has no state *and* for a composed key that names another user's
        thread — the key simply does not match, so there is nothing to return. That is the
        obscurity half; ``memory/threads.py`` is what actually refuses the request.
        """
        async with reporting_unavailable("checkpointer"):
            return await self.saver.aget_tuple(self.config_for(principal, thread_id))

    async def channel_values(self, principal: Principal, thread_id: str) -> Mapping[str, Any]:
        """The stored channel values of a thread, or an empty mapping when it has none."""
        stored = await self.load(principal, thread_id)
        if stored is None:
            return {}
        return stored.checkpoint.get("channel_values", {})

    async def forget(self, user_id: str, thread_id: str) -> None:
        """Delete every checkpoint of one thread.

        Takes a bare ``user_id`` because both callers already established ownership: explicit
        deletion (which checked the ``threads`` row first) and the retention routine (which runs
        privileged over already-expired threads). Composing the key here rather than accepting one
        keeps "a key is always {owner}:{thread}" true in one place.
        """
        async with reporting_unavailable("checkpointer"):
            await self.saver.adelete_thread(compose_thread_key(user_id, thread_id))
