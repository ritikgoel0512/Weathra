"""The MCP weather server: Weathra's single approved tool boundary.

Its own component, with its own module boundary and its own tests. It depends on ``providers``,
``geocoding``, ``analytics``, and ``weather`` — and on **nothing above it**. No agent graph, no
HTTP router, no auth layer (``specs/mcp-weather-server``, and the boundary test in task 10.8).

Two consequences of that are worth stating:

* **It needs no inference credential.** Every tool is retrieval or deterministic computation, so
  the server starts and answers with none configured — which is what makes the whole analytics and
  weather surface usable without an LLM at all.
* **It needs no principal.** Tools operate on the arguments they are given. Nothing here reads
  user-owned data, so there is no identity to check and no ownership to enforce; that boundary
  lives in ``api/`` and ``memory/``, above this layer.

Transport is configuration (design.md decision 13). In the MVP the server is reached over the
in-process transport, and promoting it to its own service is a deployment change rather than a
rewrite.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from mcp import types
from mcp.server.mcpserver import MCPServer
from pydantic import BaseModel, ValidationError

from weathra.analytics import descriptive, precipitation
from weathra.analytics.anomaly import DEFAULT_THRESHOLD, detect_anomalies
from weathra.analytics.distribution import percentile
from weathra.analytics.rolling import delta, rolling_mean
from weathra.analytics.trend import analyse_trend
from weathra.config import Settings
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.errors import (
    ValidationFailed,
    WeathraError,
)
from weathra.domain.location import Ambiguous, Location, Resolved
from weathra.domain.weather import (
    DataClass,
    Granularity,
    Measure,
    Series,
    SeriesEntry,
    UnitSystem,
)
from weathra.domain.windows import period_from_utc_instants
from weathra.geocoding.base import Geocoder
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.mcp.errors import (
    error_result,
    tool_error_for,
    unexpected_error,
    validation_error,
)
from weathra.mcp.schemas import (
    TOOL_NAMES,
    AnomalyInput,
    CompareCandidate,
    CompareInput,
    CurrentInput,
    ForecastInput,
    GeocodeInput,
    HistoryInput,
    SatelliteInput,
    StatisticsInput,
    ToolAttribution,
    ToolLocation,
    ToolPeriod,
)
from weathra.providers.base import WeatherProvider
from weathra.providers.cache import CachedProvider
from weathra.providers.gibs import GibsSatelliteProvider, SatelliteProvider
from weathra.providers.registry import build_provider
from weathra.providers.validation import resolve_horizon
from weathra.weather.comparison_service import ComparisonService, parse_criterion
from weathra.weather.forecast_service import analyse as analyse_forecast
from weathra.weather.history_service import HistoryService
from weathra.weather.uncertainty import describe_uncertainty

__all__ = ["ToolContext", "build_server", "tool_names"]

logger = logging.getLogger("weathra.mcp.server")

SERVER_NAME = "weathra-weather"

# One tool handler: a validated input model in, a structured payload or an explicit error out.
ToolHandler = Callable[[Any], Awaitable["types.CallToolResult | dict[str, Any]"]]

# Subscripted at runtime to rebuild a field's annotation. Held as Any because mypy reads a direct
# `Annotated[...]` subscript as a type form and would try to resolve `field.annotation` as a name.
_annotated: Any = Annotated


def tool_names() -> tuple[str, ...]:
    return TOOL_NAMES


@dataclass(slots=True)
class ToolContext:
    """Everything the tools need, and nothing they do not.

    No principal and no database session: the tool surface reads no user-owned data, so there is
    nothing here to scope. ``now`` is injectable so a test does not depend on the wall clock.
    """

    settings: Settings
    client: httpx.AsyncClient
    provider: WeatherProvider | None = None
    geocoder: Geocoder | None = None
    now: datetime | None = None
    satellite_provider: SatelliteProvider | None = None

    def instant(self) -> datetime:
        return self.now or datetime.now(UTC)

    def satellite(self) -> SatelliteProvider:
        """The satellite source, built once on the shared HTTP client.

        Held rather than rebuilt per call for the same reason the weather provider is: one client,
        one connection pool, and no per-call construction between ordinary use and a public
        service's rate limiter. It takes no credential, so there is nothing to inject.
        """
        if self.satellite_provider is None:
            object.__setattr__(
                self, "satellite_provider", GibsSatelliteProvider(self.client, now=self.now)
            )
        held = self.satellite_provider
        assert held is not None  # set immediately above
        return held

    def weather(self, name: str | None = None) -> WeatherProvider:
        """The provider for a call, cached, honouring a per-call provider name.

        **A name that asks for the provider we already hold gets the one we already hold.** The
        shared ``CachedProvider`` is built once in the application's lifespan and is the only thing
        standing between ordinary navigation and Open-Meteo's rate limiter. Every weather tool
        passes ``arguments.provider`` straight through, and that argument is a free-text field on
        the tool schema — so a model naming the provider explicitly, which is exactly what the
        field invites, used to build a brand-new cache, miss it by construction, issue an upstream
        call, and then throw the populated cache away. Same provider, same coordinates, same
        window: an upstream request that the shared cache already had an answer for.

        Only a name for a *different* provider gets its own instance, which is the case the
        argument exists for.
        """
        shared = name is None or name == self.settings.default_weather_provider
        if shared and self.provider is not None:
            return self.provider
        return CachedProvider(
            build_provider(self.settings, self.client, name), settings=self.settings
        )

    def places(self) -> Geocoder:
        if self.geocoder is not None:
            return self.geocoder
        return OpenMeteoGeocoder(settings=self.settings, client=self.client)


def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    """Every success carries ``ok: true``, so a caller never has to infer it."""
    return {"ok": True, **payload}


async def _resolve(context: ToolContext, arguments: Any) -> Location:
    """One location from a tool's arguments, or a coded failure.

    An ambiguous name is a failure *here* rather than a list of candidates: a tool returning
    several locations would leave the caller guessing which one the following tool call meant.
    ``geocode_location`` is the tool that surfaces candidates, and the graph presents them.
    """
    if arguments.latitude is not None and arguments.longitude is not None:
        return await context.places().resolve_coordinates(arguments.latitude, arguments.longitude)

    resolution = await context.places().resolve(arguments.location or "")
    if isinstance(resolution, Resolved):
        return resolution.location

    raise ValidationFailed(
        f"{resolution.query!r} matches several places. Call geocode_location to see the "
        "candidates, then call again with coordinates or a region-qualified name.",
        details={
            "field": "location",
            "ambiguous": True,
            "candidates": [
                ToolLocation.of(candidate).model_dump(mode="json")
                for candidate in resolution.candidates
            ],
        },
    )


def _series_from_points(
    points: Sequence[Any], *, measure: Measure, unit: str, timezone: str
) -> Series:
    """A caller-supplied series, validated into the normalized shape.

    Nulls stay null: the analytics engine excludes and counts them, and turning them into zeros
    here would be the single most damaging thing this boundary could do.
    """
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationFailed(
            f"{timezone!r} is not a known IANA timezone identifier.",
            details={"field": "timezone", "value": timezone},
        ) from exc

    entries: list[SeriesEntry] = []
    previous: datetime | None = None
    for index, point in enumerate(points):
        moment = point.time_utc
        if moment.tzinfo is None:
            raise ValidationFailed(
                f"Point {index} has no timezone; supply an ISO-8601 instant in UTC.",
                details={"field": f"points[{index}].time_utc"},
            )
        moment = moment.astimezone(UTC)
        if previous is not None and moment <= previous:
            raise ValidationFailed(
                f"Points must be in strictly increasing time order; point {index} is not.",
                details={"field": f"points[{index}].time_utc"},
            )
        previous = moment
        entries.append(
            SeriesEntry(
                time_utc=moment, time_local=moment.astimezone(zone), values={measure: point.value}
            )
        )

    granularity = Granularity.DAILY
    if len(entries) >= 2:
        gap = (entries[1].time_utc - entries[0].time_utc).total_seconds()
        granularity = Granularity.HOURLY if gap < 86_400 else Granularity.DAILY

    return Series(granularity=granularity, units={measure: unit}, entries=tuple(entries))


def _provenance_for_points(
    series: Series, arguments: Any, location_label: str | None
) -> Provenance:
    """Provenance for a caller-supplied series.

    The location is a label rather than a resolved place: the caller told us what the numbers are
    about, and inventing coordinates for it would be worse than recording what we were told.
    """
    zone = series.entries[0].time_local.tzinfo
    placeholder = Location(
        display_name=location_label or "caller-supplied series",
        latitude=0.0,
        longitude=0.0,
        timezone=str(getattr(zone, "key", "UTC")),
    )
    period = period_from_utc_instants(
        placeholder, series.entries[0].time_utc, series.entries[-1].time_utc
    )
    return Provenance(
        location=placeholder,
        period=period,
        provider=arguments.provider,
        unit_system=UnitSystem.METRIC,
        source_data_class=DataClass.HISTORICAL_OBSERVATION,
        retrieved_at=series.entries[-1].time_utc,
    )


def _statistic_payload(result: StatisticResult) -> dict[str, Any]:
    """One statistic as a tool reports it: the value, and everything needed to check it."""
    return {
        "statistic": result.statistic.value,
        "measure": result.measure.value,
        "status": result.status,
        "value": result.value,
        "values": [point.model_dump(mode="json") for point in result.values]
        if result.values
        else None,
        "unit": result.unit,
        "method": result.method,
        "parameters": result.parameters,
        "points_used": result.points_used,
        "points_excluded": result.points_excluded,
        "minimum_points": result.minimum_points,
        "reason": result.reason,
        "occurred_at_local": result.occurred_at_local.isoformat()
        if result.occurred_at_local
        else None,
        "tied": result.tied,
        "data_class": result.data_class.value,
    }


def _aggregates(
    series: Any,
    measure: Measure,
    provenance: Provenance,
    arguments: StatisticsInput,
) -> list[StatisticResult]:
    """Every statistic the caller asked for, over one window.

    Extracted so a baseline window is computed by exactly the same code as the window it is being
    compared against — two windows summarised by two code paths is how a comparison acquires a
    difference nobody can check.
    """
    results: list[StatisticResult] = []
    for name in arguments.statistics:
        if name == "minimum":
            results.append(descriptive.minimum(series, measure, provenance))
        elif name == "maximum":
            results.append(descriptive.maximum(series, measure, provenance))
        elif name == "mean":
            results.append(descriptive.mean(series, measure, provenance))
        elif name == "range":
            results.append(descriptive.value_range(series, measure, provenance))
        elif name == "standard_deviation":
            results.append(descriptive.standard_deviation(series, measure, provenance))
        elif name == "total":
            results.append(precipitation.total(series, provenance, measure=measure))
        elif name == "percentile":
            results.append(
                percentile(series, measure, provenance, level=float(arguments.percentile or 0.0))
            )
        elif name == "rolling_mean":
            results.append(
                rolling_mean(series, measure, provenance, window=int(arguments.rolling_window or 1))
            )
        elif name == "trend":
            trend = analyse_trend(series, measure, provenance)
            results.append(
                StatisticResult(
                    statistic=Statistic.TREND,
                    measure=measure,
                    value=trend.slope_per_day,
                    unit=f"{trend.unit}/day",
                    method=trend.method,
                    parameters={
                        "direction": trend.direction.value,
                        "magnitude": trend.magnitude,
                        "materiality_margin_per_day": trend.insignificance_margin_per_day,
                    },
                    points_used=trend.points_used,
                    points_excluded=trend.points_excluded,
                    minimum_points=trend.minimum_points,
                    provenance=provenance,
                )
            )
        else:
            raise ValidationFailed(
                f"{name!r} is not a statistic this tool computes.",
                details={
                    "field": "statistics",
                    "requested": name,
                    "supported": [
                        "minimum",
                        "maximum",
                        "mean",
                        "range",
                        "total",
                        "percentile",
                        "rolling_mean",
                        "trend",
                        "standard_deviation",
                    ],
                },
            )
    return results


# Aggregates whose difference between two windows is a figure worth reporting. A range or a trend
# slope differenced against another window answers no question anybody asks, and a difference of
# differences is noise; the four below are the ones a comparison is actually about.
_DIFFERENCEABLE: frozenset[Statistic] = frozenset(
    {Statistic.MEAN, Statistic.MINIMUM, Statistic.MAXIMUM, Statistic.TOTAL}
)


def _differences(
    *,
    later: Sequence[StatisticResult],
    earlier: Sequence[StatisticResult],
    unit: str,
    measure: Measure,
    provenance: Provenance,
    earlier_label: str,
    later_label: str,
) -> list[StatisticResult]:
    """The signed difference between each pair of aggregates the two windows share.

    **Why the tool computes this rather than the reader.** "This week averaged 21.5 °C and the same
    week last year averaged 19.9 °C" is two figures; "+1.5 °C" is the answer to the question that
    was asked, and until this existed nothing in Weathra computed it — a comparison run returned
    both sides and left the subtraction to whoever read them, so the one figure the question turned
    on was the one figure with no method, no provenance and no place in the evidence record.

    Only aggregates both windows actually produced are differenced, and a statistic either window
    could not compute is skipped rather than differenced against a stand-in.
    """
    by_statistic = {
        result.statistic: result
        for result in earlier
        if result.statistic in _DIFFERENCEABLE and result.value is not None
    }

    differences: list[StatisticResult] = []
    for result in later:
        if result.statistic not in _DIFFERENCEABLE or result.value is None:
            continue
        counterpart = by_statistic.get(result.statistic)
        if counterpart is None or counterpart.value is None:
            continue
        difference = delta(
            measure=measure,
            unit=unit,
            earlier=counterpart.value,
            later=result.value,
            earlier_label=f"{result.statistic.value} over {earlier_label}",
            later_label=f"{result.statistic.value} over {later_label}",
            provenance=provenance,
        )
        differences.append(difference)
    return differences


def build_server(context: ToolContext) -> MCPServer:
    """The MCP server, with all seven tools registered at startup.

    Every handler follows the same shape: the SDK validates the arguments against the declared
    schema *before* the body runs, the body does the work, and any Weathra error becomes a
    structured tool error. A failure is never a success carrying zeros.
    """
    server = MCPServer(
        name=SERVER_NAME,
        instructions=(
            "Weathra's weather tools. Every result carries its location, period, units, provider, "
            "retrieval time, and data class. Statistics are computed deterministically in Python "
            "— never estimate a figure yourself, and never treat a null as zero."
        ),
    )

    def register(
        *, name: str, description: str, model: type[BaseModel], handler: ToolHandler
    ) -> None:
        """Register one tool: a flat schema from the model, and structured errors from the body.

        The signature is *built* from the hand-written model's fields rather than declared, for a
        reason worth knowing: the SDK derives a tool's JSON Schema from its handler signature, and
        a handler taking one pydantic model produces a schema with a single nested ``arguments``
        object — which a language model would have to be told about out of band, exactly what
        ``specs/mcp-weather-server`` says a schema must not require. Reflecting the model's fields
        into keyword-only parameters gives the flat schema a caller can build a call from, while
        the model stays the single source of truth for descriptions, per-field constraints, and
        the cross-field rules a schema cannot express.
        """
        parameters: list[inspect.Parameter] = []
        annotations: dict[str, Any] = {}

        for field_name, field in model.model_fields.items():
            # Re-attaching the FieldInfo keeps the description and the ge/le bounds in the schema;
            # `field.annotation` alone would drop both.
            annotation = _annotated[field.annotation, field]
            default = (
                inspect.Parameter.empty
                if field.is_required()
                else field.get_default(call_default_factory=True)
            )
            parameters.append(
                inspect.Parameter(
                    field_name,
                    inspect.Parameter.KEYWORD_ONLY,
                    default=default,
                    annotation=annotation,
                )
            )
            annotations[field_name] = annotation

        async def entrypoint(**supplied: Any) -> types.CallToolResult | dict[str, Any]:
            try:
                arguments = model.model_validate(supplied)
            except ValidationError as failure:
                # Cross-field rules land here. Per-field ones the SDK already rejected.
                return error_result(validation_error(failure))

            try:
                result: types.CallToolResult | dict[str, Any] = await handler(arguments)
                return result
            except WeathraError as failure:
                logger.info("tool failure in %s: %s (%s)", name, failure.code, failure.message)
                return error_result(tool_error_for(failure))
            except Exception as failure:
                logger.exception("unexpected failure in %s: %s", name, type(failure).__name__)
                return error_result(unexpected_error(failure))

        # The return annotation goes on the *built* signature as well as in `__annotations__`:
        # the SDK reads it from the signature to decide whether it can emit structured content,
        # and structured content is what a caller branches on rather than parsing prose. It is
        # declared as a plain dict rather than the handler's real `CallToolResult | dict` union,
        # because a `CallToolResult` in the annotation tells the SDK "this tool builds its own
        # result, derive no schema" — which would silently drop structured content from every
        # success.
        entrypoint.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
            parameters, return_annotation=dict[str, Any]
        )
        entrypoint.__annotations__ = {**annotations, "return": dict[str, Any]}
        entrypoint.__name__ = name
        entrypoint.__doc__ = description

        server.add_tool(entrypoint, name=name, description=description, structured_output=True)

    # ---------------------------------------------------------------- geocode_location

    geocode_description = (
        "Resolve a place name or a coordinate pair to one canonical location with its "
        "timezone. Returns data class 'current' metadata only — no weather. An ambiguous "
        "name returns every candidate with its region and country so the caller can choose; "
        "a name matching nothing is an error, never a nearest match."
    )

    async def geocode_location(arguments: GeocodeInput) -> dict[str, Any]:
        if arguments.latitude is not None and arguments.longitude is not None:
            location = await context.places().resolve_coordinates(
                arguments.latitude, arguments.longitude
            )
            return _ok(
                {
                    "resolution": "resolved",
                    "location": ToolLocation.of(location).model_dump(mode="json"),
                    "candidates": [],
                }
            )

        resolution = await context.places().resolve(arguments.location or "")
        if isinstance(resolution, Resolved):
            return _ok(
                {
                    "resolution": "resolved",
                    "location": ToolLocation.of(resolution.location).model_dump(mode="json"),
                    "candidates": [],
                }
            )

        ambiguous: Ambiguous = resolution
        return _ok(
            {
                "resolution": "ambiguous",
                "location": None,
                "candidates": [
                    ToolLocation.of(candidate).model_dump(mode="json")
                    for candidate in ambiguous.candidates
                ],
                "note": (
                    f"{ambiguous.query!r} matches {len(ambiguous.candidates)} distinct places. "
                    "Choose one and call again with its coordinates."
                ),
            }
        )

    # ---------------------------------------------------------------- weather_current

    current_description = (
        "Current conditions at a location: temperature, apparent temperature, precipitation, "
        "wind speed, gust and direction, humidity, dew point, pressure, and cloud cover where "
        "the provider supplies them. Returns data class 'current' — an observation or "
        "nowcast, NOT a forecast. A measure the provider does not supply comes back null, "
        "which means absent and never zero."
    )

    async def weather_current(arguments: CurrentInput) -> dict[str, Any]:
        location = await _resolve(context, arguments)
        provider = context.weather(arguments.provider)
        conditions = await provider.current(location, unit_system=arguments.units)

        return _ok(
            {
                "attribution": ToolAttribution(
                    location=ToolLocation.of(location),
                    timestamp_utc=conditions.observed_at_utc,
                    units=conditions.unit_system,
                    provider=conditions.provider,
                    retrieved_at=conditions.retrieved_at,
                    from_cache=conditions.from_cache,
                    data_class=DataClass.CURRENT,
                ).model_dump(mode="json"),
                "observed_at_local": conditions.observed_at_local.isoformat(),
                "units": {measure.value: unit for measure, unit in conditions.units.items()},
                "values": {measure.value: value for measure, value in conditions.values.items()},
            }
        )

    # ---------------------------------------------------------------- weather_satellite

    satellite_description = (
        "The latest satellite imagery available over a location, as observational evidence. "
        "Returns data class 'satellite_observation' — a picture of the region at a stated time, "
        "NOT a forecast and NOT a measurement. It carries no cloud fraction, temperature, rain "
        "rate or classification, because the source supplies none: what comes back is the "
        "provider, the product, the UTC day it covers, the box it covers, an image reference and "
        "the attribution the source requires. Weathra does not interpret the image and no claim "
        "about the weather may be drawn from it."
    )

    async def weather_satellite(arguments: SatelliteInput) -> dict[str, Any]:
        location = await _resolve(context, arguments)
        observation = await context.satellite().observe(location)

        return _ok(
            {
                "attribution": ToolAttribution(
                    location=ToolLocation.of(location),
                    timestamp_utc=observation.retrieved_at,
                    units=UnitSystem.METRIC,
                    provider=observation.provider,
                    retrieved_at=observation.retrieved_at,
                    from_cache=False,
                    data_class=DataClass.SATELLITE_OBSERVATION,
                ).model_dump(mode="json"),
                "observation": observation.model_dump(mode="json"),
            }
        )

    # ---------------------------------------------------------------- weather_forecast

    forecast_description = (
        "Hourly and daily forecast over a horizon, with a deterministic analysis of the "
        "window: extremes, means, totals, anomalies, and trend, each with its method and "
        "point count. Returns data class 'forecast' — provider model output, which Weathra "
        "does not produce itself. Carries an uncertainty statement whose basis is horizon "
        "distance and one provider's supplied spread, not a multi-provider consensus."
    )

    async def weather_forecast(arguments: ForecastInput) -> dict[str, Any]:
        location = await _resolve(context, arguments)
        provider = context.weather(arguments.provider)
        horizon = resolve_horizon(provider.capabilities(), context.settings, arguments.days)
        forecast = await provider.forecast(location, days=horizon, unit_system=arguments.units)
        analysis = analyse_forecast(forecast)

        return _ok(
            {
                "attribution": ToolAttribution(
                    location=ToolLocation.of(location),
                    period=ToolPeriod.of(forecast.period),
                    units=forecast.unit_system,
                    provider=forecast.provider,
                    retrieved_at=forecast.retrieved_at,
                    from_cache=forecast.from_cache,
                    data_class=DataClass.FORECAST,
                ).model_dump(mode="json"),
                "horizon_days": forecast.horizon_days,
                "daily": forecast.daily.model_dump(mode="json"),
                "hourly": forecast.hourly.model_dump(mode="json"),
                "findings": [_statistic_payload(result) for result in analysis.findings],
                "anomalies": analysis.anomalies.model_dump(mode="json")
                if analysis.anomalies
                else None,
                "trend": analysis.trend.model_dump(mode="json") if analysis.trend else None,
                "uncertainty": describe_uncertainty(forecast).model_dump(mode="json"),
                "summary": analysis.summary,
            }
        )

    # ---------------------------------------------------------------- weather_history

    history_description = (
        "Observed weather over a past date range from the provider's archive. Returns data "
        "class 'historical_observation' — what actually happened, NOT a forecast and NOT a "
        "forecast-accuracy score. A range ending inside the archive's reporting lag returns "
        "the part that is available and states precisely which part is not."
    )

    async def weather_history(arguments: HistoryInput) -> dict[str, Any]:
        location = await _resolve(context, arguments)
        provider = context.weather(arguments.provider)
        service = HistoryService(
            provider=provider, settings=context.settings, now=context.instant()
        )
        observations = await service.observations(
            location, start=arguments.start, end=arguments.end, unit_system=arguments.units
        )

        return _ok(
            {
                "attribution": ToolAttribution(
                    location=ToolLocation.of(location),
                    period=ToolPeriod.of(observations.covered_period),
                    units=observations.unit_system,
                    provider=observations.provider,
                    retrieved_at=observations.retrieved_at,
                    from_cache=observations.from_cache,
                    data_class=DataClass.HISTORICAL_OBSERVATION,
                ).model_dump(mode="json"),
                "requested_period": ToolPeriod.of(observations.requested_period).model_dump(
                    mode="json"
                ),
                "partial": observations.is_partial,
                "unavailable_note": observations.unavailable_note,
                "daily": observations.daily.model_dump(mode="json"),
                "hourly": observations.hourly.model_dump(mode="json")
                if observations.hourly
                else None,
            }
        )

    # ---------------------------------------------------------------- weather_compare

    compare_description = (
        "Rank two or more locations, or the days at one location, against a criterion: "
        "warmest, coolest, driest, wettest, least_windy, or outdoor_suitability. Every "
        "candidate comes back with its rank, score, and the analytics behind the score. A "
        "candidate whose data could not be retrieved is listed as excluded with the reason "
        "rather than dropped. Set mode to 'historical' to compare archive observations "
        "instead; a comparison is never a mix of forecast and historical data."
    )

    async def weather_compare(arguments: CompareInput) -> dict[str, Any]:
        criterion = parse_criterion(arguments.criterion)
        provider = context.weather(arguments.provider)
        service = ComparisonService(
            provider=provider, settings=context.settings, now=context.instant()
        )

        if arguments.day_level:
            location = await _resolve(context, CompareCandidate(location=arguments.location))
            result = await service.compare_days(
                location, criterion=criterion, days=arguments.days, unit_system=arguments.units
            )
        else:
            locations = tuple(
                [await _resolve(context, candidate) for candidate in arguments.candidates]
            )
            if arguments.mode == "historical":
                # The input model already refused a historical mode without both bounds.
                start = arguments.start
                end = arguments.end
                if start is None or end is None:  # pragma: no cover - unreachable via the schema
                    raise ValidationFailed(
                        "A historical comparison needs both `start` and `end`.",
                        details={"field": "start"},
                    )
                result = await service.compare_locations_historically(
                    locations,
                    criterion=criterion,
                    start=start,
                    end=end,
                    unit_system=arguments.units,
                )
            else:
                result = await service.compare_locations(
                    locations,
                    criterion=criterion,
                    days=arguments.days,
                    unit_system=arguments.units,
                )

        return _ok(
            {
                "mode": result.mode.value,
                "criterion": result.criterion.value,
                "data_class": result.data_class.value,
                "period": ToolPeriod.of(result.period).model_dump(mode="json"),
                "units": result.unit_system.value,
                "provider": result.provider,
                "statistics_applied": list(result.statistics_applied),
                "local_time_basis": result.local_time_basis,
                "weighting_disclosure": result.weighting_disclosure,
                "tie_tolerance": result.tie_tolerance,
                "candidates": [
                    {
                        "label": candidate.label,
                        "location": ToolLocation.of(candidate.location).model_dump(mode="json"),
                        "period": ToolPeriod.of(candidate.period).model_dump(mode="json"),
                        "rank": candidate.rank,
                        "score": candidate.score,
                        "tied": candidate.tied,
                        "contributions": [
                            contribution.model_dump(mode="json")
                            for contribution in candidate.contributions
                        ],
                        "supporting": [
                            _statistic_payload(statistic) for statistic in candidate.supporting
                        ],
                    }
                    for candidate in result.candidates
                ],
                "excluded": [
                    {"label": item.label, "reason": item.reason, "code": item.code}
                    for item in result.excluded
                ],
            }
        )

    # ---------------------------------------------------------------- weather_statistics

    statistics_description = (
        "Deterministic statistics over a series you already retrieved. Returns data class "
        "'computed_statistic'. Every result states its method, the parameters supplied, and "
        "the number of points used; nulls are excluded and counted rather than treated as "
        "zero. This tool computes and never retrieves — pass points from a previous "
        "weather_forecast or weather_history result. Identical arguments always give "
        "identical results, and no language model is involved."
    )

    async def weather_statistics(arguments: StatisticsInput) -> dict[str, Any]:
        series = _series_from_points(
            arguments.points,
            measure=arguments.measure,
            unit=arguments.unit,
            timezone=arguments.timezone,
        )
        provenance = _provenance_for_points(series, arguments, arguments.location)
        measure = arguments.measure

        results = _aggregates(series, measure, provenance, arguments)

        payload: dict[str, Any] = {
            "measure": measure.value,
            "unit": arguments.unit,
            "data_class": DataClass.COMPUTED_STATISTIC.value,
            "period": ToolPeriod.of(provenance.period).model_dump(mode="json"),
            "provider": arguments.provider,
            "points_supplied": len(arguments.points),
            "results": [_statistic_payload(result) for result in results],
        }

        # The comparison half, when the caller supplied a window to compare against. Kept in its
        # own key with its own period rather than merged into `results`: two aggregates over two
        # windows are two different claims, and a reader who cannot tell which window a figure
        # covers cannot check either of them.
        if arguments.baseline_points is not None:
            baseline_series = _series_from_points(
                arguments.baseline_points,
                measure=arguments.measure,
                unit=arguments.unit,
                timezone=arguments.timezone,
            )
            baseline_provenance = _provenance_for_points(
                baseline_series, arguments, arguments.location
            )
            baseline = _aggregates(baseline_series, measure, baseline_provenance, arguments)

            payload["baseline"] = {
                "label": arguments.baseline_label,
                "period": ToolPeriod.of(baseline_provenance.period).model_dump(mode="json"),
                "points_supplied": len(arguments.baseline_points),
                "results": [_statistic_payload(result) for result in baseline],
            }
            # Which window is "later" is decided by the windows, not by which one the caller
            # happened to pass as the baseline. `delta` is documented as later-minus-earlier so
            # that a positive figure always means "went up", and a comparison whose sign depends on
            # argument order is a figure a reader cannot interpret.
            this_window = provenance.period
            other_window = baseline_provenance.period
            baseline_is_later = (
                this_window is not None
                and other_window is not None
                and other_window.start_utc > this_window.start_utc
            )
            this_label = arguments.location or "this window"
            other_label = arguments.baseline_label or "the baseline window"

            payload["differences"] = [
                _statistic_payload(difference)
                for difference in _differences(
                    later=baseline if baseline_is_later else results,
                    earlier=results if baseline_is_later else baseline,
                    unit=arguments.unit,
                    measure=measure,
                    provenance=baseline_provenance if baseline_is_later else provenance,
                    earlier_label=this_label if baseline_is_later else other_label,
                    later_label=other_label if baseline_is_later else this_label,
                )
            ]

        return _ok(payload)

    # ---------------------------------------------------------------- weather_anomaly

    anomaly_description = (
        "Deterministic anomaly detection over a series you already retrieved. Returns data "
        "class 'computed_statistic'. States the method (median absolute deviation), the "
        "threshold, the materiality floor, and the point count, and always reports the window "
        "extremes whether or not anything stood out. A window with nothing standing out is a "
        "real answer, not a forced selection. No language model is involved."
    )

    async def weather_anomaly(arguments: AnomalyInput) -> dict[str, Any]:
        series = _series_from_points(
            arguments.points,
            measure=arguments.measure,
            unit=arguments.unit,
            timezone=arguments.timezone,
        )
        provenance = _provenance_for_points(series, arguments, arguments.location)
        report = detect_anomalies(
            series,
            arguments.measure,
            provenance,
            threshold=arguments.threshold or DEFAULT_THRESHOLD,
        )

        return _ok(
            {
                "measure": arguments.measure.value,
                "unit": report.unit,
                "data_class": DataClass.COMPUTED_STATISTIC.value,
                "period": ToolPeriod.of(provenance.period).model_dump(mode="json"),
                "provider": arguments.provider,
                "method": report.method,
                "threshold": report.threshold,
                "median": report.median,
                "median_absolute_deviation": report.median_absolute_deviation,
                "points_used": report.points_used,
                "points_excluded": report.points_excluded,
                "anomalies": [point.model_dump(mode="json") for point in report.anomalies],
                "minimum": _statistic_payload(report.minimum),
                "maximum": _statistic_payload(report.maximum),
                "note": report.note,
            }
        )

    for name, description, model, handler in (
        ("geocode_location", geocode_description, GeocodeInput, geocode_location),
        ("weather_current", current_description, CurrentInput, weather_current),
        ("weather_forecast", forecast_description, ForecastInput, weather_forecast),
        ("weather_history", history_description, HistoryInput, weather_history),
        ("weather_compare", compare_description, CompareInput, weather_compare),
        ("weather_statistics", statistics_description, StatisticsInput, weather_statistics),
        ("weather_anomaly", anomaly_description, AnomalyInput, weather_anomaly),
        ("weather_satellite", satellite_description, SatelliteInput, weather_satellite),
    ):
        if name in context.settings.mcp_enabled_tools:
            register(name=name, description=description, model=model, handler=handler)

    return server
