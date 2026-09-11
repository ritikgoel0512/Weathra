"""Shared machinery for the analytics engine.

Every function in this package obeys the same rules, and they are worth stating once here because
``specs/deterministic-analytics`` makes them testable requirements rather than good manners:

* **Pure.** Same arguments, same result, byte for byte. No I/O, no database, no language model.
* **No clock.** The window and the units are arguments. A function that read the clock would be
  untestable and would quietly change its answer overnight.
* **Absent values are excluded and counted.** Never coerced to zero. ``points_excluded`` is part
  of every result, so "the mean of 5 of 7 days" is visible rather than implied.
* **Minimums are declared.** Each statistic states how many usable points it needs. Too few is a
  *reported* outcome carrying the counts, not an exception — so a series with seven temperature
  points and two precipitation points computes the former and explains the latter.

Only an entirely unusable series raises, and only ``AnalyticsNotPossible``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.errors import AnalyticsNotPossible
from weathra.domain.weather import Measure, Series

__all__ = [
    "INSIGNIFICANCE_MARGINS",
    "MINIMUM_POINTS",
    "UsablePoints",
    "insignificance_margin_for",
    "not_computable",
    "require_measure",
    "require_usable",
    "scalar",
    "usable_points",
]

# The declared minimum number of usable points per statistic (``specs/deterministic-analytics``).
# A single point is enough for an extreme or a total; dispersion and trend need more.
MINIMUM_POINTS: dict[Statistic, int] = {
    Statistic.MINIMUM: 1,
    Statistic.MAXIMUM: 1,
    Statistic.MEAN: 1,
    Statistic.RANGE: 2,
    Statistic.TOTAL: 1,
    Statistic.DAILY_TOTALS: 1,
    Statistic.WET_ENTRY_COUNT: 1,
    Statistic.PROBABILITY_MAXIMUM: 1,
    Statistic.PROBABILITY_MEAN: 1,
    Statistic.PROBABILITY_EXCEEDANCE: 1,
    Statistic.MEAN_SPEED: 1,
    Statistic.MAXIMUM_SUSTAINED_SPEED: 1,
    Statistic.MAXIMUM_GUST: 1,
    Statistic.PREVAILING_DIRECTION: 1,
    Statistic.ROLLING_MEAN: 2,
    Statistic.PERCENTILE: 2,
    # A rank needs reference *years*, not points: over two the only answers are 0, 50 and
    # 100, which is a verdict rather than a position. `distribution.MINIMUM_RANK_YEARS`
    # holds the same three and is what the function checks; this entry is what declares it.
    Statistic.PERCENTILE_RANK: 3,
    Statistic.DELTA: 1,
    Statistic.Z_SCORE: 1,
    Statistic.STANDARD_DEVIATION: 2,
    # Median absolute deviation over fewer than three points is not a dispersion estimate.
    Statistic.ANOMALIES: 3,
    # A slope through two points is a line, not a trend.
    Statistic.TREND: 3,
    Statistic.BASELINE: 1,
}


# Per-measure materiality: a change smaller than this, in the measure's own unit, is noise rather
# than a finding. Temperature and precipitation are design.md decision 9's figures; the rest follow
# the same reasoning — roughly the smallest change a person would notice or act on.
#
# Two things read this. `trend` treats it as a per-day slope floor, and `anomaly` treats it as an
# absolute deviation floor: a tightly clustered week has a tiny median absolute deviation, so
# ordinary variation would otherwise score above the MAD threshold and be reported as an anomaly.
INSIGNIFICANCE_MARGINS: dict[str, float] = {
    "temperature": 0.5,
    "precipitation": 0.5,
    "ratio": 1.0,
    "speed": 1.0,
    "pressure": 0.5,
    "index": 0.2,
    "direction": 5.0,
    "duration": 0.5,
}

_DEFAULT_MARGIN = 0.5


def insignificance_margin_for(measure: Measure) -> float:
    """The margin below which this measure's movement is noise."""
    from weathra.domain.weather import _DIMENSION

    return INSIGNIFICANCE_MARGINS.get(_DIMENSION.get(measure) or "", _DEFAULT_MARGIN)


