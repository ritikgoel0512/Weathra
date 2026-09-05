"""The three-role contract, checked without a database.

``0002`` creates ``weathra_request`` as ``NOLOGIN`` and every request assumes it with
``SET LOCAL ROLE``; ``0003`` creates the ``weathra_api`` login role that ``DATABASE_URL``
authenticates as and that holds the membership making the switch possible. The db-marked schema
tests assert the roles as Postgres actually ends up creating them. This file asserts the things a
database cannot show:

* that no credential is committed in the migration that creates a login role — the failure mode
  here leaks rather than breaks, so a test that only ran against a live database would never see
  it, and
* that the configuration example does not tell an operator to authenticate as the ``NOLOGIN`` role,
  which is the mistake this whole migration exists to correct. That example was wrong for a while
  and nothing caught it, because documentation is not executed.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = BACKEND_ROOT / "weathra" / "db" / "migrations" / "versions"
LOGIN_ROLE_MIGRATION = MIGRATIONS / "0003_request_login_role.py"
RLS_MIGRATION = MIGRATIONS / "0002_row_level_security.py"
ENV_EXAMPLE = BACKEND_ROOT / ".env.example"

LOGIN_ROLE = "weathra_api"
RESTRICTED_ROLE = "weathra_request"

# The attributes the login role must be created with, and why each one is on the list.
#   LOGIN         it is the identity DATABASE_URL connects as
#   NOINHERIT     membership must confer only the right to *become* the restricted role, never its
#                 privileges by default — otherwise SET LOCAL ROLE is decorative
#   NOBYPASSRLS   a request-serving identity that could bypass policies would defeat gate two
#   the four NO*  no privilege beyond logging in
REQUIRED_ATTRIBUTES = (
    "LOGIN",
    "NOINHERIT",
    "NOBYPASSRLS",
    "NOSUPERUSER",
    "NOCREATEDB",
    "NOCREATEROLE",
    "NOREPLICATION",
)

# Anything that assigns a password in SQL. Matched case-insensitively against the migration source,
# because `CREATE ROLE ... PASSWORD 'x'` and `ALTER ROLE ... PASSWORD 'x'` are the two ways a
# credential would get committed, and both read the same to a reviewer skimming a diff.
_PASSWORD_SQL = re.compile(r"\bPASSWORD\s+('|\"|:|%|\{)", re.IGNORECASE)


@pytest.fixture(scope="module")
def login_migration() -> str:
    return LOGIN_ROLE_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def migration_module() -> ModuleType:
    """The migration imported as a module, so its constants are read rather than pattern-matched.

    A revision file is not importable through the package — Alembic loads it by path — so this does
    the same thing Alembic does.
    """
    spec = importlib.util.spec_from_file_location("_m0003", LOGIN_ROLE_MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_names_the_two_roles(migration_module: ModuleType) -> None:
    assert migration_module.LOGIN_ROLE == LOGIN_ROLE
    assert migration_module.RESTRICTED_ROLE == RESTRICTED_ROLE


def test_it_follows_the_row_level_security_migration(migration_module: ModuleType) -> None:
    """Order is not cosmetic: the GRANT needs the role 0002 creates to already exist."""
    assert migration_module.revision == "0003_request_login_role"
    assert migration_module.down_revision == "0002_row_level_security"


@pytest.mark.parametrize("attribute", REQUIRED_ATTRIBUTES)
def test_the_login_role_is_created_with_the_intended_attributes(
    migration_module: ModuleType, attribute: str
) -> None:
    assert attribute in migration_module.LOGIN_ROLE_ATTRIBUTES.split()


def test_the_login_role_is_granted_membership_in_the_restricted_role(login_migration: str) -> None:
    assert "GRANT {RESTRICTED_ROLE} TO {LOGIN_ROLE}" in login_migration


def test_the_migration_assigns_no_password() -> None:
    """The one that matters. A committed credential is a leaked credential.

    ``0003`` creates the role with no password on purpose: under SCRAM it therefore cannot
    authenticate until a deployment sets one out of band, so the migration is safe to commit and
    the credential stays with the deployment (docs/deployment.md).
    """
    for migration in sorted(MIGRATIONS.glob("*.py")):
        source = migration.read_text(encoding="utf-8")
        match = _PASSWORD_SQL.search(source)
        assert match is None, (
            f"{migration.name} appears to assign a password at {match.start() if match else 0}. "
            "Role credentials are provisioned by deployment, never committed."
        )


@pytest.mark.parametrize(
    "source",
    [
        "op.execute(\"CREATE ROLE weathra_api LOGIN PASSWORD 'hunter2'\")",
        "op.execute(\"ALTER ROLE weathra_api PASSWORD 'hunter2'\")",
        'op.execute(f"CREATE ROLE {ROLE} LOGIN PASSWORD {password}")',
        'op.execute("CREATE ROLE r LOGIN PASSWORD :pw")',
    ],
)
def test_the_password_detector_catches_a_committed_credential(source: str) -> None:
    """A test that scans for a pattern is worth exactly as much as the pattern.

    Without this, a typo in the regex would turn the check above into a green light that checks
    nothing — which for a credential check is worse than having no check at all.
    """
    assert _PASSWORD_SQL.search(source) is not None


def test_the_downgrade_reverses_only_what_this_migration_owns(login_migration: str) -> None:
    """``weathra_request`` belongs to 0002. Reaching into it from here would break 0003's own
    upgrade path, and dropping a cluster-scoped login role would break a deployment's secret."""
    _, _, downgrade = login_migration.partition("def downgrade()")
    assert "REVOKE {RESTRICTED_ROLE} FROM {LOGIN_ROLE}" in downgrade
    assert "DROP ROLE" not in downgrade
    assert "ALTER ROLE" not in downgrade


