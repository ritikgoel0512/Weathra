"""The FastAPI application: what starts, in what order, and what a failure to start means.

**The lifespan builds everything expensive once.** One HTTP client, one pair of database engines,
one MCP tool client, one token validator, one embedder, one checkpointer. Per-request construction
would mean a TLS handshake per forecast and an MCP handshake per question.

**Not every dependency is required to start, and the distinction is deliberate.** ``specs/
agent-orchestration`` and ``specs/memory`` both require Weathra to keep serving what it can:

* **the request database URL** is required — without it a session cannot be opened and nearly every
  endpoint fails, so failing at startup is honest and fast;
* **the MCP server** is not. It is needed by the agent surface only, so a connection failure is
  logged, ``/ready`` reports it, and the agent routes return a 502 naming the server while the
  public weather endpoints keep working;
* **an inference credential** is not. The provider is lazy and only the agent routes construct a
  client, so a deployment without one serves everything else and says so;
* **the conversation checkpointer** is not. A memory outage means follow-ups report unavailable
  context; it does not mean a forecast fails.

**CORS is explicit and narrow.** ``CORS_ALLOWED_ORIGINS`` is validated to refuse a wildcard
(``config.py``), and ``allow_credentials`` is deliberately **off**: Weathra authenticates with a
bearer token in a header, not a cookie, so credentialed CORS would buy nothing and would make a
wildcard origin impossible to use safely later. ``Authorization`` is allowed explicitly because
that is how the browser presents the token, and ``X-Request-Id`` is allowed in and exposed out so a
client can correlate its own logs with Weathra's.

**Middleware order matters.** The request-context middleware is added last and therefore runs
*outermost*, so every request — including one CORS rejects and one an exception handler answers —
gets an id and an access-log line.

**Why the routers are wired here rather than each mounting itself.** Because the public/protected
classification is a single table (``api/classification.py``), and this is the one place that
attaches the right principal dependency to each router. A router that mounted itself would decide
its own access, which is precisely the decision the specs require to be declared centrally and
checkable.
"""

from __future__ import annotations

import logging
import logging.config
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from weathra import __version__
from weathra.agents.llm.registry import LLMProvider
from weathra.api.errors import install_error_handlers
from weathra.api.middleware import REQUEST_ID_HEADER, RequestContextMiddleware, RequestIdFilter
from weathra.api.openapi import apply_security_metadata
from weathra.api.routers import (
    account,
    agent,
    analysis,
    changes,
    comparison,
    evidence,
    health,
    history,
    locations,
    weather,
)
from weathra.auth.jwks import JwksCache
from weathra.auth.tokens import TokenValidator
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.errors import McpUnavailable, MemoryUnavailable, WeathraError
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.mcp.client import McpToolClient
from weathra.mcp.server import ToolContext, build_server
from weathra.memory.checkpointer import Checkpointer
from weathra.providers.cache import CachedProvider
from weathra.providers.http import build_http_client
from weathra.providers.registry import build_provider
from weathra.rag.embed import build_embedder
from weathra.redaction import install_redaction
from weathra.telemetry.usage import BackgroundUsageRecorder

__all__ = ["build_app", "create_app"]

logger = logging.getLogger("weathra.api")

TITLE = "Weathra"
DESCRIPTION = """\
Agentic weather intelligence. Every figure in a Weathra answer is retrieved from a named provider
or computed by deterministic code, and every answer carries the evidence record to prove it.

Endpoints are classified **public** or **protected**. A public endpoint takes parameters and
returns weather; it reads no user-owned data, except that it applies a signed-in caller's unit
preference. A protected endpoint requires a Supabase access token as a Bearer credential and
operates on the acting user's own data.
"""


