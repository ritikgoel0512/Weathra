"""Task 25.3's RLS gate, asked of the deployed database rather than of a container.

Group 18.9 proves Row Level Security holds *independently of the data path*: every query Weathra
writes carries ``WHERE user_id = :actor``, and a test that only ever goes through a handler is
therefore testing the predicate rather than the policy. 18.9 omits the predicate deliberately. This
module does the same thing against the database production actually serves from.

**Why this is not the ``db`` suite pointed at production.** It must never be. ``tests/db_support.py``
truncates every table between tests, so running the ``db``-marked suite against the deployed
database would delete every user's rows to prove a schema claim. Nothing here writes: the session
is switched to ``transaction_read_only`` as its first act after the role drop, so a mistake in this
file is refused by PostgreSQL rather than executed, and every statement below is a ``SELECT``.

**Why the rows are not created here either.** 18.9's container version inserts a row for one user
and reads it back as another. It does not need to here, and should not: both deployed accounts
already own rows — a profile at minimum, created the first time each signed in — so the question
can be asked over data that is genuinely somebody's without this module producing any. The
"restrictive, not simply broken" half is the same query run under each subject's own claims: each
must see itself, and neither may see the other.

The claims are built the way ``auth/tokens.py`` produces them and bound the way ``request_session``
binds them, because binding them some other way would be testing this module rather than the gate.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.live_support import (
    SECOND_ACCOUNT_VARIABLES,
    Credentials,
    Target,
    assert_status,
    credentials_from_env,
    fetch,
    json_body,
    sign_in,
    target_from_env,
)
from weathra.db.models import ownership_column, user_owned_tables
from weathra.db.session import bind_claims
from weathra.db.urls import async_url

pytestmark = pytest.mark.deployed

# The role a request-serving session drops to. Configuration in the application; a constant here
# because this module is asking about the deployment's role, not about a Settings default.
RESTRICTED_ROLE = "weathra_request"

DATABASE_VARIABLES = ("WEATHRA_LIVE_DATABASE_URL", "DATABASE_URL")


@pytest.fixture(scope="module")
def deployed_database_url() -> str:
    """The deployed database's request-serving URL, or a skip naming what it wants."""
    for name in DATABASE_VARIABLES:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    pytest.skip(
        "the deployed RLS gate needs the deployed database's request connection; set one of: "
        + ", ".join(DATABASE_VARIABLES)
    )


@pytest.fixture(scope="module")
def sessionmaker(deployed_database_url: str) -> Iterator[async_sessionmaker]:
    """A sessionmaker over the deployed request connection, pooling nothing.

    ``NullPool`` rather than the application's pool, and the reason is the test runner rather than
    the database: each async test here runs on its own event loop, and a pooled asyncpg connection
    opened on one loop cannot be handed to the next. It also means this module holds no connection
    against the deployment's limit between checks, which matters when the deployment is serving.
    """
    engine = create_async_engine(async_url(deployed_database_url), poolclass=NullPool, echo=False)
    yield async_sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def _reading_as(
    maker: async_sessionmaker, user_id: str | None
) -> AsyncIterator[AsyncSession]:
    """A request-scoped session acting as one subject, and incapable of writing.

    The order mirrors ``request_session`` — claims bound while still the configured user, then the
    role drop — with one statement added: ``transaction_read_only`` is turned on immediately after,
    so PostgreSQL itself refuses any write for the rest of the transaction. It is set after the
    claims rather than before because ``set_config`` is the thing binding them, and a read-only
    transaction cannot be turned back off once a write has happened — which is the guarantee.
    """
    claims = (
        {
            "sub": user_id,
            "aud": "authenticated",
            "role": "authenticated",
            "email_verified": True,
        }
        if user_id
        else None
    )
    async with maker() as session:
        await session.begin()
        try:
            await bind_claims(session, claims)
            await session.execute(text(f"SET LOCAL ROLE {RESTRICTED_ROLE}"))
            await session.execute(text("SET LOCAL transaction_read_only = on"))
            yield session
        finally:
            await session.rollback()


