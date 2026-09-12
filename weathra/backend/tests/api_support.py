"""An app wired for tests: real routers, real error handling, substituted upstreams.

The app under test is the *real* one — ``build_app``, its lifespan, its middleware, its error
handlers, its routers. Only what reaches outside the process is substituted, and each substitution
is at a boundary the production code already has:

* the **weather provider** and the **geocoder** are stubs on ``app.state``, which is where the
  lifespan puts the real ones;
* the **token validator** is the real one over a locally minted key pair, so every rejection case
  the specs name is a token this harness can produce and no Supabase call happens;
* the **inference client** is the scripted fake, installed through ``LLMProvider.override`` — the
  same hook offline evaluation uses;
* the **HTTP client** is a transport that raises, so a code path that tried to reach the network
  fails the test loudly instead of slowly.

The MCP server runs in-process against those stubs, so the tool layer, the analytics, and the
evidence recording are all the real implementations.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tests.agent_support import NOW, StubGeocoder, stub_provider
from tests.auth_support import TokenFactory, seeded_cache
from tests.provider_support import StubProvider
from weathra.agents.llm.base import LLMClient
from weathra.agents.llm.fake import FakeLLMClient
from weathra.api.app import build_app
from weathra.auth.tokens import TokenValidator
from weathra.config import Settings
from weathra.rag.embed import DeterministicEmbedder

__all__ = [
    "ApiFactory",
    "ApiHarness",
    "api_factory",
    "api_settings",
    "capturing",
    "harness",
]

ApiFactory = Callable[..., AbstractAsyncContextManager["ApiHarness"]]
"""What a test is handed: a callable that opens a harness in the *test's own task*.

