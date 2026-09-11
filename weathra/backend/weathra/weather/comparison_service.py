"""Comparison: which place, or which day, best fits a criterion.

This layer **ranks and explains; it computes nothing**. Every score is built from
``StatisticResult`` values, so the ranking can be checked rather than trusted
(``specs/location-comparison``).

Four decisions worth reading:

* **Fairness is enforced, not promised.** Every candidate gets the same window, the same units, the
  same provider, and the same statistics, and the result states that basis. A candidate retrieved
  under different terms is not comparable and cannot be scored alongside the others.
* **The composite criterion discloses its arithmetic.** "Best for being outdoors" is a judgment,
  not a measurement, so each component's value, direction, weight, and contribution is reported,
  and the result says the weighting is Weathra's own heuristic rather than an authoritative index.
* **Ties share a rank.** Two places within the tolerance are tied, and saying so is more honest
  than ordering them by whichever floating-point value came out a hair larger.
* **A candidate that cannot be retrieved is excluded with its reason, not dropped.** The comparison
  still answers if two survive, and fails plainly if fewer do — because ranking one place against
  nothing is not a comparison.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, date, datetime

from weathra.analytics import association, descriptive, precipitation
from weathra.analytics.support import require_usable
from weathra.config import Settings
from weathra.domain.analytics import Direction, Provenance, Statistic, StatisticResult
from weathra.domain.comparison import (
    ComparisonCandidate,
    ComparisonMode,
    ComparisonResult,
    ComponentContribution,
    Criterion,
    ExcludedCandidate,
)
from weathra.domain.errors import (
    UnsupportedCriterion,
    ValidationFailed,
    WeathraError,
)
from weathra.domain.location import Location
from weathra.domain.weather import (
    DataClass,
    Forecast,
    HistoricalObservations,
    Measure,
    Period,
    Series,
    UnitSystem,
)
from weathra.domain.windows import period_from_local_dates
from weathra.providers.base import WeatherProvider
from weathra.providers.validation import resolve_horizon, validate_historical_range
from weathra.weather.windows import today_at

__all__ = [
    "COMPOSITE_WEIGHTS",
    "IDEAL_TEMPERATURE_C",
    "TIE_TOLERANCE",
    "WEIGHTING_DISCLOSURE",
    "ComparisonService",
    "score_candidate",
]

# Scores within this are tied. The composite score is normalized to 0-1, and single-measure scores
# are in their measure's own unit, so the tolerance is deliberately small enough not to merge
# genuinely different places and large enough to absorb floating-point noise.
TIE_TOLERANCE = 0.05

# The composite criterion's weights. Weathra's own heuristic, disclosed in every result.
COMPOSITE_WEIGHTS: dict[Measure, float] = {
    Measure.TEMPERATURE_MEAN: 0.5,
    Measure.PRECIPITATION_SUM: 0.3,
    Measure.WIND_SPEED_MAX: 0.2,
}

# Comfort peaks here and falls away either side. 21 °C is a mild judgment and is stated as one.
IDEAL_TEMPERATURE_C = 21.0
_COMFORT_SPAN_C = 15.0

# Reference scales for normalizing the composite's components to 0-1.
_RAIN_SCALE_MM = 20.0
_WIND_SCALE_KMH = 40.0

WEIGHTING_DISCLOSURE = (
    "The outdoor-suitability score is Weathra's own heuristic, not an authoritative index. It "
    "combines temperature comfort (weight {temperature:g}), precipitation (weight "
    "{precipitation:g}), and wind (weight {wind:g}), each normalized to a 0-1 scale, with comfort "
    f"peaking at {IDEAL_TEMPERATURE_C:g} °C. Every component's value, direction, weight, and "
    "contribution is reported so the score can be recomputed by hand."
).format(
    temperature=COMPOSITE_WEIGHTS[Measure.TEMPERATURE_MEAN],
    precipitation=COMPOSITE_WEIGHTS[Measure.PRECIPITATION_SUM],
    wind=COMPOSITE_WEIGHTS[Measure.WIND_SPEED_MAX],
)

# One scored candidate before it becomes a ranked one: its label, where and when it covers, its
# score, the composite components behind that score, and the analytics results behind those.
Scored = tuple[
    str,
    Location,
    Period,
    float,
    tuple[ComponentContribution, ...],
    tuple[StatisticResult, ...],
]

# What each criterion ranks on, and which way is better.
_CRITERION_MEASURE: dict[Criterion, tuple[Measure, Direction]] = {
    Criterion.WARMEST: (Measure.TEMPERATURE_MEAN, Direction.ABOVE),
    Criterion.COOLEST: (Measure.TEMPERATURE_MEAN, Direction.BELOW),
    Criterion.DRIEST: (Measure.PRECIPITATION_SUM, Direction.BELOW),
    Criterion.WETTEST: (Measure.PRECIPITATION_SUM, Direction.ABOVE),
    Criterion.LEAST_WINDY: (Measure.WIND_SPEED_MAX, Direction.BELOW),
}


def supported_criteria() -> tuple[str, ...]:
    return tuple(criterion.value for criterion in Criterion)


def parse_criterion(name: str) -> Criterion:
    """A criterion by name, or an error listing the supported ones."""
    try:
        return Criterion(name)
    except ValueError as exc:
        raise UnsupportedCriterion(
            f"{name!r} is not a supported comparison criterion. Supported criteria: "
            f"{', '.join(supported_criteria())}.",
            details={"requested": name, "supported": list(supported_criteria())},
        ) from exc


def _statistic_for(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """The one figure a criterion ranks on: a total for rain, a mean for everything else."""
    if measure is Measure.PRECIPITATION_SUM:
        return precipitation.total(series, provenance, measure=measure)
    return descriptive.mean(series, measure, provenance)


def _comfort(temperature: float) -> float:
    """A 0-1 comfort score peaking at ``IDEAL_TEMPERATURE_C`` and falling away either side."""
    distance = abs(temperature - IDEAL_TEMPERATURE_C)
    return max(0.0, 1.0 - distance / _COMFORT_SPAN_C)


def _inverse(value: float, scale: float) -> float:
    """A 0-1 score where less is better: 0 maps to 1, ``scale`` and beyond map to 0."""
    return max(0.0, 1.0 - value / scale)


def score_candidate(
    *,
    label: str,
    location: Location,
    period: Period,
    series: Series,
    criterion: Criterion,
    provenance: Provenance,
) -> tuple[float, tuple[ComponentContribution, ...], tuple[StatisticResult, ...]]:
    """The score, its component contributions, and the analytics behind it.

    A single-measure criterion scores on the measure itself, in its own unit, so the ranking is
    directly readable ("19.2 °C beats 11.4 °C"). The composite normalizes each component to 0-1
    first, because adding degrees to millimetres would be meaningless.
    """
    require_usable(series, what=f"the series for {label}")

    if criterion.is_composite:
        contributions: list[ComponentContribution] = []
        supporting: list[StatisticResult] = []
        score = 0.0

        for measure, weight in COMPOSITE_WEIGHTS.items():
            statistic = _statistic_for(series, measure, provenance)
            supporting.append(statistic)
            if not statistic.computed or statistic.value is None:
                # A missing component contributes nothing rather than a guessed value, and the
                # not-computable result stays in `supporting` so the gap is visible.
                continue

            value = statistic.value
            if measure is Measure.TEMPERATURE_MEAN:
                normalized, direction = _comfort(value), Direction.ABOVE
            elif measure is Measure.PRECIPITATION_SUM:
                normalized, direction = _inverse(value, _RAIN_SCALE_MM), Direction.BELOW
            else:
                normalized, direction = _inverse(value, _WIND_SCALE_KMH), Direction.BELOW

            contribution = normalized * weight
            score += contribution
            contributions.append(
                ComponentContribution(
                    measure=measure,
                    value=value,
                    unit=statistic.unit,
                    direction=direction,
                    weight=weight,
                    contribution=contribution,
                    supporting=statistic,
                )
            )

        return score, tuple(contributions), tuple(supporting)

    measure, direction = _CRITERION_MEASURE[criterion]
    statistic = _statistic_for(series, measure, provenance)
    if not statistic.computed or statistic.value is None:
        raise ValidationFailed(
            f"{label} cannot be ranked by {criterion.value}: {statistic.reason}",
            details={"label": label, "criterion": criterion.value, "measure": measure.value},
        )

    # Higher is better either way, so the ranking is one sort in one direction.
    score = statistic.value if direction is Direction.ABOVE else -statistic.value
    return score, (), (statistic,)


def rank(
    scored: Sequence[Scored], *, tolerance: float = TIE_TOLERANCE
) -> tuple[ComparisonCandidate, ...]:
    """Turn scores into ranks, with candidates inside ``tolerance`` sharing one."""
    ordered = sorted(scored, key=lambda entry: (-entry[3], entry[0]))

    candidates: list[ComparisonCandidate] = []
    current_rank = 0
    previous_score: float | None = None

    for index, (label, location, period, score, contributions, supporting) in enumerate(ordered):
        tied_with_previous = previous_score is not None and abs(score - previous_score) <= tolerance
        if not tied_with_previous:
            current_rank = index + 1
            previous_score = score

        candidates.append(
            ComparisonCandidate(
                label=label,
                location=location,
                period=period,
                rank=current_rank,
                score=score,
                tied=False,  # filled in below, once every rank is known
                contributions=contributions,
                supporting=supporting,
            )
        )

    counts = {candidate.rank: 0 for candidate in candidates}
    for candidate in candidates:
        counts[candidate.rank] += 1

    return tuple(
        candidate.model_copy(update={"tied": counts[candidate.rank] > 1})
        for candidate in candidates
    )


class ComparisonService:
    """Multi-location, day-level, and historical comparison."""

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

    # ---------------------------------------------------------------- locations

    async def compare_locations(
        self,
        locations: tuple[Location, ...],
        *,
        criterion: Criterion,
        days: int | None = None,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> ComparisonResult:
        """Rank two or more locations over a shared window."""
        self._check_count(locations)
        horizon = resolve_horizon(self._provider.capabilities(), self._settings, days)

        retrievals = await asyncio.gather(
            *(
                self._provider.forecast(location, days=horizon, unit_system=unit_system)
                for location in locations
            ),
            return_exceptions=True,
        )

        scored: list[Scored] = []
        excluded: list[ExcludedCandidate] = []
        # The retrievals that survived, in ranking-independent order, so the association measures
        # below work from the same forecasts the scores came from rather than fetching again.
        retained: list[tuple[Location, Forecast]] = []

        for location, retrieval in zip(locations, retrievals, strict=True):
            if isinstance(retrieval, BaseException):
                excluded.append(self._exclusion(location, retrieval))
                continue
            forecast: Forecast = retrieval
            provenance = Provenance(
                location=location,
                period=forecast.period,
                provider=forecast.provider,
                unit_system=unit_system,
                source_data_class=DataClass.FORECAST,
                retrieved_at=forecast.retrieved_at,
            )
            try:
                score, contributions, supporting = score_candidate(
                    label=location.display_name,
                    location=location,
                    period=forecast.period,
                    series=forecast.daily,
                    criterion=criterion,
                    provenance=provenance,
                )
            except WeathraError as failure:
                excluded.append(self._exclusion(location, failure))
                continue
            scored.append(
                (
                    location.display_name,
                    location,
                    forecast.period,
                    score,
                    contributions,
                    supporting,
                )
            )
            retained.append((location, forecast))

        self._require_survivors(scored, excluded)

        association = Provenance(
            location=retained[0][0],
            period=retained[0][1].period,
            provider=retained[0][1].provider,
            unit_system=unit_system,
            source_data_class=DataClass.FORECAST,
            retrieved_at=retained[0][1].retrieved_at,
        )

        return ComparisonResult(
            mode=ComparisonMode.LOCATIONS,
            criterion=criterion,
            data_class=DataClass.FORECAST,
            period=scored[0][2],
            unit_system=unit_system,
            provider=self._provider.capabilities().name,
            statistics_applied=self._statistics_applied(criterion),
            candidates=rank(scored),
            excluded=tuple(excluded),
            tie_tolerance=TIE_TOLERANCE,
            local_time_basis=True,
            weighting_disclosure=WEIGHTING_DISCLOSURE if criterion.is_composite else None,
            correlation=self._correlation(retained, provenance=association),
            data_density=self._data_density(retained, provenance=association),
        )

    # ------------------------------------------------- how the places moved together

    @staticmethod
    def _trajectory(forecast: Forecast) -> tuple[Series, Measure]:
        """The finest series the provider supplied, and the measure that series carries.

        Hourly where there is one — it is the trajectory `04-compare-cities.png` draws, and a
        seven-point daily series is a thin thing to correlate. Daily otherwise, on the daily mean,
        because the two series carry different measures: `temperature` is instantaneous and
        `temperature_mean` is an aggregate, and asking either series for the other's measure
        returns nothing at all.
        """
        hourly = forecast.hourly
        if hourly is not None and hourly.supplies(Measure.TEMPERATURE):
            return hourly, Measure.TEMPERATURE
        return forecast.daily, Measure.TEMPERATURE_MEAN

    def _correlation(
        self,
        retained: Sequence[tuple[Location, Forecast]],
        *,
        provenance: Provenance,
    ) -> StatisticResult | None:
        """Pearson's r between the two compared places, where there are exactly two.

        **None rather than not-computable above two candidates**, and the distinction matters: a
        not-computable result says "this was asked and could not be answered", and a single
        coefficient for three places is not a question with an answer — there are three pairs. The
        screen draws no bar rather than drawing a refusal, and `screens.md` records why.
        """
        if len(retained) != 2:
            return None
        (left_place, left_forecast), (right_place, right_forecast) = retained
        left_series, measure = self._trajectory(left_forecast)
        right_series, right_measure = self._trajectory(right_forecast)
        if right_measure is not measure:
            # One provider gave an hourly series and the other did not. Comparing an instantaneous
            # reading against a daily mean is not a correlation of the same quantity, so both drop
            # to the coarser measure both can supply.
            left_series, measure = left_forecast.daily, Measure.TEMPERATURE_MEAN
            right_series = right_forecast.daily

        return association.correlation(
            left=left_series,
            right=right_series,
            measure=measure,
            left_label=left_place.display_name,
            right_label=right_place.display_name,
            unit=left_series.unit(measure) or "",
            provenance=provenance,
        )

    def _data_density(
        self,
        retained: Sequence[tuple[Location, Forecast]],
        *,
        provenance: Provenance,
    ) -> StatisticResult | None:
        """How much of the window every surviving candidate reported.

        The denominator is the longest series among them: that is the number of slots the provider
        was asked to fill, and measuring against the *shortest* would report a short answer as a
        complete one.
        """
        if not retained:
            return None
        series: list[Series] = []
        measure = Measure.TEMPERATURE_MEAN
        for _, forecast in retained:
            candidate, candidate_measure = self._trajectory(forecast)
            series.append(candidate)
            measure = candidate_measure
        # Mixed resolutions fall back to daily for the same reason the correlation does.
        if len({len(entry) for entry in series}) > 1 and any(
            forecast.hourly is None for _, forecast in retained
        ):
            series = [forecast.daily for _, forecast in retained]
            measure = Measure.TEMPERATURE_MEAN

        return association.data_density(
            series=tuple(series),
            measure=measure,
            labels=tuple(place.display_name for place, _ in retained),
            expected=max(len(entry) for entry in series),
            provenance=provenance,
        )

    # ---------------------------------------------------------------- days

    async def compare_days(
        self,
        location: Location,
        *,
        criterion: Criterion,
        days: int | None = None,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> ComparisonResult:
        """Rank the days within one location's window — "which day is driest"."""
        horizon = resolve_horizon(self._provider.capabilities(), self._settings, days)
        forecast = await self._provider.forecast(location, days=horizon, unit_system=unit_system)

        scored: list[Scored] = []
        excluded: list[ExcludedCandidate] = []

        for entry in forecast.daily.entries:
            day = entry.time_local.date()
            single = Series(
                granularity=forecast.daily.granularity,
                units=forecast.daily.units,
                entries=(entry,),
            )
            period = period_from_local_dates(location, day, day)
            provenance = Provenance(
                location=location,
                period=period,
                provider=forecast.provider,
                unit_system=unit_system,
                source_data_class=DataClass.FORECAST,
                retrieved_at=forecast.retrieved_at,
            )
            try:
                score, contributions, supporting = score_candidate(
                    label=day.isoformat(),
                    location=location,
                    period=period,
                    series=single,
                    criterion=criterion,
                    provenance=provenance,
                )
            except WeathraError as failure:
                excluded.append(
                    ExcludedCandidate(
                        label=day.isoformat(),
                        location=location,
                        reason=failure.message,
                        code=failure.code,
                    )
                )
                continue
            scored.append((day.isoformat(), location, period, score, contributions, supporting))

        self._require_survivors(scored, excluded, what="days")

        return ComparisonResult(
            mode=ComparisonMode.DAYS,
            criterion=criterion,
            data_class=DataClass.FORECAST,
            period=forecast.period,
            unit_system=unit_system,
            provider=forecast.provider,
            statistics_applied=self._statistics_applied(criterion),
            candidates=rank(scored),
            excluded=tuple(excluded),
            tie_tolerance=TIE_TOLERANCE,
            local_time_basis=True,
            weighting_disclosure=WEIGHTING_DISCLOSURE if criterion.is_composite else None,
        )

    # ---------------------------------------------------------------- historical

    async def compare_locations_historically(
        self,
        locations: tuple[Location, ...],
        *,
        criterion: Criterion,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> ComparisonResult:
        """The same ranking, from archive observations rather than a forecast.

        Labelled ``historical_observation``, and never mixed with forecast data: a comparison where
        one candidate came from the archive and another from the forecast would be meaningless, so
        the whole comparison is one class or the other.
        """
        self._check_count(locations)
        for location in locations:
            validate_historical_range(
                self._provider.capabilities(),
                start=start,
                end=end,
                today=today_at(location, self._instant()),
            )

        retrievals = await asyncio.gather(
            *(
                self._provider.history(location, start=start, end=end, unit_system=unit_system)
                for location in locations
            ),
            return_exceptions=True,
        )

        scored: list[Scored] = []
        excluded: list[ExcludedCandidate] = []

        for location, retrieval in zip(locations, retrievals, strict=True):
            if isinstance(retrieval, BaseException):
                excluded.append(self._exclusion(location, retrieval))
                continue
            observations: HistoricalObservations = retrieval
            provenance = Provenance(
                location=location,
                period=observations.covered_period,
                provider=observations.provider,
                unit_system=unit_system,
                source_data_class=DataClass.HISTORICAL_OBSERVATION,
                retrieved_at=observations.retrieved_at,
            )
            try:
                score, contributions, supporting = score_candidate(
                    label=location.display_name,
                    location=location,
                    period=observations.covered_period,
                    series=observations.daily,
                    criterion=criterion,
                    provenance=provenance,
                )
            except WeathraError as failure:
                excluded.append(self._exclusion(location, failure))
                continue
            scored.append(
                (
                    location.display_name,
                    location,
                    observations.covered_period,
                    score,
                    contributions,
                    supporting,
                )
            )

        self._require_survivors(scored, excluded)

        return ComparisonResult(
            mode=ComparisonMode.LOCATIONS,
            criterion=criterion,
            data_class=DataClass.HISTORICAL_OBSERVATION,
            period=scored[0][2],
            unit_system=unit_system,
            provider=self._provider.capabilities().name,
            statistics_applied=self._statistics_applied(criterion),
            candidates=rank(scored),
            excluded=tuple(excluded),
            tie_tolerance=TIE_TOLERANCE,
            local_time_basis=True,
            weighting_disclosure=WEIGHTING_DISCLOSURE if criterion.is_composite else None,
        )

    # ---------------------------------------------------------------- internals

    def _check_count(self, locations: tuple[Location, ...]) -> None:
        if len(locations) < 2:
            raise ValidationFailed(
                f"A location comparison needs at least two locations; {len(locations)} was given. "
                "To compare days at one location, ask for a day-level comparison instead.",
                details={"field": "locations", "given": len(locations), "minimum": 2},
            )
        limit = self._settings.comparison_max_locations
        if len(locations) > limit:
            raise ValidationFailed(
                f"A comparison covers at most {limit} locations; {len(locations)} were given.",
                details={"field": "locations", "given": len(locations), "maximum": limit},
            )

    @staticmethod
    def _exclusion(location: Location, failure: BaseException) -> ExcludedCandidate:
        """A retrieval failure as an excluded candidate, with no raw payload in the reason."""
        if isinstance(failure, WeathraError):
            return ExcludedCandidate(
                label=location.display_name,
                location=location,
                reason=failure.message,
                code=failure.code,
            )
        return ExcludedCandidate(
            label=location.display_name,
            location=location,
            reason="This location's data could not be retrieved.",
            code="internal_error",
        )

    @staticmethod
    def _require_survivors(
        scored: Sequence[Scored], excluded: Sequence[ExcludedCandidate], *, what: str = "locations"
    ) -> None:
        if len(scored) < 2:
            raise ValidationFailed(
                f"Too few {what} could be evaluated: {len(scored)} of "
                f"{len(scored) + len(excluded)} survived retrieval, and a comparison needs at "
                "least two.",
                details={
                    "evaluated": len(scored),
                    "excluded": [
                        {"label": item.label, "code": item.code, "reason": item.reason}
                        for item in excluded
                    ],
                },
            )

    @staticmethod
    def _statistics_applied(criterion: Criterion) -> tuple[str, ...]:
        if criterion.is_composite:
            return tuple(
                f"{measure.value}: "
                + ("total" if measure is Measure.PRECIPITATION_SUM else "mean")
                + f" (weight {weight:g})"
                for measure, weight in COMPOSITE_WEIGHTS.items()
            )
        measure, direction = _CRITERION_MEASURE[criterion]
        statistic = Statistic.TOTAL if measure is Measure.PRECIPITATION_SUM else Statistic.MEAN
        better = "higher is better" if direction is Direction.ABOVE else "lower is better"
        return (f"{measure.value}: {statistic.value} ({better})",)
