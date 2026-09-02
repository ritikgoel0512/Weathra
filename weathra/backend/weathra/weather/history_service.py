"""The Historical Agent's capability: observations, period comparison, and baselines.

Three things this module is careful about, each because a spec scenario turns on it:

* **Labelling.** Observations are labelled ``historical_observation``; a baseline Weathra computed
  is labelled ``computed_statistic`` and described as *Weathra's own*, never as an official climate
  normal published by a meteorological authority.
* **Shared basis.** A period comparison uses the same units, the same provider, and the same
  statistics on both sides, and says so. Periods of unequal length are permitted and the result
  states that they differ — because comparing a 28-day month to a 31-day one is a legitimate
  question whose answer needs that caveat attached.
* **One-sided is not a comparison.** If the archive covers one period and not the other, the
  request fails naming which one. Reporting the available half as though it were a comparison would
  be the most misleading possible answer.

Forecast-accuracy scoring is explicitly *not* here, and ``refuse_accuracy_scoring`` exists to make
that refusal a first-class answer rather than a historical comparison quietly substituted for it.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from pydantic import BaseModel, ConfigDict, Field

from weathra.analytics import descriptive, precipitation
from weathra.analytics.distribution import z_score
from weathra.analytics.rolling import delta, percentage_change
from weathra.analytics.support import require_usable
from weathra.config import Settings
from weathra.domain.analytics import Provenance, StatisticResult
from weathra.domain.errors import NoDataForRange, RangeOutsideCoverage
from weathra.domain.location import Location
from weathra.domain.weather import (
    DataClass,
    HistoricalObservations,
    Measure,
    Period,
    Series,
    SeriesEntry,
    UnitSystem,
)
from weathra.providers.base import WeatherProvider
from weathra.providers.validation import validate_historical_range
from weathra.weather.windows import baseline_periods, historical_window, today_at

__all__ = [
    "ACCURACY_REFUSAL",
    "Baseline",
    "BaselineComparison",
    "HistoryService",
    "PeriodComparison",
    "refuse_accuracy_scoring",
]

# The measures a historical comparison and a baseline are built from. Kept in one place so both
# sides of a comparison provably use the same statistics.
COMPARISON_MEASURES: tuple[Measure, ...] = (
    Measure.TEMPERATURE_MEAN,
    Measure.TEMPERATURE_MAX,
    Measure.TEMPERATURE_MIN,
    Measure.PRECIPITATION_SUM,
    Measure.WIND_SPEED_MAX,
)

ACCURACY_REFUSAL = (
    "Weathra does not offer forecast-accuracy or forecast-skill scoring. That would mean comparing "
    "forecasts captured in the past against what was later observed, which needs a long history of "
    "captured forecasts that Weathra does not yet have. A historical comparison is a different "
    "thing and is not a substitute for it: it says what the weather did, not how good a past "
    "forecast was."
)


class PeriodComparison(BaseModel):
    """Two past periods, their aggregates, and the signed differences between them."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    data_class: DataClass = DataClass.HISTORICAL_OBSERVATION
    earlier_period: Period
    later_period: Period
    provider: str = Field(min_length=1)
    unit_system: UnitSystem
    statistics_applied: tuple[str, ...] = Field(min_length=1)
    earlier: tuple[StatisticResult, ...] = Field(min_length=1)
    later: tuple[StatisticResult, ...] = Field(min_length=1)
    deltas: tuple[StatisticResult, ...] = ()
    percentage_changes: dict[str, float | None] = Field(default_factory=dict)
    lengths_differ: bool
    basis: str = Field(min_length=1, description="The shared basis, stated in the result.")


class Baseline(BaseModel):
    """A multi-year baseline for one location and calendar period, computed by Weathra."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    data_class: DataClass = DataClass.COMPUTED_STATISTIC
    measure: Measure
    calendar_period: Period = Field(description="The calendar window the baseline describes.")
    years_requested: int = Field(ge=1)
    years_used: tuple[int, ...] = Field(min_length=1)
    mean: StatisticResult
    standard_deviation: StatisticResult
    minimum: StatisticResult
    maximum: StatisticResult
    provider: str = Field(min_length=1)
    unit_system: UnitSystem
    labelling: str = Field(min_length=1)
    coverage_note: str | None = Field(
        default=None, description="Set when fewer years were available than requested."
    )

    @property
    def years_count(self) -> int:
        return len(self.years_used)

    @property
    def is_partial(self) -> bool:
        return self.years_count < self.years_requested


class BaselineComparison(BaseModel):
    """A current or forecast value placed against a baseline."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    measure: Measure
    baseline: Baseline
    observed_or_forecast_value: float
    observed_data_class: DataClass
    difference: StatisticResult
    z_score: StatisticResult
    characterization: str = Field(min_length=1)
    forecast_side_caveat: str | None = Field(
        default=None,
        description="Present when one side is a forecast: that side is uncertain, and it says so.",
    )


