"""Trend: which way a measure moved across a window.

**A deliberate refinement of design.md decision 9, for the reason the decision itself gives.** The
design chose a least-squares slope over first-versus-last so that "a single end spike does not read
as a trend". Least-squares does not deliver that. A week of 11 °C with one 24 °C day on the end
fits a slope of 1.4 °C/day — comfortably past any sane insignificance margin — so the flat week
would be reported as strongly warming, which is exactly the outcome
``specs/deterministic-analytics`` forbids ("A single spike at either end of the window SHALL NOT by
itself produce a trend").

So the slope is the **Theil-Sen estimator**: the median of the slopes of every pair of points. It
is the standard robust trend estimator in climatology for this exact reason. On the spike week, 15
of 21 pairwise slopes are zero and the median is zero — steady. On a genuinely warming week every
pairwise slope is 2 °C/day and the median is 2 — rising. Same intent as the design, a method that
actually holds it.

**Steady is a real answer.** Each measure has a materiality margin (``analytics/support.py``); a
slope smaller than that is steady rather than a very slight trend, because "0.02 °C per day warmer"
is noise dressed as a finding.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np

from weathra.analytics.support import (
    INSIGNIFICANCE_MARGINS,
    MINIMUM_POINTS,
    insignificance_margin_for,
    usable_points,
)
from weathra.domain.analytics import Provenance, Statistic, TrendDirection, TrendReport
from weathra.domain.errors import AnalyticsNotPossible
from weathra.domain.weather import Measure, Series

__all__ = [
    "INSIGNIFICANCE_MARGINS",
    "analyse_trend",
    "insignificance_margin_for",
    "theil_sen_slope",
]


def theil_sen_slope(days: np.ndarray, values: np.ndarray) -> float:
    """The median of the slopes between every pair of points.

    Robust to a minority of outliers by construction: moving one point out of seven changes six of
    twenty-one pairwise slopes, and the median of the rest is unmoved. Pairs sharing an x value
    are skipped — they have no slope.
    """
    slopes = [
        (values[second] - values[first]) / (days[second] - days[first])
        for first, second in combinations(range(len(days)), 2)
        if days[second] != days[first]
    ]
    if not slopes:
        return 0.0
    return float(np.median(np.asarray(slopes, dtype=float)))


def analyse_trend(
    series: Series,
    measure: Measure,
    provenance: Provenance,
    *,
    margin: float | None = None,
) -> TrendReport:
    """The direction, magnitude, and method of a measure's movement across the window."""
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    resolved_margin = margin if margin is not None else insignificance_margin_for(measure)
    method = (
        "Theil-Sen slope (median of pairwise slopes) per day, classified against a "
        f"{resolved_margin:g} {unit}/day materiality margin"
    )

    required = MINIMUM_POINTS[Statistic.TREND]
    if len(points) < required:
        raise AnalyticsNotPossible(
            f"A trend needs at least {required} usable {measure.value} points; "
            f"{len(points)} of {points.total_entries} entries carry one.",
            details={
                "measure": measure.value,
                "required": required,
                "available": len(points),
            },
        )

    # Elapsed days from the first usable point, so the slope is per day whatever the granularity
    # and whatever the local clocks did in between.
    first = points.times_utc[0]
    days = np.asarray(
        [(moment - first).total_seconds() / 86_400.0 for moment in points.times_utc], dtype=float
    )
    values = np.asarray(points.values, dtype=float)

    slope = theil_sen_slope(days, values)
    span_days = float(days[-1] - days[0])

    if abs(slope) < resolved_margin:
        direction = TrendDirection.STEADY
    elif slope > 0:
        direction = TrendDirection.RISING
    else:
        direction = TrendDirection.FALLING

    return TrendReport(
        measure=measure,
        direction=direction,
        slope_per_day=slope,
        magnitude=abs(slope) * span_days,
        unit=unit,
        insignificance_margin_per_day=resolved_margin,
        method=method,
        points_used=len(points),
        points_excluded=points.excluded,
        minimum_points=required,
        provenance=provenance,
    )
