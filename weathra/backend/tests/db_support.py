"""Fixtures for `db`-marked tests.

`db` tests need a real PostgreSQL with pgvector, because the things they assert — Row Level
Security policies, an HNSW index, a `set_config` claims binding — have no in-memory equivalent.
SQLite would let the tests pass while proving nothing.

The database comes from ``WEATHRA_TEST_DATABASE_URL``. CI provides it as a service container
(task 3.5); locally, any Postgres 16 with pgvector will do:

    docker run -d --name weathra-test-db -e POSTGRES_PASSWORD=weathra -e POSTGRES_DB=weathra \\
        -p 55432:5432 pgvector/pgvector:pg16
    export WEATHRA_TEST_DATABASE_URL=postgresql://postgres:weathra@127.0.0.1:55432/weathra

With the variable unset, every `db` test skips with that message rather than failing — and they are
deselected by default anyway.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import AbstractAsyncContextManager
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session, request_session
from weathra.domain.identity import Principal

BACKEND_ROOT = Path(__file__).resolve().parents[1]

SKIP_REASON = (
    "WEATHRA_TEST_DATABASE_URL is not set. `db` tests need a real PostgreSQL with pgvector; see "
    "tests/db_support.py for the one-line container command."
)


# Tables the truncation deliberately leaves alone, because none of them holds a test's rows.
#
# The first two are schema bookkeeping — emptying them would make the next test re-run every
# migration. The four after are the reference data migration 0008 seeds: the catalog, the shipped
# policies, the plans and their allowances. A deployed database always has them, so a test that ran
# against an empty catalog would be testing a state that never occurs, and every model resolution
# would fail for a reason no production deployment could reproduce. A test that adds its *own*
# catalog entry or policy is responsible for removing it.
PRESERVED_TABLES = (
    "alembic_version",
    "checkpoint_migrations",
    "subscription_plans",
    "model_catalog",
    "model_policies",
    "usage_limits",
)

_PRESERVED_TABLES_SQL = ", ".join(f"'{name}'" for name in PRESERVED_TABLES)


def test_database_url() -> str | None:
    return os.environ.get("WEATHRA_TEST_DATABASE_URL")


@pytest.fixture(scope="session")
def database_url() -> str:
    url = test_database_url()
    if not url:
        pytest.skip(SKIP_REASON)
    return url


@pytest.fixture(scope="session")
def migrated_database(database_url: str) -> Iterator[str]:
    """Apply every migration once per session, under the privileged connection.

    Applied rather than created from metadata: the Row Level Security policies, the extension, and
    the HNSW index exist only in migrations, so ``create_all`` would test a different schema from
    the one that gets deployed.
    """
    from alembic import command
    from alembic.config import Config

    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "weathra" / "db" / "migrations"))
    config.cmd_opts = type("Options", (), {"x": [f"url={database_url}"]})()

    command.upgrade(config, "head")
    yield database_url


@pytest.fixture(scope="session")
def checkpointer_schema(migrated_database: str) -> str:
    """Create LangGraph's checkpointer tables once, the way a deploy does.

    Separate from ``migrated_database`` because the library owns that schema: it is created by the
    saver's own ``setup()``, not by an Alembic revision (design.md decision 11).

    Every test that boots the app needs it, not only the memory tests: the thread and account
    deletion routes delete checkpoints, so an app built on the migrations alone raises
    ``UndefinedTable`` where a deployed one — which runs this at deploy time — would not.
    """
    import asyncio

    from weathra.memory.checkpointer import ensure_checkpoint_schema

    settings = Settings(
        supabase_url="https://test.supabase.co",
        database_url=migrated_database,
        database_url_privileged=migrated_database,
    )
    asyncio.run(ensure_checkpoint_schema(settings))
    return migrated_database


@pytest.fixture
def db_settings(migrated_database: str) -> Settings:
    """Settings pointed at the test database, in request-serving mode."""
    return Settings(
        supabase_url="https://test.supabase.co",
        database_url=migrated_database,
        database_url_privileged=migrated_database,
        database_pool_size=2,
        database_pool_max_overflow=0,
    )


@pytest.fixture
async def engines(db_settings: Settings) -> AsyncIterator[Engines]:
    built = Engines.create(db_settings)
    try:
        yield built
    finally:
        await built.dispose()


@pytest.fixture
async def privileged(engines: Engines) -> AsyncIterator[AsyncSession]:
    """A session with no role switch and no claims — the administrative connection."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        yield session


