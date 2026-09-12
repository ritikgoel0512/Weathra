"""The normalized weather model — the one shape every layer above ``providers/`` reads.

Design decisions that show up in the field layout (design.md decision 6):

* **Units live on the series, not on each value.** A ``Quantity`` object per point would triple an
  hourly payload and force chart code to unpack objects per point. Each ``Series`` carries
  ``units: dict[Measure, str]`` once; values are plain ``float | None``.
* **``None`` means the provider did not supply it.** Never zero, never a substituted default. An
  absent measure keeps its key with a null value so a consumer can tell "asked for, not supplied"
  from "never asked for" (``specs/weather-providers``).
* **Every entry carries both timestamps.** ``time_utc`` is what windowing, thresholds, and
  comparison use; ``time_local`` is what a person reads. The redundancy is cheap and removes the
  largest bug class in a system where "Thursday evening" means Thursday *there*.
* **Every result carries a ``data_class`` from the moment it leaves the provider layer.** Labelling
  at the source is what makes ``specs/safety-grounding``'s no-conflation rule cheap to honour
  everywhere downstream.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from weathra.domain.location import Location

__all__ = [
    "DAILY_AGGREGATES",
    "INSTANTANEOUS_MEASURES",
    "AttributedResult",
    "ConfidenceBand",
    "CurrentConditions",
    "DataClass",
    "Forecast",
    "Granularity",
    "HistoricalObservations",
    "HorizonPoint",
    "Measure",
    "Period",
    "Series",
    "SeriesEntry",
    "SpreadPoint",
    "UncertaintyStatement",
    "UnitSystem",
    "unit_for",
    "units_map",
]


class UnitSystem(StrEnum):
    """The unit system a result is expressed in. Metric unless a caller says otherwise."""

    METRIC = "metric"
    IMPERIAL = "imperial"


class DataClass(StrEnum):
    """What kind of thing a reported value is.

    Carried from the provider layer to the response envelope and rendered in the UI. An answer
    combining classes labels each part; a class is never conflated with another
    (``specs/safety-grounding``).
    """

    CURRENT = "current"
    FORECAST = "forecast"
    HISTORICAL_OBSERVATION = "historical_observation"
    COMPUTED_STATISTIC = "computed_statistic"
    AI_INTERPRETATION = "ai_interpretation"
    # Imagery observed from orbit. Its own class rather than ``CURRENT`` because it is a different
    # kind of claim: a current reading is a provider's figure for a place, and this is a picture of
    # a region at a stated time, carrying no figure at all. Collapsing the two would let an answer
    # credit a temperature to a satellite.
    SATELLITE_OBSERVATION = "satellite_observation"


class Granularity(StrEnum):
    """The time resolution of a series."""

    HOURLY = "hourly"
    DAILY = "daily"


class Measure(StrEnum):
    """Every measure the normalized model defines.

    The instantaneous measures are the twelve named in ``specs/weather-providers``. The daily
    aggregates are the per-measure daily summaries a provider may additionally supply.
    """

    # --- instantaneous (current conditions and the hourly series)
    TEMPERATURE = "temperature"
    APPARENT_TEMPERATURE = "apparent_temperature"
    PRECIPITATION = "precipitation"
    PRECIPITATION_PROBABILITY = "precipitation_probability"
    WIND_SPEED = "wind_speed"
    WIND_GUST = "wind_gust"
    WIND_DIRECTION = "wind_direction"
    RELATIVE_HUMIDITY = "relative_humidity"
    DEW_POINT = "dew_point"
    SURFACE_PRESSURE = "surface_pressure"
    CLOUD_COVER = "cloud_cover"
    UV_INDEX = "uv_index"
    # The provider's own condition code (WMO 4677 as Open-Meteo publishes it). A *code*, not a
    # measurement: it is carried so the product can say "light rain" with the provider attributed,
    # instead of inferring a sky state from cloud cover and precipitation, which is the inference
    # `specs/safety-grounding` exists to prevent. See `WEATHER_CODE_MEASURES` below.
    WEATHER_CODE = "weather_code"

    # --- daily aggregates
    TEMPERATURE_MAX = "temperature_max"
    TEMPERATURE_MIN = "temperature_min"
    TEMPERATURE_MEAN = "temperature_mean"
    APPARENT_TEMPERATURE_MAX = "apparent_temperature_max"
    APPARENT_TEMPERATURE_MIN = "apparent_temperature_min"
    PRECIPITATION_SUM = "precipitation_sum"
    PRECIPITATION_HOURS = "precipitation_hours"
    PRECIPITATION_PROBABILITY_MAX = "precipitation_probability_max"
    PRECIPITATION_PROBABILITY_MEAN = "precipitation_probability_mean"
    WIND_SPEED_MAX = "wind_speed_max"
    WIND_GUST_MAX = "wind_gust_max"
    WIND_DIRECTION_DOMINANT = "wind_direction_dominant"
    RELATIVE_HUMIDITY_MEAN = "relative_humidity_mean"
    DEW_POINT_MEAN = "dew_point_mean"
    SURFACE_PRESSURE_MEAN = "surface_pressure_mean"
    CLOUD_COVER_MEAN = "cloud_cover_mean"
    UV_INDEX_MAX = "uv_index_max"
    # The dominant code for a day, as the provider aggregates it.
    WEATHER_CODE_DOMINANT = "weather_code_dominant"


INSTANTANEOUS_MEASURES: tuple[Measure, ...] = (
    Measure.TEMPERATURE,
    Measure.APPARENT_TEMPERATURE,
    Measure.PRECIPITATION,
    Measure.PRECIPITATION_PROBABILITY,
    Measure.WIND_SPEED,
    Measure.WIND_GUST,
    Measure.WIND_DIRECTION,
    Measure.RELATIVE_HUMIDITY,
    Measure.DEW_POINT,
    Measure.SURFACE_PRESSURE,
    Measure.CLOUD_COVER,
    Measure.UV_INDEX,
)

DAILY_AGGREGATES: tuple[Measure, ...] = (
    Measure.TEMPERATURE_MAX,
    Measure.TEMPERATURE_MIN,
    Measure.TEMPERATURE_MEAN,
    Measure.APPARENT_TEMPERATURE_MAX,
    Measure.APPARENT_TEMPERATURE_MIN,
    Measure.PRECIPITATION_SUM,
    Measure.PRECIPITATION_HOURS,
    Measure.PRECIPITATION_PROBABILITY_MAX,
    Measure.PRECIPITATION_PROBABILITY_MEAN,
    Measure.WIND_SPEED_MAX,
    Measure.WIND_GUST_MAX,
    Measure.WIND_DIRECTION_DOMINANT,
    Measure.RELATIVE_HUMIDITY_MEAN,
    Measure.DEW_POINT_MEAN,
    Measure.SURFACE_PRESSURE_MEAN,
    Measure.CLOUD_COVER_MEAN,
    Measure.UV_INDEX_MAX,
)

# The physical dimension each measure reports, so a unit need be stated only once per dimension.
_DIMENSION: dict[Measure, str] = {
    Measure.TEMPERATURE: "temperature",
    Measure.APPARENT_TEMPERATURE: "temperature",
    Measure.DEW_POINT: "temperature",
    Measure.TEMPERATURE_MAX: "temperature",
    Measure.TEMPERATURE_MIN: "temperature",
    Measure.TEMPERATURE_MEAN: "temperature",
    Measure.APPARENT_TEMPERATURE_MAX: "temperature",
    Measure.APPARENT_TEMPERATURE_MIN: "temperature",
    Measure.DEW_POINT_MEAN: "temperature",
    Measure.PRECIPITATION: "precipitation",
    Measure.PRECIPITATION_SUM: "precipitation",
    Measure.PRECIPITATION_PROBABILITY: "ratio",
    Measure.PRECIPITATION_PROBABILITY_MAX: "ratio",
    Measure.PRECIPITATION_PROBABILITY_MEAN: "ratio",
    Measure.RELATIVE_HUMIDITY: "ratio",
    Measure.RELATIVE_HUMIDITY_MEAN: "ratio",
    Measure.CLOUD_COVER: "ratio",
    Measure.CLOUD_COVER_MEAN: "ratio",
    Measure.WIND_SPEED: "speed",
    Measure.WIND_GUST: "speed",
    Measure.WIND_SPEED_MAX: "speed",
    Measure.WIND_GUST_MAX: "speed",
    Measure.WIND_DIRECTION: "direction",
    Measure.WIND_DIRECTION_DOMINANT: "direction",
    Measure.SURFACE_PRESSURE: "pressure",
    Measure.SURFACE_PRESSURE_MEAN: "pressure",
    Measure.UV_INDEX: "index",
    Measure.UV_INDEX_MAX: "index",
    Measure.PRECIPITATION_HOURS: "duration",
    # Dimensionless and unconvertible. A code is an identifier for a condition, so it carries no
    # unit in either system, and nothing downstream may sum, average or interpolate it.
    Measure.WEATHER_CODE: "code",
    Measure.WEATHER_CODE_DOMINANT: "code",
}

_UNITS: dict[str, dict[UnitSystem, str]] = {
    "temperature": {UnitSystem.METRIC: "°C", UnitSystem.IMPERIAL: "°F"},
    "precipitation": {UnitSystem.METRIC: "mm", UnitSystem.IMPERIAL: "in"},
    "speed": {UnitSystem.METRIC: "km/h", UnitSystem.IMPERIAL: "mph"},
    # Pressure is reported in hectopascals in both systems: that is what the provider supplies and
    # what every meteorological reader expects. Converting it would invent precision.
    "pressure": {UnitSystem.METRIC: "hPa", UnitSystem.IMPERIAL: "hPa"},
    "ratio": {UnitSystem.METRIC: "%", UnitSystem.IMPERIAL: "%"},
    "direction": {UnitSystem.METRIC: "°", UnitSystem.IMPERIAL: "°"},
    "index": {UnitSystem.METRIC: "index", UnitSystem.IMPERIAL: "index"},
    "duration": {UnitSystem.METRIC: "h", UnitSystem.IMPERIAL: "h"},
    # Not a quantity and not convertible: the "unit" names what the number *is*, so a reader of a
    # units map is told it is a published code rather than a measurement in disguise.
    "code": {UnitSystem.METRIC: "WMO code", UnitSystem.IMPERIAL: "WMO code"},
}

# The measures that carry a provider condition code rather than a quantity. Analytics must not
# compute over these — a mean of WMO codes is a number with no meaning — and the deterministic
# layer excludes them by asking this rather than by listing measures again.
WEATHER_CODE_MEASURES: frozenset[Measure] = frozenset(
    {Measure.WEATHER_CODE, Measure.WEATHER_CODE_DOMINANT}
)


def unit_for(measure: Measure, unit_system: UnitSystem) -> str:
    """The unit a measure is expressed in under a unit system. Every value resolves to one."""
    return _UNITS[_DIMENSION[measure]][unit_system]


def units_map(measures: tuple[Measure, ...], unit_system: UnitSystem) -> dict[Measure, str]:
    """The series-level units map for a set of measures."""
    return {measure: unit_for(measure, unit_system) for measure in measures}


class Period(BaseModel):
    """A half-open time window ``[start_utc, end_utc)``, resolved from a location's timezone.

    Windowing is always done in UTC; the local bounds are carried alongside for display. The
    server's own timezone is never consulted.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    start_utc: AwareDatetime
    end_utc: AwareDatetime
    start_local: AwareDatetime
    end_local: AwareDatetime
    timezone: str = Field(min_length=1, description="IANA identifier the local bounds are in.")

    @model_validator(mode="after")
    def _bounds_are_ordered_and_consistent(self) -> Self:
        if self.end_utc < self.start_utc:
            raise ValueError(
                f"A period's end ({self.end_utc.isoformat()}) must not precede its start "
                f"({self.start_utc.isoformat()})."
            )
        for label, utc_value, local_value in (
            ("start", self.start_utc, self.start_local),
            ("end", self.end_utc, self.end_local),
        ):
            if utc_value != local_value:
                raise ValueError(
                    f"A period's {label} in local time must be the same instant as in UTC; "
                    f"{local_value.isoformat()} != {utc_value.isoformat()}."
                )
        return self

    @property
    def duration_hours(self) -> float:
        return (self.end_utc - self.start_utc).total_seconds() / 3600.0

    def contains(self, moment: datetime) -> bool:
        return self.start_utc <= moment.astimezone(UTC) < self.end_utc


