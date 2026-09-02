"""Structured, self-describing analytics results.

Every meteorological number Weathra reports is one of these. A result states what was computed, its
value, its unit, the window and location it covers, which provider's data it came from, how many
points went into it, and by what method — because ``specs/deterministic-analytics`` requires a
reader to be able to check a figure, and ``specs/safety-grounding`` requires the answer prose to be
traceable to it.

Two shapes matter as much as the values:

* **A statistic that cannot be computed is a result, not an exception.** A series with seven
  temperature points and two precipitation points computes its temperature statistics and reports
  precipitation *not computable* with the required and available counts. Only a series with nothing
  usable at all raises.
* **Absent values are excluded and counted.** ``points_excluded`` is part of the result, so
  "mean of 5 of 7 points" is visible rather than a silent average over coerced zeros.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, UnitSystem

__all__ = [
    "AnomalyPoint",
    "AnomalyReport",
    "Direction",
    "PointValue",
    "Provenance",
    "Statistic",
    "StatisticResult",
    "TrendDirection",
    "TrendReport",
]


class Statistic(StrEnum):
    """Every statistic the deterministic engine produces."""

    # descriptive
    MINIMUM = "minimum"
    MAXIMUM = "maximum"
    MEAN = "mean"
    RANGE = "range"
    # precipitation
    TOTAL = "total"
    DAILY_TOTALS = "daily_totals"
    WET_ENTRY_COUNT = "wet_entry_count"
    PROBABILITY_MAXIMUM = "probability_maximum"
    PROBABILITY_MEAN = "probability_mean"
    PROBABILITY_EXCEEDANCE = "probability_exceedance"
    # wind
    MEAN_SPEED = "mean_speed"
    MAXIMUM_SUSTAINED_SPEED = "maximum_sustained_speed"
    MAXIMUM_GUST = "maximum_gust"
    PREVAILING_DIRECTION = "prevailing_direction"
    # derived
    ROLLING_MEAN = "rolling_mean"
    PERCENTILE = "percentile"
    DELTA = "delta"
    Z_SCORE = "z_score"
    STANDARD_DEVIATION = "standard_deviation"
    # composite reports
    ANOMALIES = "anomalies"
    TREND = "trend"
    BASELINE = "baseline"


class Direction(StrEnum):
    """Which way is "better" for a measure under a criterion, and which way a threshold points."""

    ABOVE = "above"
    BELOW = "below"


class TrendDirection(StrEnum):
    """The classification a trend slope falls into, against its insignificance margin."""

    RISING = "rising"
    FALLING = "falling"
    STEADY = "steady"


class Provenance(BaseModel):
    """Where the numbers behind a result came from.

    Carried on every result so attribution reaches the response envelope as a field rather than
    something a model has to remember to mention.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    period: Period
    provider: str = Field(min_length=1, description="Whose data was analysed.")
    unit_system: UnitSystem
    source_data_class: DataClass = Field(
        description="What the analysed series was — a forecast, or a historical observation."
    )
    retrieved_at: AwareDatetime = Field(description="When that series was obtained from upstream.")

    @model_validator(mode="after")
    def _source_is_retrieved_data(self) -> Self:
        if self.source_data_class in (DataClass.COMPUTED_STATISTIC, DataClass.AI_INTERPRETATION):
            raise ValueError(
                "A statistic's provenance names the retrieved data it was computed from — a "
                "forecast, current conditions, or a historical observation — not another "
                "computed value."
            )
        return self


class PointValue(BaseModel):
    """One timestamped value in a series-shaped result: a per-day total, a rolling mean."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime
    time_local: AwareDatetime
    value: float | None = Field(description="Null where the window had nothing usable.")

    @model_validator(mode="after")
    def _timestamps_are_the_same_instant(self) -> Self:
        if self.time_utc != self.time_local:
            raise ValueError("time_local must be the same instant as time_utc.")
        return self


class StatisticResult(BaseModel):
    """One computed — or explicitly not-computable — statistic, fully self-describing.

    ``status`` is the whole point of the model: ``not_computable`` is a first-class outcome
    carrying the reason and the counts, so a partial analysis reports precisely what it could not
    do instead of omitting it or inventing it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    statistic: Statistic
    measure: Measure
    status: Literal["computed", "not_computable"] = "computed"
    data_class: Literal[DataClass.COMPUTED_STATISTIC] = DataClass.COMPUTED_STATISTIC

    value: float | None = Field(
        default=None, description="The scalar result, for scalar statistics."
    )
    values: tuple[PointValue, ...] | None = Field(
        default=None, description="The sequence, for series-shaped statistics."
    )
    unit: str = Field(
        description=(
            "The unit the value is expressed in. Empty only for a not-computable result whose "
            "measure the series never declared — there is no unit to state for a measure the "
            "provider does not supply."
        )
    )

    occurred_at_utc: AwareDatetime | None = Field(
        default=None, description="When an extreme occurred. Set for minima, maxima, and gusts."
    )
    occurred_at_local: AwareDatetime | None = None
    tied: bool = Field(
        default=False, description="Whether the extreme was shared by more than one entry."
    )
    tied_at: tuple[AwareDatetime, ...] = Field(
        default=(), description="Every tied timestamp, earliest first, when an extreme was tied."
    )

    method: str = Field(
        min_length=1,
        description=(
            "How it was computed, stated rather than implied — 'arithmetic mean of usable "
            "points', 'linear interpolation (numpy default)', 'least-squares slope'."
        ),
    )
    parameters: dict[str, Any] = Field(
        default_factory=dict, description="What the caller asked for: window length, level, k."
    )
    points_used: int = Field(ge=0, description="Usable points that went into the value.")
    points_excluded: int = Field(
        default=0, ge=0, description="Points excluded because the value was absent — never zeroed."
    )
    minimum_points: int = Field(
        ge=0, description="The declared minimum this statistic needs to be computable."
    )
    reason: str | None = Field(
        default=None, description="Why it was not computable. Required when it was not."
    )

    provenance: Provenance

    @model_validator(mode="after")
    def _status_and_payload_agree(self) -> Self:
        if self.status == "computed":
            if self.value is None and self.values is None:
                raise ValueError(f"{self.statistic.value} is marked computed but carries no value.")
            if not self.unit:
                raise ValueError(
                    f"{self.statistic.value} is marked computed and must state its unit."
                )
            if self.reason is not None:
                raise ValueError("A computed statistic must not carry a not-computable reason.")
            if self.points_used < self.minimum_points:
                raise ValueError(
                    f"{self.statistic.value} was computed from {self.points_used} points but "
                    f"declares a minimum of {self.minimum_points}."
                )
        else:
            if not self.reason:
                raise ValueError(
                    f"{self.statistic.value} is not computable and must state why, with the "
                    "required and available counts."
                )
            if self.value is not None or self.values is not None:
                raise ValueError("A not-computable statistic must not carry a value.")
        if self.tied and not self.tied_at:
            raise ValueError("A tied extreme must record the tied timestamps.")
        if self.occurred_at_utc is not None and self.occurred_at_utc != self.occurred_at_local:
            raise ValueError("occurred_at_local must be the same instant as occurred_at_utc.")
        return self

    @property
    def computed(self) -> bool:
        return self.status == "computed"


