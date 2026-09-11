"""How two series move together, and how much of a window was actually observed.

Both of these exist for `04-compare-cities.png`, whose "Synthesis confidence" panel draws a
**correlation score** and a **data density** bar. The artifact frames them as properties of a
model's synthesis; they are properties of the *data*, so they are computed here, deterministically,
and the screen labels them as what they are.

**Alignment is by instant, not by index.** Two candidates' series are the same length in the
ordinary case, and assuming that is how a correlation quietly becomes nonsense the first time one
provider returns a shorter window than the other. Every pairing below is made on `time_utc`, so a
point only enters the arithmetic when both sides reported *the same moment*. A place whose window
is offset by an hour correlates against nothing rather than against its neighbour's next reading.

**Neither number is a confidence.** A high correlation between two cities' temperatures says the
two moved together; it says nothing about whether either forecast is right. A full data density
says the provider answered for every slot it was asked about; it says nothing about accuracy. The
method strings say so, because a bar labelled "confidence" next to a weather figure is exactly the
kind of borrowed authority `specs/safety-grounding` forbids.
"""

from __future__ import annotations

import math
from typing import Any

from weathra.analytics.support import MINIMUM_POINTS, usable_points
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.weather import Measure, Series

__all__ = ["AlignedPair", "align", "correlation", "data_density"]


class AlignedPair:
    """The points two series both reported, at the same instants.

    Carries the counts the caller needs to be honest about what was dropped: how many instants each
    side offered, how many matched, and how many matched but carried a null on one side.
    """

    __slots__ = ("common_instants", "excluded", "left", "left_offered", "right", "right_offered")

    def __init__(self, left: Series, right: Series, measure: Measure) -> None:
        first = usable_points(left, measure)
        second = usable_points(right, measure)

        # Keyed on the UTC instant. A provider that reports the same instant twice is not a case
        # this needs to handle carefully — the later value wins and the count reflects the keys.
        left_by_instant: dict[Any, float] = dict(zip(first.times_utc, first.values, strict=True))
        right_by_instant: dict[Any, float] = dict(zip(second.times_utc, second.values, strict=True))

        shared = sorted(set(left_by_instant) & set(right_by_instant), key=str)
        self.left: tuple[float, ...] = tuple(left_by_instant[key] for key in shared)
        self.right: tuple[float, ...] = tuple(right_by_instant[key] for key in shared)

        # What each side *offered*, usable or not: the denominator a density is honest against.
        self.left_offered = len(left)
        self.right_offered = len(right)
        # Instants present on both sides at all, before nulls are considered.
        both = {entry.time_utc for entry in left.entries} & {
            entry.time_utc for entry in right.entries
        }
        self.common_instants = len(both)
        self.excluded = self.common_instants - len(shared)

    def __len__(self) -> int:
        return len(self.left)


def align(left: Series, right: Series, measure: Measure) -> AlignedPair:
    """The instants both series carry a value for. See `AlignedPair`."""
    return AlignedPair(left, right, measure)