def test_the_restricted_role_migration_is_unchanged_in_its_essentials() -> None:
    """0003 adds a role; it must not have quietly required 0002 to relax the one it protects."""
    source = RLS_MIGRATION.read_text(encoding="utf-8")
    assert "CREATE ROLE {RESTRICTED_ROLE} NOLOGIN NOBYPASSRLS" in source


# =========================================================================== the configuration


@pytest.fixture(scope="module")
def env_example() -> str:
    return ENV_EXAMPLE.read_text(encoding="utf-8")


def _database_url_line(env_example: str) -> str:
    for line in env_example.splitlines():
        if line.startswith("DATABASE_URL="):
            return line
    raise AssertionError("DATABASE_URL is not documented in .env.example")


def test_the_example_request_url_does_not_authenticate_as_the_restricted_role(
    env_example: str,
) -> None:
    """The defect this migration corrects. ``weathra_request`` is NOLOGIN, so an operator following
    the old example built a URL that could never connect."""
    line = _database_url_line(env_example)
    assert f"//{RESTRICTED_ROLE}:" not in line, (
        f"{RESTRICTED_ROLE} is NOLOGIN and cannot be connected as; DATABASE_URL authenticates as "
        f"{LOGIN_ROLE} and assumes {RESTRICTED_ROLE} per transaction."
    )


def test_the_example_request_url_authenticates_as_the_login_role(env_example: str) -> None:
    assert f"//{LOGIN_ROLE}" in _database_url_line(env_example)


def test_the_example_request_url_uses_a_session_mode_port(env_example: str) -> None:
    """Not 6543. Transaction mode has no prepared statements, which the asyncpg engine and the
    checkpointer's session-scoped ``SET ROLE`` both depend on."""
    assert ":6543/" not in _database_url_line(env_example)


def test_the_restricted_role_setting_still_names_the_assumed_role(env_example: str) -> None:
    """DATABASE_RESTRICTED_ROLE is the SET LOCAL ROLE target, not the login identity."""
    assert f"DATABASE_RESTRICTED_ROLE={RESTRICTED_ROLE}" in env_example
