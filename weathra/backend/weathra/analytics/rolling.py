"""Rolling averages and period-over-period deltas.

Both state their method and window length in the result, because "the 3-day rolling mean" is
ambiguous until you know whether a value is labelled with the first, middle, or last day of its
window. Weathra labels each rolling value with the **last** day of the window it covers, which is
the only choice that never uses data from after the label — the reading a person expects from
"the 3-day average as of Thursday".

A window longer than the series is an error naming both lengths, not a shorter window silently
substituted (``specs/deterministic-analytics``).
"""

from __future__ import annotations

import numpy as np

from weathra.analytics.support import not_computable, usable_points
from weathra.domain.analytics import PointValue, Provenance, Statistic, StatisticResult
from weathra.domain.errors import ValidationFailed
from weathra.domain.weather import Measure, Series

__all__ = ["delta", "percentage_change", "rolling_mean"]


def rolling_mean(
    series: Series,
    measure: Measure,
    provenance: Provenance,
    *,
    window: int,
) -> StatisticResult:
    """The rolling mean over ``window`` consecutive usable points.

    Raises when the window exceeds the usable series length, stating both numbers.
    """
    if window < 1:
        raise ValidationFailed(
            f"A rolling window must be at least 1 point; {window} was requested.",
            details={"field": "window", "requested": window, "minimum": 1},
        )

    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = (
        f"arithmetic mean over a trailing {window}-point window, each value labelled with the "
        "last point it covers"
    )

    if len(points) < window:
        raise ValidationFailed(
            f"A {window}-point rolling window does not fit a series with {len(points)} usable "
            f"{measure.value} point(s).",
            details={
                "field": "window",
                "requested_window": window,
                "available_points": len(points),
                "total_entries": points.total_entries,
            },
        )

    if not points.enough_for(Statistic.ROLLING_MEAN):
        return not_computable(
            Statistic.ROLLING_MEAN,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
            parameters={"window": window},
        )

    array = np.asarray(points.values, dtype=float)
    # A uniform-weight convolution is the rolling mean; `valid` drops the partial windows at the
    # start rather than reporting an average over fewer points than the label claims.
    means = np.convolve(array, np.ones(window) / window, mode="valid")

    values = tuple(
        PointValue(
            time_utc=points.times_utc[index + window - 1],
            time_local=points.times_local[index + window - 1],
            value=float(value),
        )
        for index, value in enumerate(means)
    )

    return StatisticResult(
        statistic=Statistic.ROLLING_MEAN,
        measure=measure,
        status="computed",
        values=values,
        unit=unit,
        method=method,
        parameters={"window": window},
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=window,
        provenance=provenance,
    )


def delta(
    *,
    measure: Measure,
    unit: str,
    earlier: float,
    later: float,
    earlier_label: str,
    later_label: str,
    provenance: Provenance,
) -> StatisticResult:
    """The signed difference between two aggregates, carrying both inputs.

    ``later - earlier``, so a positive delta always means "went up". Both inputs are reported in
    ``parameters`` because a difference without its operands cannot be checked.
    """
    return StatisticResult(
        statistic=Statistic.DELTA,
        measure=measure,
        status="computed",
        value=float(later - earlier),
        unit=unit,
        method="later aggregate minus earlier aggregate",
        parameters={
            "earlier": earlier,
            "later": later,
            "earlier_label": earlier_label,
            "later_label": later_label,
        },
        points_used=2,
        points_excluded=0,
        minimum_points=1,
        provenance=provenance,
    )


def percentage_change(earlier: float, later: float) -> float | None:
    """The percentage change, or ``None`` when the base is zero.

    A percentage change from zero is undefined, not infinite: "precipitation rose from 0 mm to
    4 mm" is a real statement, but "it rose by ∞%" is not one worth printing.
    """
    if earlier == 0:
        return None
    return (later - earlier) / abs(earlier) * 100.0