def correlation(
    *,
    left: Series,
    right: Series,
    measure: Measure,
    left_label: str,
    right_label: str,
    unit: str,
    provenance: Provenance,
) -> StatisticResult:
    """Pearson's *r* between two places' trajectories for one measure.

    **The formula.**

        r = Σ((xᵢ - x̄)(yᵢ - ȳ)) / sqrt(Σ(xᵢ - x̄)² · Σ(yᵢ - ȳ)²)

    over the instants both series reported. Pearson rather than a rank correlation because the
    question the screen asks is whether the two places' temperatures *rose and fell together by
    comparable amounts*, which is a linear-association question; Spearman would answer a different
    one (whether their orderings agree) and would be the right choice if either series were
    ordinal, which neither is.

    `r` is in [-1, 1] and is returned unchanged as the value, with the unit
    `"correlation coefficient"` rather than the measure's own — it is dimensionless, and giving it
    °C would invite somebody to read it as a temperature. The percentage the artifact draws is a
    *presentation* of |r| and belongs to the caller, which is why it is not returned here.

    **Four edge cases, each a reported outcome rather than an exception:**

    * **Too few aligned points.** Under `MINIMUM_POINTS[Statistic.CORRELATION]` the coefficient is
      not computable. Two points always correlate perfectly — `r` is exactly ±1 through any two
      points — so a two-point "96%" would be an artefact of the arithmetic, not a finding.
    * **Zero variance on either side.** A flat series has no deviation to covary with, so `r` is
      undefined rather than zero: the denominator is zero. Reported not computable with the side
      that was flat named, in the same shape `z_score` uses for a spreadless baseline.
    * **Missing values.** Dropped pairwise — an instant is used only when *both* sides carry a
      value — and the count of matched-but-null instants is reported as `points_excluded`.
    * **Misaligned periods.** Handled by construction: alignment is on the instant, so a
      non-overlapping window yields zero aligned points and falls into the first case, with the
      instants each side offered stated in the parameters so the reason is visible.
    """
    pair = align(left, right, measure)
    method = (
        "Pearson correlation of the two places' values at the instants both reported, "
        f"paired on UTC time: r = sum((x-mean(x))*(y-mean(y))) / sqrt(sum((x-mean(x))^2) * "
        f"sum((y-mean(y))^2)), between {left_label} and {right_label}"
    )
    parameters: dict[str, Any] = {
        "left": left_label,
        "right": right_label,
        "measure_unit": unit,
        "aligned_points": len(pair),
        "common_instants": pair.common_instants,
        "left_offered": pair.left_offered,
        "right_offered": pair.right_offered,
    }
    minimum = MINIMUM_POINTS[Statistic.CORRELATION]

    def refuse(reason: str) -> StatisticResult:
        return StatisticResult(
            statistic=Statistic.CORRELATION,
            measure=measure,
            status="not_computable",
            unit="correlation coefficient",
            method=method,
            parameters=parameters,
            points_used=len(pair),
            points_excluded=pair.excluded,
            minimum_points=minimum,
            reason=reason,
            provenance=provenance,
        )

    if len(pair) < minimum:
        if pair.common_instants == 0:
            return refuse(
                f"{left_label} and {right_label} share no instant in this window, so there is "
                f"nothing to correlate: one offered {pair.left_offered} readings and the other "
                f"{pair.right_offered}, at different times."
            )
        return refuse(
            f"A correlation needs at least {minimum} instants both places reported; this window "
            f"has {len(pair)}. Through two points the coefficient is exactly ±1 whatever the data, "
            "so a figure here would be an artefact of the arithmetic."
        )

    left_mean = sum(pair.left) / len(pair)
    right_mean = sum(pair.right) / len(pair)
    left_deviations = [value - left_mean for value in pair.left]
    right_deviations = [value - right_mean for value in pair.right]
    left_spread = math.fsum(deviation * deviation for deviation in left_deviations)
    right_spread = math.fsum(deviation * deviation for deviation in right_deviations)

    if left_spread == 0.0 or right_spread == 0.0:
        flat = left_label if left_spread == 0.0 else right_label
        if left_spread == 0.0 and right_spread == 0.0:
            flat = f"{left_label} and {right_label}"
        return refuse(
            f"The correlation is undefined: {flat} reported the same value at every instant in "
            "this window, so there is no variation to move with. The places' figures are still "
            "reported separately."
        )

    covariance = math.fsum(
        first * second for first, second in zip(left_deviations, right_deviations, strict=True)
    )
    coefficient = covariance / math.sqrt(left_spread * right_spread)
    # Clamped against floating-point drift past the mathematical bound, which a perfectly
    # correlated pair can produce in the last bit and which would read as a broken statistic.
    coefficient = max(-1.0, min(1.0, coefficient))

    return StatisticResult(
        statistic=Statistic.CORRELATION,
        measure=measure,
        status="computed",
        value=coefficient,
        unit="correlation coefficient",
        method=method,
        parameters=parameters,
        points_used=len(pair),
        points_excluded=pair.excluded,
        minimum_points=minimum,
        provenance=provenance,
    )


def data_density(
    *,
    series: tuple[Series, ...],
    measure: Measure,
    labels: tuple[str, ...],
    expected: int,
    provenance: Provenance,
) -> StatisticResult:
    """How much of the window every candidate actually reported, as a percentage.

    **The formula.**

        density = instants every candidate reported / expected instants * 100

    `expected` is the number of slots the window was asked for — the longest series' length, which
    is what the provider was asked to fill. The numerator counts only instants where **every**
    candidate carries a value, because the figure exists to say how much of the comparison rested
    on data rather than on absence: a slot one place reported and another did not is a slot the
    comparison could not use.

    That makes it deliberately pessimistic, and the method says so. A per-candidate average would
    read higher and would describe something the comparison never used.

    Reported not computable, with the reason, when the window asked for nothing — the only case
    where the denominator is zero. A window that asked for slots and got none back is a **0%**
    density, not an absent one: zero is the honest measurement there, and stating it is the point.

    **`points_used` is the denominator here, not the numerator**, which is the opposite of every
    other statistic in this package and is therefore worth stating. Elsewhere "points used" means
    the values that went into an average; for a density the statistic *examined* every slot the
    window asked for and found some of them empty, so the slots are what it used. The numerator is
    the value itself and `parameters["usable_instants"]`. Reporting the numerator here would also
    make a genuine 0% fail its own minimum-points check — the field would say the statistic was
    computed from nothing, when in fact it was computed from a window that was fully examined.
    """
    method = (
        "instants every candidate reported a value for, over the instants the window asked for, "
        f"as a percentage; {len(series)} candidates: {', '.join(labels)}"
    )
    parameters: dict[str, Any] = {
        "candidates": list(labels),
        "expected_instants": expected,
    }

    if expected <= 0:
        return StatisticResult(
            statistic=Statistic.DATA_DENSITY,
            measure=measure,
            status="not_computable",
            unit="%",
            method=method,
            parameters=parameters,
            points_used=0,
            points_excluded=0,
            minimum_points=MINIMUM_POINTS[Statistic.DATA_DENSITY],
            reason=(
                "The window asked for no instants, so there is no denominator to report a density "
                "against."
            ),
            provenance=provenance,
        )

    reported: set[Any] | None = None
    for candidate in series:
        points = usable_points(candidate, measure)
        instants = set(points.times_utc)
        reported = instants if reported is None else (reported & instants)
    usable = len(reported or set())

    parameters["usable_instants"] = usable
    return StatisticResult(
        statistic=Statistic.DATA_DENSITY,
        measure=measure,
        status="computed",
        value=usable / expected * 100.0,
        unit="%",
        method=method,
        parameters=parameters,
        points_used=expected,
        points_excluded=max(0, expected - usable),
        minimum_points=MINIMUM_POINTS[Statistic.DATA_DENSITY],
        provenance=provenance,
    )
