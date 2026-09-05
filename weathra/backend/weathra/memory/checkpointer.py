"""Short-term conversation state, held in LangGraph's own Postgres checkpointer.

Design.md decision 11 chose the library's checkpointer over a hand-rolled store: graph state —
including an interrupted run mid-flight — persists correctly across instances and restarts without
reimplementing LangGraph's serialization, which is the part that would quietly rot.

**Scoping a table we do not own.** The checkpointer owns its schema, so ownership cannot be a
column we add. Three mechanisms combine instead, and the docstrings here are careful about which is
which:

* the checkpointer's ``thread_id`` is the composed key ``{user_id}:{thread_id}``, built only ever
  from the acting principal's own subject, so a caller cannot *address* another user's checkpoint
  without already knowing that user's subject;
* the ``threads`` row in ``memory/threads.py``, which we do own and which Row Level Security does
  cover, records the owner and is checked *before the graph is invoked at all*;
* **Row Level Security on the checkpoint tables themselves**, added by ``ensure_checkpoint_schema``.
  The composed key is not only a name — ``split_part(thread_id, ':', 1)`` recovers the owner, and
  the policies compare it against the same ``weathra_current_user_id()`` every user-owned table
  uses. So the composed key stopped being obscurity and became a predicate the database enforces.

The second is still the gate that produces a clean refusal; the third is what a leaked
request-serving credential runs into. Neither alone would be enough, which is why ``Checkpointer``
will not build a config from a bare string: every entry point here takes a ``Principal``, so there
is no code path that composes a key for a user other than the caller.

**Binding the acting subject.** A policy is only as good as the identity bound on the connection,
and the checkpointer does not use the request session's — it speaks psycopg over its own pool. So
every checkpoint statement runs inside :meth:`Checkpointer.acting_as`, which sets the subject the
policies read; a graph invoked outside it reaches nothing at all rather than everything. The
binding is cleared as each cursor closes and again as the connection returns to the pool.

**Its own connections, deliberately.** The checkpointer speaks psycopg, not SQLAlchemy, so it
cannot share the request engine's pool. It gets a small pool of its own on the *request-serving*
credential, and each connection assumes the restricted role the moment it is opened — this is
request-path work, and it must not run privileged. ``ensure_checkpoint_schema`` grants that role
DML on the three thread-scoped tables at deploy time and writes the policies that bound it to its
own threads; ``checkpoint_migrations`` is the library's schema bookkeeping and it gets nothing.

The one exception is the retention job, which passes ``role=ConnectionRole.PRIVILEGED``. That job
runs privileged from end to end and has no ``DATABASE_URL`` at all, so making it resolve the
request credential just to clear expired graph state would force a privileged-only process to hold
a request-serving one. It is the same reason ``Engines`` builds each of its two engines lazily.

**Unavailability is reported, never guessed around.** Every connection failure becomes
``MemoryUnavailable``, which ``memory/degradation.py`` turns into "conversation context is
unavailable" rather than an answer that silently had no context (``specs/memory``).
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from contextvars import ContextVar
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointTuple
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection, AsyncCursor, OperationalError
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout

from weathra.config import Settings
from weathra.db.session import CLAIMS_SETTING, validated_role_name
from weathra.db.urls import ConnectionRole, libpq_url, resolve_url
from weathra.domain.errors import MemoryUnavailable
from weathra.domain.identity import THREAD_KEY_SEPARATOR, Principal, compose_thread_key
from weathra.memory.availability import reporting_unavailable

__all__ = [
    "CHECKPOINT_TABLES",
    "THREAD_SCOPED_CHECKPOINT_TABLES",
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

# The three that carry ``thread_id`` — the composed ``{user_id}:{thread_id}`` key — and can
# therefore be scoped to their owner. ``checkpoint_migrations`` is the library's own schema-version
# bookkeeping: one integer column, written only by ``setup()`` under the privileged connection, and
# nothing the request role ever needs. It is deliberately absent here and deliberately un-granted.
THREAD_SCOPED_CHECKPOINT_TABLES = ("checkpoints", "checkpoint_blobs", "checkpoint_writes")

# One policy per table, named like 0002's so the two read as the same idea.
_POLICY_NAME = "{table}_owner_only"

# The owner recovered from the composed key, compared against the acting subject. `split_part` is
# unambiguous because `compose_thread_key` refuses the separator on both halves. An unbound session
# makes `weathra_current_user_id()` NULL, so the comparison is NULL, so the policy denies — the
# request role reaches nothing at all without a principal, which is the property that matters most.
_OWNER_PREDICATE = f"split_part(thread_id, '{THREAD_KEY_SEPARATOR}', 1) = weathra_current_user_id()"

# The acting subject for checkpoint work on this task. Set only by `Checkpointer` from an already
# validated `Principal` — or from a user id whose ownership the caller established — and never from
# request input, which is what keeps it unspoofable.
_ACTING_SUBJECT: ContextVar[str | None] = ContextVar("weathra_checkpoint_subject", default=None)

_BIND_CLAIMS_SQL = "SELECT set_config(%s, %s, false)"


def _claims_payload(subject: str | None) -> str:
    """The claims JSON the policies read, or an empty setting binding nobody."""
    return json.dumps({"sub": subject}) if subject else ""


class _ClaimsBindingSaver(AsyncPostgresSaver):
    """The library's saver, with the acting subject bound on whichever connection it picks up.

    The checkpointer holds a *pool*, and the saver takes a connection out of it per operation — so
    binding claims once at checkout, the way ``db/session.py`` does for a request transaction, is
    not available here. Overriding the one seam where the saver acquires its cursor is: every read
    and write LangGraph performs, including the ones it performs from inside a running graph, goes
    through it.

    The binding is session-scoped rather than transaction-scoped because the saver runs autocommit,
    where a transaction-local setting would not outlive the statement that set it. It is cleared
    again as the cursor closes, and the pool clears it once more when the connection is returned —
    two chances, because a setting left behind on a pooled connection is a cross-user leak.
    """

    @asynccontextmanager
    async def _cursor(self, *, pipeline: bool = False) -> AsyncIterator[AsyncCursor[DictRow]]:
        async with super()._cursor(pipeline=pipeline) as cursor:
            await cursor.execute(
                _BIND_CLAIMS_SQL, (CLAIMS_SETTING, _claims_payload(_ACTING_SUBJECT.get()))
            )
            try:
                yield cursor
            finally:
                # Suppressed because the connection may already be unusable — an error here would
                # replace whatever actually went wrong with a confusing one, and the pool's reset
                # is the guarantee that matters.
                with suppress(Exception):
                    await cursor.execute(_BIND_CLAIMS_SQL, (CLAIMS_SETTING, ""))


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
    """Create the checkpointer's tables and secure them, under the **privileged** connection.

    Runs at deploy time alongside the Alembic migrations. It cannot *be* an Alembic revision: the
    library creates its own tables, so a migration would have to duplicate LangGraph's schema and
    track its migrations by hand. What it can do — and now does — is finish the job a migration
    would have finished, because creating the tables is only half of it.

    **The other half is Row Level Security, and it is not optional.** A managed Postgres may switch
    RLS on for these tables the moment the library creates them: Supabase runs an ``ensure_rls``
    event trigger over everything created in ``public``. A ``GRANT`` does not survive that — RLS
    with no applicable policy denies every row to a role that is neither table owner nor
    ``BYPASSRLS`` — so granting alone would leave conversation memory silently unreadable. And the
    inverse, leaving RLS off where the platform does not switch it on, would leave every user's
    conversation state readable by anything holding the request credential. So this enables RLS
    itself and writes the policies, on every platform, rather than depending on either default.

    Checkpoint state is *user data*, unlike the corpus and the snapshots, so the policies are
    owner-restricting rather than merely role-scoped: the composed ``{user_id}:{thread_id}`` key in
    ``thread_id`` is what they test, against the same ``weathra_current_user_id()`` the user-owned
    tables use. That turns the composed key from obscurity into a third gate — ``memory/threads.py``
    is still the one checked before the graph runs.

    Not ``FORCE``d: forcing would apply the policies to the table owner, which is the privileged
    connection that retention runs on, and retention legitimately deletes every expired user's rows.

    Idempotent, and safe to re-run: the grants are re-asserted, the policies dropped and recreated.
    Re-running cannot widen anything, because the revoke below is unconditional and the policy set
    is replaced rather than added to.

    Raises rather than returning if the security half fails, so a deployment never reads
    "checkpointer schema ready" over tables that are RLS-enabled and reachable by nobody.
    """
    conninfo = libpq_url(resolve_url(settings, ConnectionRole.PRIVILEGED))
    role = validated_role_name(settings.database_restricted_role)

    async with AsyncPostgresSaver.from_conn_string(conninfo) as saver:
        await saver.setup()
        # `from_conn_string` yields a saver over a single connection, never a pool.
        connection = saver.conn
        if not isinstance(connection, AsyncConnection):  # pragma: no cover - shape guard
            raise RuntimeError("the checkpointer setup connection is not a plain connection")

        # The policies call it, so a database without it would produce policies that raise on every
        # row rather than a clear failure here. It comes from migration 0002; if it is missing, the
        # migrations have not been applied and nothing below is safe to do.
        accessor = await (
            await connection.execute(
                "SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                "WHERE n.nspname = 'public' AND p.proname = 'weathra_current_user_id'"
            )
        ).fetchone()
        if not accessor or not accessor["n"]:
            raise RuntimeError(
                "weathra_current_user_id() is absent, so the checkpoint policies cannot be "
                "written. Apply the Alembic migrations before provisioning the checkpointer."
            )

        # One transaction: either the tables end up secured, or the failure is visible and this
        # raises. A half-installed policy set is the state most likely to be mistaken for working.
        async with connection.transaction():
            # Bookkeeping only, and privileged-only. Revoked unconditionally because an earlier
            # deployment granted the request role full DML on it.
            await connection.execute(f"REVOKE ALL ON checkpoint_migrations FROM {role}")

            for table in THREAD_SCOPED_CHECKPOINT_TABLES:
                policy = _POLICY_NAME.format(table=table)
                await connection.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
                # Dropped first so a re-run replaces the policy instead of failing on it, and so a
                # policy from an older shape of this code cannot survive alongside the current one.
                await connection.execute(f"DROP POLICY IF EXISTS {policy} ON {table}")
                await connection.execute(
                    f"CREATE POLICY {policy} ON {table} FOR ALL TO {role} "
                    f"USING ({_OWNER_PREDICATE}) WITH CHECK ({_OWNER_PREDICATE})"
                )
                # After the policy, never before: until one exists the table is deny-all, which is
                # the safe direction to be caught halfway.
                await connection.execute(
                    f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {role}"
                )

    logger.info(
        "checkpointer schema ready; %s restricted to its own threads on %s",
        role,
        ", ".join(THREAD_SCOPED_CHECKPOINT_TABLES),
    )
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
        self._saver: _ClaimsBindingSaver | None = None

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

        async def clear_bound_claims(connection: AsyncConnection[DictRow]) -> None:
            """Unbind the acting subject as a connection goes back to the pool.

            The saver binds it session-wide, because it runs autocommit and a transaction-local
            setting would not outlive the statement. This is the guarantee that one request's
            subject cannot be inherited by the next request to draw the same connection — the
            saver clears it too, but only this runs whatever went wrong in between.
            """
            await connection.execute(_BIND_CLAIMS_SQL, (CLAIMS_SETTING, ""))

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
            reset=clear_bound_claims,
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
        self._saver = _ClaimsBindingSaver(conn=pool)

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

        Invoke the graph inside :meth:`acting_as`. The saver binds whatever subject is in scope, and
        outside that block there is none — so the policies match no row and the run reads and writes
        nothing. That is the safe direction to fail, but it is still a failure.
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

    @asynccontextmanager
    async def acting_as(self, user_id: str) -> AsyncIterator[None]:
        """Bind one subject for every checkpoint statement made inside this block.

        **The sanctioned way to run a graph.** ``config_for`` addresses the right rows; this is
        what makes the database agree — the checkpoint policies compare the composed key's owner
        against the bound subject, so a graph invoked outside this block reaches nothing at all
        rather than reaching everything.

        Takes a bare ``user_id`` because both kinds of caller already hold one they established:
        a request path that validated a ``Principal``, and the deletion paths that checked the
        ``threads`` row first. Nothing here reads a subject out of caller input.
        """
        token = _ACTING_SUBJECT.set(user_id)
        try:
            yield
        finally:
            _ACTING_SUBJECT.reset(token)

    def config_for(self, principal: Principal, thread_id: str) -> RunnableConfig:
        """The config a graph invocation for this principal's thread runs under."""
        return checkpoint_config(principal, thread_id)

    async def load(self, principal: Principal, thread_id: str) -> CheckpointTuple | None:
        """The latest checkpoint of one of this principal's threads, or ``None``.

        ``None`` for a thread that has no state *and* for a composed key that names another user's
        thread — the key simply does not match, so there is nothing to return. That is the
        obscurity half; ``memory/threads.py`` is what actually refuses the request.
        """
        async with reporting_unavailable("checkpointer"), self.acting_as(principal.user_id):
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
        async with reporting_unavailable("checkpointer"), self.acting_as(user_id):
            await self.saver.adelete_thread(compose_thread_key(user_id, thread_id))
