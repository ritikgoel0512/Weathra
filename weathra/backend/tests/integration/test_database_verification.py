"""Task 23.6 — the check that stands in for pointing the `db` suite at production.

Task 23.6 asks for the deployed Supabase database to be verified: migrations applied, pgvector
enabled, Row Level Security applied. The obvious way to do that is the one thing that must never
happen — the `db` suite truncates every user-owned table between tests (`tests/db_support.py`), so
running it against production would delete every account's data in order to prove a schema claim.

`scripts/verify_database.py` asserts the same schema properties directly, in a session PostgreSQL
refuses writes for, and `database-retention.yml` runs it against production before it deletes
anything. This file is what makes that script trustworthy: it runs against the disposable database
the rest of the `db` suite uses, and it checks both directions — that a correctly migrated database
passes, and that each property it claims to check actually fails when it is broken.

The second direction is the point. A verifier that returns PASS unconditionally is worse than no
verifier, because it converts an unchecked assumption into a recorded one; so every property is
broken here on purpose and the check is required to notice.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

from weathra.db.urls import sync_url

pytestmark = pytest.mark.db

BACKEND_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def verifier() -> ModuleType:
    """The script, imported from its path — it lives in `scripts/`, not in the package."""
    path = BACKEND_ROOT / "scripts" / "verify_database.py"
    assert path.is_file(), "scripts/verify_database.py is missing"
    spec = importlib.util.spec_from_file_location("weathra_verify_database", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # Registered before execution: `@dataclass` resolves its annotations through
    # `sys.modules[cls.__module__]`, so a module absent from it cannot define one.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def connection(migrated_database: str) -> Iterator[Connection]:
    """A plain synchronous connection to the migrated disposable database."""
    # `sync_url` is the same rewrite the migrations and the verifier use, so the driver here is
    # the driver production connects with rather than whatever the bare scheme defaults to.
    engine = create_engine(
        sync_url(migrated_database).render_as_string(hide_password=False), poolclass=NullPool
    )
    with engine.connect() as open_connection:
        yield open_connection
    engine.dispose()


@pytest.fixture
def head(verifier: ModuleType) -> str:
    return str(verifier.repository_head(BACKEND_ROOT))


def _named(checks: list[Any], name: str) -> Any:
    matching = [check for check in checks if check.name == name]
    assert matching, f"no check named {name!r}"
    return matching[0]


def test_a_migrated_database_passes_every_check(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """The whole of task 23.6's schema half, against a database built the way production is."""
    checks = verifier.verify(connection, head)
    failed = [check.name for check in checks if not check.ok]
    assert not failed, f"checks failed on a correctly migrated database: {failed}"

    names = [check.name for check in checks]
    assert "migrations applied" in names
    assert "pgvector enabled" in names
    assert any(name.startswith("RLS on ") for name in names)
    assert f"role {verifier.RESTRICTED_ROLE}" in names
    assert f"role {verifier.LOGIN_ROLE}" in names


