"""Applying stated assumptions to a real series — arithmetic, and nothing more.

`specs/deterministic-analytics` puts every computed figure here, and a scenario is a computed figure
like any other: the same arguments produce the same answer, byte for byte, with no I/O, no clock and
no language model. What makes it a *scenario* rather than a forecast is only that one of its inputs
came from a person instead of from a provider.

**It does not model weather, and the distinction is the whole point.** Adding two degrees to every
hour of a real forecast produces a series that is two degrees warmer; it does not produce the
weather that would occur if the atmosphere were two degrees warmer, because that would require
physics this system does not have and will not pretend to. So the output is labelled as what it is —
a stated assumption applied to a retrieved series — and every value carries the arithmetic that
produced it.

**Three rules, each of which would otherwise be re-decided per measure.**

* **An absent value stays absent.** A provider that reported no humidity for an hour is not a
  provider that reported zero, and adding five points to nothing is not five.
* **A physical bound is a bound.** Relative humidity is a percentage and cannot leave 0-100;
  precipitation and wind speed cannot go negative. An assumption that would cross one is applied up
  to the bound and the crossing is *counted*, so "the assumption was clipped on 9 of 24 hours" is
  visible rather than silently absorbed.
* **The method is stated per measure**, because "+2.5" and "+15%" are different operations and a
  reader cannot tell which was used from the number alone.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.weather import Measure, Series, SeriesEntry

__all__ = [
    "ADJUSTABLE",
    "Adjustment",
    "ScenarioAssumptions",
    "ScenarioMeasure",
    "apply_assumptions",
]


class Adjustment(BaseModel):
    """How one measure is changed, and within what bounds."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    kind: str = Field(description="'offset' adds a quantity; 'scale' multiplies by a percentage.")
    minimum: float | None = Field(default=None, description="Physical floor, where one exists.")
    maximum: float | None = Field(default=None, description="Physical ceiling, where one exists.")

    def method(self, amount: float) -> str:
        """The sentence that describes what was done, for the reader of the result."""
        if self.kind == "scale":
            return f"each reported value scaled by {amount:+.1f}%"
        return f"{amount:+.2f} added to each reported value"


# The measures an assumption may address, and the bounds that constrain each. Deliberately short:
# these are the four the approved screen offers, and each is a quantity Open-Meteo actually reports.
# A measure absent from this table cannot be adjusted, which is what keeps the surface honest.
ADJUSTABLE: dict[Measure, Adjustment] = {
    Measure.TEMPERATURE: Adjustment(measure=Measure.TEMPERATURE, kind="offset"),
    Measure.PRECIPITATION: Adjustment(measure=Measure.PRECIPITATION, kind="scale", minimum=0.0),
    Measure.RELATIVE_HUMIDITY: Adjustment(
        measure=Measure.RELATIVE_HUMIDITY, kind="offset", minimum=0.0, maximum=100.0
    ),
    Measure.WIND_SPEED: Adjustment(measure=Measure.WIND_SPEED, kind="offset", minimum=0.0),
}