class UsablePoints:
    """The subset of a series that actually carries a value for one measure.

    Holding the timestamps alongside the values is what lets an extreme report *when* it happened
    without re-walking the series, and what keeps the excluded count honest.
    """

    __slots__ = ("_entries", "excluded", "measure", "times_local", "times_utc", "values")

    def __init__(self, series: Series, measure: Measure) -> None:
        self.measure = measure
        values: list[float] = []
        times_utc: list[Any] = []
        times_local: list[Any] = []
        excluded = 0

        for entry in series.entries:
            value = entry.value(measure)
            if value is None:
                excluded += 1
                continue
            values.append(value)
            times_utc.append(entry.time_utc)
            times_local.append(entry.time_local)

        self.values: tuple[float, ...] = tuple(values)
        self.times_utc: tuple[Any, ...] = tuple(times_utc)
        self.times_local: tuple[Any, ...] = tuple(times_local)
        self.excluded = excluded
        self._entries = len(series.entries)

    def __len__(self) -> int:
        return len(self.values)

    def __bool__(self) -> bool:
        return bool(self.values)

    @property
    def total_entries(self) -> int:
        return self._entries

    def enough_for(self, statistic: Statistic) -> bool:
        return len(self.values) >= MINIMUM_POINTS[statistic]


def usable_points(series: Series, measure: Measure) -> UsablePoints:
    return UsablePoints(series, measure)


def require_usable(series: Series, *, what: str = "this series") -> None:
    """Raise when there is nothing at all to analyse.

    The one case that is an error rather than a reported outcome: an empty series, or one whose
    every value is absent for every measure.
    """
    if len(series) == 0:
        raise AnalyticsNotPossible(
            f"There is no data to analyse: {what} is empty.",
            details={"entries": 0},
        )
    if not any(measure for measure in series.measures if series.supplies(measure)):
        raise AnalyticsNotPossible(
            f"There is no data to analyse: {what} carries {len(series)} entries but no usable "
            "value for any measure.",
            details={"entries": len(series), "usable": 0},
        )


def require_measure(series: Series, measure: Measure) -> None:
    """Raise when a measure was never asked for at all.

    Distinct from "asked for and not supplied", which is a *reported* not-computable outcome. A
    threshold on a measure the series does not carry is a caller error and names the measure
    (``specs/forecast-analysis``).
    """
    if measure not in series.units:
        from weathra.domain.errors import UnsupportedMeasure

        raise UnsupportedMeasure(
            f"This series does not carry {measure.value}; it carries "
            f"{', '.join(sorted(item.value for item in series.measures))}.",
            details={
                "field": "measure",
                "requested": measure.value,
                "available": sorted(item.value for item in series.measures),
            },
        )


def scalar(
    statistic: Statistic,
    measure: Measure,
    *,
    value: float,
    unit: str,
    method: str,
    points: UsablePoints,
    provenance: Provenance,
    occurred_at: Sequence[Any] | None = None,
    tied_at: Sequence[Any] = (),
    parameters: dict[str, Any] | None = None,
) -> StatisticResult:
    """A computed scalar result, with the counts and provenance filled in consistently."""
    utc = occurred_at[0] if occurred_at else None
    local = occurred_at[1] if occurred_at else None
    return StatisticResult(
        statistic=statistic,
        measure=measure,
        status="computed",
        value=value,
        unit=unit,
        occurred_at_utc=utc,
        occurred_at_local=local,
        tied=len(tied_at) > 1,
        tied_at=tuple(tied_at) if len(tied_at) > 1 else (),
        method=method,
        parameters=parameters or {},
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=MINIMUM_POINTS[statistic],
        provenance=provenance,
    )


def not_computable(
    statistic: Statistic,
    measure: Measure,
    *,
    unit: str,
    method: str,
    points: UsablePoints,
    provenance: Provenance,
    reason: str | None = None,
    parameters: dict[str, Any] | None = None,
) -> StatisticResult:
    """A not-computable result stating the reason and both counts.

    The default reason names the required and available counts, which is what
    ``specs/deterministic-analytics`` asks a partial analysis to report.
    """
    required = MINIMUM_POINTS[statistic]
    if reason is None:
        if points.total_entries == 0:
            reason = f"{statistic.value} needs {required} usable point(s); the series is empty."
        elif len(points) == 0:
            reason = (
                f"{measure.value} is not supplied for this series, so {statistic.value} cannot "
                f"be computed. All {points.total_entries} entries are absent."
            )
        else:
            reason = (
                f"{statistic.value} needs at least {required} usable {measure.value} point(s); "
                f"{len(points)} of {points.total_entries} entries carry one."
            )

    return StatisticResult(
        statistic=statistic,
        measure=measure,
        status="not_computable",
        value=None,
        unit=unit,
        method=method,
        parameters=parameters or {},
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=required,
        reason=reason,
        provenance=provenance,
    )