A factory rather than an async-generator fixture, because the MCP tool client runs its transport in
an anyio task group and pytest finalizes such a fixture in a different task from the one that
entered it — which raises "attempted to exit cancel scope in a different task" over the top of
whatever the test was actually asserting.
"""


def api_settings(factory: TokenFactory, database_url: str, **overrides: object) -> Settings:
    """Settings for an API test: the test database, in-process MCP, no inference credential.

    The issuer and audience match the token factory's, so the real validator accepts the tokens the
    factory mints and rejects everything else for the reasons the specs name.
    """
    values: dict[str, object] = {
        "supabase_url": "https://project.supabase.co",
        "supabase_jwt_issuer": factory.issuer,
        "supabase_jwt_audience": factory.audience,
        "database_url": database_url,
        "database_url_privileged": database_url,
        # The application's own defaults, rather than the two this used to cap it at. A request
        # serving an agent question now holds up to three connections at its peak — its own
        # transaction, the background telemetry write, and the quota gate's short reserve-or-settle
        # — and a pool of two starves the telemetry write until its timeout fires. Capping the
        # suite below what the app is configured for tests a resource budget nothing runs on.
        "database_pool_size": 5,
        "database_pool_max_overflow": 2,
        "mcp_transport": "in-process",
        "embedding_model_id": "weathra-hashing-v1",
        "http_backoff_seconds": 0,
        "cors_allowed_origins": ("http://localhost:3000",),
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _refuse_outbound(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"an API test made an outbound request to {request.url}")


@contextmanager
def capturing(caplog: Any, *, logger_name: str = "", level: int = logging.INFO) -> Iterator[None]:
    """Capture log records the app emits, after its own logging configuration has run.

    The lifespan calls ``logging.config.dictConfig``, which replaces the root logger's handlers —
    including the one pytest's ``caplog`` installed. That is correct for the app and inconvenient
    here, so the capture handler is re-attached for the duration of the assertion rather than the
    app being made to tiptoe around a test fixture.
    """
    target = logging.getLogger(logger_name)
    previous = target.level
    target.setLevel(level)
    target.addHandler(caplog.handler)
    try:
        yield
    finally:
        target.removeHandler(caplog.handler)
        target.setLevel(previous)


@dataclass(slots=True)
class ApiHarness:
    """The app, a client for it, and the substitutions a test can reach for."""

    app: FastAPI
    client: httpx.AsyncClient
    settings: Settings
    factory: TokenFactory
    provider: StubProvider
    geocoder: StubGeocoder
    llm: FakeLLMClient | None = None
    _now: datetime = field(default=NOW)

    def authorize(self, *, subject: str, **claims: object) -> dict[str, str]:
        """Headers bearing a valid token for one subject."""
        return {"Authorization": f"Bearer {self.factory.valid(subject=subject, **claims)}"}

    def bearer(self, token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def script(
        self,
        *,
        completions: list[str] | None = None,
        json_responses: list[object] | None = None,
        failure: Exception | None = None,
    ) -> FakeLLMClient:
        """Install a scripted inference client, the way offline evaluation does."""
        fake = FakeLLMClient(
            completions=completions or [],
            json_responses=json_responses or [],  # type: ignore[arg-type]
            failure=failure,
        )
        self.app.state.inference.override(fake)
        self.llm = fake
        return fake

    def unconfigure_inference(self) -> None:
        """Put the provider back to having no credential, for the 503 case."""
        from weathra.agents.llm.registry import LLMProvider

        self.app.state.inference = LLMProvider(
            self.app.state.http_client,
            self.settings.model_copy(update={"openrouter_api_key": None}),
        )

    def installed_client(self) -> LLMClient | None:
        return self.llm


@asynccontextmanager
async def harness(
    *,
    factory: TokenFactory,
    database_url: str,
    provider: StubProvider | None = None,
    geocoder: StubGeocoder | None = None,
    now: datetime | None = None,
    **overrides: object,
) -> AsyncIterator[ApiHarness]:
    """Build the real app against stub upstreams, and run its lifespan.

    The stubs are installed on ``app.state`` *after* the lifespan has run, overwriting what it
    built. Doing it that way rather than by patching means the lifespan's own wiring is exercised —
    including the MCP connection, which is then rebuilt against the stub provider so the tool layer
    answers from fixtures.
    """
    settings = api_settings(factory, database_url, **overrides)
    app = build_app(settings)

    # The app harness's forecast begins today.
    #
    # `StubProvider` otherwise starts its series on a fixed date, which the unit suites assert
    # against by literal and must keep. A *route* test cannot: anything that refuses a window
    # already past — Travel Intelligence refuses a trip in the past — has no date that is both
    # inside a fixed 2026-03 window and not behind the real clock. A forecast that starts now is
    # what a forecast provider actually does, and it leaves every literal-asserting unit test alone.
    stub_weather = provider or stub_provider(forecast_start=date.today())
    stub_places = geocoder or StubGeocoder()

    async with (
        httpx.AsyncClient(transport=httpx.MockTransport(_refuse_outbound)) as no_network,
        app.router.lifespan_context(app),
    ):
        # Substituted at the boundaries the lifespan itself uses.
        app.state.weather_provider = stub_weather
        app.state.geocoder = stub_places
        app.state.embedder = DeterministicEmbedder(model_id="weathra-hashing-v1")
        app.state.token_validator = TokenValidator(
            settings=settings, jwks=seeded_cache(factory, settings=settings)
        )
        # The lifespan's real client would reach the network; this one raises instead.
        await app.state.http_client.aclose()
        app.state.http_client = no_network

        # The in-process MCP server the lifespan built wraps the *real* provider, so it is
        # rebuilt here against the stub. The client is the real one either way.
        await _reconnect_tools(app, settings, stub_weather, stub_places, now or NOW)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://weathra.test",
        ) as client:
            yield ApiHarness(
                app=app,
                client=client,
                settings=settings,
                factory=factory,
                provider=stub_weather,
                geocoder=stub_places,
            )


async def _reconnect_tools(
    app: FastAPI,
    settings: Settings,
    provider: StubProvider,
    geocoder: StubGeocoder,
    now: datetime,
) -> None:
    """Rebuild the in-process MCP server against the stubs and reconnect the real client."""
    from weathra.mcp.client import McpToolClient
    from weathra.mcp.server import ToolContext, build_server

    if app.state.tools is not None:
        await app.state.tools.close()

    server = build_server(
        ToolContext(
            settings=settings,
            client=app.state.http_client,
            provider=provider,
            geocoder=geocoder,
            now=now,
        )
    )
    client = McpToolClient(settings=settings, server=server)
    await client.connect()
    app.state.tools = client


@pytest.fixture
def api_factory(
    token_factory: TokenFactory, checkpointer_schema: str, clean_database: None
) -> ApiFactory:
    """A harness the *test* opens, rather than a fixture that holds one open.

    The MCP tool client runs its transport in an anyio task group, and pytest finalizes an
    async-generator fixture in a different task from the one that set it up — which raises
    "attempted to exit cancel scope in a different task" over the top of whatever the test was
    actually doing. Handing back a factory keeps setup, body, and teardown in one task, and is the
    same shape ``tests/agent_support.connected_tools`` already uses for the same reason.

    It depends on ``checkpointer_schema`` rather than ``migrated_database`` — the same URL, plus
    LangGraph's tables — because this harness boots the whole app, and the thread and account
    deletion routes reach the checkpointer. A deployed app always has those tables; a test app
    built on the migrations alone did not, and failed on the ``DELETE`` routes only.
    """

    def build(**overrides: Any) -> AbstractAsyncContextManager[ApiHarness]:
        return harness(factory=token_factory, database_url=checkpointer_schema, **overrides)

    return build
