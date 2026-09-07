"""The two database engines, deliberately separate (design.md decision 5).

``Engines`` is built once per process by the application lifespan and holds:

* the **request engine**, which every request-serving session comes from, and
* the **privileged engine**, used only where privileged access is genuinely required —
  migrations, the retention routine, corpus ingestion, evaluation test-user provisioning.

**Both are created lazily**, on first use, and that is not just tidiness. A privileged-only
process — ``weathra-ingest-corpus``, the retention job — has no business requiring
``DATABASE_URL``, and a request-serving process has no business resolving
``DATABASE_URL_PRIVILEGED``. Eager construction would make each demand the other's credential.
The API's lifespan calls ``open_request_engine`` at startup so a missing request URL still fails
immediately there rather than on the first request.

Keeping them apart in the type, not only in configuration, is what makes "a request path has no
privileged connection" checkable: a request-serving process never resolves
``DATABASE_URL_PRIVILEGED``, and ``Settings`` refuses to start at all if a service-role key is
present in that mode.

Pool sizing is deliberately small. The backend runtime scales instances horizontally, so Postgres
connection limits — not application throughput — are the binding constraint, which is why the pool
size is a deployment setting rather than a code constant.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from weathra.config import Settings
from weathra.db.urls import ConnectionRole, async_url, resolve_url

__all__ = ["Engines", "create_privileged_engine", "create_request_engine"]


def create_request_engine(settings: Settings) -> AsyncEngine:
    """The engine every request-serving session comes from.

    Sessions opened from it assume the restricted role, so Row Level Security applies to them.
    """
    return create_async_engine(
        async_url(resolve_url(settings, ConnectionRole.REQUEST)),
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_pool_max_overflow,
        pool_pre_ping=True,
        echo=False,
    )


def create_privileged_engine(settings: Settings) -> AsyncEngine:
    """The engine for migrations and administrative routines. Never used to serve a request.

    ``NullPool`` because privileged work is occasional and short: holding pooled privileged
    connections open would consume exactly the connections request traffic needs.
    """
    return create_async_engine(
        async_url(resolve_url(settings, ConnectionRole.PRIVILEGED)),
        poolclass=NullPool,
        echo=False,
    )


@dataclass(slots=True)
class Engines:
    """Process-wide database engines, owned by the application lifespan."""

    settings: Settings
    _request_engine: AsyncEngine | None = field(default=None, repr=False)
    _privileged_engine: AsyncEngine | None = field(default=None, repr=False)

    @classmethod
    def create(cls, settings: Settings) -> Engines:
        return cls(settings=settings)

    def open_request_engine(self) -> AsyncEngine:
        """Resolve the request connection now, so a missing URL fails at startup.

        Called by the API lifespan. A privileged-only process never calls it.
        """
        return self.request_engine

    @property
    def request_engine(self) -> AsyncEngine:
        if self._request_engine is None:
            self._request_engine = create_request_engine(self.settings)
        return self._request_engine

    @property
    def request_sessionmaker(self) -> async_sessionmaker:
        return async_sessionmaker(self.request_engine, expire_on_commit=False)

    def privileged(self) -> AsyncEngine:
        """The privileged engine, created on first use."""
        if self._privileged_engine is None:
            self._privileged_engine = create_privileged_engine(self.settings)
        return self._privileged_engine

    @property
    def privileged_sessionmaker(self) -> async_sessionmaker:
        return async_sessionmaker(self.privileged(), expire_on_commit=False)

    @property
    def privileged_engine_created(self) -> bool:
        """Whether anything has actually asked for privileged access in this process."""
        return self._privileged_engine is not None

    @property
    def request_engine_created(self) -> bool:
        return self._request_engine is not None

    async def dispose(self) -> None:
        """Close whatever was actually opened. Nothing is created just to be disposed of."""
        if self._request_engine is not None:
            await self._request_engine.dispose()
            self._request_engine = None
        if self._privileged_engine is not None:
            await self._privileged_engine.dispose()
            self._privileged_engine = None
