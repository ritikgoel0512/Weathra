"""Hand-written tool schemas (design.md decision 13).

**Deliberately not derived from the HTTP request models.** A tool's schema and description are read
by a language model, which makes them prompt engineering: the wording of a description changes how
often a model picks the right tool. Coupling them to the API's own models would turn every wording
tweak into an API change, and would drag HTTP concerns — pagination, headers, envelopes — into a
surface that has none.

They *are* pydantic models rather than raw JSON dictionaries, because that is what makes
``specs/mcp-weather-server``'s "validate before doing any work" true by construction: the SDK
validates arguments against the model before the handler body runs, so a missing argument cannot
reach a provider call.

Output shapes are declared here too. Every weather-bearing result carries the location, the period,
the units, the provider, the retrieval time, and its data class — so attribution reaches the caller
without the graph reconstructing it, and no provider-specific field name ever escapes.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, UnitSystem

__all__ = [
    "TOOL_NAMES",
    "AnomalyInput",
    "CompareInput",
    "CurrentInput",
    "ForecastInput",
    "GeocodeInput",
    "HistoryInput",
    "SatelliteInput",
    "StatisticsInput",
    "ToolAttribution",
    "ToolLocation",
    "ToolPeriod",
    "ToolSeries",
]

# The eight tools, in the order ``specs/mcp-weather-server``'s catalog lists them.
TOOL_NAMES: tuple[str, ...] = (
    "geocode_location",
    "weather_current",
    "weather_forecast",
    "weather_history",
    "weather_compare",
    "weather_statistics",
    "weather_anomaly",
    "weather_satellite",
)

Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]


class _Input(BaseModel):
    """Base for every tool input: unknown arguments are rejected, not ignored."""

    model_config = ConfigDict(extra="forbid")


class _LocationArguments(_Input):
    """A place, named or given as coordinates. Exactly one form is required."""

    location: str | None = Field(
        default=None,
        description=(
            "A place name, optionally qualified: 'Berlin', 'Springfield, Illinois'. Supply this "
            "or a latitude and longitude pair, not both."
        ),
    )
    latitude: Latitude | None = Field(
        default=None, description="Decimal degrees, -90 to 90. Requires longitude."
    )
    longitude: Longitude | None = Field(
        default=None, description="Decimal degrees, -180 to 180. Requires latitude."
    )

    @model_validator(mode="after")
    def _exactly_one_form(self) -> Self:
        named = self.location is not None and self.location.strip() != ""
        coordinates = self.latitude is not None and self.longitude is not None

        if named and coordinates:
            raise ValueError(
                "Supply either a place name or a latitude and longitude pair, not both."
            )
        if not named and not coordinates:
            if self.latitude is not None or self.longitude is not None:
                raise ValueError("Coordinates need both latitude and longitude.")
            raise ValueError(
                "A location is required: supply a place name, or a latitude and longitude pair."
            )
        return self


class GeocodeInput(_LocationArguments):
    """Resolve a place name or coordinate pair to one canonical location."""


class CurrentInput(_LocationArguments):
    """Current conditions for a location."""

    units: UnitSystem = Field(
        default=UnitSystem.METRIC, description="'metric' or 'imperial'. Metric by default."
    )
    provider: str | None = Field(
        default=None, description="A registered provider name. The configured default if omitted."
    )


class SatelliteInput(_LocationArguments):
    """The latest satellite imagery available over a location.

    Location-oriented and nothing else. There is no product argument because there is one product
    (`docs/satellite-source.md` records which and why), and a parameter offering a choice that does
    not exist would be an invitation to a model to ask for something that cannot be served.
    """


class ForecastInput(_LocationArguments):
    """Hourly and daily forecast over a horizon."""

    days: Annotated[int, Field(ge=1, le=16)] | None = Field(
        default=None,
        description=(
            "Forecast horizon in days, 1 to 16. Defaults to 7. A horizon beyond the provider's "
            "maximum is rejected with that maximum stated, never silently shortened."
        ),
    )
    units: UnitSystem = Field(
        default=UnitSystem.METRIC,
        description="'metric' or 'imperial'. Metric by default.",
    )
    provider: str | None = Field(
        default=None,
        description="A registered provider name. The configured default if omitted.",
    )


class HistoryInput(_LocationArguments):
    """Observed weather over a past date range. Returns historical observations, not a forecast."""

    start: date = Field(description="First day of the range, inclusive (YYYY-MM-DD).")
    end: date = Field(description="Last day of the range, inclusive (YYYY-MM-DD).")
    units: UnitSystem = Field(
        default=UnitSystem.METRIC,
        description="'metric' or 'imperial'. Metric by default.",
    )
    provider: str | None = Field(
        default=None,
        description="A registered provider name. The configured default if omitted.",
    )

    @model_validator(mode="after")
    def _range_is_ordered(self) -> Self:
        if self.end < self.start:
            raise ValueError(
                f"The range's end ({self.end.isoformat()}) must not precede its start "
                f"({self.start.isoformat()})."
            )
        return self


class CompareCandidate(_Input):
    """One place in a comparison."""

    location: str | None = None
    latitude: Latitude | None = None
    longitude: Longitude | None = None

    @model_validator(mode="after")
    def _has_a_form(self) -> Self:
        if not (self.location or (self.latitude is not None and self.longitude is not None)):
            raise ValueError("Each candidate needs a place name or a latitude and longitude pair.")
        return self


class CompareInput(_Input):
    """Compare locations, or the days at one location, against a criterion."""

    criterion: str = Field(
        description=(
            "One of: warmest, coolest, driest, wettest, least_windy, outdoor_suitability. The "
            "composite outdoor-suitability score discloses its own weighting as Weathra's "
            "heuristic."
        )
    )
    candidates: tuple[CompareCandidate, ...] = Field(
        default=(),
        description=(
            "Two or more places to rank. Leave empty and set `day_level` with a single "
            "`location` to rank the days at one place instead."
        ),
    )
    location: str | None = Field(
        default=None, description="The single place for a day-level comparison."
    )
    day_level: bool = Field(
        default=False, description="Rank the days within one location's window."
    )
    mode: Literal["forecast", "historical"] = Field(
        default="forecast",
        description=(
            "'historical' compares archive observations over a past range instead of a forecast. "
            "A comparison is never a mix of the two."
        ),
    )
    days: Annotated[int, Field(ge=1, le=16)] | None = None
    start: date | None = Field(default=None, description="Required when mode is 'historical'.")
    end: date | None = Field(default=None, description="Required when mode is 'historical'.")
    units: UnitSystem = Field(
        default=UnitSystem.METRIC,
        description="'metric' or 'imperial'. Metric by default.",
    )
    provider: str | None = Field(
        default=None,
        description="A registered provider name. The configured default if omitted.",
    )

    @model_validator(mode="after")
    def _shape_matches_the_mode(self) -> Self:
        if self.day_level:
            if not self.location:
                raise ValueError("A day-level comparison needs a single `location`.")
            if self.candidates:
                raise ValueError(
                    "A day-level comparison ranks the days at one location, so it takes "
                    "`location` rather than `candidates`."
                )
        elif len(self.candidates) < 2:
            raise ValueError(
                "A location comparison needs at least two candidates. To compare the days at one "
                "place, set day_level to true and supply `location`."
            )

        if self.mode == "historical":
            if self.start is None or self.end is None:
                raise ValueError("A historical comparison needs both `start` and `end`.")
            if self.end < self.start:
                raise ValueError("The range's end must not precede its start.")
        return self


class SeriesPoint(_Input):
    """One point of a series a caller supplies to the analytics tools."""

    time_utc: datetime = Field(description="The instant, in UTC (ISO-8601).")
    value: float | None = Field(
        description="The reading, or null when it was not supplied. Null is never treated as zero."
    )


class StatisticsInput(_Input):
    """Deterministic statistics over a retrieved series.

    The series is supplied by the caller — normally from a previous ``weather_forecast`` or
    ``weather_history`` result — so this tool computes and never retrieves. That separation is what
    makes "the model interprets but never calculates" enforceable: analytics has no way to fetch
    data of its own.
    """

    measure: Measure = Field(description="Which measure the values are.")
    unit: str = Field(min_length=1, description="The unit the values are in, e.g. '°C'.")
    points: tuple[SeriesPoint, ...] = Field(
        min_length=1, description="The series, in time order. Nulls are excluded and counted."
    )
    statistics: tuple[str, ...] = Field(
        default=("minimum", "maximum", "mean", "range"),
        description=(
            "Any of: minimum, maximum, mean, range, total, percentile, rolling_mean, trend, "
            "standard_deviation."
        ),
    )
    percentile: Annotated[float, Field(ge=0.0, le=100.0)] | None = Field(
        default=None, description="Required when 'percentile' is requested."
    )
    rolling_window: Annotated[int, Field(ge=1)] | None = Field(
        default=None, description="Required when 'rolling_mean' is requested."
    )
    location: str | None = Field(
        default=None, description="What the series is about, for the result's provenance."
    )
    timezone: str = Field(
        default="UTC", description="IANA zone the local timestamps are reported in."
    )
    provider: str = Field(
        default="caller-supplied",
        description="Where the series came from, recorded in the result's provenance.",
    )

    @model_validator(mode="after")
    def _parameters_match_the_requests(self) -> Self:
        if "percentile" in self.statistics and self.percentile is None:
            raise ValueError("A percentile statistic needs a `percentile` level.")
        if "rolling_mean" in self.statistics and self.rolling_window is None:
            raise ValueError("A rolling mean needs a `rolling_window` length.")
        return self


class AnomalyInput(_Input):
    """Deterministic anomaly detection over a retrieved series."""

    measure: Measure
    unit: str = Field(min_length=1)
    points: tuple[SeriesPoint, ...] = Field(min_length=1)
    threshold: Annotated[float, Field(gt=0.0)] | None = Field(
        default=None,
        description=(
            "Deviation score, in median-absolute-deviations, beyond which a point is anomalous. "
            "Defaults to 2.0. A point must also differ materially in absolute terms."
        ),
    )
    location: str | None = None
    timezone: str = "UTC"
    provider: str = "caller-supplied"


# --------------------------------------------------------------------------- output shapes


class ToolLocation(BaseModel):
    """A location as a tool reports it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    identifier: str
    display_name: str
    latitude: float
    longitude: float
    timezone: str
    region: str | None = None
    country: str | None = None
    country_code: str | None = None

    @classmethod
    def of(cls, location: Location) -> ToolLocation:
        return cls(
            identifier=location.identifier,
            display_name=location.display_name,
            latitude=location.latitude,
            longitude=location.longitude,
            timezone=location.timezone,
            region=location.region,
            country=location.country,
            country_code=location.country_code,
        )

    def to_location(self) -> Location:
        """Back to a domain ``Location``, for a caller reading a tool result.

        Written out rather than validated wholesale, because ``identifier`` is *derived* on
        ``Location`` and reported here for a caller's convenience — feeding it back in would be
        rejected as an unknown field, which is the correct behaviour for a value nobody should be
        able to set independently of the coordinates it comes from.
        """
        return Location(
            display_name=self.display_name,
            latitude=self.latitude,
            longitude=self.longitude,
            timezone=self.timezone,
            region=self.region,
            country=self.country,
            country_code=self.country_code,
        )