class ScenarioAssumptions(BaseModel):
    """What a person supposed. Every field optional; an omitted one changes nothing."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    temperature_delta: float | None = Field(
        default=None, ge=-30.0, le=30.0, description="Added to every reported temperature."
    )
    precipitation_percent: float | None = Field(
        default=None,
        ge=-100.0,
        le=500.0,
        description="Scales every reported precipitation figure. -100 removes it entirely.",
    )
    relative_humidity_delta: float | None = Field(
        default=None,
        ge=-100.0,
        le=100.0,
        description="Added to every reported humidity, in points.",
    )
    wind_speed_delta: float | None = Field(
        default=None, ge=-200.0, le=200.0, description="Added to every reported wind speed."
    )

    def stated(self) -> dict[Measure, float]:
        """Only the assumptions actually made, keyed by the measure each addresses."""
        pairs: tuple[tuple[Measure, float | None], ...] = (
            (Measure.TEMPERATURE, self.temperature_delta),
            (Measure.PRECIPITATION, self.precipitation_percent),
            (Measure.RELATIVE_HUMIDITY, self.relative_humidity_delta),
            (Measure.WIND_SPEED, self.wind_speed_delta),
        )
        return {measure: amount for measure, amount in pairs if amount is not None}


class ScenarioMeasure(BaseModel):
    """One measure, before and after, with the arithmetic that produced the after."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    unit: str | None = None
    assumption: float
    method: str
    baseline_mean: float | None = Field(
        default=None, description="Mean of the reported values. Null where none were reported."
    )
    scenario_mean: float | None = None
    difference: float | None = Field(
        default=None, description="Scenario mean less baseline mean, where both exist."
    )
    points_used: int = Field(default=0, ge=0)
    points_excluded: int = Field(
        default=0, ge=0, description="Hours the provider reported nothing for this measure."
    )
    clipped: int = Field(
        default=0,
        ge=0,
        description="Hours where the assumption would have crossed a physical bound and was "
        "applied up to it instead. Counted rather than absorbed.",
    )


def _adjust(value: float, adjustment: Adjustment, amount: float) -> tuple[float, bool]:
    """One value, adjusted and bounded. Returns the value and whether a bound was reached."""
    moved = value * (1.0 + amount / 100.0) if adjustment.kind == "scale" else value + amount

    bounded = moved
    if adjustment.minimum is not None:
        bounded = max(adjustment.minimum, bounded)
    if adjustment.maximum is not None:
        bounded = min(adjustment.maximum, bounded)
    return bounded, bounded != moved


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def apply_assumptions(
    baseline: Series, assumptions: ScenarioAssumptions
) -> tuple[Series, tuple[ScenarioMeasure, ...]]:
    """The baseline series with the assumptions applied, and what each one did.

    The returned series carries the same instants, the same granularity and the same units as the
    baseline: only the values move, and only for the measures an assumption addressed. Everything
    else passes through untouched, so a scenario chart and a forecast chart are the same shape.
    """
    stated = assumptions.stated()

    entries: list[SeriesEntry] = []
    clipped: dict[Measure, int] = dict.fromkeys(stated, 0)
    before: dict[Measure, list[float]] = {measure: [] for measure in stated}
    after: dict[Measure, list[float]] = {measure: [] for measure in stated}
    excluded: dict[Measure, int] = dict.fromkeys(stated, 0)

    for entry in baseline.entries:
        values: dict[Measure, float | None] = dict(entry.values)
        for measure, amount in stated.items():
            reported = entry.values.get(measure)
            if reported is None:
                # Absent stays absent. Adjusting nothing produces nothing, not the adjustment.
                excluded[measure] += 1
                continue
            moved, hit_bound = _adjust(reported, ADJUSTABLE[measure], amount)
            values[measure] = moved
            before[measure].append(reported)
            after[measure].append(moved)
            if hit_bound:
                clipped[measure] += 1
        entries.append(
            SeriesEntry(time_utc=entry.time_utc, time_local=entry.time_local, values=values)
        )

    scenario = Series(
        granularity=baseline.granularity, units=dict(baseline.units), entries=tuple(entries)
    )

    measures = tuple(
        ScenarioMeasure(
            measure=measure,
            unit=baseline.units.get(measure),
            assumption=amount,
            method=ADJUSTABLE[measure].method(amount),
            baseline_mean=_mean(before[measure]),
            scenario_mean=_mean(after[measure]),
            difference=(
                None
                if _mean(before[measure]) is None or _mean(after[measure]) is None
                else _mean(after[measure]) - _mean(before[measure])  # type: ignore[operator]
            ),
            points_used=len(before[measure]),
            points_excluded=excluded[measure],
            clipped=clipped[measure],
        )
        for measure, amount in stated.items()
    )

    return scenario, measures
