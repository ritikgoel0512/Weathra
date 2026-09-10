#!/usr/bin/env python3
"""Assign a principal to a subscription plan, for the case the product cannot serve.

The product *can* serve this: `PUT /admin/principals/{subject}/plan` is an administrative endpoint,
and task 34.22 built the screen that calls it. This script is for the case that screen cannot cover
— the one where nobody is signed in as an administrator to press it, which is the same shape as the
first-administrator problem `grant_administrator.py` exists for.

**What it needs, and what that means.** The privileged database connection —
``DATABASE_URL_PRIVILEGED`` or ``WEATHRA_RUNTIME_MODE=privileged`` — which no request-serving
process holds. `user_plans` grants the request role ``SELECT`` and nothing else, so a plan
assignment is a privileged write however it is made; somebody who can run this can already write
any row, which is exactly why this is a safe place for the escape hatch and a bad place for
anything else.

**Every assignment is recorded**, through the same `PlanStore.assign` the endpoint uses, so the
audit row is identical whichever way it happened. A run with no acting administrator attributes the
change to the subject itself rather than inventing an actor, as the role bootstrap does.

**A plan is not a role.** Assigning Premium grants no administrative capability, and holding the
administrative role entitles nobody to a tier. They are separate columns in separate tables for that
reason, and this script touches only the plan.

Usage::

    python scripts/assign_plan.py --list
    python scripts/assign_plan.py --subject <auth-subject-uuid> --plan premium
    python scripts/assign_plan.py --administrators --plan premium

``--administrators`` assigns the tier to every principal holding the administrative role, and
refuses if there is more than one, because "the product owner" is a description of a single account
and quietly changing several is not what anybody meant by it.

``--subject-for-email`` resolves a subject from Supabase's own ``auth.users``, for the operator who
knows which account they mean but not its UUID. **Weathra stores no email**, and this does not
change that: it reads the identity provider's table with the privileged credential, prints the
subject and nothing else, and writes nothing anywhere. It exists because the alternative — an
operator picking between two UUIDs by eye — is how the wrong account gets put on a tier. If the
address matches no account, or more than one, it refuses rather than choosing.
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
from weathra.domain.entitlements import PlanCode
from weathra.entitlements.plans import PlanStore

REFUSAL = (
    "Refusing to run: this needs the privileged database connection. Set "
    "DATABASE_URL_PRIVILEGED, or WEATHRA_RUNTIME_MODE=privileged with a privileged DATABASE_URL. "
    "It is never available to a request-serving process, which is the point."
)


def _subject(value: str) -> str:
    """A UUID, checked here so a typo is a message rather than a row nobody holds."""
    try:
        return str(uuid.UUID(value))
    except ValueError as bad:
        raise argparse.ArgumentTypeError(
            f"{value!r} is not an auth subject. Expected the UUID from the token's `sub` claim."
        ) from bad


async def _subject_for_email(session: object, email: str) -> str | None:
    """The auth subject for an address, from the identity provider's own table.

    Nothing is printed but the subject, which is not personal data and is already visible in this
    script's own listing. Weathra's tables are untouched: `specs/authentication` keeps contact
    detail in Supabase Auth, and reading it here does not copy it anywhere.
    """
    rows = (
        await session.execute(  # type: ignore[attr-defined]
            text("SELECT id::text FROM auth.users WHERE lower(email) = lower(:address)"),
            {"address": email},
        )
    ).all()
    if len(rows) != 1:
        return None
    return str(rows[0][0])


async def _run(
    *,
    subject: str | None,
    plan: str | None,
    listing: bool,
    administrators: bool,
    email: str | None,
) -> int:
    settings = Settings()
    if settings.database_url_privileged is None and settings.runtime_mode != "privileged":
        print(REFUSAL, file=sys.stderr)
        return 2

    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            plans = PlanStore(session)

            if listing:
                available = await plans.list()
                print(f"{len(available)} plan(s):")
                for record in sorted(available, key=lambda item: item.rank):
                    print(f"  {record.plan_code}  rank {record.rank}  {record.display_name}")

                holders = await RoleStore(session).holders(ADMINISTRATOR_ROLE)
                print(f"{len(holders)} administrator(s):")
                for grant in holders:
                    # Read through the privileged session; the request role sees its own row only.
                    assigned = await session.scalar(
                        text("SELECT plan_code FROM user_plans WHERE user_id = CAST(:u AS uuid)"),
                        {"u": grant.user_id},
                    )
                    standing = assigned or "none assigned (defaults to free)"
                    print(f"  {grant.user_id}  plan: {standing}")
                return 0

            if email is not None:
                found = await _subject_for_email(session, email)
                if found is None:
                    print(
                        "That address matches no account, or more than one. Refusing to guess.",
                        file=sys.stderr,
                    )
                    return 4
                print(f"subject: {found}")
                if plan is None:
                    return 0
                subject = found

            assert plan is not None
            targets: list[str]
            if administrators:
                holders = await RoleStore(session).holders(ADMINISTRATOR_ROLE)
                if len(holders) != 1:
                    print(
                        f"Refusing: {len(holders)} principals hold the administrative role. "
                        "--administrators is for the single-owner case; name the subject instead.",
                        file=sys.stderr,
                    )
                    return 3
                targets = [holders[0].user_id]
            else:
                assert subject is not None
                targets = [subject]

            for target in targets:
                record = await plans.assign(target, plan, acting_principal=target)
                print(f"{target} is on {record.plan_code} ({record.display_name}).")
            print("Recorded in admin_audit. A plan is an entitlement, not an authorization.")
            return 0
    finally:
        await engines.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subject", type=_subject, help="The auth subject to assign.")
    parser.add_argument(
        "--administrators",
        action="store_true",
        help="Assign the sole administrative principal. Refuses if there is more than one.",
    )
    parser.add_argument(
        "--plan", choices=[code.value for code in PlanCode], help="free, pro, or premium."
    )
    parser.add_argument(
        "--subject-for-email",
        dest="email",
        help="Resolve the subject for an address from Supabase's auth.users. Prints the subject.",
    )
    parser.add_argument("--list", action="store_true", help="Show the plans and who is on what.")
    arguments = parser.parse_args()

    if arguments.list:
        return asyncio.run(
            _run(subject=None, plan=None, listing=True, administrators=False, email=None)
        )
    if arguments.email is None and (
        arguments.plan is None or (arguments.subject is None and not arguments.administrators)
    ):
        parser.error(
            "give --plan with --subject, --administrators or --subject-for-email, or use --list"
        )
    return asyncio.run(
        _run(
            subject=arguments.subject,
            plan=arguments.plan,
            listing=False,
            administrators=arguments.administrators,
            email=arguments.email,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
