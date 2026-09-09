"""The one dependency every administrative route takes, and why it is a dependency.

Separated from the package's ``__init__`` so the routers can import it without the package
importing them back — a cycle Python resolves by raising, which is a tidier failure than most but
still a failure.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.api.dependencies import engines_of
from weathra.auth.deps import AdministrativePrincipal
from weathra.auth.rls import administrative_session

__all__ = ["AdministrativeSession", "administrative_db"]


async def administrative_db(
    request: Request,
    principal: AdministrativePrincipal,
) -> AsyncIterator[AsyncSession]:
    """The privileged connection, reachable only by a principal holding the administrative role.

    The dependency on ``AdministrativePrincipal`` is the whole security argument and is not
    decorative: FastAPI resolves it first, so an unauthenticated caller is refused with 401 and an
    ordinary one with 403 *before* this function runs. There is no ordering in which a caller
    without the role obtains this session — it is not obtained and then guarded, it cannot be
    obtained at all.

    Privileged rather than restricted because the request role holds ``SELECT`` and nothing else on
    every operational table (`0005`), and ``SELECT`` only on ``user_plans`` (`0006`). Those grants
    are the reason self-service administration is impossible, so administration has to come from
    the other side of them.
    """
    del principal  # depended on for authorization; routes take it separately when they need it
    async with administrative_session(engines_of(request)) as session:
        yield session


AdministrativeSession = Annotated[AsyncSession, Depends(administrative_db)]
