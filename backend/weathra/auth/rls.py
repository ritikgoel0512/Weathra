"""Binding the acting principal to a database session.

``db/session.py`` owns the mechanism — a transaction, the claims in ``request.jwt.claims``, the
restricted role. This module is the one place that decides *which* claims go in: the validated
claim set of the acting ``Principal``, and nothing a caller supplied.

Opening a session with no principal is a supported state, and a deliberately useless one: the
claims bind empty, ``weathra_current_user_id()`` returns NULL, and every policy treats that as
owning nothing. A public endpoint therefore reads no user-owned row even if a handler bug asked it
to (``specs/authentication``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from weathra.db.engine import Engines
from weathra.db.session import privileged_session, request_session
from weathra.domain.identity import Principal

__all__ = ["administrative_session", "claims_of", "session_for"]


def claims_of(principal: Principal | None) -> dict[str, object] | None:
    """The claim set to bind, or ``None`` for an unauthenticated session.

    The subject is asserted explicitly rather than trusted from the claim mapping: a policy
    comparing ``user_id`` against ``sub`` must see the same value ``Principal.user_id`` carries,
    and that value has already been stripped and validated.
    """
    if principal is None:
        return None
    return {**dict(principal.claims), "sub": principal.user_id}


@asynccontextmanager
async def session_for(engines: Engines, principal: Principal | None) -> AsyncIterator[AsyncSession]:
    """A request-scoped session acting as ``principal``.

    The only sanctioned way for a handler to reach the database. A handler that opened a plain
    session would get a connection the policies do not constrain, which is why nothing else in the
    request path constructs one.
    """
    async with request_session(
        engines.request_sessionmaker,
        claims=claims_of(principal),
        restricted_role=engines.settings.database_restricted_role,
    ) as session:
        yield session


@asynccontextmanager
async def administrative_session(engines: Engines) -> AsyncIterator[AsyncSession]:
    """A privileged session for administrative routines only.

    Callers: the retention routine, corpus ingestion, evaluation test-user provisioning. Never a
    handler serving a browser — this connection is constrained by no policy at all.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        yield session
