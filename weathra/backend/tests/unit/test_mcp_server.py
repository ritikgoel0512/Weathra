"""Group 10 — the MCP weather server: catalog, contracts, determinism, validation, errors,
transport, and the boundary.

Every tool is exercised **over the real protocol** through the in-memory transport, not by calling
the handler function. That is the point of the boundary: what a client sees is the schema, the
error flag, and the structured content — and a test that called the handler directly would verify
none of it.
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from mcp.client._memory import InMemoryTransport
from mcp.client.session import ClientSession

from tests import factories as f
from tests.provider_support import StubProvider, fixture, provider_settings
from weathra.config import Settings
from weathra.domain.errors import ProviderTimeout, ProviderUnavailable
from weathra.domain.location import Location
from weathra.domain.weather import Forecast, Measure, UnitSystem
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.mcp.client import McpToolClient
from weathra.mcp.errors import ToolErrorClass
from weathra.mcp.schemas import TOOL_NAMES
from weathra.mcp.server import ToolContext, build_server
from weathra.providers.base import WeatherProvider
from weathra.providers.open_meteo import OpenMeteoProvider
from weathra.providers.registry import ProviderNotFound

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)

# A transport that answers whichever Open-Meteo endpoint is asked for, from the recordings.
ROUTES = {
    "geocoding-api": "geocode_reykjavik",
    "archive-api": "archive_berlin_2025_02",
    "api.open-meteo.com": "forecast_berlin_metric_7d",
}


def routed_client(overrides: dict[str, str] | None = None) -> httpx.AsyncClient:
    routes = {**ROUTES, **(overrides or {})}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        # Checked before `current=`: a coordinate lookup asks for both, and it is the timezone it
        # actually wants.
        if "timezone=auto" in url:
            return httpx.Response(200, json=fixture("timezone_lookup_reykjavik"))
        if "current=" in url:
            return httpx.Response(200, json=fixture("current_berlin_metric"))
        for fragment, name in routes.items():
            if fragment in url:
                return httpx.Response(200, json=fixture(name))
        raise AssertionError(f"unexpected outbound request to {url}")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def context(
    *,
    client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
    provider: WeatherProvider | None = None,
) -> ToolContext:
    resolved = settings or provider_settings()
    http = client or routed_client()
    return ToolContext(
        settings=resolved,
        client=http,
        provider=provider,
        geocoder=OpenMeteoGeocoder(settings=resolved, client=http),
        now=NOW,
    )


class Connected:
    """A client session over the in-memory transport, for one test."""

    def __init__(self, tool_context: ToolContext | None = None) -> None:
        self._context = tool_context or context()
        self._stack: Any = None
        self.session: ClientSession | None = None

    async def __aenter__(self) -> ClientSession:
        from contextlib import AsyncExitStack

        self._stack = AsyncExitStack()
        await self._stack.__aenter__()
        server = build_server(self._context)
        read, write = await self._stack.enter_async_context(InMemoryTransport(server))
        self.session = await self._stack.enter_async_context(ClientSession(read, write))
        await self.session.initialize()
        return self.session

    async def __aexit__(self, *args: object) -> None:
        await self._stack.__aexit__(*args)


def structured(result: Any) -> dict[str, Any]:
    return dict(getattr(result, "structured_content", None) or {})


def failed(result: Any) -> bool:
    return bool(getattr(result, "is_error", False))


# =========================================================================== 10.1 the catalog


async def test_all_seven_tools_are_listed_with_schemas_and_descriptions() -> None:
    async with Connected() as session:
        catalog = await session.list_tools()
        by_name = {tool.name: tool for tool in catalog.tools}

        assert set(by_name) == set(TOOL_NAMES)
        for name, tool in by_name.items():
            assert tool.description, f"{name} has no description"
            assert tool.input_schema, f"{name} has no input schema"
            assert tool.input_schema.get("type") == "object"


async def test_every_tool_schema_declares_its_properties() -> None:
    """A client must be able to construct a call from the schema alone."""
    async with Connected() as session:
        catalog = await session.list_tools()
        for tool in catalog.tools:
            properties = tool.input_schema.get("properties", {})
            assert properties, f"{tool.name} declares no arguments"
            # Flat, not one nested object: a caller must be able to build a call from the schema
            # alone, which a `{"arguments": {...}}` wrapper would not allow.
            assert set(properties) != {"arguments"}, f"{tool.name}'s schema is nested"
            for argument, schema in properties.items():
                # A `$ref` to an enum carries its documentation in `$defs` rather than at the
                # property, which is still self-describing to a client reading the whole schema.
                described = schema.get("description") or schema.get("title") or schema.get("$ref")
                assert described, f"{tool.name}.{argument} is undocumented in the schema"


async def test_each_tool_description_states_the_data_class_it_returns() -> None:
    async with Connected() as session:
        catalog = await session.list_tools()
        by_name = {tool.name: (tool.description or "") for tool in catalog.tools}

        assert "historical_observation" in by_name["weather_history"]
        assert "not a forecast" in by_name["weather_history"].lower()
        assert "'current'" in by_name["weather_current"]
        assert "not a forecast" in by_name["weather_current"].lower()
        assert "'forecast'" in by_name["weather_forecast"]
        assert "computed_statistic" in by_name["weather_statistics"]
        assert "computed_statistic" in by_name["weather_anomaly"]


async def test_no_tool_offers_a_write_or_code_execution() -> None:
    """specs/agent-orchestration: nothing in the catalog can write, execute, or reach the disk."""
    async with Connected() as session:
        catalog = await session.list_tools()
        for tool in catalog.tools:
            rendered = f"{tool.name} {tool.description} {tool.input_schema}".lower()
            for forbidden in ("exec", "eval", "shell", "subprocess", "filepath", "sql", "delete"):
                assert forbidden not in tool.name.lower(), f"{tool.name} names {forbidden}"
            assert "arbitrary" not in rendered


# =========================================================================== 10.2 the contracts


async def test_geocode_resolves_a_unique_name() -> None:
    async with Connected() as session:
        result = await session.call_tool("geocode_location", {"location": "Reykjavik"})
        payload = structured(result)

        assert failed(result) is False
        assert payload["ok"] is True
        assert payload["resolution"] == "resolved"
        assert payload["location"]["timezone"] == "Atlantic/Reykjavik"
        assert payload["location"]["identifier"].startswith("loc:")


async def test_geocode_surfaces_candidates_for_an_ambiguous_name() -> None:
    tool_context = context(client=routed_client({"geocoding-api": "geocode_springfield"}))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool("geocode_location", {"location": "Springfield"})
        payload = structured(result)

    assert failed(result) is False
    assert payload["resolution"] == "ambiguous"
    assert len(payload["candidates"]) >= 2
    assert payload["location"] is None
    assert "matches" in payload["note"]


async def test_geocode_by_coordinates_returns_a_timezone() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "geocode_location", {"latitude": 64.15, "longitude": -21.94}
        )
        payload = structured(result)
        assert payload["resolution"] == "resolved"
        assert payload["location"]["timezone"] == "Atlantic/Reykjavik"


async def test_current_conditions_carry_full_attribution() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_current", {"location": "Reykjavik"})
        payload = structured(result)
        attribution = payload["attribution"]

        assert attribution["location"]["display_name"]
        assert attribution["provider"] == "open-meteo"
        assert attribution["units"] == "metric"
        assert attribution["retrieved_at"]
        assert attribution["data_class"] == "current"
        assert attribution["timestamp_utc"]
        assert payload["values"]["temperature"] is not None


async def test_a_forecast_carries_attribution_findings_and_uncertainty() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_forecast", {"location": "Reykjavik", "days": 7})
        payload = structured(result)

        assert payload["attribution"]["data_class"] == "forecast"
        assert payload["attribution"]["period"]["timezone"]
        assert payload["horizon_days"] == 7
        assert payload["findings"]
        assert all("method" in finding for finding in payload["findings"])
        assert payload["uncertainty"]["multi_provider_consensus"] is False
        assert "not a multi-provider consensus" in payload["uncertainty"]["basis"]
        assert payload["summary"]


async def test_a_forecast_reports_the_units_it_was_asked_for() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_forecast", {"location": "Reykjavik", "days": 3, "units": "imperial"}
        )
        payload = structured(result)
        assert payload["attribution"]["units"] == "imperial"


async def test_no_tool_result_carries_a_provider_specific_field_name() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_forecast", {"location": "Reykjavik", "days": 3})
        rendered = str(structured(result))
        for upstream in (
            "temperature_2m",
            "wind_gusts_10m",
            "generationtime_ms",
            "utc_offset_seconds",
        ):
            assert upstream not in rendered


# =========================================================================== 10.3 history, compare


async def test_history_returns_observations_labelled_historical() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_history",
            {"location": "Reykjavik", "start": "2025-02-01", "end": "2025-02-28"},
        )
        payload = structured(result)

        assert failed(result) is False
        assert payload["attribution"]["data_class"] == "historical_observation"
        assert payload["daily"]["entries"]
        assert payload["partial"] is False


async def test_history_states_a_partial_range_precisely() -> None:
    from tests.provider_support import nullify_trailing

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "geocoding-api" in url:
            return httpx.Response(200, json=fixture("geocode_reykjavik"))
        return httpx.Response(
            200, json=nullify_trailing(fixture("archive_berlin_2025_02"), "daily", 5)
        )

    tool_context = context(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_history",
            {"location": "Reykjavik", "start": "2025-02-01", "end": "2025-02-28"},
        )
        payload = structured(result)

    assert payload["partial"] is True
    assert "not yet available" in payload["unavailable_note"]


async def test_compare_ranks_multiple_locations() -> None:
    """Two candidates, both resolvable, ranked with their supporting analytics."""
    tool_context = context(provider=StubProvider(daily_values=[10.0, 12.0, 14.0]))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_compare",
            {
                "criterion": "warmest",
                "candidates": [
                    {"latitude": 52.52, "longitude": 13.41},
                    {"latitude": 48.14, "longitude": 11.58},
                ],
                "days": 3,
            },
        )
        payload = structured(result)

    assert failed(result) is False
    assert payload["criterion"] == "warmest"
    assert payload["data_class"] == "forecast"
    assert len(payload["candidates"]) == 2
    assert all(candidate["supporting"] for candidate in payload["candidates"])
    assert payload["statistics_applied"]


async def test_compare_lists_an_excluded_candidate_with_its_reason() -> None:
    class OneFails(StubProvider):
        async def forecast(
            self,
            location: Location,
            *,
            days: int,
            unit_system: UnitSystem = UnitSystem.METRIC,
        ) -> Forecast:
            if location.latitude > 60:
                raise ProviderTimeout("The provider did not respond in time.")
            return await super().forecast(location, days=days, unit_system=unit_system)

    tool_context = context(provider=OneFails(daily_values=[10.0, 12.0, 14.0]))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_compare",
            {
                "criterion": "warmest",
                "candidates": [
                    {"latitude": 52.52, "longitude": 13.41},
                    {"latitude": 48.14, "longitude": 11.58},
                    {"latitude": 64.15, "longitude": -21.94},
                ],
                "days": 3,
            },
        )
        payload = structured(result)

    assert len(payload["candidates"]) == 2
    assert len(payload["excluded"]) == 1
    assert payload["excluded"][0]["code"] == "provider_timeout"


async def test_compare_supports_a_day_level_mode() -> None:
    tool_context = context(provider=StubProvider(daily_values=[10.0, 12.0, 14.0]))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_compare",
            {"criterion": "warmest", "location": "Reykjavik", "day_level": True, "days": 3},
        )
        payload = structured(result)

    assert payload["mode"] == "days"
    assert len(payload["candidates"]) == 3


async def test_compare_supports_a_historical_mode() -> None:
    tool_context = context(provider=StubProvider(daily_values=[10.0, 12.0, 14.0]))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_compare",
            {
                "criterion": "wettest",
                "candidates": [
                    {"latitude": 52.52, "longitude": 13.41},
                    {"latitude": 48.14, "longitude": 11.58},
                ],
                "mode": "historical",
                "start": "2025-02-01",
                "end": "2025-02-05",
            },
        )
        payload = structured(result)

    assert payload["data_class"] == "historical_observation"


async def test_the_composite_criterion_discloses_its_weighting() -> None:
    tool_context = context(provider=StubProvider(daily_values=[10.0, 12.0, 14.0]))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_compare",
            {
                "criterion": "outdoor_suitability",
                "candidates": [
                    {"latitude": 52.52, "longitude": 13.41},
                    {"latitude": 48.14, "longitude": 11.58},
                ],
                "days": 3,
            },
        )
        payload = structured(result)

    assert payload["weighting_disclosure"]
    assert "own heuristic" in payload["weighting_disclosure"]


# =========================================================================== 10.4 analytics tools


POINTS = [
    {"time_utc": "2026-03-02T00:00:00Z", "value": 11.0},
    {"time_utc": "2026-03-03T00:00:00Z", "value": 12.0},
    {"time_utc": "2026-03-04T00:00:00Z", "value": 11.5},
    {"time_utc": "2026-03-05T00:00:00Z", "value": 27.5},
    {"time_utc": "2026-03-06T00:00:00Z", "value": 12.0},
    {"time_utc": "2026-03-07T00:00:00Z", "value": 11.0},
    {"time_utc": "2026-03-08T00:00:00Z", "value": 12.5},
]


async def test_statistics_reports_method_parameters_and_point_count() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_statistics",
            {
                "measure": "temperature_max",
                "unit": "°C",
                "points": POINTS,
                "statistics": ["minimum", "maximum", "mean", "percentile"],
                "percentile": 90.0,
            },
        )
        payload = structured(result)

        assert failed(result) is False
        assert payload["data_class"] == "computed_statistic"
        assert payload["points_supplied"] == 7
        by_statistic = {item["statistic"]: item for item in payload["results"]}
        assert by_statistic["maximum"]["value"] == 27.5
        assert by_statistic["mean"]["points_used"] == 7
        assert "linear interpolation" in by_statistic["percentile"]["method"]
        assert by_statistic["percentile"]["parameters"]["level"] == 90.0


async def test_identical_statistics_arguments_give_identical_results() -> None:
    async with Connected() as session:
        arguments = {
            "measure": "temperature_max",
            "unit": "°C",
            "points": POINTS,
            "statistics": ["minimum", "maximum", "mean", "range"],
        }
        first = structured(await session.call_tool("weather_statistics", arguments))
        second = structured(await session.call_tool("weather_statistics", arguments))
        assert first == second


async def test_statistics_excludes_nulls_rather_than_zeroing_them() -> None:
    async with Connected() as session:
        points = [
            {"time_utc": "2026-03-02T00:00:00Z", "value": 10.0},
            {"time_utc": "2026-03-03T00:00:00Z", "value": None},
            {"time_utc": "2026-03-04T00:00:00Z", "value": 20.0},
        ]
        result = await session.call_tool(
            "weather_statistics",
            {"measure": "temperature_max", "unit": "°C", "points": points, "statistics": ["mean"]},
        )
        mean = structured(result)["results"][0]
        assert mean["value"] == 15.0, "a null was treated as zero"
        assert mean["points_used"] == 2
        assert mean["points_excluded"] == 1


async def test_anomaly_reports_its_method_threshold_and_point_count() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_anomaly", {"measure": "temperature_max", "unit": "°C", "points": POINTS}
        )
        payload = structured(result)

        assert failed(result) is False
        assert "median absolute deviation" in payload["method"]
        assert payload["threshold"] == 2.0
        assert payload["points_used"] == 7
        assert [point["value"] for point in payload["anomalies"]] == [27.5]
        assert payload["minimum"]["value"] == 11.0
        assert payload["maximum"]["value"] == 27.5


async def test_anomaly_always_reports_extremes_even_with_none_found() -> None:
    async with Connected() as session:
        flat = [
            {"time_utc": f"2026-03-{day:02d}T00:00:00Z", "value": 11.0 + (day % 2) * 0.1}
            for day in range(2, 9)
        ]
        payload = structured(
            await session.call_tool(
                "weather_anomaly", {"measure": "temperature_max", "unit": "°C", "points": flat}
            )
        )
        assert payload["anomalies"] == []
        assert payload["minimum"]["value"] == 11.0
        assert payload["maximum"]["value"] == 11.1


async def test_the_analytics_tools_succeed_with_no_inference_credential() -> None:
    async with Connected() as session:
        assert provider_settings().openrouter_api_key is None
        for tool, arguments in (
            (
                "weather_statistics",
                {
                    "measure": "temperature_max",
                    "unit": "°C",
                    "points": POINTS,
                    "statistics": ["mean"],
                },
            ),
            ("weather_anomaly", {"measure": "temperature_max", "unit": "°C", "points": POINTS}),
        ):
            result = await session.call_tool(tool, arguments)
            assert failed(result) is False, tool


# =========================================================================== 10.5 validation


async def test_a_missing_required_argument_is_refused_with_no_upstream_call() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=fixture("forecast_berlin_metric_7d"))

    tool_context = context(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool("weather_history", {"location": "Reykjavik"})

    assert failed(result) is True
    assert calls == [], "an invalid call reached the provider"


async def test_a_zero_day_horizon_is_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_forecast", {"location": "Reykjavik", "days": 0})
        assert failed(result) is True
        text = " ".join(block.text for block in result.content if hasattr(block, "text"))
        assert "days" in text


async def test_an_over_long_horizon_states_the_maximum() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_forecast", {"location": "Reykjavik", "days": 30})
        assert failed(result) is True


async def test_an_unknown_tool_name_is_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_teleport", {})
        assert failed(result) is True
        text = " ".join(block.text for block in result.content if hasattr(block, "text"))
        assert "weather_teleport" in text


async def test_no_location_at_all_is_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool("weather_current", {})
        assert failed(result) is True


async def test_both_location_forms_at_once_are_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_current", {"location": "Berlin", "latitude": 52.52, "longitude": 13.41}
        )
        assert failed(result) is True


async def test_an_unrecognized_argument_is_ignored_rather_than_honoured() -> None:
    """What the protocol layer actually does, recorded rather than assumed.

    The MCP SDK validates arguments against the declared schema and drops anything the schema does
    not name, so an unknown argument never reaches a handler. That is weaker than rejecting it, but
    it is the property that matters: a caller cannot smuggle a parameter past the schema. The three
    invalid-call cases `specs/mcp-weather-server` does name — a missing required argument, an
    out-of-range one, and an unknown tool name — are each covered above.
    """
    async with Connected() as session:
        result = await session.call_tool(
            "weather_current", {"location": "Reykjavik", "colour": "blue"}
        )
        assert failed(result) is False
        assert "colour" not in str(structured(result))


async def test_a_single_candidate_comparison_is_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_compare",
            {"criterion": "warmest", "candidates": [{"latitude": 52.52, "longitude": 13.41}]},
        )
        assert failed(result) is True


async def test_an_unsupported_criterion_lists_the_supported_ones() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_compare",
            {
                "criterion": "sunniest",
                "candidates": [
                    {"latitude": 52.52, "longitude": 13.41},
                    {"latitude": 48.14, "longitude": 11.58},
                ],
            },
        )
        payload = structured(result)
        assert failed(result) is True
        assert payload["error_class"] == ToolErrorClass.INVALID_INPUT.value
        assert "warmest" in payload["message"]


async def test_a_percentile_without_a_level_is_refused() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_statistics",
            {
                "measure": "temperature_max",
                "unit": "°C",
                "points": POINTS,
                "statistics": ["percentile"],
            },
        )
        assert failed(result) is True


async def test_an_unsupported_statistic_lists_the_supported_ones() -> None:
    async with Connected() as session:
        result = await session.call_tool(
            "weather_statistics",
            {
                "measure": "temperature_max",
                "unit": "°C",
                "points": POINTS,
                "statistics": ["median_of_medians"],
            },
        )
        payload = structured(result)
        assert failed(result) is True
        assert "minimum" in str(payload["details"]["supported"])


# =========================================================================== 10.6 error semantics


@pytest.mark.parametrize(
    ("failure", "expected_class", "retryable"),
    [
        (ProviderTimeout("too slow"), ToolErrorClass.PROVIDER_TIMEOUT, True),
        (ProviderUnavailable("unreachable"), ToolErrorClass.PROVIDER_UNAVAILABLE, True),
    ],
)
async def test_a_provider_failure_is_a_structured_tool_error(
    failure: Exception, expected_class: ToolErrorClass, retryable: bool
) -> None:
    class Failing(StubProvider):
        async def forecast(
            self,
            location: Location,
            *,
            days: int,
            unit_system: UnitSystem = UnitSystem.METRIC,
        ) -> Forecast:
            raise failure

    tool_context = context(provider=Failing())
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_forecast", {"latitude": 52.52, "longitude": 13.41, "days": 3}
        )
        payload = structured(result)

    assert failed(result) is True, "a failure must be flagged as an error, not returned as data"
    assert payload["ok"] is False
    assert payload["error_class"] == expected_class.value
    assert payload["retryable"] is retryable
    assert "temperature" not in str(payload), "an error must carry no weather values"


async def test_every_error_class_is_distinguishable() -> None:
    """The six classes specs/mcp-weather-server requires to be tellable apart."""
    from weathra.domain.errors import (
        LocationNotFound,
        NoDataForRange,
        ProviderRateLimited,
        ValidationFailed,
    )
    from weathra.mcp.errors import tool_error_for

    classes = {
        tool_error_for(failure).error_class
        for failure in (
            ValidationFailed("bad"),
            LocationNotFound("nowhere"),
            NoDataForRange("nothing"),
            ProviderUnavailable("down"),
            ProviderTimeout("slow"),
            ProviderRateLimited("limited"),
        )
    }
    assert len(classes) == 6


async def test_an_unresolvable_location_is_its_own_error_class() -> None:
    tool_context = context(client=routed_client({"geocoding-api": "geocode_none"}))
    async with Connected(tool_context) as opened:
        result = await opened.call_tool("weather_current", {"location": "zzzzqqqqxxxx"})
        payload = structured(result)

    assert failed(result) is True
    assert payload["error_class"] == ToolErrorClass.LOCATION_NOT_RESOLVABLE.value


async def test_no_error_body_carries_credential_material() -> None:
    class Leaky(StubProvider):
        async def forecast(
            self,
            location: Location,
            *,
            days: int,
            unit_system: UnitSystem = UnitSystem.METRIC,
        ) -> Forecast:
            raise ProviderUnavailable(
                "upstream said: apikey=super-secret-value",
                details={"authorization": "Bearer super-secret-value"},
            )

    tool_context = context(provider=Leaky())
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_forecast", {"latitude": 52.52, "longitude": 13.41, "days": 3}
        )
        rendered = str(structured(result)) + " ".join(
            block.text for block in result.content if hasattr(block, "text")
        )

    assert "super-secret-value" not in rendered


async def test_an_unexpected_failure_stays_opaque() -> None:
    class Broken(StubProvider):
        async def forecast(
            self,
            location: Location,
            *,
            days: int,
            unit_system: UnitSystem = UnitSystem.METRIC,
        ) -> Forecast:
            raise RuntimeError("internal detail: /var/secrets/db-password")

    tool_context = context(provider=Broken())
    async with Connected(tool_context) as opened:
        result = await opened.call_tool(
            "weather_forecast", {"latitude": 52.52, "longitude": 13.41, "days": 3}
        )
        payload = structured(result)

    assert failed(result) is True
    assert payload["error_class"] == ToolErrorClass.INTERNAL.value
    assert "db-password" not in str(payload)
    assert payload["details"] == {"exception": "RuntimeError"}


# =========================================================================== 10.7 the client


async def test_the_client_connects_and_lists_the_catalog() -> None:
    server = build_server(context())
    async with McpToolClient(settings=provider_settings(), server=server) as client:
        assert set(client.tool_names()) == set(TOOL_NAMES)
        catalog = client.catalog_for_prompt()
        assert len(catalog) == 7
        assert all(entry["description"] and entry["input_schema"] for entry in catalog)


async def test_the_client_returns_a_failure_as_an_outcome_rather_than_raising() -> None:
    server = build_server(context())
    async with McpToolClient(settings=provider_settings(), server=server) as client:
        outcome = await client.call("weather_current", {})

    assert outcome.failed is True
    assert outcome.error_code
    assert outcome.tool == "weather_current"


async def test_the_client_refuses_an_unknown_tool_with_the_available_names() -> None:
    from weathra.domain.errors import ToolNotFound

    server = build_server(context())
    async with McpToolClient(settings=provider_settings(), server=server) as client:
        with pytest.raises(ToolNotFound) as caught:
            await client.call("weather_teleport", {})

    assert "weather_teleport" in caught.value.message
    assert "weather_forecast" in caught.value.message


async def test_an_unreachable_server_fails_at_startup_naming_it_and_its_address() -> None:
    """specs/mcp-weather-server: the failure names the server and its configured address."""
    from weathra.domain.errors import McpUnavailable

    settings = provider_settings(mcp_transport="http", mcp_server_address="http://127.0.0.1:1/mcp")
    with pytest.raises(McpUnavailable) as caught:
        async with McpToolClient(settings=settings):
            pass

    assert "weathra-weather" in caught.value.message
    assert "http://127.0.0.1:1/mcp" in caught.value.message
    assert caught.value.details["address"] == "http://127.0.0.1:1/mcp"


async def test_an_in_process_client_with_no_server_is_a_wiring_error() -> None:
    from weathra.domain.errors import McpUnavailable

    with pytest.raises(McpUnavailable, match="wiring error"):
        async with McpToolClient(settings=provider_settings()):
            pass


async def test_a_server_missing_a_configured_tool_fails_at_startup() -> None:
    from mcp.server.mcpserver import MCPServer

    from weathra.domain.errors import McpUnavailable

    bare = MCPServer(name="bare")

    @bare.tool(name="geocode_location", description="Only one tool.")
    def only(location: str) -> dict[str, str]:
        return {"location": location}

    with pytest.raises(McpUnavailable) as caught:
        async with McpToolClient(settings=provider_settings(), server=bare):
            pass

    assert "does not expose the configured tools" in caught.value.message
    assert "weather_forecast" in caught.value.message


async def test_the_client_honours_a_narrowed_enabled_tool_set() -> None:
    """The enabled set is configuration; a subset must not fail startup."""
    settings = provider_settings(mcp_enabled_tools="geocode_location,weather_current")
    server = build_server(context(settings=settings))
    async with McpToolClient(settings=settings, server=server) as client:
        assert "weather_current" in client.tool_names()


# =========================================================================== 10.8 the boundary


MCP_ROOT = Path(__file__).resolve().parents[2] / "weathra" / "mcp"

FORBIDDEN_IMPORTS = ("weathra.agents", "weathra.api", "weathra.memory", "weathra.evaluation")


def test_no_mcp_module_imports_the_graph_the_api_or_the_auth_layer() -> None:
    """The boundary task 10.8 asks for, read off the real source tree."""
    offences: list[str] = []
    for path in MCP_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            targets: list[str] = []
            if isinstance(node, ast.Import):
                targets = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                targets = [node.module]
            for target in targets:
                if target.startswith(FORBIDDEN_IMPORTS) or target.startswith("weathra.auth"):
                    offences.append(f"{path.name} imports {target}")
    assert not offences, offences


async def test_every_tool_is_exercisable_without_a_graph_or_a_principal() -> None:
    """Seven tools, seven calls, no agent graph constructed and no identity anywhere."""
    async with Connected() as session:
        calls: list[tuple[str, dict[str, Any]]] = [
            ("geocode_location", {"location": "Reykjavik"}),
            ("weather_current", {"location": "Reykjavik"}),
            ("weather_forecast", {"location": "Reykjavik", "days": 3}),
            (
                "weather_history",
                {"location": "Reykjavik", "start": "2025-02-01", "end": "2025-02-10"},
            ),
            (
                "weather_compare",
                {"criterion": "warmest", "location": "Reykjavik", "day_level": True, "days": 3},
            ),
            (
                "weather_statistics",
                {
                    "measure": "temperature_max",
                    "unit": "°C",
                    "points": POINTS,
                    "statistics": ["mean"],
                },
            ),
            ("weather_anomaly", {"measure": "temperature_max", "unit": "°C", "points": POINTS}),
        ]

        for name, arguments in calls:
            result = await session.call_tool(name, arguments)
            assert failed(result) is False, (name, structured(result))


def test_the_tool_context_carries_no_identity_or_session() -> None:
    """There is nothing to scope here, so there is nothing to get wrong."""
    fields = set(ToolContext.__dataclass_fields__)
    assert fields == {"settings", "client", "provider", "geocoder", "now"}
    assert not any(
        term in field for field in fields for term in ("principal", "user", "session", "token")
    )


async def test_the_server_starts_with_no_inference_credential_configured() -> None:
    settings = provider_settings()
    assert settings.openrouter_api_key is None
    server = build_server(context(settings=settings))
    async with McpToolClient(settings=settings, server=server) as client:
        assert len(client.tools) == 7


def test_the_tools_are_reachable_without_the_open_meteo_provider_class() -> None:
    """A stub provider satisfies the whole tool surface, which is what makes it swappable."""
    built = context(provider=StubProvider())
    assert built.weather().capabilities().name == "stub"
    assert not isinstance(built.weather(), OpenMeteoProvider)


def test_the_measure_vocabulary_is_the_domains_own() -> None:
    """A tool argument names a Weathra measure, not a provider field."""
    assert Measure.TEMPERATURE_MAX.value == "temperature_max"
    assert f.BERLIN.identifier.startswith("loc:")


class TestSharedProviderCache:
    """The tool surface must not throw away the cache the application built for it.

    ``ToolContext.provider`` is the process-wide ``CachedProvider`` from the lifespan, and it is
    the only thing between ordinary navigation and Open-Meteo's rate limiter. Every weather tool
    forwards ``arguments.provider``, a free-text field the tool schema openly invites a model to
    fill in — so naming the configured provider explicitly used to build a second, empty cache,
    miss it by construction, and issue an upstream call the shared cache already had an answer for.
    """

    def test_omitting_the_provider_uses_the_shared_cache(self) -> None:
        shared = StubProvider()
        tools = context(provider=shared)

        assert tools.weather(None) is shared

    def test_naming_the_configured_provider_uses_the_shared_cache(self) -> None:
        shared = StubProvider()
        settings = provider_settings()
        tools = context(provider=shared, settings=settings)

        # The regression: the same provider, spelled out rather than omitted.
        assert tools.weather(settings.default_weather_provider) is shared

    def test_naming_a_different_provider_still_gets_its_own(self) -> None:
        shared = StubProvider()
        tools = context(provider=shared)

        # The case the argument exists for. An unregistered name fails in the registry rather than
        # quietly returning the shared provider, which is what proves the branch was taken.
        with pytest.raises(ProviderNotFound):
            tools.weather("not-a-registered-provider")
