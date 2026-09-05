"""The migrations under an administrator that is not a superuser.

Every other `db`-marked test migrates as the container's ``postgres``, which is a superuser, and
that is what hid a real defect until the first migration against a real project: ``0003`` used to
re-assert the login role's attributes with a fixed ``ALTER ROLE … NOSUPERUSER NOREPLICATION …``,
and PostgreSQL refuses that for any role that does not itself hold the attribute — in *either*
direction, so naming ``NOSUPERUSER`` on a role that is already ``NOSUPERUSER`` still fails. A
managed Postgres never hands out superuser: Supabase's ``postgres`` has ``CREATEROLE``,
``CREATEDB`` and ``BYPASSRLS``, and neither ``SUPERUSER`` nor ``REPLICATION``. The whole upgrade
was rejected before any of it took effect.

So these tests run the real migration chain as a role shaped like that one. The point is not that
the roles come out right — ``test_db_schema.py`` already asserts that — but that they come out
right *without* a superuser applying them, which is the only environment that matters in
production and the one CI does not otherwise have.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from sqlalchemy.engine import make_url

from weathra.db.urls import libpq_url

pytestmark = pytest.mark.db

BACKEND_ROOT = Path(__file__).resolve().parents[2]

LOGIN_ROLE = "weathra_api"
RESTRICTED_ROLE = "weathra_request"

# The stand-in for Supabase's `postgres`. Deliberately not a superuser, and deliberately without
# REPLICATION: those two are exactly what the old fixed-list ALTER could not survive.
PROBE_ROLE = "weathra_migration_probe"
# Throwaway, for a role that exists only inside the test cluster and is dropped again at the end.
# The credentials that matter are never in the repository — see `test_db_roles.py`.
PROBE_PASSWORD = "probe-role-local-test-only"
PROBE_ATTRIBUTES = "LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS NOREPLICATION"

USER_OWNED = ("profiles", "preferences", "saved_locations", "threads", "agent_runs")
SHARED = ("forecast_snapshots", "knowledge_documents", "knowledge_chunks")


def _admin_connection(database_url: str) -> psycopg.Connection:
    """A cluster-administration connection, as whoever owns the test database."""
    return psycopg.connect(libpq_url(database_url), autocommit=True)


def _url_for(database_url: str, *, database: str, username: str, password: str | None) -> str:
    return (
        make_url(database_url)
        .set(username=username, password=password, database=database)
        .render_as_string(hide_password=False)
    )


def _owner_url(database_url: str, database: str) -> str:
    base = make_url(database_url)
    return _url_for(
        database_url, database=database, username=base.username or "", password=base.password
    )


def _probe_url(database_url: str, database: str) -> str:
    return _url_for(database_url, database=database, username=PROBE_ROLE, password=PROBE_PASSWORD)


def _alembic_config(url: str) -> object:
    """Alembic driven the way a deployment drives it, rather than reproducing the SQL here."""
    from alembic.config import Config

    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "weathra" / "db" / "migrations"))
    config.cmd_opts = type("Options", (), {"x": [f"url={url}"]})()
    return config


def _upgrade(url: str) -> None:
    from alembic import command

    command.upgrade(_alembic_config(url), "head")  # type: ignore[arg-type]


def _downgrade_to_base(url: str) -> None:
    from alembic import command

    command.downgrade(_alembic_config(url), "base")  # type: ignore[arg-type]


def _drop_probe_role(admin: psycopg.Connection) -> None:
    """Remove the probe and only what the probe itself granted.

    ``DROP OWNED BY`` is what makes the role droppable at all: a role that granted a membership is
    the grantor of it, and PostgreSQL refuses to drop a grantor. It touches nothing granted by the
    cluster owner in another test, which is the property that lets these tests share a cluster.
    """
    exists = admin.execute(
        "SELECT count(*) FROM pg_roles WHERE rolname = %s", (PROBE_ROLE,)
    ).fetchone()
    if not exists or not exists[0]:
        return
    admin.execute(sql.SQL("DROP OWNED BY {} CASCADE").format(sql.Identifier(PROBE_ROLE)))
    admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(PROBE_ROLE)))


def _grant_admin_option_on_existing_roles(admin: psycopg.Connection) -> None:
    """Hand the probe what it would hold on Supabase, where it is the role that created these.

    The roles are cluster-scoped, so a superuser-run migration in another test may already have
    created them. Without ADMIN OPTION the probe could not alter them at all, and the corrective
    ALTER these tests exist to exercise would fail for an unrelated reason.
    """
    for role in (LOGIN_ROLE, RESTRICTED_ROLE):
        present = admin.execute(
            "SELECT count(*) FROM pg_roles WHERE rolname = %s", (role,)
        ).fetchone()
        if present and present[0]:
            admin.execute(
                sql.SQL("GRANT {} TO {} WITH ADMIN OPTION").format(
                    sql.Identifier(role), sql.Identifier(PROBE_ROLE)
                )
            )


@pytest.fixture
def unprivileged_admin(database_url: str) -> Iterator[str]:
    """A Supabase-shaped migration administrator, and an empty database it owns.

    Yields the URL that authenticates as it. Skips rather than fails where the test cluster's own
    user cannot create roles and databases, since that says nothing about the migrations.
    """
    name = f"weathra_probe_{uuid.uuid4().hex[:12]}"

    with _admin_connection(database_url) as admin:
        capable = admin.execute(
            "SELECT rolsuper OR (rolcreaterole AND rolcreatedb) FROM pg_roles "
            "WHERE rolname = current_user"
        ).fetchone()
        if not (capable and capable[0]):
            pytest.skip("the test database's user cannot create roles and databases")

        _drop_probe_role(admin)  # a previous run that died before its teardown
        admin.execute(
            sql.SQL("CREATE ROLE {} {} PASSWORD {}").format(
                sql.Identifier(PROBE_ROLE),
                sql.SQL(PROBE_ATTRIBUTES),
                sql.Literal(PROBE_PASSWORD),
            )
        )
        admin.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(name), sql.Identifier(PROBE_ROLE)
            )
        )
        _grant_admin_option_on_existing_roles(admin)

    # On Supabase the migration role may install this itself; in a stock container the extension is
    # not trusted, so the cluster owner puts it there first. Either way it is 0001's
    # `CREATE EXTENSION IF NOT EXISTS` that runs under the probe.
    with psycopg.connect(_owner_url(database_url, name), autocommit=True) as fresh:
        fresh.execute("CREATE EXTENSION IF NOT EXISTS vector")

    try:
        yield _probe_url(database_url, name)
    finally:
        with _admin_connection(database_url) as admin:
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
            _drop_probe_role(admin)


def test_the_whole_chain_applies_without_a_superuser(unprivileged_admin: str) -> None:
    """0001 through 0003, applied by a role with no superuser and no REPLICATION.

    This is the test that would have caught the failure. It asserts nothing clever — that the
    upgrade completes at all is the finding.
    """
    _upgrade(unprivileged_admin)

    with psycopg.connect(unprivileged_admin, autocommit=True) as conn:
        revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    assert revision is not None and revision[0] == "0003_request_login_role"


def test_the_login_role_is_correct_when_a_non_superuser_created_it(
    unprivileged_admin: str, database_url: str
) -> None:
    """A migration that ran but left the role over-privileged would be no better than one that
    failed, so the attributes are asserted against what Postgres actually recorded."""
    _upgrade(unprivileged_admin)

    with _admin_connection(database_url) as admin:
        row = admin.execute(
            "SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreatedb, "
            "rolcreaterole, rolreplication FROM pg_roles WHERE rolname = %s",
            (LOGIN_ROLE,),
        ).fetchone()

    assert row is not None, f"the migration did not create {LOGIN_ROLE}"
    can_login, inherits, bypass, is_super, createdb, createrole, replication = row
    assert can_login is True, "DATABASE_URL authenticates as this role"
    assert inherits is False, "NOINHERIT is what keeps SET LOCAL ROLE load-bearing"
    assert bypass is False, "a request-serving identity must never bypass row level security"
    assert is_super is False, "the role must not be a superuser, however the migration was applied"
    assert (createdb, createrole, replication) == (False, False, False)


def test_the_membership_is_granted_when_a_non_superuser_migrates(
    unprivileged_admin: str, database_url: str
) -> None:
    """Without this grant the role switch every request performs would fail outright."""
    _upgrade(unprivileged_admin)

    with _admin_connection(database_url) as admin:
        granted = admin.execute(
            "SELECT r.rolname FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member "
            "JOIN pg_roles r ON r.oid = am.roleid WHERE m.rolname = %s",
            (LOGIN_ROLE,),
        ).fetchall()

    assert RESTRICTED_ROLE in {row[0] for row in granted}


def test_the_login_role_gains_no_table_privileges_when_a_non_superuser_migrates(
    unprivileged_admin: str,
) -> None:
    """Checked in the probe's own database, where the tables it created live. Before the role
    switch, a request-serving connection must be able to reach nothing."""
    _upgrade(unprivileged_admin)

    with psycopg.connect(unprivileged_admin, autocommit=True) as conn:
        for table in USER_OWNED + SHARED:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                granted = conn.execute(
                    "SELECT has_table_privilege(%s, %s, %s)",
                    (LOGIN_ROLE, table, f"{privilege} WITH GRANT OPTION"),
                ).fetchone()
                assert granted is not None and granted[0] is False, (
                    f"{LOGIN_ROLE} should hold no direct {privilege} on {table}"
                )


def test_an_over_privileged_login_role_stops_the_migration(
    unprivileged_admin: str, database_url: str
) -> None:
    """The replacement for what the unconditional ALTER used to promise.

    Naming only the clauses the administrator may change would otherwise mean a role left
    ``REPLICATION`` by someone else quietly stays that way and becomes the identity serving
    requests. The migration has to refuse instead of proceeding.
    """
    with _admin_connection(database_url) as admin:
        present = admin.execute(
            "SELECT count(*) FROM pg_roles WHERE rolname = %s", (LOGIN_ROLE,)
        ).fetchone()
        if not present or not present[0]:
            admin.execute(
                sql.SQL("CREATE ROLE {} LOGIN NOINHERIT").format(sql.Identifier(LOGIN_ROLE))
            )
        # Set by the cluster owner, and beyond anything the probe may clear: it holds no
        # REPLICATION, so PostgreSQL will not let it change that attribute in either direction.
        admin.execute(sql.SQL("ALTER ROLE {} REPLICATION").format(sql.Identifier(LOGIN_ROLE)))
        admin.execute(
            sql.SQL("GRANT {} TO {} WITH ADMIN OPTION").format(
                sql.Identifier(LOGIN_ROLE), sql.Identifier(PROBE_ROLE)
            )
        )

    try:
        with pytest.raises(Exception, match="hold no other attribute"):
            _upgrade(unprivileged_admin)
    finally:
        with _admin_connection(database_url) as admin:
            admin.execute(sql.SQL("ALTER ROLE {} NOREPLICATION").format(sql.Identifier(LOGIN_ROLE)))


def test_the_migrations_still_downgrade_and_reapply(database_url: str) -> None:
    """Task 3.2's cycle, kept intact by the fix. Run as the cluster owner, which owns the
    extension that 0001's downgrade drops — the probe does not, and is not asked to."""
    name = f"weathra_cycle_{uuid.uuid4().hex[:12]}"

    with _admin_connection(database_url) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))

    url = _owner_url(database_url, name)
    try:
        _upgrade(url)
        _downgrade_to_base(url)
        _upgrade(url)

        with psycopg.connect(url, autocommit=True) as conn:
            revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()
        assert revision is not None and revision[0] == "0003_request_login_role"
    finally:
        with _admin_connection(database_url) as admin:
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