@pytest.fixture
async def clean_database(engines: Engines) -> AsyncIterator[None]:
    """Truncate every table before and after a test, so tests do not see each other's rows."""

    async def truncate() -> None:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            # Computed rather than listed. A new table would otherwise leak rows between tests
            # until someone remembered to add it here, and the exclusions are all data the
            # migrations themselves own rather than anything a test produced.
            rows = await session.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                    f"AND table_name NOT IN ({_PRESERVED_TABLES_SQL})"
                )
            )
            tables = sorted(row[0] for row in rows)
            if not tables:
                return

            # Only the tables that actually hold something. TRUNCATE writes a new relfilenode and
            # fsyncs it per table whether or not there was a row in it, which is unnoticeable at
            # ten tables and is not at twenty-one — most tests touch two or three. One round trip
            # finds them, and an EXISTS against an empty heap costs nothing.
            occupied = await session.execute(
                text(
                    " UNION ALL ".join(
                        f"SELECT '{name}' WHERE EXISTS (SELECT 1 FROM {name})" for name in tables
                    )
                )
            )
            dirty = sorted(row[0] for row in occupied)
            if dirty:
                await session.execute(text(f"TRUNCATE {', '.join(dirty)} CASCADE"))

    await truncate()
    try:
        yield
    finally:
        await truncate()


@pytest.fixture
async def seeded_reference_data(engines: Engines) -> AsyncIterator[None]:
    """Put the catalog, policies, plans and allowances back exactly as migration 0008 seeded them.

    ``clean_database`` deliberately preserves these four tables — a deployed database always has
    them, and a test running against an empty catalog would exercise a state that never occurs. The
    cost of that decision is this fixture: a test that *changes* a seeded row would otherwise leak
    into every test that ran after it, and the leak is invisible, because the next test still sees a
    perfectly plausible catalog. It was found exactly that way, by a promotion test reordering
    `balanced` and a later assertion quietly comparing the reordered list against itself.

    Restoring by re-running the seed rather than by undoing specific edits, so a test that changes
    something nobody anticipated is covered too.
    """
    await _reseed_reference_data(engines)
    try:
        yield
    finally:
        await _reseed_reference_data(engines)


async def _reseed_reference_data(engines: Engines) -> None:
    """Delete the four seeded tables and re-apply migration 0008's data."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "weathra_seed_0008",
        BACKEND_ROOT
        / "weathra"
        / "db"
        / "migrations"
        / "versions"
        / "0008_seed_model_policy_data.py",
    )
    assert spec is not None and spec.loader is not None
    seed_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed_module)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        # FK-safe order, and the first group is the part that is easy to get wrong: `model_catalog`
        # is referenced with ON DELETE RESTRICT by recorded usage and by evaluation results, so a
        # reseed that went straight for the catalog fails as soon as anything has recorded a call.
        # Those tables are a test's own rows — `clean_database` empties them too — so clearing them
        # here is removing test data rather than reaching past a boundary.
        for referencing in (
            "llm_usage_events",
            "model_comparison_results",
            "model_evaluations",
        ):
            await session.execute(text(f"DELETE FROM {referencing}"))
        for table in ("usage_limits", "user_plans", "subscription_plans", "model_policies"):
            await session.execute(text(f"DELETE FROM {table}"))
        await session.execute(text("DELETE FROM model_catalog"))
        await session.run_sync(lambda sync: seed_module.seed(sync.connection()))


def new_user_id() -> str:
    """A fresh auth subject. UUID-shaped because that is what Supabase issues."""
    return str(uuid.uuid4())


def claims_for(user_id: str, *, email: str | None = None) -> dict[str, object]:
    """A validated claim set as ``auth/tokens.py`` would produce it."""
    return {
        "sub": user_id,
        "email": email or f"{user_id[:8]}@example.test",
        "email_verified": True,
        "aud": "authenticated",
        "role": "authenticated",
    }


def principal_for(user_id: str, *, email: str | None = None) -> Principal:
    """A principal as ``auth/deps.py`` would build it from a validated token."""
    return Principal.from_claims(claims_for(user_id, email=email))


def session_as(engines: Engines, user_id: str | None) -> AbstractAsyncContextManager[AsyncSession]:
    """A request-scoped session acting as one user, exactly as a request would open it."""
    return request_session(
        engines.request_sessionmaker,
        claims=claims_for(user_id) if user_id else None,
        restricted_role=engines.settings.database_restricted_role,
    )


async def insert_profile(session: AsyncSession, user_id: str) -> None:
    """Create a profile row directly. Used to set up the *other* user in an isolation test."""
    await session.execute(
        text("INSERT INTO profiles (user_id) VALUES (:user_id) ON CONFLICT DO NOTHING"),
        {"user_id": user_id},
    )


async def insert_saved_location(
    session: AsyncSession, user_id: str, *, location_id: str = "loc:52.52,13.41"
) -> str:
    row_id = str(uuid.uuid4())
    await session.execute(
        text(
            "INSERT INTO saved_locations (id, user_id, location_id, label, location) "
            "VALUES (:id, :user_id, :location_id, :label, :location)"
        ),
        {
            "id": row_id,
            "user_id": user_id,
            "location_id": location_id,
            "label": "Berlin",
            "location": '{"display_name": "Berlin"}',
        },
    )
    return row_id


def sessionmaker_for(engines: Engines) -> async_sessionmaker:
    return engines.request_sessionmaker