class SeriesEntry(BaseModel):
    """One point in a series: the instant, in both forms, and its measured values."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime = Field(description="Used by every window, threshold, and comparison.")
    time_local: AwareDatetime = Field(description="What a person reads. Carries the offset.")
    values: dict[Measure, float | None] = Field(
        description="A null means the provider did not supply the measure — never zero."
    )

    @model_validator(mode="after")
    def _timestamps_are_the_same_instant(self) -> Self:
        if self.time_utc != self.time_local:
            raise ValueError(
                f"time_local ({self.time_local.isoformat()}) and time_utc "
                f"({self.time_utc.isoformat()}) must be the same instant."
            )
        if self.time_utc.utcoffset() != timedelta(0):
            raise ValueError("time_utc must be expressed in UTC.")
        return self

    def value(self, measure: Measure) -> float | None:
        """The value for a measure, or ``None`` when it was not supplied."""
        return self.values.get(measure)

    def has(self, measure: Measure) -> bool:
        """Whether this entry actually carries a value for a measure."""
        return self.values.get(measure) is not None


class Series(BaseModel):
    """An ordered run of entries at one granularity, with one units map for the whole series."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    granularity: Granularity
    units: dict[Measure, str] = Field(
        description="Every measure the series declares, and the unit it is expressed in."
    )
    entries: tuple[SeriesEntry, ...] = ()

    @model_validator(mode="after")
    def _entries_are_ordered_and_declared(self) -> Self:
        previous: datetime | None = None
        declared = set(self.units)
        for entry in self.entries:
            if previous is not None and entry.time_utc <= previous:
                raise ValueError(
                    "Series entries must be strictly ordered by time_utc; "
                    f"{entry.time_utc.isoformat()} does not follow {previous.isoformat()}."
                )
            previous = entry.time_utc
            undeclared = set(entry.values) - declared
            if undeclared:
                raise ValueError(
                    "A series entry carries measures the series does not declare a unit for: "
                    f"{sorted(measure.value for measure in undeclared)}."
                )
        return self

    @property
    def measures(self) -> tuple[Measure, ...]:
        """The measures this series declares, in declaration order."""
        return tuple(self.units)

    def __len__(self) -> int:
        return len(self.entries)

    def unit(self, measure: Measure) -> str | None:
        return self.units.get(measure)

    def values_for(self, measure: Measure) -> tuple[float | None, ...]:
        """Every value for a measure, positionally aligned with ``entries``."""
        return tuple(entry.value(measure) for entry in self.entries)

    def supplies(self, measure: Measure) -> bool:
        """Whether the provider supplied at least one usable value for this measure.

        A declared measure with every value null is *absent*, not zero: it is exactly the case
        ``specs/weather-providers`` requires to be reported as unavailable.
        """
        return any(entry.has(measure) for entry in self.entries)

    def usable_count(self, measure: Measure) -> int:
        """How many entries carry a value for this measure. The rest are excluded, never zeroed."""
        return sum(1 for entry in self.entries if entry.has(measure))

    def absent_count(self, measure: Measure) -> int:
        return len(self.entries) - self.usable_count(measure)