class ToolPeriod(BaseModel):
    """The time a result covers, in both forms."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    start_utc: datetime
    end_utc: datetime
    start_local: str
    end_local: str
    timezone: str

    @classmethod
    def of(cls, period: Period) -> ToolPeriod:
        return cls(
            start_utc=period.start_utc,
            end_utc=period.end_utc,
            start_local=period.start_local.isoformat(),
            end_local=period.end_local.isoformat(),
            timezone=period.timezone,
        )

    def to_period(self) -> Period:
        """Back to a domain ``Period``. The local bounds are the same instants, re-parsed."""
        return Period(
            start_utc=self.start_utc,
            end_utc=self.end_utc,
            start_local=datetime.fromisoformat(self.start_local),
            end_local=datetime.fromisoformat(self.end_local),
            timezone=self.timezone,
        )


class ToolAttribution(BaseModel):
    """What every weather-bearing tool result carries."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: ToolLocation
    period: ToolPeriod | None = None
    timestamp_utc: datetime | None = None
    units: UnitSystem
    provider: str
    retrieved_at: datetime
    from_cache: bool = False
    data_class: DataClass


class ToolSeries(BaseModel):
    """A series as a tool reports it: one units map, values that may be null."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    granularity: str
    units: dict[str, str]
    entries: tuple[dict[str, Any], ...]


def location_from_payload(payload: dict[str, Any]) -> Location:
    """The location inside a tool result's attribution block."""
    return ToolLocation.model_validate(payload["location"]).to_location()


def period_from_payload(payload: dict[str, Any]) -> Period | None:
    """The period inside a tool result's attribution block, when it reported one."""
    block = payload.get("period")
    return ToolPeriod.model_validate(block).to_period() if block else None
