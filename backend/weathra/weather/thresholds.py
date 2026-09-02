"""Threshold crossings: when a measure first passes a value a caller cares about.

Three behaviours the spec is specific about:

* **Not crossed is a result, not silence.** "When does it first exceed 20 mm?" answered with an
  empty list reads as a missing answer; answered with "not crossed in this window" it reads as
  the fact it is. ``specs/forecast-analysis`` requires the explicit form.
* **Crossings are reported in local time.** The caller asked about a place, so "Thursday 14:00"
  means Thursday afternoon there.
* **A threshold on a measure the series lacks is an error naming the measure**, not a silently
  empty answer. That is a caller mistake worth surfacing.

A crossing is a *transition*: the first entry is only a crossing if it already satisfies the
condition and there is nothing before it to transition from. Otherwise a series that starts hot
would report no crossing at all for "above 30 °C", which is not what anyone means.
"""

from __future__ import annotations

from datetime import datetime
from typing import Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from weathra.analytics.support import require_measure, usable_points
from weathra.domain.analytics import Direction, Provenance
from weathra.domain.weather import DataClass, Measure, Series

__all__ = ["Crossing", "ThresholdCondition", "ThresholdReport", "find_crossings"]


class ThresholdCondition(BaseModel):
    """What the caller wants to know about: a measure, a direction, and a value."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    direction: Direction
    value: float

    def satisfied_by(self, reading: float) -> bool:
        if self.direction is Direction.ABOVE:
            return reading > self.value
        return reading < self.value

    def describe(self, unit: str) -> str:
        word = "above" if self.direction is Direction.ABOVE else "below"
        return f"{self.measure.value} {word} {self.value:g}{f' {unit}' if unit else ''}"


class Crossing(BaseModel):
    """One transition into the condition, with the reading at that point."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    time_utc: AwareDatetime
    time_local: AwareDatetime
    value: float

    @model_validator(mode="after")
    def _timestamps_are_the_same_instant(self) -> Self:
        if self.time_utc != self.time_local:
            raise ValueError("time_local must be the same instant as time_utc.")
        return self


class ThresholdReport(BaseModel):
    """Whether and when a condition was met across the window."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    condition: ThresholdCondition
    crossed: bool
    crossings: tuple[Crossing, ...] = ()
    unit: str
    data_class: DataClass
    statement: str = Field(min_length=1, description="The plain sentence a reader sees.")
    points_used: int = Field(ge=0)
    points_excluded: int = Field(default=0, ge=0)
    method: str = Field(min_length=1)
    provenance: Provenance

    @model_validator(mode="after")
    def _crossed_agrees_with_the_crossings(self) -> Self:
        if self.crossed and not self.crossings:
            raise ValueError("A crossed threshold must report where it crossed.")
        if not self.crossed and self.crossings:
            raise ValueError("An uncrossed threshold cannot carry crossings.")
        return self

    @property
    def first(self) -> Crossing | None:
        return self.crossings[0] if self.crossings else None


def find_crossings(
    series: Series,
    condition: ThresholdCondition,
    provenance: Provenance,
    *,
    data_class: DataClass = DataClass.FORECAST,
) -> ThresholdReport:
    """Every transition into ``condition`` across the series, first one first."""
    require_measure(series, condition.measure)

    points = usable_points(series, condition.measure)
    unit = series.unit(condition.measure) or ""
    method = (
        "transitions into the condition across usable points, reported in the location's local "
        "time; the first point counts when it already satisfies the condition"
    )

    crossings: list[Crossing] = []
    previously_satisfied = False
    for index, value in enumerate(points.values):
        satisfied = condition.satisfied_by(value)
        if satisfied and not previously_satisfied:
            crossings.append(
                Crossing(
                    time_utc=points.times_utc[index],
                    time_local=points.times_local[index],
                    value=value,
                )
            )
        previously_satisfied = satisfied

    described = condition.describe(unit)
    if crossings:
        statement = (
            f"{described} first occurs at "
            f"{_readable(crossings[0].time_local)} ({crossings[0].value:g}"
            f"{f' {unit}' if unit else ''})"
            + (
                f", and {len(crossings) - 1} more time(s) in this window."
                if len(crossings) > 1
                else "."
            )
        )
    elif len(points) == 0:
        statement = (
            f"{condition.measure.value} is not supplied for this window, so whether it goes "
            f"{'above' if condition.direction is Direction.ABOVE else 'below'} "
            f"{condition.value:g} cannot be determined."
        )
    else:
        statement = f"{described} does not occur at any point in this window."

    return ThresholdReport(
        condition=condition,
        crossed=bool(crossings),
        crossings=tuple(crossings),
        unit=unit,
        data_class=data_class,
        statement=statement,
        points_used=len(points),
        points_excluded=points.excluded,
        method=method,
        provenance=provenance,
    )


def _readable(moment: datetime) -> str:
    """A local timestamp a person can read, with its offset so it is unambiguous."""
    return moment.strftime("%a %d %b %H:%M %Z").strip()