class AttributedResult(BaseModel):
    """What every retrieval result carries, whatever it is.

    Provider, units, retrieval time, cache status, and data class are on the result itself, so
    attribution reaches a response envelope without anything downstream reconstructing it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    provider: str = Field(min_length=1, description="Which provider served it.")
    unit_system: UnitSystem
    retrieved_at: AwareDatetime = Field(description="When the data was obtained from upstream.")
    from_cache: bool = Field(description="Whether this answer came from cache.")

    @model_validator(mode="after")
    def _retrieved_at_is_utc(self) -> Self:
        if self.retrieved_at.utcoffset() != timedelta(0):
            raise ValueError("retrieved_at must be expressed in UTC.")
        return self


class CurrentConditions(AttributedResult):
    """Observed-or-nowcast conditions at a location. Labelled ``current``, never ``forecast``."""

    data_class: Literal[DataClass.CURRENT] = DataClass.CURRENT
    observed_at_utc: AwareDatetime
    observed_at_local: AwareDatetime
    units: dict[Measure, str]
    values: dict[Measure, float | None]

    @model_validator(mode="after")
    def _observation_time_is_consistent(self) -> Self:
        if self.observed_at_utc != self.observed_at_local:
            raise ValueError("observed_at_local must be the same instant as observed_at_utc.")
        undeclared = set(self.values) - set(self.units)
        if undeclared:
            raise ValueError(
                "Current conditions carry measures with no declared unit: "
                f"{sorted(measure.value for measure in undeclared)}."
            )
        return self

    def value(self, measure: Measure) -> float | None:
        return self.values.get(measure)

    def has(self, measure: Measure) -> bool:
        return self.values.get(measure) is not None


class Forecast(AttributedResult):
    """Provider model output for a future window. Labelled ``forecast``, never ``current``."""

    data_class: Literal[DataClass.FORECAST] = DataClass.FORECAST
    period: Period
    horizon_days: int = Field(ge=1, description="The requested horizon, as served.")
    hourly: Series
    daily: Series

    @model_validator(mode="after")
    def _granularities_match_their_fields(self) -> Self:
        if self.hourly.granularity is not Granularity.HOURLY:
            raise ValueError("Forecast.hourly must carry an hourly series.")
        if self.daily.granularity is not Granularity.DAILY:
            raise ValueError("Forecast.daily must carry a daily series.")
        return self


class HistoricalObservations(AttributedResult):
    """Observed past weather from the archive. Labelled a historical observation.

    ``covered_period`` may be shorter than ``requested_period`` when the range runs into the
    archive's reporting lag. When it does, ``unavailable_note`` states precisely which part is not
    yet available rather than the result quietly covering less than it was asked for
    (``specs/historical-weather``).
    """

    data_class: Literal[DataClass.HISTORICAL_OBSERVATION] = DataClass.HISTORICAL_OBSERVATION
    requested_period: Period
    covered_period: Period
    hourly: Series | None = None
    daily: Series
    unavailable_note: str | None = None

    @model_validator(mode="after")
    def _partial_coverage_is_stated(self) -> Self:
        if self.daily.granularity is not Granularity.DAILY:
            raise ValueError("HistoricalObservations.daily must carry a daily series.")
        if self.hourly is not None and self.hourly.granularity is not Granularity.HOURLY:
            raise ValueError("HistoricalObservations.hourly must carry an hourly series.")
        if (
            self.covered_period.start_utc < self.requested_period.start_utc
            or self.covered_period.end_utc > self.requested_period.end_utc
        ):
            raise ValueError("The covered period must lie within the requested period.")
        if self.is_partial and not self.unavailable_note:
            raise ValueError(
                "Partial coverage must state which part of the requested range is unavailable."
            )
        return self

    @property
    def is_partial(self) -> bool:
        return (
            self.covered_period.start_utc != self.requested_period.start_utc
            or self.covered_period.end_utc != self.requested_period.end_utc
        )


class ConfidenceBand(StrEnum):
    """How much assurance a forecast figure deserves, by distance into the horizon.

    A band, not a probability: with one provider there is no consensus signal to derive a
    probability from, and presenting one would overstate what the system knows.
    """

    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"


class HorizonPoint(BaseModel):
    """How far into the horizon one figure sits, and the band that follows from it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime
    time_local: AwareDatetime
    hours_ahead: float = Field(ge=0.0, description="From the reference time, not from 'now'.")
    confidence: ConfidenceBand

    @model_validator(mode="after")
    def _timestamps_are_the_same_instant(self) -> Self:
        if self.time_utc != self.time_local:
            raise ValueError("time_local must be the same instant as time_utc.")
        return self


