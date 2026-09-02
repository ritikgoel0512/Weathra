"""Percentiles and z-scores.

Both name their method in the result, and for the same reason: a percentile depends on the
interpolation rule, and a z-score depends on which reference it was computed against. Leaving
either implicit makes the number uncheckable, which is exactly what
``specs/deterministic-analytics`` forbids.

The interpolation method is numpy's default, **linear**, and it is stated rather than assumed —
different packages default differently, and "the 90th percentile" can legitimately differ by a
degree between two of them.
"""

from __future__ import annotations

from typing import Literal

import numpy as np

from weathra.analytics.support import not_computable, scalar, usable_points
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.errors import ValidationFailed
from weathra.domain.weather import Measure, Series

__all__ = ["INTERPOLATION_METHOD", "percentile", "z_score"]

# numpy's default. Named in every result rather than left to the reader to guess. Typed as a
# Literal so a typo becomes a type error rather than a runtime one.
INTERPOLATION_METHOD: Literal["linear"] = "linear"


def percentile(
    series: Series,
    measure: Measure,
    provenance: Provenance,
    *,
    level: float,
) -> StatisticResult:
    """The ``level``-th percentile of a measure, naming its interpolation method."""
    if not 0.0 <= level <= 100.0:
        raise ValidationFailed(
            f"A percentile must be between 0 and 100; {level} was requested.",
            details={"field": "level", "requested": level, "minimum": 0, "maximum": 100},
        )

    points = usable_points(series, measure)
    unit = series.unit(measure) or ""
    method = f"{level:g}th percentile, {INTERPOLATION_METHOD} interpolation (numpy default)"

    if not points.enough_for(Statistic.PERCENTILE):
        return not_computable(
            Statistic.PERCENTILE,
            measure,
            unit=unit,
            method=method,
            points=points,
            provenance=provenance,
            parameters={"level": level, "interpolation": INTERPOLATION_METHOD},
        )

    value = float(
        np.percentile(np.asarray(points.values, dtype=float), level, method=INTERPOLATION_METHOD)
    )
    return scalar(
        Statistic.PERCENTILE,
        measure,
        value=value,
        unit=unit,
        method=method,
        points=points,
        provenance=provenance,
        parameters={"level": level, "interpolation": INTERPOLATION_METHOD},
    )


def z_score(
    *,
    measure: Measure,
    unit: str,
    value: float,
    reference_mean: float,
    reference_standard_deviation: float,
    reference_label: str,
    provenance: Provenance,
    reference_years: int | None = None,
) -> StatisticResult:
    """How unusual a value is against an explicitly supplied reference.

    A zero-variance reference gives an **undefined** z-score with the reason, not a division by
    zero and not a very large number. That case is real: a baseline built from one year has no
    spread, and reporting "infinitely unusual" would be worse than reporting nothing.
    """
    method = f"(value - reference mean) / reference standard deviation, against {reference_label}"
    parameters: dict[str, object] = {
        "value": value,
        "reference_mean": reference_mean,
        "reference_standard_deviation": reference_standard_deviation,
        "reference_period": reference_label,
    }
    if reference_years is not None:
        parameters["reference_years"] = reference_years

    if reference_standard_deviation == 0:
        return StatisticResult(
            statistic=Statistic.Z_SCORE,
            measure=measure,
            status="not_computable",
            unit="standard deviations",
            method=method,
            parameters=parameters,
            points_used=1,
            points_excluded=0,
            minimum_points=1,
            reason=(
                f"The z-score is undefined: {reference_label} has a standard deviation of zero, "
                "so there is no spread to measure this value against. The signed difference is "
                "still reported."
            ),
            provenance=provenance,
        )

    return StatisticResult(
        statistic=Statistic.Z_SCORE,
        measure=measure,
        status="computed",
        value=float((value - reference_mean) / reference_standard_deviation),
        unit="standard deviations",
        method=method,
        parameters={**parameters, "measure_unit": unit},
        points_used=1,
        points_excluded=0,
        minimum_points=1,
        provenance=provenance,
    )
