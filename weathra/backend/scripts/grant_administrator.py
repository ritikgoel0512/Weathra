#!/usr/bin/env python3
"""Grant or revoke the administrative role, for the one case the API cannot serve.

`specs/authentication` holds the administrative role in `admin_roles`, and the API surface that
manages it requires the role to use it. That is the correct design and it has one consequence: the
*first* administrator cannot be granted through the API, because there is nobody yet to authorize
the grant. This is the bootstrap, and it is deliberately not an endpoint — a route that could
promote somebody without an administrator would be the hole the whole design closes.

**What it needs, and what that means.** The privileged database connection —
``DATABASE_URL_PRIVILEGED`` or ``WEATHRA_RUNTIME_MODE=privileged`` — which is the same credential
Alembic and the retention job use, and which no request-serving process holds. Somebody who can run
this can already write any row in the database; the role grant is not a new power for them, which
is exactly why this is the right place for the bootstrap and the wrong place for anything else.

**Every grant is recorded.** A bootstrap grant has no acting administrator to attribute, so
``granted_by`` is null and the audit row names the subject itself rather than a fiction. A later
grant made through the API names the administrator who made it.

Usage::

    python scripts/grant_administrator.py --subject <auth-subject-uuid>
    python scripts/grant_administrator.py --subject <auth-subject-uuid> --revoke
    python scripts/grant_administrator.py --list

The subject is the Supabase auth subject — the ``sub`` claim, a UUID — not an email address.
Weathra stores no email of its own (`specs/authentication`), so it cannot look one up, and guessing
would be the sort of convenience that grants the role to the wrong person.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import text

from weathra.auth.roles import ADMINISTRATOR_ROLE, RoleStore
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session

REFUSAL = (
    "Refusing to run: this needs the privileged database connection. Set "
    "DATABASE_URL_PRIVILEGED, or WEATHRA_RUNTIME_MODE=privileged with a privileged DATABASE_URL. "
    "It is never available to a request-serving process, which is the point."
)


def _subject(value: str) -> str:
    """A UUID, checked here so a typo is a message rather than a database error.

    Every Supabase auth subject is a UUID. Accepting anything else would let a mistyped identifier
    become a role row nobody holds, which reads in the audit trail exactly like one that worked.
    """
    try:
        return str(uuid.UUID(value))
    except ValueError as bad:
        raise argparse.ArgumentTypeError(
            f"{value!r} is not an auth subject. Expected the UUID from the token's `sub` claim."
        ) from bad


async def _run(subject: str | None, *, revoke: bool, listing: bool) -> int:
    settings = Settings()
    if settings.database_url_privileged is None and settings.runtime_mode != "privileged":
        print(REFUSAL, file=sys.stderr)
        return 2

    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            store = RoleStore(session)

            if listing:
                holders = await store.holders(ADMINISTRATOR_ROLE)
                if not holders:
                    print("No administrators. Grant the first one with --subject.")
                    return 0
                print(f"{len(holders)} administrator(s):")
                for grant in holders:
                    granter = grant.granted_by or "bootstrap"
                    print(f"  {grant.user_id}  granted {grant.granted_at:%Y-%m-%d} by {granter}")
                return 0

            assert subject is not None  # argparse requires one of --subject or --list
            if revoke:
                await store.revoke(subject, ADMINISTRATOR_ROLE, acting_principal=subject)
                print(f"Revoked the administrative role from {subject}.")
                return 0

            # The profile is not required — a role may be granted before its holder has ever signed
            # in — but saying whether one exists is worth a line, because a grant to a subject with
            # no profile is usually a mistyped identifier rather than a plan.
            known = await session.scalar(
                text("SELECT EXISTS (SELECT 1 FROM profiles WHERE user_id = CAST(:u AS uuid))"),
                {"u": subject},
            )
            await store.grant(subject, ADMINISTRATOR_ROLE, acting_principal=None)
            print(f"Granted the administrative role to {subject}.")
            if not known:
                print(
                    "  Note: no profile exists for that subject yet. That is legitimate — the role "
                    "applies from their first signed-in request — but check the identifier if you "
                    "expected them to have used Weathra already."
                )
            return 0
    finally:
        await engines.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Grant, revoke, or list Weathra's administrative role. Privileged.",
        epilog="The first administrator can only be granted here; every later one may use the API.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--subject", type=_subject, help="The auth subject (the `sub` claim).")
    group.add_argument("--list", action="store_true", help="Show who holds the role.")
    parser.add_argument("--revoke", action="store_true", help="Take the role away instead.")
    arguments = parser.parse_args()

    if arguments.revoke and arguments.list:
        parser.error("--revoke and --list are different operations.")
    return asyncio.run(_run(arguments.subject, revoke=arguments.revoke, listing=arguments.list))


if __name__ == "__main__":
    raise SystemExit(main())
