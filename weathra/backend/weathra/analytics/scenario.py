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
    "ScenarioCrossing",
    "ScenarioEffects",
    "ScenarioExtreme",
    "ScenarioMeasure",
    "ScenarioSignal",
    "apply_assumptions",
    "summarise_effects",
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


# ---------------------------------------------------------------- what it did


class ScenarioCrossing(BaseModel):
    """How often a series is on the far side of a threshold, before and after.

    A count of hours, not a probability and not a risk. The threshold is stated so a reader can see
    what is being counted: "hours with any precipitation reported" is a different claim from "hours
    it will rain", and only the first is something arithmetic can answer.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    unit: str | None = None
    threshold: float
    label: str = Field(description="What crossing the threshold means, in words.")
    baseline_hours: int = Field(ge=0)
    scenario_hours: int = Field(ge=0)
    difference: int = Field(description="Scenario hours less baseline hours. May be negative.")


class ScenarioExtreme(BaseModel):
    """The highest value a measure reaches, before and after, and when the scenario reaches it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    unit: str | None = None
    baseline: float | None = None
    scenario: float | None = None
    difference: float | None = None
    occurred_at_local: str | None = Field(
        default=None, description="When the scenario reaches its highest value."
    )


class ScenarioSignal(BaseModel):
    """One derived statement about the scenario, with the figures it was derived from.

    `kind` is a stable identifier a screen can branch on; `label` is what a person reads; `detail`
    is one sentence built from counted or computed figures only. Nothing here names a hazard the
    data does not measure — "more hours with rain" is a count, "urban drainage saturation" is
    meteorology this system does not do.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: str
    label: str
    detail: str
    measure: Measure | None = None


class ScenarioEffects(BaseModel):
    """What applying the assumptions did to the series, beyond moving its means."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    risk: ScenarioSignal
    sensitivity: ScenarioSignal
    crossings: tuple[ScenarioCrossing, ...] = ()
    extremes: tuple[ScenarioExtreme, ...] = ()
    method: str


# The thresholds counted, and what crossing each one means. Deliberately few and deliberately
# literal: each is a quantity the provider reports, and each count is a fact about the series
# rather than an inference about the weather.
_THRESHOLDS: tuple[tuple[Measure, float, str], ...] = (
    (Measure.PRECIPITATION, 0.0, "hours with precipitation reported"),
    (Measure.WIND_SPEED, 0.0, "hours with wind reported"),
)


def _count_above(series: Series, measure: Measure, threshold: float) -> int:
    return sum(
        1
        for entry in series.entries
        if (value := entry.values.get(measure)) is not None and value > threshold
    )


def _peak(series: Series, measure: Measure) -> tuple[float | None, str | None]:
    """The highest reported value of a measure, and the local time it occurs at."""
    best: float | None = None
    when: str | None = None
    for entry in series.entries:
        value = entry.values.get(measure)
        if value is None:
            continue
        if best is None or value > best:
            best = value
            when = entry.time_local.isoformat()
    return best, when


def summarise_effects(
    baseline: Series, scenario: Series, measures: Sequence[ScenarioMeasure]
) -> ScenarioEffects:
    """What the assumptions did, past the means: crossings, peaks, and two derived statements.

    **Every figure is counted or subtracted, and the two statements say which figure they came
    from.** The risk signal is whichever *counted* change is largest — more hours carrying rain,
    a higher peak wind, a higher peak temperature — and where nothing was assumed it says so rather
    than reaching for a word. The sensitivity signal is whichever assumption moved its own measure
    furthest *relative to that measure's own baseline*, which is the only way four quantities in
    four units can be ranked against each other without inventing a common scale.

    Neither names a hazard. `specs/safety-grounding` puts severity behind the referral in the agent,
    and a lab that counts wet hours must not start calling them flood risk.
    """
    crossings = tuple(
        ScenarioCrossing(
            measure=measure,
            unit=baseline.units.get(measure),
            threshold=threshold,
            label=label,
            baseline_hours=(before := _count_above(baseline, measure, threshold)),
            scenario_hours=(after := _count_above(scenario, measure, threshold)),
            difference=after - before,
        )
        for measure, threshold, label in _THRESHOLDS
        if any(entry.values.get(measure) is not None for entry in baseline.entries)
    )

    extremes: list[ScenarioExtreme] = []
    for measure in (Measure.TEMPERATURE, Measure.WIND_SPEED, Measure.PRECIPITATION):
        before_peak, _ = _peak(baseline, measure)
        after_peak, when = _peak(scenario, measure)
        if before_peak is None and after_peak is None:
            continue
        extremes.append(
            ScenarioExtreme(
                measure=measure,
                unit=baseline.units.get(measure),
                baseline=before_peak,
                scenario=after_peak,
                difference=(
                    None if before_peak is None or after_peak is None else after_peak - before_peak
                ),
                occurred_at_local=when,
            )
        )

    return ScenarioEffects(
        risk=_risk_signal(crossings, tuple(extremes), measures),
        sensitivity=_sensitivity_signal(measures),
        crossings=crossings,
        extremes=tuple(extremes),
        method=(
            "Counted from the two series directly: hours past each stated threshold, and the "
            "highest reported value of each measure. No distribution is assumed and nothing is "
            "extrapolated."
        ),
    )