@pytest.fixture(scope="module")
def credentials() -> Credentials:
    """One deployed account is enough for most of this module; `subjects` asks for the second."""
    found, missing = credentials_from_env()
    if found is None:
        pytest.skip(
            "the deployed RLS gate needs a deployed account; missing: " + ", ".join(missing)
        )
    return found


@pytest.fixture(scope="module")
def target() -> Target:
    return target_from_env()


def _subject_of(credentials: Credentials, target: Target, email: str, password: str) -> str:
    """The subject the deployment acts as for one account, taken from `/me` rather than assumed."""
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        token = sign_in(client, credentials, email, password)
        response = fetch(
            client, "GET", target.api("/me"), headers={"Authorization": f"Bearer {token}"}
        )
        assert_status(response, 200, *credentials.secrets)
        identifier = json_body(response, *credentials.secrets).get("user_id")
    assert isinstance(identifier, str) and identifier
    return identifier


@pytest.fixture(scope="module")
def one_subject(credentials: Credentials, target: Target) -> str:
    """The first account's subject.

    Separate from `subjects` because three of the checks below need *a* real subject rather than
    two distinct ones — the role switch, the claims binding and the anonymous session are
    properties of one session, and skipping them for want of a second account would withhold
    evidence the single account can give.
    """
    return _subject_of(credentials, target, credentials.user_a_email, credentials.user_a_password)


@pytest.fixture(scope="module")
def subjects(credentials: Credentials, target: Target) -> tuple[str, str]:
    """The two deployed accounts' subjects, taken from the deployment rather than assumed.

    Asked of `/me` with each account's own session, so the identifiers under test are the ones the
    backend itself acts as — not something read out of the database and matched by hope.
    """
    if not credentials.has_second_account:
        pytest.skip(
            "'one subject cannot see another's row' needs a second account; missing: "
            + ", ".join(SECOND_ACCOUNT_VARIABLES)
        )
    assert credentials.user_b_email and credentials.user_b_password
    first = _subject_of(credentials, target, credentials.user_a_email, credentials.user_a_password)
    second = _subject_of(credentials, target, credentials.user_b_email, credentials.user_b_password)
    if first == second:
        pytest.skip(
            "both live accounts resolve to the same deployed subject, so 'no subject sees "
            "another's row' has no second subject to ask about; point "
            + " and ".join(SECOND_ACCOUNT_VARIABLES)
            + " at a second account"
        )
    return first, second


# ------------------------------------------------------------------ the gate, structurally


async def test_every_user_owned_table_has_row_level_security_enabled_and_forced(
    sessionmaker: async_sessionmaker,
) -> None:
    """The guard on the guard, on the deployed schema.

    ``FORCE`` matters as much as ``ENABLE``: without it the table's owner is exempt from the
    policies it defines, so every isolation assertion below would hold for the restricted role and
    silently not hold for the connection migrations run under.
    """
    async with _reading_as(sessionmaker, None) as session:
        for table in user_owned_tables():
            row = (
                await session.execute(
                    text(
                        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                        "WHERE oid = to_regclass(:table)"
                    ),
                    {"table": table},
                )
            ).one_or_none()
            assert row is not None, f"{table} does not exist on the deployed database"
            enabled, forced = row
            assert enabled, f"{table} has no row level security on the deployed database"
            assert forced, f"{table} does not FORCE it, so the owner would bypass the policy"

            policies = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' "
                    "AND tablename = :table"
                ),
                {"table": table},
            )
            assert policies and policies >= 1, f"{table} carries no owner-restricting policy"


async def test_the_deployed_restricted_role_cannot_bypass_the_policies(
    sessionmaker: async_sessionmaker,
) -> None:
    """``NOBYPASSRLS`` and ``NOLOGIN``, without which every policy above would be advisory."""
    async with _reading_as(sessionmaker, None) as session:
        row = (
            await session.execute(
                text("SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = :r"),
                {"r": RESTRICTED_ROLE},
            )
        ).one_or_none()

    assert row is not None, f"the deployed database has no {RESTRICTED_ROLE} role"
    bypass, superuser, can_login = row
    assert not bypass, "the deployed restricted role can bypass Row Level Security"
    assert not superuser
    assert not can_login, "and it is NOLOGIN, so it cannot be connected to directly"