class SpreadPoint(BaseModel):
    """A provider-supplied range around a figure, where the provider supplies one."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime
    measure: Measure
    lower: float
    upper: float

    @model_validator(mode="after")
    def _bounds_are_ordered(self) -> Self:
        if self.upper < self.lower:
            raise ValueError("A spread's upper bound must not fall below its lower bound.")
        return self


class UncertaintyStatement(BaseModel):
    """What a forecast figure's confidence rests on, disclosed rather than implied.

    ``specs/forecast-analysis`` and ``specs/safety-grounding`` both require the *basis* to be
    stated: with a single provider, confidence comes from horizon distance and whatever spread the
    provider supplies — it is not a multi-provider consensus, and the statement says so every time.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(min_length=1)
    reference_time_utc: AwareDatetime = Field(
        description="The instant horizon distances are measured from."
    )
    horizon: tuple[HorizonPoint, ...] = ()
    provider_spread: tuple[SpreadPoint, ...] = ()
    spread_available: bool = Field(
        description="False when the provider supplies no spread, stated rather than inferred."
    )
    multi_provider_consensus: Literal[False] = False
    basis: str = Field(
        min_length=1,
        description=(
            "The disclosure a reader sees: confidence decreases with horizon distance, and the "
            "signal is derived from one provider's output and its supplied spread only."
        ),
    )

    @model_validator(mode="after")
    def _spread_presence_matches_the_flag(self) -> Self:
        if self.spread_available and not self.provider_spread:
            raise ValueError("spread_available is set but no provider spread is carried.")
        if not self.spread_available and self.provider_spread:
            raise ValueError("A provider spread is carried but spread_available is false.")
        return self

    def confidence_at(self, moment: datetime) -> ConfidenceBand | None:
        """The band for the horizon point at an instant, if this statement covers it."""
        for point in self.horizon:
            if point.time_utc == moment.astimezone(UTC):
                return point.confidence
        return None
