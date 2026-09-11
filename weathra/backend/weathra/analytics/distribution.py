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

from weathra.analytics.support import MINIMUM_POINTS, not_computable, scalar, usable_points
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.errors import ValidationFailed
from weathra.domain.weather import Measure, Series

__all__ = ["INTERPOLATION_METHOD", "MINIMUM_RANK_YEARS", "percentile", "percentile_rank", "z_score"]

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


# Below this many reference values a rank says less than it appears to. With two years the only
# answers are 0, 50 and 100; with three the resolution is 33 points. Three is the floor because a
# rank over three years is coarse but honest, and the method line states the resolution so nobody
# reads "67th percentile" as a finer measurement than it is.
#
# Read from the declared table rather than written twice: `specs/deterministic-analytics` requires
# every statistic to declare its minimum, and two constants that must agree eventually will not.
MINIMUM_RANK_YEARS = MINIMUM_POINTS[Statistic.PERCENTILE_RANK]


def percentile_rank(
    *,
    measure: Measure,
    unit: str,
    value: float,
    reference_values: tuple[float, ...],
    reference_label: str,
    provenance: Provenance,
) -> StatisticResult:
    """Where ``value`` sits within ``reference_values``, as a percentage of them below it.

    This is the *inverse* of `percentile` above and the two are worth keeping straight: that one
    answers "what temperature is the 90th percentile", this one answers "what percentile is this
    temperature". `03-historical-analytics.png` asks for the second, beside the z-score.

    **The formula, because a rank has several and they disagree.**

        rank = (below + 0.5 * equal) / n * 100

    The mid-rank convention: a value equal to one reference value counts as half below it, which is
    what keeps the rank of the reference set's own median at 50 rather than drifting with ties. The
    alternatives — strictly-below, or below-or-equal — put an identical value at 0 or 100 for the
    same data, which is why the rule is written in the method rather than left to whoever reads the
    number. No interpolation: with a handful of years there is nothing to interpolate between that
    would not be inventing a distribution the archive did not supply.

    **Like is compared with like.** ``reference_values`` are the per-year means of the *same*
    calendar window, not the individual daily observations across it. A window mean has far less
    spread than the days inside it, so ranking a mean against daily values would report almost
    everything as unremarkable — the arithmetic would be right and the statement would be false.

    Fewer than `MINIMUM_RANK_YEARS` references gives a **not computable** result with the reason,
    in the same shape `z_score` uses for a zero-variance baseline.
    """
    count = len(reference_values)
    method = (
        "(years below + half the years equal) / years, as a percentage, against the per-year "
        "means of "
        f"{reference_label}"
        + (
            f"; {count} years, so the finest distinction is {100 / count:.0f} points"
            if count
            else ""
        )
    )
    parameters: dict[str, object] = {
        "value": value,
        "reference_years": count,
        "reference_period": reference_label,
        "measure_unit": unit,
        "convention": "mid-rank; no interpolation",
    }

    if count < MINIMUM_RANK_YEARS:
        return StatisticResult(
            statistic=Statistic.PERCENTILE_RANK,
            measure=measure,
            status="not_computable",
            unit="percentile",
            method=method,
            parameters=parameters,
            points_used=count,
            points_excluded=0,
            minimum_points=MINIMUM_RANK_YEARS,
            reason=(
                f"A percentile rank needs at least {MINIMUM_RANK_YEARS} reference years to say "
                f"anything a difference does not already say; {reference_label} has {count}. "
                "The signed difference and the z-score are still reported."
            ),
            provenance=provenance,
        )

    below = sum(1 for other in reference_values if other < value)
    equal = sum(1 for other in reference_values if other == value)
    rank = (below + 0.5 * equal) / count * 100

    return StatisticResult(
        statistic=Statistic.PERCENTILE_RANK,
        measure=measure,
        status="computed",
        value=float(rank),
        unit="percentile",
        method=method,
        parameters={**parameters, "years_below": below, "years_equal": equal},
        points_used=count,
        points_excluded=0,
        minimum_points=MINIMUM_RANK_YEARS,
        provenance=provenance,
    )