async def test_a_request_session_on_the_deployed_database_runs_as_the_restricted_role(
    sessionmaker: async_sessionmaker, one_subject: str
) -> None:
    """Without the role switch the policies would not bind at all."""
    async with _reading_as(sessionmaker, one_subject) as session:
        role = await session.scalar(text("SELECT current_role"))
        bound = await session.scalar(text("SELECT weathra_current_user_id()"))
        read_only = await session.scalar(text("SELECT current_setting('transaction_read_only')"))

    assert role == RESTRICTED_ROLE
    assert bound == one_subject, "the acting subject's claims are not bound"
    assert read_only == "on", "this module is able to write to the deployed database"


# ------------------------------------------------------------------ the gate, behaviourally


@pytest.mark.parametrize("table", [t for t in user_owned_tables() if t != "usage_counters"])
async def test_no_subject_sees_another_s_row_with_the_ownership_predicate_omitted(
    sessionmaker: async_sessionmaker, subjects: tuple[str, str], table: str
) -> None:
    """18.9 against the deployed database: no ``WHERE``, and still nobody else's rows.

    ``usage_counters`` is excluded because it is keyed by ``subject`` rather than by a user, and
    holds an internal subject alongside the accounts — it is 34.x's table and is covered there.
    Every other user-owned table is asked the same question in both directions.
    """
    first, second = subjects
    column = ownership_column(table)

    for actor, other in ((first, second), (second, first)):
        async with _reading_as(sessionmaker, actor) as session:
            rows = await session.execute(text(f"SELECT DISTINCT {column} FROM {table}"))
            visible = {str(row[0]) for row in rows if row[0] is not None}

        assert other not in visible, f"{table} let the other account's row through: {table}"
        assert visible <= {actor}, (
            f"{table} returned rows owned by neither the actor nor nobody: "
            f"{sorted(visible - {actor})}"
        )


async def test_the_policy_is_restrictive_rather_than_simply_returning_nothing(
    sessionmaker: async_sessionmaker, subjects: tuple[str, str]
) -> None:
    """The other half, and the one that makes the test above mean something.

    A policy that returned nothing to everybody would pass every assertion above. Each account has
    a profile row — created the first time it signed in, and read back through `/me` a moment ago —
    so each must see exactly its own, with no ownership predicate in the query.
    """
    first, second = subjects
    for actor in (first, second):
        async with _reading_as(sessionmaker, actor) as session:
            rows = await session.execute(text("SELECT user_id FROM profiles"))
            visible = {str(row[0]) for row in rows}
        assert visible == {actor}, (
            f"a subject's own profile is not what its own session sees: {sorted(visible)}"
        )
    assert first != second


async def test_a_session_with_no_subject_sees_no_user_owned_row(
    sessionmaker: async_sessionmaker, one_subject: str
) -> None:
    """A public endpoint reads no user-owned row on the deployed database either."""
    async with _reading_as(sessionmaker, None) as session:
        for table in user_owned_tables():
            found = await session.scalar(text(f"SELECT count(*) FROM {table}"))
            assert found == 0, f"an unauthenticated session saw a row in {table}"


async def test_claims_do_not_survive_into_the_next_use_of_a_pooled_connection(
    sessionmaker: async_sessionmaker, one_subject: str
) -> None:
    """``SET LOCAL`` scoped to the transaction, asserted against the deployed database."""
    async with _reading_as(sessionmaker, one_subject) as session:
        bound = await session.scalar(text("SELECT weathra_current_user_id()"))
    assert bound == one_subject

    async with _reading_as(sessionmaker, None) as session:
        after = await session.scalar(text("SELECT weathra_current_user_id()"))
    assert after is None, "the previous session's identity survived into an anonymous one"