def test_every_user_owned_table_is_covered(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """The table list comes from the models, so a new user-owned table is checked automatically.

    A verifier with a hand-written list would silently stop covering the newest table, which is
    exactly when RLS is most likely to have been forgotten.
    """
    from weathra.db.models import user_owned_tables

    covered = {
        check.name.removeprefix("RLS on ")
        for check in verifier.verify(connection, head)
        if check.name.startswith("RLS on ")
    }
    assert covered == set(user_owned_tables())


def test_an_unmigrated_database_is_reported(verifier: ModuleType, connection: Connection) -> None:
    """ "Applied" means applied to *this* chain, not merely that some version row exists."""
    check = _named(
        verifier.verify(connection, "0099_a_revision_that_does_not_exist"), "migrations applied"
    )
    assert not check.ok
    assert "repository head" in check.detail


def test_row_level_security_switched_off_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """Disabled RLS on one table, which is the shape of the mistake that matters."""
    connection.execute(text("ALTER TABLE profiles DISABLE ROW LEVEL SECURITY"))
    try:
        check = _named(verifier.verify(connection, head), "RLS on profiles")
        assert not check.ok
        assert "enabled=False" in check.detail
    finally:
        connection.execute(text("ALTER TABLE profiles ENABLE ROW LEVEL SECURITY"))


def test_row_level_security_not_forced_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """Enabled but not forced is the subtle one, and it is why `forced` is checked separately.

    Without FORCE, the table's owner — which is the role the migrations and the retention job
    connect as — bypasses the policies it defines. The policies would exist, `relrowsecurity` would
    be true, and a check that stopped there would report a protection that does not apply.
    """
    connection.execute(text("ALTER TABLE threads NO FORCE ROW LEVEL SECURITY"))
    try:
        check = _named(verifier.verify(connection, head), "RLS on threads")
        assert not check.ok
        assert "forced=False" in check.detail
    finally:
        connection.execute(text("ALTER TABLE threads FORCE ROW LEVEL SECURITY"))


def test_a_missing_policy_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """RLS with no policy denies everything, which reads as working until something needs a row.

    Its own transaction, rolled back: `DROP POLICY` is transactional, and undoing it that way
    restores the policy exactly. Re-issuing the migration's `CREATE POLICY` here instead would be a
    second definition of the same policy, free to drift from the migration and then prove nothing.
    """
    transaction = connection.begin()
    try:
        connection.execute(text("DROP POLICY preferences_owner_only ON preferences"))
        check = _named(verifier.verify(connection, head), "RLS on preferences")
        assert not check.ok
        assert "policies=0" in check.detail
    finally:
        transaction.rollback()


def test_a_login_capable_restricted_role_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """`weathra_request` must not be able to log in: it is assumed, never authenticated as."""
    connection.execute(text(f"ALTER ROLE {verifier.RESTRICTED_ROLE} LOGIN"))
    try:
        check = _named(verifier.verify(connection, head), f"role {verifier.RESTRICTED_ROLE}")
        assert not check.ok
        assert "canlogin=True" in check.detail
    finally:
        connection.execute(text(f"ALTER ROLE {verifier.RESTRICTED_ROLE} NOLOGIN"))


def test_a_bypassing_request_role_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """BYPASSRLS on the request role would make every policy in the database decorative."""
    connection.execute(text(f"ALTER ROLE {verifier.RESTRICTED_ROLE} BYPASSRLS"))
    try:
        check = _named(verifier.verify(connection, head), f"role {verifier.RESTRICTED_ROLE}")
        assert not check.ok
        assert "bypassrls=True" in check.detail
    finally:
        connection.execute(text(f"ALTER ROLE {verifier.RESTRICTED_ROLE} NOBYPASSRLS"))


def test_an_inheriting_login_role_is_caught(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """INHERIT would make the per-transaction `SET LOCAL ROLE` decorative.

    Membership in `weathra_request` would apply automatically to every query, so a request that
    skipped the role switch would still be answered — with the login role's rights.
    """
    connection.execute(text(f"ALTER ROLE {verifier.LOGIN_ROLE} INHERIT"))
    try:
        check = _named(verifier.verify(connection, head), f"role {verifier.LOGIN_ROLE}")
        assert not check.ok
        assert "inherit=True" in check.detail
    finally:
        connection.execute(text(f"ALTER ROLE {verifier.LOGIN_ROLE} NOINHERIT"))


@pytest.mark.parametrize("attribute", ["SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION"])
def test_a_privileged_login_role_is_caught(
    verifier: ModuleType, connection: Connection, head: str, attribute: str
) -> None:
    """Each of these lets the request path do something the restricted role exists to prevent."""
    connection.execute(text(f"ALTER ROLE {verifier.LOGIN_ROLE} {attribute}"))
    try:
        check = _named(verifier.verify(connection, head), f"role {verifier.LOGIN_ROLE}")
        assert not check.ok
        assert "holds" in check.detail
    finally:
        connection.execute(text(f"ALTER ROLE {verifier.LOGIN_ROLE} NO{attribute}"))


def test_no_check_reports_a_row_of_anyone_s_data(
    verifier: ModuleType, connection: Connection, head: str
) -> None:
    """Names, counts and booleans only: this runs against production and prints its findings."""
    for check in verifier.verify(connection, head):
        assert "@" not in check.detail, f"{check.name} reports something address-shaped"
        assert "://" not in check.detail, f"{check.name} reports something URL-shaped"


def test_the_dsn_is_scrubbed_from_a_failure(verifier: ModuleType) -> None:
    """A connection error is the one place a password turns up in prose."""
    scrub = verifier.scrubber("postgresql://user:hunter2@db.example.com:5432/postgres", "hunter2")
    scrubbed = scrub("could not connect to postgresql://user:hunter2@db.example.com:5432/postgres")
    assert "hunter2" not in scrubbed
    assert "«redacted»" in scrubbed
