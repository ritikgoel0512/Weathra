"""Precipitation totals, wet-threshold counts, and probability analysis.

One rule dominates this module: **probability is reported only when the provider supplies a
probability.** It is never inferred from an amount. "It rained 4 mm, so the chance of rain was
high" is a category error — the amount is what happened, the probability was a statement about
what might. ``specs/deterministic-analytics`` requires the unavailable case to be reported with
its reason and no inferred value, which is what ``probability_analysis`` does.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from weathra.analytics.support import UsablePoints, not_computable, scalar, usable_points
from weathra.domain.analytics import PointValue, Provenance, Statistic, StatisticResult
from weathra.domain.weather import Measure, Series

__all__ = [
    "DEFAULT_WET_THRESHOLD_MM",
    "daily_totals",
    "probability_analysis",
    "total",
    "wet_entry_count",
]

# What counts as a wet entry when a caller names no threshold. 0.1 mm is the smallest amount most
# instruments record, so anything at or above it is "it rained" rather than "trace".
DEFAULT_WET_THRESHOLD_MM = 0.1


def total(
    series: Series,
    provenance: Provenance,
    *,
    measure: Measure = Measure.PRECIPITATION_SUM,
) -> StatisticResult:
    """Precipitation summed over the window."""
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = "sum of usable points"

    if not points.enough_for(Statistic.TOTAL):
        return not_computable(
            Statistic.TOTAL,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
        )

    return scalar(
        Statistic.TOTAL,
        measure,
        value=float(np.sum(np.asarray(points.values, dtype=float))),
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
    )


def daily_totals(
    series: Series,
    provenance: Provenance,
    *,
    measure: Measure = Measure.PRECIPITATION,
) -> StatisticResult:
    """Precipitation summed per local calendar day.

    Grouped by the *local* date of each entry, so "Tuesday's rain" means Tuesday there. An hourly
    series therefore collapses into one value per day; a daily series passes through unchanged.
    """
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = "sum of usable points grouped by local calendar day"

    if not points.enough_for(Statistic.DAILY_TOTALS):
        return not_computable(
            Statistic.DAILY_TOTALS,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
        )

    buckets: dict[object, list[float]] = {}
    first_moment: dict[object, tuple[object, object]] = {}
    for index, value in enumerate(points.values):
        local = points.times_local[index]
        day = local.date()
        buckets.setdefault(day, []).append(value)
        first_moment.setdefault(day, (points.times_utc[index], local))

    values = tuple(
        PointValue(
            time_utc=first_moment[day][0],
            time_local=first_moment[day][1],
            value=float(sum(amounts)),
        )
        for day, amounts in buckets.items()
    )

    return StatisticResult(
        statistic=Statistic.DAILY_TOTALS,
        measure=measure,
        status="computed",
        values=values,
        unit=unit,
        method=method,
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=1,
        provenance=provenance,
    )


def wet_entry_count(
    series: Series,
    provenance: Provenance,
    *,
    threshold: float = DEFAULT_WET_THRESHOLD_MM,
    measure: Measure = Measure.PRECIPITATION_SUM,
) -> StatisticResult:
    """How many entries recorded at least ``threshold`` precipitation.

    A count, so it is exact rather than tolerant: the evaluation suite compares counts for
    equality, which is only meaningful if the boundary is defined. At or above the threshold
    counts.
    """
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = f"count of usable points at or above {threshold:g}"

    if not points.enough_for(Statistic.WET_ENTRY_COUNT):
        return not_computable(
            Statistic.WET_ENTRY_COUNT,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
            parameters={"threshold": threshold},
        )

    count = int(np.count_nonzero(np.asarray(points.values, dtype=float) >= threshold))
    return scalar(
        Statistic.WET_ENTRY_COUNT,
        measure,
        value=float(count),
        # A count is dimensionless whatever the measure's own unit is.
        unit="entries",
        method=method,
        points=points,
        provenance=provenance,
        parameters={"threshold": threshold, "threshold_unit": series.unit(measure)},
    )


def probability_analysis(
    series: Series,
    provenance: Provenance,
    *,
    level: float | None = None,
    measure: Measure = Measure.PRECIPITATION_PROBABILITY,
) -> tuple[StatisticResult, ...]:
    """Maximum, mean, and (optionally) exceedance of provider-supplied precipitation probability.

    When the provider supplies no probability — the archive never does — every result comes back
    not-computable with the reason, and **no value is inferred from precipitation amount**.
    """
    points = usable_points(series, measure)
    unit = series.unit(measure) or "%"

    unavailable_reason = None
    if measure not in series.units:
        unavailable_reason = (
            f"This provider supplies no {measure.value} for this series, so probability analysis "
            "is unavailable. No probability is inferred from precipitation amount."
        )
    elif len(points) == 0:
        unavailable_reason = (
            f"{measure.value} is declared but absent for all {points.total_entries} entries, so "
            "probability analysis is unavailable. No probability is inferred from precipitation "
            "amount."
        )

    results: list[StatisticResult] = []
    array = np.asarray(points.values, dtype=float) if points else np.asarray([], dtype=float)

    for statistic, method, compute in (
        (
            Statistic.PROBABILITY_MAXIMUM,
            "maximum of provider-supplied probability",
            lambda: float(array.max()),
        ),
        (
            Statistic.PROBABILITY_MEAN,
            "arithmetic mean of provider-supplied probability",
            lambda: float(array.mean()),
        ),
    ):
        if unavailable_reason or not points.enough_for(statistic):
            results.append(
                not_computable(
                    statistic,
                    measure,
                    unit=unit,
                    method=method,
                    points=points,
                    provenance=provenance,
                    reason=unavailable_reason,
                )
            )
        else:
            results.append(
                scalar(
                    statistic,
                    measure,
                    value=compute(),
                    unit=unit,
                    method=method,
                    points=points,
                    provenance=provenance,
                )
            )

    if level is not None:
        results.append(
            _exceedance(
                series,
                points,
                provenance,
                level=level,
                measure=measure,
                unit=unit,
                unavailable_reason=unavailable_reason,
            )
        )

    return tuple(results)


def _exceedance(
    series: Series,
    points: UsablePoints,
    provenance: Provenance,
    *,
    level: float,
    measure: Measure,
    unit: str,
    unavailable_reason: str | None,
) -> StatisticResult:
    """The entries whose probability reached ``level``, as a series-shaped result."""
    method = f"entries with provider-supplied probability at or above {level:g}"

    if unavailable_reason or not points.enough_for(Statistic.PROBABILITY_EXCEEDANCE):
        return not_computable(
            Statistic.PROBABILITY_EXCEEDANCE,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
            reason=unavailable_reason,
            parameters={"level": level},
        )

    values: Sequence[PointValue] = tuple(
        PointValue(
            time_utc=points.times_utc[index],
            time_local=points.times_local[index],
            value=value,
        )
        for index, value in enumerate(points.values)
        if value >= level
    )

    return StatisticResult(
        statistic=Statistic.PROBABILITY_EXCEEDANCE,
        measure=measure,
        status="computed",
        # The count is the scalar a reader wants; the entries themselves are alongside it.
        value=float(len(values)),
        values=tuple(values),
        unit="entries",
        method=method,
        parameters={"level": level, "level_unit": unit},
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=1,
        provenance=provenance,
    )