def refuse_accuracy_scoring() -> str:
    """The refusal, as a value rather than an exception.

    A caller asking "how accurate have your forecasts been" gets an answer, not an error — and
    crucially not a historical comparison dressed up as one (``specs/historical-weather``).
    """
    return ACCURACY_REFUSAL


def provenance_for(observations: HistoricalObservations) -> Provenance:
    return Provenance(
        location=observations.location,
        period=observations.covered_period,
        provider=observations.provider,
        unit_system=observations.unit_system,
        source_data_class=DataClass.HISTORICAL_OBSERVATION,
        retrieved_at=observations.retrieved_at,
    )


def aggregate(
    observations: HistoricalObservations,
    *,
    measures: tuple[Measure, ...] = COMPARISON_MEASURES,
) -> tuple[StatisticResult, ...]:
    """The same statistics, in the same order, for either side of a comparison."""
    require_usable(observations.daily, what="the retrieved observations")
    provenance = provenance_for(observations)
    daily = observations.daily

    results: list[StatisticResult] = []
    for measure in measures:
        if measure is Measure.PRECIPITATION_SUM:
            results.append(precipitation.total(daily, provenance, measure=measure))
        elif measure is Measure.WIND_SPEED_MAX:
            results.append(descriptive.mean(daily, measure, provenance))
            results.append(descriptive.maximum(daily, measure, provenance))
        else:
            results.append(descriptive.mean(daily, measure, provenance))
            results.append(descriptive.minimum(daily, measure, provenance))
            results.append(descriptive.maximum(daily, measure, provenance))
    return tuple(results)


def statistics_applied(measures: tuple[Measure, ...] = COMPARISON_MEASURES) -> tuple[str, ...]:
    """The names of the statistics both sides of a comparison were given."""
    return tuple(
        f"{measure.value}: "
        + ("total" if measure is Measure.PRECIPITATION_SUM else "mean, minimum, maximum")
        for measure in measures
    )


