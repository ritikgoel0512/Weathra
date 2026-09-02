"""Shared fixtures for the agent suite: an in-process MCP tool client, and evidence-record parts.

The MCP client is the real one, connected over the in-process transport to a real server backed by
the stub provider. That combination is what makes the graph tests worth running: the nodes call
tools exactly as they will in production, the tools run the real analytics, and nothing reaches the
network (design.md decision 20).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx

from tests.provider_support import StubProvider, stub_capabilities
from weathra.config import Settings
from weathra.domain.errors import LocationNotFound
from weathra.domain.evidence import Attribution, Finding, ToolCall, ToolResult
from weathra.domain.location import Ambiguous, Location, Resolution, Resolved
from weathra.domain.weather import DataClass, Period, UnitSystem
from weathra.mcp.client import McpToolClient
from weathra.mcp.server import ToolContext, build_server

NOW = datetime(2025, 6, 15, 9, 0, tzinfo=UTC)

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    region="Berlin",
    country="Germany",
    country_code="DE",
)
MUNICH = Location(
    display_name="Munich",
    latitude=48.14,
    longitude=11.58,
    timezone="Europe/Berlin",
    country_code="DE",
)
LISBON = Location(
    display_name="Lisbon",
    latitude=38.72,
    longitude=-9.14,
    timezone="Europe/Lisbon",
    country_code="PT",
)

KNOWN_PLACES: dict[str, Location] = {
    "berlin": BERLIN,
    "munich": MUNICH,
    "münchen": MUNICH,
    "lisbon": LISBON,
    "lisboa": LISBON,
}


class StubGeocoder:
    """Resolves a small fixed gazetteer. Never touches the network.

    A place it does not know raises ``LocationNotFound``, which is what the refusal tests need: no
    nearest match, no partial match, no substitution.
    """

    name = "stub"

    def __init__(self, *, ambiguous: tuple[Location, ...] = ()) -> None:
        self._ambiguous = ambiguous
        self.resolve_calls: list[str] = []

    async def resolve(self, query: str) -> Resolution:
        self.resolve_calls.append(query)
        cleaned = query.strip().casefold()

        if self._ambiguous and cleaned == "springfield":
            return Ambiguous(query=query, candidates=self._ambiguous)

        found = KNOWN_PLACES.get(cleaned)
        if found is None:
            raise LocationNotFound(f"No location matched {query!r}.", details={"query": query})
        return Resolved(query=query, location=found)

    async def resolve_coordinates(self, latitude: float, longitude: float) -> Location:
        for location in KNOWN_PLACES.values():
            if (
                abs(location.latitude - latitude) < 0.5
                and abs(location.longitude - longitude) < 0.5
            ):
                return location
        return Location(
            display_name=f"{latitude:.2f}, {longitude:.2f}",
            latitude=latitude,
            longitude=longitude,
            timezone="UTC",
        )

    async def search(self, query: str, *, limit: int = 5) -> tuple[Location, ...]:
        cleaned = query.strip().casefold()
        return tuple(location for name, location in KNOWN_PLACES.items() if cleaned in name)[:limit]


def agent_settings(**overrides: object) -> Settings:
    """Settings for an agent run: in-process MCP, no inference credential unless asked."""
    values: dict[str, object] = {
        "supabase_url": "https://test.supabase.co",
        "mcp_transport": "in-process",
        "http_backoff_seconds": 0,
        "agent_max_steps": 12,
        "agent_wall_clock_budget_seconds": 30.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def stub_provider(**overrides: object) -> StubProvider:
    """A provider with a week of plausible, slightly varying values."""
    values: dict[str, object] = {
        "daily_values": [11.0, 12.5, 13.0, 10.5, 14.0, 12.0, 11.5],
        "capabilities": stub_capabilities(),
    }
    values.update(overrides)
    return StubProvider(**values)  # type: ignore[arg-type]


@asynccontextmanager
async def connected_tools(
    *,
    settings: Settings | None = None,
    provider: StubProvider | None = None,
    geocoder: StubGeocoder | None = None,
    now: datetime | None = None,
) -> AsyncIterator[McpToolClient]:
    """A connected MCP tool client over the in-process transport.

    Entered inline rather than through an async-generator fixture: both MCP transports run their
    own anyio task group, and closing one from a different task raises "cancel scope in a different
    task" over the top of whatever actually happened.
    """
    resolved = settings or agent_settings()
    # A client the tools must never reach for: the stub provider and stub geocoder answer every
    # call, so an outbound request here would mean a tool went around them.
    async with httpx.AsyncClient(transport=httpx.MockTransport(_refuse_outbound)) as never_used:
        context = ToolContext(
            settings=resolved,
            client=never_used,
            provider=provider or stub_provider(),
            geocoder=geocoder or StubGeocoder(),
            now=now or NOW,
        )
        server = build_server(context)
        client = McpToolClient(settings=resolved, server=server)
        await client.connect()
        try:
            yield client
        finally:
            await client.close()


def _refuse_outbound(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"an agent test made an outbound request to {request.url}")


# =========================================================================== evidence parts


def attribution_for(
    location: Location = BERLIN,
    *,
    data_class: DataClass = DataClass.FORECAST,
    provider: str = "stub",
    days: int = 3,
) -> Attribution:
    return Attribution(
        provider=provider,
        location=location,
        data_class=data_class,
        period=period_for(location, days=days),
        retrieved_at=NOW,
    )


def period_for(location: Location = BERLIN, *, days: int = 3) -> Period:
    """A window whose local bounds are the same instants as its UTC ones, as ``Period`` requires."""
    end = NOW + timedelta(days=days)
    return Period(
        start_utc=NOW,
        end_utc=end,
        start_local=NOW.astimezone(location.zoneinfo),
        end_local=end.astimezone(location.zoneinfo),
        timezone=location.timezone,
    )


def finding_for(
    value: float,
    location: Location = BERLIN,
    *,
    label: str = "Maximum temperature",
    unit: str = "°C",
    data_class: DataClass = DataClass.FORECAST,
    method: str | None = None,
) -> Finding:
    return Finding(
        label=label,
        value=value,
        unit=unit,
        data_class=data_class,
        method=method,
        attribution=attribution_for(location, data_class=data_class),
    )


def tool_exchange(
    sequence: int,
    tool: str,
    location: Location = BERLIN,
    *,
    ok: bool = True,
    data_class: DataClass = DataClass.FORECAST,
) -> tuple[ToolCall, ToolResult]:
    from weathra.domain.evidence import AgentName

    call = ToolCall(
        sequence=sequence,
        tool=tool,
        agent=AgentName.FORECAST,
        arguments={"latitude": location.latitude, "longitude": location.longitude},
        started_at=NOW,
        duration_ms=4.0,
    )
    if ok:
        result = ToolResult(
            sequence=sequence,
            tool=tool,
            ok=True,
            data_class=data_class,
            attribution=attribution_for(location, data_class=data_class),
            payload={"ok": True},
        )
    else:
        result = ToolResult(
            sequence=sequence,
            tool=tool,
            ok=False,
            error_code="provider_unavailable",
            error_message="the provider could not be reached",
        )
    return call, result


def unit_system_of(name: str) -> UnitSystem:
    return UnitSystem(name)
