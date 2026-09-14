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
from weathra.auth.rls import administrative_session, session_for

__all__ = [
    "AdministrativeReadSession",
    "AdministrativeSession",
    "administrative_db",
    "administrative_read_db",
]


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


async def administrative_read_db(
    request: Request,
    principal: AdministrativePrincipal,
) -> AsyncIterator[AsyncSession]:
    """The ordinary request connection, acting as the administrator, for administrative *reads*.

    **Why a second session exists at all.** ``administrative_db`` above opens the privileged
    connection, and the request-serving container is deliberately never given that credential:
    ``tests/test_secret_storage.py::test_the_render_service_never_holds_the_privileged_database_url``
    asserts it and explains that migrations run from GitHub Actions precisely so the browser-facing
    container never holds a connection that bypasses Row Level Security. Every administrative read
    therefore returned 500 in production — ``resolve_url`` raising ``DATABASE_URL_PRIVILEGED is not
    configured`` inside the dependency, after authorization had already succeeded, which is why the
    screen saw no 403 and no route ever ran. The ``db`` suite could not catch it because it runs
    where both credentials exist.

    **What this does instead.** The same session every other handler uses: the restricted role, with
    the acting principal's validated claims bound, so Row Level Security applies to it exactly as it
    applies to anybody. ``0016`` is what makes the administrative rows reachable through it, and it
    reaches them through ``weathra_is_administrative()`` — a ``SECURITY DEFINER`` predicate over
    ``admin_roles`` that ``0011`` already built, and that no claim, header or body field can
    satisfy.
    So the authorization is asserted twice over the same state: once by ``AdministrativePrincipal``,
    which produces the 401 and the 403, and once by the database, which produces no rows. A handler
    bug that forgot the dependency would read nothing rather than everything.

    **Reads only, and that is enforced below the code.** ``0016`` grants the restricted role
    ``SELECT`` and nothing else, so an administrative *write* attempted on this session is
    refused by PostgreSQL rather than by a convention. Every mutation keeps
    ``AdministrativeSession`` and the privileged connection, which is to say it keeps running
    somewhere other than this container.
    """
    async with session_for(engines_of(request), principal) as session:
        yield session


AdministrativeReadSession = Annotated[AsyncSession, Depends(administrative_read_db)]