def _configure_logging(settings: Settings) -> None:
    """Structured-ish logging with the request id on every record, and redaction installed.

    ``disable_existing_loggers`` is off: the module loggers throughout Weathra are created at
    import time, and disabling them here would silence exactly the layers whose logs matter.
    """
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "filters": {"request_id": {"()": RequestIdFilter}},
            "formatters": {
                "weathra": {
                    "format": "%(asctime)s %(levelname)s [%(request_id)s] %(name)s %(message)s"
                }
            },
            "handlers": {
                "default": {
                    "class": "logging.StreamHandler",
                    "formatter": "weathra",
                    "filters": ["request_id"],
                }
            },
            "root": {"handlers": ["default"], "level": settings.log_level},
        }
    )
    # The backstop, not the design: nothing in Weathra logs a credential on purpose.
    install_redaction()


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Build the process's shared resources, and tear them down in reverse."""
    settings: Settings = app.state.settings
    _configure_logging(settings)
    logger.info(
        "starting Weathra %s in %s (prefix %s)",
        __version__,
        settings.environment,
        settings.api_version_prefix,
    )

    app.state.http_client = build_http_client(settings)
    app.state.engines = Engines.create(settings)
    # Resolved now rather than on the first request: a missing DATABASE_URL should fail the
    # deployment, not the first person to ask a question.
    app.state.engines.open_request_engine()

    app.state.token_validator = TokenValidator(
        settings=settings,
        jwks=JwksCache(
            jwks_url=settings.jwks_url,
            ttl_seconds=settings.supabase_jwks_cache_ttl_seconds,
            client=app.state.http_client,
        ),
    )
    app.state.geocoder = OpenMeteoGeocoder(settings=settings, client=app.state.http_client)
    app.state.weather_provider = CachedProvider(
        build_provider(settings, app.state.http_client, None), settings=settings
    )
    app.state.embedder = build_embedder(settings)
    app.state.inference = LLMProvider(app.state.http_client, settings)
    # One per process, so the telemetry failure counter is a property of the deployment rather
    # than of a request. Writes are scheduled off the answer path (`specs/llm-telemetry`).
    app.state.usage_recorder = BackgroundUsageRecorder()

    app.state.tools = await _connect_tools(app, settings)
    app.state.checkpointer = await _open_memory(settings)

    try:
        yield
    finally:
        logger.info("shutting down Weathra")
        await app.state.usage_recorder.drain()
        if app.state.checkpointer is not None:
            await app.state.checkpointer.close()
        if app.state.tools is not None:
            await app.state.tools.close()
        await app.state.engines.dispose()
        await app.state.http_client.aclose()


async def _connect_tools(app: FastAPI, settings: Settings) -> McpToolClient | None:
    """Connect the MCP tool client, or log why the agent surface will be unavailable.

    In-process transport builds the server here and hands it to the client, which is what makes the
    default deployment one container rather than two (design.md decision 6).
    """
    server = None
    if settings.mcp_transport == "in-process":
        server = build_server(
            ToolContext(
                settings=settings,
                client=app.state.http_client,
                provider=app.state.weather_provider,
                geocoder=app.state.geocoder,
            )
        )

    client = McpToolClient(settings=settings, server=server)
    try:
        await client.connect()
    except McpUnavailable as failure:
        # Not fatal: the agent routes will return a 502 naming the server, and every public
        # weather endpoint keeps working.
        logger.error("the MCP weather server is unavailable: %s", failure.message)
        return None
    return client


async def _open_memory(settings: Settings) -> Checkpointer | None:
    """Open the conversation checkpointer, or carry on without it.

    ``specs/memory``: the stateless capabilities keep serving through a memory outage, and a
    follow-up reports that context is unavailable. Refusing to start would break the first.
    """
    checkpointer = Checkpointer(settings)
    try:
        await checkpointer.open()
    except (MemoryUnavailable, WeathraError, ValueError) as failure:
        logger.error("conversation memory is unavailable: %s", failure)
        await checkpointer.close()
        return None
    return checkpointer


def build_app(settings: Settings | None = None) -> FastAPI:
    """The application. Takes settings so a test can build one without touching the environment."""
    resolved = settings or Settings()

    app = FastAPI(
        title=TITLE,
        description=DESCRIPTION,
        version=__version__,
        lifespan=_lifespan,
        docs_url=f"{resolved.api_version_prefix}/docs",
        redoc_url=f"{resolved.api_version_prefix}/redoc",
        openapi_url=f"{resolved.api_version_prefix}/openapi.json",
    )
    app.state.settings = resolved

    install_error_handlers(app)

    # CORS first so it wraps the routers, then the request context, which therefore runs outermost
    # and gives *every* response an id — including one CORS rejects.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_allowed_origins),
        # Off on purpose: the token travels in a header, not a cookie, so credentialed CORS would
        # add exposure without adding capability.
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware)

    prefix = resolved.api_version_prefix
    for router in (
        health.router,
        locations.router,
        weather.router,
        changes.router,
        history.router,
        analysis.router,
        comparison.router,
        agent.router,
        account.router,
        evidence.router,
    ):
        app.include_router(router, prefix=prefix)

    apply_security_metadata(app, prefix=prefix)
    return app


def create_app() -> FastAPI:
    """The ASGI entry point. ``uvicorn weathra.api.app:create_app --factory``."""
    return build_app()
