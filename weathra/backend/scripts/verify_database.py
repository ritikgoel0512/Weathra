#!/usr/bin/env python3
"""Verify the deployed database is configured the way task 23.6 requires, without touching it.

Task 23.6 asks for pgvector enabled, Row Level Security applied, and the migrations applied, on the
deployed Supabase database. None of that can be seen from a development machine — the privileged
connection lives only in CI — and the obvious way to check it is the one thing that must never
happen: the ``db``-marked suite truncates every table between tests (``tests/db_support.py``), so
pointing it at production would delete every user's data to prove a schema claim.

So this asserts the same properties the suite asserts about the schema, directly against the
deployed database, in a session PostgreSQL itself refuses writes for:

* the migration chain is applied and at the repository's head, with exactly one version row;
* the ``vector`` extension exists, so pgvector is enabled rather than merely depended upon;
* every user-owned table has Row Level Security **enabled and forced**, with at least one policy —
  forced matters because the tables' owner would otherwise bypass the policies it defines;
* the two roles exist with the attributes the design depends on: ``weathra_request`` cannot log in
  and cannot bypass RLS, and ``weathra_api`` can log in, does not inherit, and holds none of
  ``SUPERUSER``, ``CREATEDB``, ``CREATEROLE``, ``REPLICATION`` or ``BYPASSRLS``.

**Read-only is enforced by the server, not by care.** The session is opened with
``postgresql_readonly=True``, so a mistake in this file is refused by PostgreSQL rather than
executed. It runs under the privileged connection because the request role cannot see another
user's rows or the catalogue entries that prove the policies exist — and every failure message is
scrubbed of the DSN before it is printed, because a connection error is the one place a password
turns up in prose.

It prints names, counts and booleans. It never prints a row of anyone's data.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import engine_from_config, text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

from weathra.config import Settings
from weathra.db.models import user_owned_tables
from weathra.db.urls import ConnectionRole, resolve_url, sync_url

RESTRICTED_ROLE = "weathra_request"
LOGIN_ROLE = "weathra_api"

# Attributes that would each defeat a different part of the design, so each is named rather than
# summarised: inheritance would make the per-transaction `SET LOCAL ROLE` decorative, and any of the
# rest would let the request path do something the restricted role exists to prevent.
FORBIDDEN_LOGIN_ROLE_ATTRIBUTES = ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication")


@dataclass(frozen=True)
class Check:
    """One verified property: what was asked, whether it holds, and what was seen."""

    name: str
    ok: bool
    detail: str


def repository_head(backend_root: Path) -> str:
    """The head revision this checkout defines, so "applied" means "applied to *this* chain"."""
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "weathra" / "db" / "migrations"))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise RuntimeError(f"the migration chain has {len(heads)} heads; expected exactly one")
    return heads[0]


def check_migrations(connection: Connection, head: str) -> Check:
    rows = connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
    if len(rows) != 1:
        return Check("migrations applied", False, f"{len(rows)} version rows; expected exactly one")
    applied = rows[0]
    return Check(
        "migrations applied",
        applied == head,
        f"at {applied}" if applied == head else f"at {applied}, repository head is {head}",
    )


def check_pgvector(connection: Connection) -> Check:
    version = connection.execute(
        text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
    ).scalar_one_or_none()
    return Check(
        "pgvector enabled",
        version is not None,
        f"vector {version}" if version else "the vector extension is not installed",
    )


def check_row_level_security(connection: Connection) -> list[Check]:
    """RLS enabled *and* forced *and* carrying policies, per user-owned table."""
    state = connection.execute(
        text(
            """
            SELECT c.relname            AS table_name,
                   c.relrowsecurity     AS enabled,
                   c.relforcerowsecurity AS forced,
                   (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = ANY(:tables)
            """
        ),
        {"tables": list(user_owned_tables())},
    )
    seen = {row.table_name: row for row in state}

    checks: list[Check] = []
    for table in user_owned_tables():
        row = seen.get(table)
        if row is None:
            checks.append(Check(f"RLS on {table}", False, "the table does not exist"))
            continue
        ok = bool(row.enabled) and bool(row.forced) and row.policies > 0
        checks.append(
            Check(
                f"RLS on {table}",
                ok,
                f"enabled={row.enabled} forced={row.forced} policies={row.policies}",
            )
        )
    return checks


def check_roles(connection: Connection) -> list[Check]:
    rows = connection.execute(
        text(
            """
            SELECT rolname, rolcanlogin, rolbypassrls, rolinherit,
                   rolsuper, rolcreatedb, rolcreaterole, rolreplication
              FROM pg_roles
             WHERE rolname = ANY(:names)
            """
        ),
        {"names": [RESTRICTED_ROLE, LOGIN_ROLE]},
    )
    seen = {row.rolname: row for row in rows}

    checks: list[Check] = []

    restricted = seen.get(RESTRICTED_ROLE)
    if restricted is None:
        checks.append(Check(f"role {RESTRICTED_ROLE}", False, "the role does not exist"))
    else:
        ok = not restricted.rolcanlogin and not restricted.rolbypassrls
        checks.append(
            Check(
                f"role {RESTRICTED_ROLE}",
                ok,
                f"canlogin={restricted.rolcanlogin} bypassrls={restricted.rolbypassrls}",
            )
        )

    login = seen.get(LOGIN_ROLE)
    if login is None:
        checks.append(Check(f"role {LOGIN_ROLE}", False, "the role does not exist"))
    else:
        held = [name for name in FORBIDDEN_LOGIN_ROLE_ATTRIBUTES if getattr(login, name)]
        ok = login.rolcanlogin and not login.rolinherit and not login.rolbypassrls and not held
        detail = (
            f"canlogin={login.rolcanlogin} inherit={login.rolinherit} "
            f"bypassrls={login.rolbypassrls}"
        )
        checks.append(Check(f"role {LOGIN_ROLE}", ok, detail + (f" holds {held}" if held else "")))

    return checks


def verify(connection: Connection, head: str) -> list[Check]:
    """Every check, in the order a reader would want them: schema, extension, policies, roles."""
    return [
        check_migrations(connection, head),
        check_pgvector(connection),
        *check_row_level_security(connection),
        *check_roles(connection),
    ]


def scrubber(*secrets: str) -> Any:
    """Remove anything that could carry the credential from a message, longest match first."""
    ordered = sorted({value for value in secrets if value}, key=len, reverse=True)

    def scrub(message: str) -> str:
        for secret in ordered:
            message = message.replace(secret, "«redacted»")
        return message

    return scrub


def main(argv: list[str] | None = None) -> int:
    settings = Settings()
    if settings.runtime_mode != "privileged":
        print(
            "Refusing to run: set WEATHRA_RUNTIME_MODE=privileged. The request role cannot read "
            "the catalogue entries that prove the policies exist.",
            file=sys.stderr,
        )
        return 2

    backend_root = Path(__file__).resolve().parent.parent
    raw = resolve_url(settings, ConnectionRole.PRIVILEGED)
    url = sync_url(raw)
    rendered = url.render_as_string(hide_password=False)
    scrub = scrubber(raw, rendered, url.password or "")

    engine = engine_from_config(
        {"sqlalchemy.url": rendered}, prefix="sqlalchemy.", poolclass=NullPool
    )
    try:
        head = repository_head(backend_root)
        # The server refuses every write for the life of this session, so a mistake here is
        # rejected by PostgreSQL rather than executed.
        connection = engine.connect().execution_options(postgresql_readonly=True)
        with connection:
            checks = verify(connection, head)
    except Exception as failure:
        # Scrubbed before printing: a connection error is the one place a password turns up in
        # prose, and this runs where the DSN is real.
        print(f"could not verify the database: {scrub(str(failure))}", file=sys.stderr)
        return 1
    finally:
        engine.dispose()

    width = max(len(check.name) for check in checks)
    for check in checks:
        print(f"  {'PASS' if check.ok else 'FAIL'}  {check.name:{width}}  {check.detail}")

    failed = [check.name for check in checks if not check.ok]
    if failed:
        print(f"\n{len(failed)} check(s) failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"\nall {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
