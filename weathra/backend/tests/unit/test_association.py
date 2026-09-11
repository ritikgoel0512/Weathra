"""Correlation and data density — the arithmetic, and the four ways each can have no answer.

`04-compare-cities.png` draws both as bars, which is the least forgiving way to show a statistic: a
bar at 96% looks like a measurement whether or not one was taken. So the cases that matter here are
the degenerate ones — too few points, a flat series, nulls, windows that do not overlap — because
each of them has a plausible wrong answer that a bar would render without complaint.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from weathra.analytics.association import align, correlation, data_density
from weathra.analytics.support import MINIMUM_POINTS
from weathra.domain.analytics import Provenance, Statistic, StatisticResult
from weathra.domain.location import Location
from weathra.domain.weather import (
    DataClass,
    Granularity,
    Measure,
    Period,
    Series,
    SeriesEntry,
    UnitSystem,
)

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.405,
    timezone="Europe/Berlin",
    country="Germany",
    country_code="DE",
)

START = datetime(2026, 9, 4, 0, 0, tzinfo=UTC)


def _period() -> Period:
    return Period(
        start_utc=START,
        end_utc=START + timedelta(days=1),
        start_local=START,
        end_local=START + timedelta(days=1),
        timezone="Europe/Berlin",
    )


def _provenance() -> Provenance:
    return Provenance(
        location=BERLIN,
        period=_period(),
        provider="test-provider",
        unit_system=UnitSystem.METRIC,
        source_data_class=DataClass.FORECAST,
        retrieved_at=START,
    )


def _series(values: list[float | None], *, offset_hours: int = 0) -> Series:
    """An hourly series of temperatures, one entry per hour from `START` plus an offset."""
    return Series(
        granularity=Granularity.HOURLY,
        units={Measure.TEMPERATURE: "°C"},
        entries=tuple(
            SeriesEntry(
                time_utc=START + timedelta(hours=index + offset_hours),
                time_local=START + timedelta(hours=index + offset_hours),
                values={Measure.TEMPERATURE: value},
            )
            for index, value in enumerate(values)
        ),
    )


def _correlate(left: Series, right: Series) -> StatisticResult:
    return correlation(
        left=left,
        right=right,
        measure=Measure.TEMPERATURE,
        left_label="Berlin",
        right_label="Munich",
        unit="°C",
        provenance=_provenance(),
    )


class TestTheCoefficient:
    def test_two_series_that_rise_together_correlate_at_one(self) -> None:
        result = _correlate(_series([1.0, 2.0, 3.0, 4.0]), _series([10.0, 20.0, 30.0, 40.0]))
        assert result.status == "computed"
        assert result.value == pytest.approx(1.0)
        # Clamped, so floating-point drift never reports a coefficient outside its own bound.
        assert result.value is not None and -1.0 <= result.value <= 1.0

    def test_two_series_that_move_oppositely_correlate_at_minus_one(self) -> None:
        result = _correlate(_series([1.0, 2.0, 3.0, 4.0]), _series([40.0, 30.0, 20.0, 10.0]))
        assert result.value == pytest.approx(-1.0)

    def test_a_partial_relationship_lands_between_the_bounds(self) -> None:
        # Worked by hand: x = 1,2,3,4 and y = 2,1,4,3 give r = +0.6.
        result = _correlate(_series([1.0, 2.0, 3.0, 4.0]), _series([2.0, 1.0, 4.0, 3.0]))
        assert result.value == pytest.approx(0.6)

    def test_it_is_dimensionless_and_says_so(self) -> None:
        """The unit is the coefficient, never the measure's.

        A value of 0.96 carrying "°C" is the kind of label somebody reads as a temperature, and
        this is the one figure on the screen that is a ratio of two variances.
        """
        result = _correlate(_series([1.0, 2.0, 3.0]), _series([2.0, 4.0, 6.0]))
        assert result.unit == "correlation coefficient"
        assert result.measure is Measure.TEMPERATURE

    def test_the_method_names_the_pair_and_the_arithmetic(self) -> None:
        result = _correlate(_series([1.0, 2.0, 3.0]), _series([2.0, 4.0, 6.0]))
        assert "Pearson" in result.method
        assert "Berlin" in result.method and "Munich" in result.method
        # The formula, so the figure is checkable from the response rather than from this file.
        assert "mean(x)" in result.method


class TestWhenThereIsNoCoefficient:
    def test_too_few_aligned_points_is_refused_rather_than_reported_as_one(self) -> None:
        """Two points always correlate perfectly, which is the trap this guards.

        Through any two points Pearson's r is exactly ±1 whatever the values, so a two-point
        comparison would draw a full bar for a pair that shares nothing but arithmetic.
        """
        result = _correlate(_series([1.0, 2.0]), _series([5.0, 9.0]))
        assert result.status == "not_computable"
        assert result.value is None
        assert "artefact" in (result.reason or "")
        assert result.minimum_points == MINIMUM_POINTS[Statistic.CORRELATION] == 3

    def test_a_flat_series_makes_the_coefficient_undefined_not_zero(self) -> None:
        """Zero on one side is a division by zero, and zero would read as "unrelated"."""
        result = _correlate(_series([7.0, 7.0, 7.0, 7.0]), _series([1.0, 2.0, 3.0, 4.0]))
        assert result.status == "not_computable"
        assert "undefined" in (result.reason or "")
        # The flat side is named, so a reader knows which place to look at.
        assert "Berlin" in (result.reason or "")

    def test_a_flat_series_on_the_other_side_names_that_side(self) -> None:
        result = _correlate(_series([1.0, 2.0, 3.0, 4.0]), _series([7.0, 7.0, 7.0, 7.0]))
        assert "Munich" in (result.reason or "")

    def test_both_flat_names_both(self) -> None:
        result = _correlate(_series([3.0, 3.0, 3.0]), _series([9.0, 9.0, 9.0]))
        assert "Berlin and Munich" in (result.reason or "")

    def test_windows_that_do_not_overlap_correlate_against_nothing(self) -> None:
        """The case index alignment gets silently wrong.

        Paired by position, a series starting six hours later would correlate against its
        neighbour's *other* readings and produce a confident number about nothing. Paired by
        instant, it shares nothing and says so.
        """
        result = _correlate(
            _series([1.0, 2.0, 3.0, 4.0]), _series([1.0, 2.0, 3.0, 4.0], offset_hours=48)
        )
        assert result.status == "not_computable"
        assert "share no instant" in (result.reason or "")
        assert result.points_used == 0
        # Both sides' offered counts are stated, so the reason is diagnosable.
        assert result.parameters["left_offered"] == 4
        assert result.parameters["right_offered"] == 4

    def test_a_partial_overlap_uses_only_the_shared_instants(self) -> None:
        # Offset by one hour: three of four instants are shared, which clears the minimum of three.
        result = _correlate(
            _series([1.0, 2.0, 3.0, 4.0]), _series([2.0, 4.0, 6.0, 8.0], offset_hours=1)
        )
        assert result.status == "computed"
        assert result.points_used == 3

    def test_nulls_are_dropped_pairwise_and_counted(self) -> None:
        """An instant enters the arithmetic only when both sides carry a value."""
        left = _series([1.0, None, 3.0, 4.0, 5.0])
        right = _series([2.0, 4.0, 6.0, None, 10.0])
        result = _correlate(left, right)
        assert result.status == "computed"
        assert result.points_used == 3, "hours 0, 2 and 4 are usable on both sides"
        assert result.points_excluded == 2, "hours 1 and 3 matched but carried a null"


class TestDataDensity:
    def _density(
        self, *series: Series, expected: int, measure: Measure = Measure.TEMPERATURE
    ) -> StatisticResult:
        return data_density(
            series=series,
            measure=measure,
            labels=tuple(f"place-{index}" for index in range(len(series))),
            expected=expected,
            provenance=_provenance(),
        )

    def test_a_fully_reported_window_is_one_hundred_percent(self) -> None:
        result = self._density(_series([1.0, 2.0, 3.0]), _series([4.0, 5.0, 6.0]), expected=3)
        assert result.status == "computed"
        assert result.value == pytest.approx(100.0)
        assert result.unit == "%"

    def test_it_counts_only_instants_every_candidate_reported(self) -> None:
        """Deliberately pessimistic, because that is what the comparison could use.

        A slot one place reported and another did not is a slot the ranking rested on absence. A
        per-candidate average would read higher and describe something that never happened.
        """
        result = self._density(
            _series([1.0, 2.0, 3.0, 4.0]),
            _series([1.0, None, 3.0, None]),
            expected=4,
        )
        assert result.value == pytest.approx(50.0)
        # The denominator, deliberately: for a density the statistic examined every slot the window
        # asked for. The numerator is the value and `parameters["usable_instants"]`.
        assert result.points_used == 4
        assert result.points_excluded == 2

    def test_a_window_that_returned_nothing_is_zero_not_absent(self) -> None:
        """Zero is the honest measurement, and the bar should show it.

        Reporting this as not-computable would hide a provider that answered with nothing behind
        the same blank a misconfiguration produces.
        """
        result = self._density(_series([None, None]), _series([None, None]), expected=2)
        assert result.status == "computed"
        assert result.value == pytest.approx(0.0)
        # It examined both slots and found neither usable, which is why a genuine zero survives
        # the minimum-points check that the numerator would have failed.
        assert result.points_used == 2
        assert result.points_excluded == 2

    def test_a_window_that_asked_for_nothing_has_no_denominator(self) -> None:
        result = self._density(_series([]), expected=0)
        assert result.status == "not_computable"
        assert "no denominator" in (result.reason or "")

    def test_the_parameters_carry_both_halves_of_the_fraction(self) -> None:
        """So the percentage is checkable rather than trusted."""
        result = self._density(_series([1.0, 2.0, None]), _series([1.0, 2.0, 3.0]), expected=3)
        assert result.parameters["usable_instants"] == 2
        assert result.parameters["expected_instants"] == 3
        assert result.value == pytest.approx(2 / 3 * 100)

    def test_it_works_for_more_than_two_candidates(self) -> None:
        """Unlike the correlation, which is a pair statistic and absent above two."""
        result = self._density(
            _series([1.0, 2.0, 3.0]),
            _series([1.0, 2.0, None]),
            _series([1.0, None, 3.0]),
            expected=3,
        )
        assert result.value == pytest.approx(1 / 3 * 100)
        assert len(result.parameters["candidates"]) == 3


class TestAlignment:
    def test_it_reports_what_each_side_offered(self) -> None:
        pair = align(_series([1.0, 2.0, None]), _series([1.0, 2.0]), Measure.TEMPERATURE)
        assert len(pair) == 2
        assert pair.left_offered == 3
        assert pair.right_offered == 2
        assert pair.common_instants == 2
        assert pair.excluded == 0

    def test_an_instant_matched_but_null_counts_as_excluded(self) -> None:
        pair = align(_series([1.0, None]), _series([1.0, 5.0]), Measure.TEMPERATURE)
        assert len(pair) == 1
        assert pair.common_instants == 2
        assert pair.excluded == 1
