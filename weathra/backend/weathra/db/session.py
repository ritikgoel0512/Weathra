"""Sessions: the only sanctioned way to reach the database.

A request-scoped session does three things before a handler sees it, in this order:

1. opens a transaction,
2. binds the acting user's claims into ``request.jwt.claims``, which is what the Row Level Security
   policies read, and
3. assumes the restricted role, so those policies actually bind — a table's owner is otherwise
   exempt from them.

The order matters. Claims are set while still connected as the configured user; the role switch
comes last, because everything after it runs with no privilege beyond what the policies allow.

``SET LOCAL`` scopes both to the transaction, so a pooled connection handed to the next request
carries neither the previous request's claims nor its role. Getting that wrong would be a
cross-user data leak, which is why ``reset_role`` runs even on the failure path.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

__all__ = [
    "CLAIMS_SETTING",
    "assume_restricted_role",
    "bind_claims",
    "privileged_session",
    "request_session",
    "validated_role_name",
]

# The Postgres setting the policies read. The name matches Supabase's own convention so a policy
# written for either environment reads the same value.
CLAIMS_SETTING = "request.jwt.claims"

# A role name is an SQL identifier and cannot be bound as a parameter, so it is validated instead.
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def validated_role_name(role: str) -> str:
    """A role name confirmed to be a plain SQL identifier.

    Public because the checkpointer's deploy-time grant needs the same check: a role name cannot be
    bound as a parameter, so every place that interpolates one goes through here.
    """
    if not _IDENTIFIER.match(role):
        raise ValueError(
            f"{role!r} is not a valid PostgreSQL role name. The restricted role is configuration "
            "(DATABASE_RESTRICTED_ROLE) and must be a plain identifier."
        )
    return role


async def bind_claims(session: AsyncSession, claims: Mapping[str, Any] | None) -> None:
    """Bind the acting user's validated claims for the rest of the transaction.

    Passing ``None`` binds an empty setting, which every policy treats as owning nothing — so a
    session opened without a principal reads no user-owned row rather than reading all of them.
    """
    payload = json.dumps(dict(claims)) if claims else ""
    await session.execute(
        text("SELECT set_config(:setting, :claims, true)"),
        {"setting": CLAIMS_SETTING, "claims": payload},
    )


async def assume_restricted_role(session: AsyncSession, role: str) -> None:
    """Drop to the non-privileged role for the rest of the transaction."""
    await session.execute(text(f"SET LOCAL ROLE {validated_role_name(role)}"))


@asynccontextmanager
async def request_session(
    sessionmaker: async_sessionmaker,
    *,
    claims: Mapping[str, Any] | None,
    restricted_role: str,
) -> AsyncIterator[AsyncSession]:
    """A transaction-scoped session with the request's claims bound and RLS in force.

    Commits on a clean exit, rolls back on an exception. The role and the claims are reset either
    way, because the connection goes back to a pool that the next request will draw from.
    """
    async with sessionmaker() as session:
        try:
            await session.begin()
            await bind_claims(session, claims)
            await assume_restricted_role(session, restricted_role)
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
        finally:
            # SET LOCAL ends with the transaction, but a pooled connection is worth being explicit
            # about: an unreset role here would be a cross-user leak, not a tidiness problem. A
            # broken connection needs no reset, so a failure here is nothing to raise over.
            with suppress(BaseException):
                await session.execute(text("RESET ROLE"))


@asynccontextmanager
async def privileged_session(sessionmaker: async_sessionmaker) -> AsyncIterator[AsyncSession]:
    """A session with no role switch and no claims, for administrative work only.

    Callers: Alembic, the retention routine, corpus ingestion, and evaluation test-user
    provisioning. Never a handler serving a browser — this connection is not constrained by any
    policy.
    """
    async with sessionmaker() as session:
        try:
            await session.begin()
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