class AnomalyPoint(BaseModel):
    """One entry that stood out, with how far out it stood."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime
    time_local: AwareDatetime
    value: float
    deviation: float = Field(
        description="Signed distance from the series median, in the measure's own unit."
    )
    deviation_score: float = Field(
        description="Deviation in median-absolute-deviations — what the threshold is compared to."
    )

    @model_validator(mode="after")
    def _timestamps_are_the_same_instant(self) -> Self:
        if self.time_utc != self.time_local:
            raise ValueError("time_local must be the same instant as time_utc.")
        return self


class AnomalyReport(BaseModel):
    """What stood out in a window, by a stated method, with the extremes always reported.

    The method is median-absolute-deviation rather than standard deviation on purpose
    (design.md decision 9): a seven-point window containing one extreme has its own SD inflated by
    that extreme, which suppresses exactly the outlier the spec wants surfaced. A flat window has
    zero MAD and reports extremes only.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    data_class: Literal[DataClass.COMPUTED_STATISTIC] = DataClass.COMPUTED_STATISTIC
    anomalies: tuple[AnomalyPoint, ...] = ()
    minimum: StatisticResult = Field(description="Always reported, anomalies or not.")
    maximum: StatisticResult = Field(description="Always reported, anomalies or not.")
    method: str = Field(min_length=1)
    threshold: float = Field(description="Deviation score beyond which an entry is anomalous.")
    median: float
    median_absolute_deviation: float = Field(ge=0.0)
    unit: str = Field(
        description="Empty when the measure was not supplied at all; `note` then says so."
    )
    points_used: int = Field(ge=0)
    points_excluded: int = Field(default=0, ge=0)
    note: str | None = Field(
        default=None,
        description="Stated when the method could not run — a flat window, for instance.",
    )
    provenance: Provenance

    @model_validator(mode="after")
    def _flat_window_reports_extremes_only(self) -> Self:
        if self.median_absolute_deviation == 0.0 and self.anomalies:
            raise ValueError(
                "A zero median-absolute-deviation window has no dispersion to judge against, so "
                "it must report extremes only."
            )
        return self

    @property
    def found_any(self) -> bool:
        return bool(self.anomalies)


class TrendReport(BaseModel):
    """Which way a measure moved across a window, by least-squares slope.

    Slope rather than first-versus-last, so a single spike at either end does not read as a trend
    (design.md decision 9). Variation inside the per-measure insignificance margin is steady.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    data_class: Literal[DataClass.COMPUTED_STATISTIC] = DataClass.COMPUTED_STATISTIC
    direction: TrendDirection
    slope_per_day: float
    magnitude: float = Field(
        ge=0.0, description="Total modelled change across the window, in the measure's unit."
    )
    unit: str = Field(min_length=1)
    insignificance_margin_per_day: float = Field(
        ge=0.0, description="Below this slope the movement is reported as steady."
    )
    method: str = Field(min_length=1)
    points_used: int = Field(ge=0)
    points_excluded: int = Field(default=0, ge=0)
    minimum_points: int = Field(ge=0)
    provenance: Provenance

    @model_validator(mode="after")
    def _direction_matches_the_slope(self) -> Self:
        if abs(self.slope_per_day) < self.insignificance_margin_per_day:
            expected = TrendDirection.STEADY
        elif self.slope_per_day > 0:
            expected = TrendDirection.RISING
        else:
            expected = TrendDirection.FALLING
        if self.direction is not expected:
            raise ValueError(
                f"A slope of {self.slope_per_day} against a margin of "
                f"{self.insignificance_margin_per_day} is {expected.value}, not "
                f"{self.direction.value}."
            )
        return self
