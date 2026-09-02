"""Extremes, means, and ranges — for temperature and any other continuous measure.

Extremes carry the timestamp they occurred at, and a tie is *recorded* rather than resolved
silently: two days sharing the week's maximum is a fact about the week, and reporting only the
earlier one without saying so would hide it. The earliest tied timestamp is the one reported,
because "when did it first get that warm" is the question a reader is actually asking
(``specs/deterministic-analytics``).
"""

from __future__ import annotations

import numpy as np

from weathra.analytics.support import (
    UsablePoints,
    not_computable,
    scalar,
    usable_points,
)
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.weather import Measure, Series

__all__ = [
    "describe",
    "excluded_count",
    "maximum",
    "mean",
    "minimum",
    "standard_deviation",
    "value_range",
]


def _extreme(
    series: Series,
    measure: Measure,
    provenance: Provenance,
    *,
    statistic: Statistic,
    want_maximum: bool,
) -> StatisticResult:
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = (
        f"{'maximum' if want_maximum else 'minimum'} of usable {measure.value} points, "
        "ties recorded and the earliest timestamp reported"
    )

    if not points.enough_for(statistic):
        return not_computable(
            statistic, measure, unit=unit, method=method, points=points, provenance=provenance
        )

    array = np.asarray(points.values, dtype=float)
    target = float(array.max() if want_maximum else array.min())
    # np.isclose rather than ==: two floats that print the same should tie rather than
    # arbitrarily pick whichever the hardware rounded lower.
    tied_indices = [
        index for index, value in enumerate(points.values) if np.isclose(value, target, atol=0.0)
    ]
    first = tied_indices[0]

    return scalar(
        statistic,
        measure,
        value=target,
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
        occurred_at=(points.times_utc[first], points.times_local[first]),
        tied_at=[points.times_utc[index] for index in tied_indices],
    )


def minimum(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """The lowest value in the window, with when it occurred."""
    return _extreme(series, measure, provenance, statistic=Statistic.MINIMUM, want_maximum=False)


def maximum(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """The highest value in the window, with when it occurred."""
    return _extreme(series, measure, provenance, statistic=Statistic.MAXIMUM, want_maximum=True)


def mean(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """The arithmetic mean of the usable points. Absent values are excluded, not zeroed."""
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = "arithmetic mean of usable points"

    if not points.enough_for(Statistic.MEAN):
        return not_computable(
            Statistic.MEAN, measure, unit=unit, method=method, points=points, provenance=provenance
        )

    return scalar(
        Statistic.MEAN,
        measure,
        value=float(np.mean(np.asarray(points.values, dtype=float))),
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
    )


def value_range(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """Maximum minus minimum. Needs two points: one point has no range."""
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = "maximum minus minimum over usable points"

    if not points.enough_for(Statistic.RANGE):
        return not_computable(
            Statistic.RANGE,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
        )

    array = np.asarray(points.values, dtype=float)
    return scalar(
        Statistic.RANGE,
        measure,
        value=float(array.max() - array.min()),
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
    )


def standard_deviation(series: Series, measure: Measure, provenance: Provenance) -> StatisticResult:
    """Sample standard deviation, for a baseline's spread.

    Sample (``ddof=1``) rather than population: a baseline is a sample of years, not the whole
    population of them, and using the population form would understate the spread.
    """
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = "sample standard deviation (ddof=1) of usable points"

    if not points.enough_for(Statistic.STANDARD_DEVIATION):
        return not_computable(
            Statistic.STANDARD_DEVIATION,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
        )

    return scalar(
        Statistic.STANDARD_DEVIATION,
        measure,
        value=float(np.std(np.asarray(points.values, dtype=float), ddof=1)),
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
    )


def describe(
    series: Series, measure: Measure, provenance: Provenance
) -> tuple[StatisticResult, ...]:
    """Minimum, maximum, mean, and range together.

    Each is computed independently, so a series long enough for a mean but too short for a range
    reports the range not-computable while still returning the rest.
    """
    return (
        minimum(series, measure, provenance),
        maximum(series, measure, provenance),
        mean(series, measure, provenance),
        value_range(series, measure, provenance),
    )


def excluded_count(series: Series, measure: Measure) -> int:
    """How many entries were left out of every computation for this measure."""
    return UsablePoints(series, measure).excluded