def _risk_signal(
    crossings: Sequence[ScenarioCrossing],
    extremes: Sequence[ScenarioExtreme],
    measures: Sequence[ScenarioMeasure],
) -> ScenarioSignal:
    """The largest counted change, named for what was counted."""
    if not measures:
        return ScenarioSignal(
            kind="none",
            label="No assumption applied",
            detail="The scenario is the retrieved forecast, unchanged.",
        )

    wetter = next(
        (
            crossing
            for crossing in crossings
            if crossing.measure is Measure.PRECIPITATION and crossing.difference > 0
        ),
        None,
    )
    if wetter is not None:
        return ScenarioSignal(
            kind="more-wet-hours",
            label="More hours carrying rain",
            detail=(
                f"{wetter.scenario_hours} of the window's hours carry precipitation under the "
                f"assumptions, against {wetter.baseline_hours} in the retrieved forecast."
            ),
            measure=Measure.PRECIPITATION,
        )

    by_measure = {extreme.measure: extreme for extreme in extremes}
    wind = by_measure.get(Measure.WIND_SPEED)
    if wind is not None and wind.difference is not None and wind.difference > 0:
        return ScenarioSignal(
            kind="higher-peak-wind",
            label="Higher peak wind",
            detail=(
                f"The highest wind speed in the window rises from {wind.baseline:.1f} to "
                f"{wind.scenario:.1f}{f' {wind.unit}' if wind.unit else ''}."
            ),
            measure=Measure.WIND_SPEED,
        )

    temperature = by_measure.get(Measure.TEMPERATURE)
    if temperature is not None and temperature.difference is not None:
        direction = "rises" if temperature.difference > 0 else "falls"
        if temperature.difference == 0:
            direction = "holds at"
        unit = f" {temperature.unit}" if temperature.unit else ""
        warmer = temperature.difference > 0
        return ScenarioSignal(
            kind="higher-peak-temperature" if warmer else "lower-peak-temperature",
            label="Higher peak temperature" if warmer else "Lower peak temperature",
            detail=(
                f"The highest temperature in the window {direction} "
                f"{temperature.scenario:.1f}{unit}, from {temperature.baseline:.1f}{unit}."
            ),
            measure=Measure.TEMPERATURE,
        )

    return ScenarioSignal(
        kind="muted",
        label="No counted change",
        detail="The assumptions moved no threshold count and no peak in this window.",
    )


def _sensitivity_signal(measures: Sequence[ScenarioMeasure]) -> ScenarioSignal:
    """Which assumption moved its own measure furthest, relative to that measure's own baseline.

    Four assumptions in four units cannot be ranked directly — two degrees and fifteen percent are
    not comparable quantities. Dividing each measure's movement by its own baseline mean puts them
    on one scale that is defined for all four, and the ratio is reported so the ranking can be
    checked rather than taken on trust. A measure whose baseline mean is zero is ranked on the
    absolute movement instead, because the ratio is undefined there rather than infinite.
    """
    ranked: list[tuple[float, ScenarioMeasure]] = []
    for measure in measures:
        if measure.difference is None:
            continue
        base = measure.baseline_mean
        share = (
            abs(measure.difference / base)
            if base is not None and base != 0
            else abs(measure.difference)
        )
        ranked.append((share, measure))

    if not ranked:
        return ScenarioSignal(
            kind="none",
            label="Not ranked",
            detail="No assumption moved a measure this window reported.",
        )

    share, strongest = max(ranked, key=lambda pair: pair[0])
    return ScenarioSignal(
        kind="most-sensitive",
        label=f"Most sensitive to {strongest.measure.value.replace('_', ' ')}",
        detail=(
            f"That assumption moved its own mean by {share * 100:.1f}% of the retrieved mean, "
            f"the largest share of the four."
        ),
        measure=strongest.measure,
    )