class HistoryService:
    """Retrieval and comparison over the archive."""

    def __init__(
        self,
        *,
        provider: WeatherProvider,
        settings: Settings,
        now: datetime | None = None,
    ) -> None:
        self._provider = provider
        self._settings = settings
        self._now = now

    def _instant(self) -> datetime:
        return self._now or datetime.now(UTC)

    # ---------------------------------------------------------------- retrieval

    async def observations(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> HistoricalObservations:
        """Observed weather over a past range, validated against declared coverage."""
        validate_historical_range(
            self._provider.capabilities(),
            start=start,
            end=end,
            today=today_at(location, self._instant()),
        )
        return await self._provider.history(location, start=start, end=end, unit_system=unit_system)

    # ---------------------------------------------------------------- comparison

    async def compare_periods(
        self,
        location: Location,
        *,
        earlier_start: date,
        earlier_end: date,
        later_start: date,
        later_end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
        measures: tuple[Measure, ...] = COMPARISON_MEASURES,
    ) -> PeriodComparison:
        """Compare two explicitly supplied past periods on a shared basis."""
        earlier = await self._side(
            location, earlier_start, earlier_end, unit_system, label="the earlier period"
        )
        later = await self._side(
            location, later_start, later_end, unit_system, label="the later period"
        )

        earlier_results = aggregate(earlier, measures=measures)
        later_results = aggregate(later, measures=measures)

        deltas: list[StatisticResult] = []
        changes: dict[str, float | None] = {}
        earlier_by_key = {(result.statistic, result.measure): result for result in earlier_results}
        for result in later_results:
            counterpart = earlier_by_key.get((result.statistic, result.measure))
            if counterpart is None or counterpart.value is None or result.value is None:
                continue
            deltas.append(
                delta(
                    measure=result.measure,
                    unit=result.unit,
                    earlier=counterpart.value,
                    later=result.value,
                    earlier_label=_period_label(earlier.covered_period),
                    later_label=_period_label(later.covered_period),
                    provenance=result.provenance,
                )
            )
            changes[f"{result.statistic.value}:{result.measure.value}"] = percentage_change(
                counterpart.value, result.value
            )

        earlier_days = (earlier_end - earlier_start).days + 1
        later_days = (later_end - later_start).days + 1
        lengths_differ = earlier_days != later_days

        basis = (
            f"Both periods are measured in {unit_system.value} units from "
            f"{self._provider.capabilities().name}, with the same statistics applied to each."
        )
        if lengths_differ:
            basis += (
                f" The periods differ in length: {earlier_days} day(s) against {later_days} "
                "day(s), so totals are not directly comparable even though the means are."
            )

        return PeriodComparison(
            location=location,
            earlier_period=earlier.covered_period,
            later_period=later.covered_period,
            provider=earlier.provider,
            unit_system=unit_system,
            statistics_applied=statistics_applied(measures),
            earlier=earlier_results,
            later=later_results,
            deltas=tuple(deltas),
            percentage_changes=changes,
            lengths_differ=lengths_differ,
            basis=basis,
        )

    async def _side(
        self,
        location: Location,
        start: date,
        end: date,
        unit_system: UnitSystem,
        *,
        label: str,
    ) -> HistoricalObservations:
        """One side of a comparison, or a failure naming *which* side is unavailable."""
        try:
            observations = await self.observations(
                location, start=start, end=end, unit_system=unit_system
            )
        except (NoDataForRange, RangeOutsideCoverage) as failure:
            raise type(failure)(
                f"{label.capitalize()} ({start.isoformat()} to {end.isoformat()}) is not "
                f"available: {failure.message} A one-sided result is not a comparison, so the "
                "request cannot be answered.",
                details={**failure.details, "side": label},
            ) from failure

        if len(observations.daily) == 0:
            raise NoDataForRange(
                f"{label.capitalize()} ({start.isoformat()} to {end.isoformat()}) returned no "
                "observations, so there is nothing to compare on that side.",
                details={"side": label, "start": start.isoformat(), "end": end.isoformat()},
            )
        return observations

    # ---------------------------------------------------------------- baselines

    async def baseline(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        years: int,
        measure: Measure = Measure.TEMPERATURE_MEAN,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> Baseline:
        """A baseline for a calendar period, over as many of ``years`` as the archive covers.

        A year the archive cannot serve is *dropped and reported*, never silently narrowed: the
        result states which years went into it and how many were asked for.
        """
        candidates = baseline_periods(
            location, start=start, end=end, years=years, reference_year=start.year + 1
        )

        collected: list[tuple[int, HistoricalObservations]] = []
        for year, period in candidates:
            try:
                observations = await self.observations(
                    location,
                    start=period.start_local.date(),
                    end=(period.end_local.date()),
                    unit_system=unit_system,
                )
            except (NoDataForRange, RangeOutsideCoverage):
                continue
            if observations.daily.supplies(measure):
                collected.append((year, observations))

        if not collected:
            raise NoDataForRange(
                f"The archive holds no {measure.value} observations for this calendar period in "
                f"any of the {years} year(s) requested.",
                details={"measure": measure.value, "years_requested": years},
            )

        # One series carrying every year's values, so the baseline statistics are computed by the
        # same functions as everything else rather than by ad-hoc arithmetic here.
        merged = _merge_years(collected, measure)
        provenance = provenance_for(collected[0][1])

        years_used = tuple(sorted(year for year, _ in collected))
        note = None
        if len(years_used) < years:
            note = (
                f"{len(years_used)} of the {years} requested years were available in the archive: "
                f"{', '.join(str(year) for year in years_used)}."
            )

        return Baseline(
            location=location,
            measure=measure,
            calendar_period=historical_window(location, start, end),
            years_requested=years,
            years_used=years_used,
            mean=descriptive.mean(merged, measure, provenance),
            standard_deviation=descriptive.standard_deviation(merged, measure, provenance),
            minimum=descriptive.minimum(merged, measure, provenance),
            maximum=descriptive.maximum(merged, measure, provenance),
            provider=collected[0][1].provider,
            unit_system=unit_system,
            labelling=(
                f"A historical statistic computed by Weathra from {collected[0][1].provider} "
                f"archive observations over {len(years_used)} year(s). It is not an official "
                "climate normal published by a meteorological authority."
            ),
            coverage_note=note,
        )

    def compare_against_baseline(
        self,
        *,
        baseline: Baseline,
        value: float,
        value_data_class: DataClass,
    ) -> BaselineComparison:
        """Place a current or forecast value against a baseline.

        The z-score comes back *undefined with its reason* when the baseline has no spread, and
        the signed difference is reported either way — which is what ``specs/historical-weather``
        requires of the zero-variance case.
        """
        mean_value = baseline.mean.value
        spread = baseline.standard_deviation.value
        if mean_value is None:
            raise NoDataForRange(
                "The baseline has no computable mean, so there is nothing to compare against.",
                details={"measure": baseline.measure.value},
            )

        difference = delta(
            measure=baseline.measure,
            unit=baseline.mean.unit,
            earlier=mean_value,
            later=value,
            earlier_label=f"the {baseline.years_count}-year baseline",
            later_label="the value being compared",
            provenance=baseline.mean.provenance,
        )

        score = z_score(
            measure=baseline.measure,
            unit=baseline.mean.unit,
            value=value,
            reference_mean=mean_value,
            reference_standard_deviation=spread if spread is not None else 0.0,
            reference_label=(
                f"the {baseline.years_count}-year baseline for "
                f"{_period_label(baseline.calendar_period)}"
            ),
            reference_years=baseline.years_count,
            provenance=baseline.mean.provenance,
        )

        caveat = None
        if value_data_class is DataClass.FORECAST:
            caveat = (
                "One side of this comparison is a forecast and is therefore uncertain; the "
                "baseline side is built from observed archive data."
            )

        return BaselineComparison(
            location=baseline.location,
            measure=baseline.measure,
            baseline=baseline,
            observed_or_forecast_value=value,
            observed_data_class=value_data_class,
            difference=difference,
            z_score=score,
            characterization=_characterize(baseline, value, difference, score),
            forecast_side_caveat=caveat,
        )


def _merge_years(collected: list[tuple[int, HistoricalObservations]], measure: Measure) -> Series:
    """One series containing every collected year's values for ``measure``.

    Timestamps are kept as retrieved, so the baseline's extremes still report the real date they
    occurred on rather than a synthetic one. Building a real ``Series`` rather than a list of
    floats is what lets the baseline's mean, spread, and extremes come from the same analytics
    functions as everything else — no ad-hoc arithmetic in this layer.
    """
    by_instant: dict[datetime, SeriesEntry] = {}
    units: dict[Measure, str] = {}
    for _year, observations in collected:
        units.setdefault(measure, observations.daily.unit(measure) or "")
        for entry in observations.daily.entries:
            if entry.value(measure) is None:
                continue
            # Keyed by instant so one day contributes one value. Distinct years have distinct
            # dates in practice; a collision means the provider served a range it was not asked
            # for, and counting that day twice would skew the baseline rather than fail loudly.
            by_instant.setdefault(
                entry.time_utc, entry.model_copy(update={"values": {measure: entry.value(measure)}})
            )

    entries = sorted(by_instant.values(), key=lambda entry: entry.time_utc)
    return Series(
        granularity=collected[0][1].daily.granularity,
        units=units,
        entries=tuple(entries),
    )


def _period_label(period: Period) -> str:
    start = period.start_local
    end = period.end_local
    return f"{start.date().isoformat()} to {end.date().isoformat()}"


def _characterize(
    baseline: Baseline, value: float, difference: StatisticResult, score: StatisticResult
) -> str:
    """A plain-language characterization, from the computed figures only."""
    signed = difference.value or 0.0
    unit = baseline.mean.unit
    measure_name = baseline.measure.value.replace("_", " ")

    if abs(signed) < 0.05:
        direction = "in line with"
    elif signed > 0:
        direction = "above"
    else:
        direction = "below"

    sentence = (
        f"{value:g} {unit} is {abs(signed):g} {unit} {direction} the "
        f"{baseline.years_count}-year baseline {measure_name} of {baseline.mean.value:g} {unit}"
    )
    if score.computed and score.value is not None:
        sentence += f" ({score.value:+.2f} standard deviations)"
    else:
        sentence += f" (z-score undefined: {score.reason})"
    return sentence + "."
