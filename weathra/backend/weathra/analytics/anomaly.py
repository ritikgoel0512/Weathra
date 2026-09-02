"""Anomaly detection by median absolute deviation (design.md decision 9).

**Why not standard deviation.** A seven-point window containing one extreme has its own SD
inflated by that extreme, so the outlier's own z-score comes out modest and the point the spec
most wants surfaced is the one the method hides. The median absolute deviation is not moved by a
single point, so the extreme stands out against the rest of the window rather than against a
window that includes it.

**The threshold is 2.0 MAD**, scaled by 1.4826 so it reads on the same scale as a standard
deviation for normally-distributed data — which is what makes "2.0" a familiar number rather than
an arbitrary one.

**Two conditions, not one.** A point is anomalous when it is *both* beyond the MAD threshold and
materially different in absolute terms. The second condition is what makes "no anomalies" a real
answer: a week of 11.0-11.4 °C has a median absolute deviation of 0.1 °C, so the 11.4 °C day scores
2.02 MADs and pure MAD would report it as an anomaly — a third of a degree presented as a finding.
The materiality floor is the same per-measure margin the trend classifier uses, so "not worth
mentioning" means one thing across the engine.

**Extremes are always reported**, anomalies or not. A window with nothing standing out is a real
answer, and the reader still wants to know the week's high and low. A flat window — zero MAD — has
no dispersion to judge against, so it reports extremes only and says so.
"""

from __future__ import annotations

import numpy as np

from weathra.analytics.descriptive import maximum, minimum
from weathra.analytics.support import (
    MINIMUM_POINTS,
    insignificance_margin_for,
    usable_points,
)
from weathra.domain.analytics import AnomalyPoint, AnomalyReport, Provenance, Statistic
from weathra.domain.weather import Measure, Series

__all__ = ["DEFAULT_THRESHOLD", "MAD_SCALE", "detect_anomalies"]

# Deviations beyond this many scaled MADs are anomalous.
DEFAULT_THRESHOLD = 2.0

# Converts MAD to a standard-deviation-comparable scale for normally-distributed data.
MAD_SCALE = 1.4826


def detect_anomalies(
    series: Series,
    measure: Measure,
    provenance: Provenance,
    *,
    threshold: float = DEFAULT_THRESHOLD,
) -> AnomalyReport:
    """What stands out in the window, with the method and threshold stated."""
    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    floor = insignificance_margin_for(measure)
    method = (
        f"median absolute deviation, scaled by {MAD_SCALE}, threshold {threshold:g} MAD and a "
        f"materiality floor of {floor:g} {unit}; window extremes always reported"
    )

    low = minimum(series, measure, provenance)
    high = maximum(series, measure, provenance)

    if not points.enough_for(Statistic.ANOMALIES):
        return AnomalyReport(
            measure=measure,
            anomalies=(),
            minimum=low,
            maximum=high,
            method=method,
            threshold=threshold,
            median=float(np.median(np.asarray(points.values, dtype=float))) if points else 0.0,
            median_absolute_deviation=0.0,
            unit=unit,
            points_used=len(points),
            points_excluded=points.excluded,
            note=(
                f"Anomaly detection needs at least {MINIMUM_POINTS[Statistic.ANOMALIES]} usable "
                f"{measure.value} points; {len(points)} of {points.total_entries} entries carry "
                "one. The window extremes are reported."
            ),
            provenance=provenance,
        )

    array = np.asarray(points.values, dtype=float)
    median = float(np.median(array))
    deviations = np.abs(array - median)
    mad = float(np.median(deviations))

    if np.isclose(mad, 0.0):
        return AnomalyReport(
            measure=measure,
            anomalies=(),
            minimum=low,
            maximum=high,
            method=method,
            threshold=threshold,
            median=median,
            median_absolute_deviation=0.0,
            unit=unit,
            points_used=len(points),
            points_excluded=points.excluded,
            note=(
                "Every value in this window sits at the median, so there is no dispersion to "
                "judge an anomaly against. The window extremes are reported."
            ),
            provenance=provenance,
        )

    scaled = mad * MAD_SCALE
    anomalies = tuple(
        AnomalyPoint(
            time_utc=points.times_utc[index],
            time_local=points.times_local[index],
            value=float(value),
            deviation=float(value - median),
            deviation_score=float(abs(value - median) / scaled),
        )
        for index, value in enumerate(points.values)
        if abs(value - median) / scaled >= threshold and abs(value - median) >= floor
    )

    return AnomalyReport(
        measure=measure,
        anomalies=anomalies,
        minimum=low,
        maximum=high,
        method=method,
        threshold=threshold,
        median=median,
        median_absolute_deviation=mad,
        unit=unit,
        points_used=len(points),
        points_excluded=points.excluded,
        provenance=provenance,
    )
