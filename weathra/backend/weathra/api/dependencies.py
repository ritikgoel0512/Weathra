"""What a handler can ask for, and where each thing comes from.

Everything expensive is built once by the lifespan and read off ``app.state`` here: the HTTP
client, the database engines, the MCP tool client, the token validator, the inference provider, the
embedder. A dependency that constructed one per request would open a TLS connection per forecast.

**The session dependencies are the interesting ones.** There are two, and the difference is
authorization:

* ``request_session`` — the only way a handler reaches the database. It opens a transaction, binds
  the acting principal's claims, and drops to the restricted role, so Row Level Security applies
  to everything the handler does (design.md decision 5). A handler that wanted a "plain" session
  would be asking for a connection the policies do not constrain, and there is no dependency here
  that gives one.
* the absence of a privileged one — deliberate. Privileged access belongs to migrations, the
  retention job, and corpus ingestion, none of which serve a request. A route needing it would be
  a design question, not a missing dependency.

**A public route gets a session with no principal.** The claims bind empty,
``weathra_current_user_id()`` returns NULL, and every policy treats that as owning nothing — so a
public handler reads no user-owned row even if a bug asked it to.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Annotated

import httpx
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.llm.registry import LLMProvider
from weathra.auth.deps import OptionalPrincipal
from weathra.auth.rls import session_for
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.errors import McpUnavailable
from weathra.geocoding.base import Geocoder
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.mcp.client import McpToolClient
from weathra.memory.checkpointer import Checkpointer
from weathra.providers.base import WeatherProvider
from weathra.providers.cache import CachedProvider
from weathra.providers.registry import build_provider
from weathra.rag.embed import EmbeddingProvider

__all__ = [
    "CurrentSession",
    "Engine",
    "HttpClient",
    "Inference",
    "Places",
    "Tools",
    "WeatherFor",
    "settings_of",
]

logger = logging.getLogger("weathra.api.dependencies")


def settings_of(request: Request) -> Settings:
    """The process's settings, validated once at startup."""
    settings = getattr(request.app.state, "settings", None)
    if not isinstance(settings, Settings):  # pragma: no cover - the lifespan always sets it
        raise RuntimeError("The application was started without settings on its state.")
    return settings


def http_client_of(request: Request) -> httpx.AsyncClient:
    """The process-wide HTTP client. One per process, so connections are pooled."""
    client = getattr(request.app.state, "http_client", None)
    if not isinstance(client, httpx.AsyncClient):  # pragma: no cover
        raise RuntimeError("The application was started without an HTTP client on its state.")
    return client


def engines_of(request: Request) -> Engines:
    engines = getattr(request.app.state, "engines", None)
    if not isinstance(engines, Engines):  # pragma: no cover
        raise RuntimeError("The application was started without database engines on its state.")
    return engines


def tools_of(request: Request) -> McpToolClient:
    """The connected MCP tool client, or a clear failure naming the server.

    ``McpUnavailable`` rather than a ``RuntimeError``: the agent surface genuinely can be up
    without the MCP server, and a caller is owed the reason and a 502 rather than a 500.
    """
    client = getattr(request.app.state, "tools", None)
    if not isinstance(client, McpToolClient):
        raise McpUnavailable(
            "The MCP weather server is not connected, so the agent surface cannot run. Check "
            "MCP_TRANSPORT and MCP_SERVER_ADDRESS.",
            details={"server": "weathra-weather"},
        )
    return client


def inference_of(request: Request) -> LLMProvider:
    """The lazy inference provider. Asking for it does not construct a client."""
    provider = getattr(request.app.state, "inference", None)
    if not isinstance(provider, LLMProvider):  # pragma: no cover
        raise RuntimeError("The application was started without an inference provider.")
    return provider


def embedder_of(request: Request) -> EmbeddingProvider:
    embedder: EmbeddingProvider | None = getattr(request.app.state, "embedder", None)
    if embedder is None:  # pragma: no cover
        raise RuntimeError("The application was started without an embedder.")
    return embedder


def checkpointer_of(request: Request) -> Checkpointer | None:
    """The conversation checkpointer, or ``None`` when memory could not be opened.

    ``None`` is a supported state: ``specs/memory`` requires the stateless capabilities to keep
    serving through a memory outage, so the app starts without it and says so.
    """
    checkpointer = getattr(request.app.state, "checkpointer", None)
    return checkpointer if isinstance(checkpointer, Checkpointer) else None


def geocoder_of(request: Request) -> Geocoder:
    """The configured geocoder, built once."""
    existing = getattr(request.app.state, "geocoder", None)
    if existing is not None:
        return existing  # type: ignore[no-any-return]
    return OpenMeteoGeocoder(settings=settings_of(request), client=http_client_of(request))


def weather_of(request: Request) -> WeatherProvider:
    """The configured weather provider, wrapped in the shared cache.

    Cached at the provider layer rather than per route, so two endpoints asking for the same
    forecast in the same window make one upstream call (``specs/weather-providers``).
    """
    existing = getattr(request.app.state, "weather_provider", None)
    if existing is not None:
        return existing  # type: ignore[no-any-return]
    settings = settings_of(request)
    return CachedProvider(
        build_provider(settings, http_client_of(request), None), settings=settings
    )


async def current_session(
    request: Request, principal: OptionalPrincipal
) -> AsyncIterator[AsyncSession]:
    """A transaction acting as the caller, or as nobody at all.

    The only sanctioned route into the database from a handler. With no principal the claims bind
    empty and every ownership policy treats the session as owning nothing, which is exactly what a
    public endpoint should be able to do.
    """
    engines = engines_of(request)
    async with session_for(engines, principal) as session:
        yield session


HttpClient = Annotated[httpx.AsyncClient, Depends(http_client_of)]
Engine = Annotated[Engines, Depends(engines_of)]
Tools = Annotated[McpToolClient, Depends(tools_of)]
Inference = Annotated[LLMProvider, Depends(inference_of)]
Places = Annotated[Geocoder, Depends(geocoder_of)]
WeatherFor = Annotated[WeatherProvider, Depends(weather_of)]
CurrentSession = Annotated[AsyncSession, Depends(current_session)]
Configuration = Annotated[Settings, Depends(settings_of)]
Embedder = Annotated[EmbeddingProvider, Depends(embedder_of)]
Memory = Annotated[Checkpointer | None, Depends(checkpointer_of)]
