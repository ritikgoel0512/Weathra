"""Group 7 — the deterministic analytics engine.

Every test is a pure function call over a synthetic series. No network, no database, no clock, no
inference credential — which is not incidental: ``specs/deterministic-analytics`` makes exactly
that a requirement, and ``test_every_function_runs_with_no_external_service`` asserts it by
actually removing the ability to open a socket.
"""

from __future__ import annotations

import socket
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from tests import factories as f
from weathra.analytics.anomaly import DEFAULT_THRESHOLD, MAD_SCALE, detect_anomalies
from weathra.analytics.descriptive import (
    describe,
    maximum,
    mean,
    minimum,
    standard_deviation,
    value_range,
)
from weathra.analytics.distribution import INTERPOLATION_METHOD, percentile, z_score
from weathra.analytics.precipitation import (
    daily_totals,
    probability_analysis,
    total,
    wet_entry_count,
)
from weathra.analytics.rolling import delta, percentage_change, rolling_mean
from weathra.analytics.support import (
    MINIMUM_POINTS,
    require_measure,
    require_usable,
    usable_points,
)
from weathra.analytics.trend import analyse_trend, insignificance_margin_for
from weathra.analytics.wind import (
    compass_sector,
    humidity_statistics,
    pressure_statistics,
    prevailing_direction,
    wind_statistics,
)
from weathra.domain.analytics import Statistic, TrendDirection
from weathra.domain.errors import AnalyticsNotPossible, UnsupportedMeasure, ValidationFailed
from weathra.domain.weather import (
    DataClass,
    Granularity,
    Measure,
    Series,
    UnitSystem,
    units_map,
)

PROVENANCE = f.provenance()


def daily(values: Sequence[float | None], measure: Measure = Measure.TEMPERATURE_MAX) -> Series:
    return f.series({measure: values})


# =========================================================================== 7.1 descriptive


def test_temperature_statistics_report_value_unit_and_extremes() -> None:
    series = daily([4.0, 11.0, 18.0, 9.0, 6.0, 15.0, 12.0])
    low, high, average, spread = describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert low.value == 4.0
    assert high.value == 18.0
    assert average.value == pytest.approx(75.0 / 7)
    assert spread.value == 14.0
    for result in (low, high, average, spread):
        assert result.unit == "°C"
        assert result.method
        assert result.points_used == 7
        assert result.data_class is DataClass.COMPUTED_STATISTIC


def test_an_extreme_carries_the_timestamp_it_occurred_at() -> None:
    series = daily([4.0, 11.0, 18.0, 9.0])
    high = maximum(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert high.occurred_at_utc == datetime(2026, 3, 4, tzinfo=UTC)
    assert high.occurred_at_local is not None
    assert high.occurred_at_local.date().isoformat() == "2026-03-04"
    assert high.tied is False


def test_a_tied_extreme_reports_the_earliest_and_records_the_tie() -> None:
    series = daily([18.0, 11.0, 18.0, 9.0])
    high = maximum(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert high.value == 18.0
    assert high.tied is True
    assert len(high.tied_at) == 2
    assert high.occurred_at_utc == min(high.tied_at)


def test_absent_values_are_excluded_and_counted_rather_than_zeroed() -> None:
    series = daily([4.0, None, 18.0, None])
    low, high, average, spread = describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert low.value == 4.0, "a null was treated as zero"
    assert average.value == 11.0
    assert spread.value == 14.0
    for result in (low, high, average, spread):
        assert result.points_used == 2
        assert result.points_excluded == 2


def test_a_measure_absent_from_the_series_is_reported_not_computable() -> None:
    series = f.series({Measure.TEMPERATURE_MAX: [4.0], Measure.PRECIPITATION_SUM: [None]})
    result = mean(series, Measure.PRECIPITATION_SUM, PROVENANCE)

    assert result.computed is False
    assert result.value is None
    assert "not supplied" in (result.reason or "")
    assert result.points_used == 0


def test_a_range_needs_two_points_and_says_so() -> None:
    result = value_range(daily([4.0]), Measure.TEMPERATURE_MAX, PROVENANCE)
    assert result.computed is False
    assert "at least 2" in (result.reason or "")
    assert result.minimum_points == 2


def test_a_single_point_still_yields_an_extreme_and_a_mean() -> None:
    series = daily([4.0])
    assert minimum(series, Measure.TEMPERATURE_MAX, PROVENANCE).value == 4.0
    assert mean(series, Measure.TEMPERATURE_MAX, PROVENANCE).value == 4.0


def test_a_sample_standard_deviation_is_used_for_spread() -> None:
    result = standard_deviation(
        daily([2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    # Population SD would be 2.0; the sample form is larger, and the method says which it is.
    assert result.value == pytest.approx(2.13809, rel=1e-4)
    assert "ddof=1" in result.method


# =========================================================================== 7.2 precipitation


def test_precipitation_totals_are_summed_over_the_window() -> None:
    series = f.series({Measure.PRECIPITATION_SUM: [0.0, 2.4, 0.0, 5.1, 0.2]})
    result = total(series, PROVENANCE)
    assert result.value == pytest.approx(7.7)
    assert result.unit == "mm"


def test_per_day_totals_group_by_local_calendar_day() -> None:
    """An hourly series collapses to one value per local day."""
    series = f.series(
        {Measure.PRECIPITATION: [0.5] * 48},
        granularity=Granularity.HOURLY,
        start=datetime(2026, 3, 2, 0, 0, tzinfo=UTC),
    )
    result = daily_totals(series, PROVENANCE)

    assert result.values is not None
    # 48 hours from 00:00 UTC on 2 March spans three local days in Berlin (+01:00).
    assert len(result.values) == 3
    assert sum(point.value or 0 for point in result.values) == pytest.approx(24.0)


def test_a_wet_entry_count_is_exact_and_names_its_threshold() -> None:
    series = f.series({Measure.PRECIPITATION_SUM: [0.0, 0.05, 0.1, 3.0, None]})
    result = wet_entry_count(series, PROVENANCE)

    assert result.value == 2.0, "the boundary is inclusive"
    assert result.unit == "entries"
    assert result.parameters["threshold"] == 0.1
    assert result.points_excluded == 1


def test_a_custom_wet_threshold_is_honoured() -> None:
    series = f.series({Measure.PRECIPITATION_SUM: [0.0, 0.5, 3.0]})
    assert wet_entry_count(series, PROVENANCE, threshold=1.0).value == 1.0


def test_probability_analysis_reports_maximum_mean_and_exceedance() -> None:
    series = f.series(
        {Measure.PRECIPITATION_PROBABILITY: [10.0, 60.0, 80.0, 30.0]},
        granularity=Granularity.HOURLY,
    )
    highest, average, exceedance = probability_analysis(
        series, PROVENANCE, level=60.0, measure=Measure.PRECIPITATION_PROBABILITY
    )

    assert highest.value == 80.0
    assert average.value == 45.0
    assert exceedance.value == 2.0, "at or above the level"
    assert exceedance.parameters["level"] == 60.0
    assert exceedance.values is not None
    assert [point.value for point in exceedance.values] == [60.0, 80.0]


def test_probability_is_unavailable_rather_than_inferred_from_amount() -> None:
    """The archive supplies rainfall but never a probability. No probability may be derived."""
    series = f.series({Measure.PRECIPITATION_SUM: [0.0, 12.0, 4.0]})
    results = probability_analysis(series, PROVENANCE, level=60.0)

    assert len(results) == 3
    for result in results:
        assert result.computed is False
        assert result.value is None
        assert "No probability is inferred from precipitation amount" in (result.reason or "")


def test_a_declared_but_empty_probability_column_is_also_unavailable() -> None:
    series = f.series({Measure.PRECIPITATION_PROBABILITY: [None, None]})
    for result in probability_analysis(series, PROVENANCE):
        assert result.computed is False
        assert "absent for all 2 entries" in (result.reason or "")


# =========================================================================== 7.3 wind, humidity


def test_wind_statistics_report_speed_gust_and_sector() -> None:
    series = f.series(
        {
            Measure.WIND_SPEED: [10.0, 14.0, 12.0],
            Measure.WIND_GUST: [22.0, 41.0, 30.0],
            Measure.WIND_DIRECTION: [270.0, 280.0, 260.0],
        },
        granularity=Granularity.HOURLY,
    )
    mean_speed, max_sustained, max_gust, direction = wind_statistics(series, PROVENANCE)

    assert mean_speed.statistic is Statistic.MEAN_SPEED
    assert mean_speed.value == pytest.approx(12.0)
    assert max_sustained.statistic is Statistic.MAXIMUM_SUSTAINED_SPEED
    assert max_sustained.value == 14.0
    assert max_gust.statistic is Statistic.MAXIMUM_GUST
    assert max_gust.value == 41.0
    assert max_gust.occurred_at_utc is not None, "a gust must say when it happened"
    assert direction.parameters["sector"] == "W"


def test_the_prevailing_direction_is_a_vector_mean_not_an_arithmetic_one() -> None:
    """350° and 10° average to due north, not to due south."""
    series = f.series({Measure.WIND_DIRECTION: [350.0, 10.0]}, granularity=Granularity.HOURLY)
    result = prevailing_direction(series, PROVENANCE)

    assert result.value == pytest.approx(0.0, abs=1e-6)
    assert result.parameters["sector"] == "N"


def test_directions_that_cancel_out_report_no_prevailing_direction() -> None:
    series = f.series({Measure.WIND_DIRECTION: [0.0, 180.0]}, granularity=Granularity.HOURLY)
    result = prevailing_direction(series, PROVENANCE)
    assert result.computed is False
    assert "cancel out" in (result.reason or "")


@pytest.mark.parametrize(
    ("degrees", "sector"),
    [(0.0, "N"), (11.0, "N"), (12.0, "NNE"), (90.0, "E"), (180.0, "S"), (270.0, "W"), (359.0, "N")],
)
def test_compass_sectors(degrees: float, sector: str) -> None:
    assert compass_sector(degrees) == sector


def test_humidity_statistics_report_mean_and_range() -> None:
    series = f.series(
        {Measure.RELATIVE_HUMIDITY: [50.0, 70.0, 90.0], Measure.DEW_POINT: [4.0, 6.0, 8.0]},
        granularity=Granularity.HOURLY,
    )
    humidity_mean, humidity_range, dew_mean, dew_range = humidity_statistics(series, PROVENANCE)

    assert humidity_mean.value == 70.0
    assert humidity_range.value == 40.0
    assert humidity_mean.unit == "%"
    assert dew_mean.value == 6.0
    assert dew_range.value == 4.0
    assert dew_mean.unit == "°C"


def test_pressure_statistics_report_mean_and_range() -> None:
    series = f.series({Measure.SURFACE_PRESSURE: [1010.0, 1014.0]}, granularity=Granularity.HOURLY)
    pressure_mean, pressure_range = pressure_statistics(series, PROVENANCE)
    assert pressure_mean.value == 1012.0
    assert pressure_range.value == 4.0
    assert pressure_mean.unit == "hPa"


def test_a_missing_measure_leaves_the_others_computed() -> None:
    """The partial-availability requirement, on the wind bundle."""
    series = f.series(
        {
            Measure.WIND_SPEED: [10.0, 14.0],
            Measure.WIND_GUST: [None, None],
            Measure.WIND_DIRECTION: [270.0, 280.0],
        },
        granularity=Granularity.HOURLY,
    )
    mean_speed, max_sustained, max_gust, direction = wind_statistics(series, PROVENANCE)

    assert mean_speed.computed is True
    assert max_sustained.computed is True
    assert direction.computed is True
    assert max_gust.computed is False
    assert "not supplied" in (max_gust.reason or "")


# =========================================================================== 7.4 rolling, percentiles


def test_a_rolling_mean_reports_its_values_window_and_method() -> None:
    series = daily([10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0])
    result = rolling_mean(series, Measure.TEMPERATURE_MAX, PROVENANCE, window=3)

    assert result.values is not None
    assert len(result.values) == 5, "a 3-point window over 7 points yields 5 values"
    assert [point.value for point in result.values] == [12.0, 14.0, 16.0, 18.0, 20.0]
    assert result.parameters["window"] == 3
    assert "trailing 3-point window" in result.method


def test_each_rolling_value_is_labelled_with_the_last_day_it_covers() -> None:
    series = daily([10.0, 12.0, 14.0])
    result = rolling_mean(series, Measure.TEMPERATURE_MAX, PROVENANCE, window=3)
    assert result.values is not None
    assert result.values[0].time_utc == series.entries[2].time_utc


def test_a_rolling_window_longer_than_the_series_states_both_lengths() -> None:
    series = daily([10.0] * 7)
    with pytest.raises(ValidationFailed) as caught:
        rolling_mean(series, Measure.TEMPERATURE_MAX, PROVENANCE, window=10)

    assert caught.value.details["requested_window"] == 10
    assert caught.value.details["available_points"] == 7
    assert "10-point" in caught.value.message


def test_a_rolling_window_counts_usable_points_not_entries() -> None:
    series = daily([10.0, None, 12.0])
    with pytest.raises(ValidationFailed) as caught:
        rolling_mean(series, Measure.TEMPERATURE_MAX, PROVENANCE, window=3)
    assert caught.value.details["available_points"] == 2
    assert caught.value.details["total_entries"] == 3


def test_a_zero_rolling_window_is_refused() -> None:
    with pytest.raises(ValidationFailed, match="at least 1 point"):
        rolling_mean(daily([1.0, 2.0]), Measure.TEMPERATURE_MAX, PROVENANCE, window=0)


def test_a_percentile_names_its_interpolation_method() -> None:
    series = daily([float(value) for value in range(1, 11)])
    result = percentile(series, Measure.TEMPERATURE_MAX, PROVENANCE, level=90.0)

    assert result.value == pytest.approx(9.1)
    assert INTERPOLATION_METHOD in result.method
    assert result.parameters["interpolation"] == INTERPOLATION_METHOD
    assert result.parameters["level"] == 90.0


def test_a_percentile_outside_zero_to_a_hundred_is_refused() -> None:
    for level in (-1.0, 101.0):
        with pytest.raises(ValidationFailed, match="between 0 and 100"):
            percentile(daily([1.0, 2.0]), Measure.TEMPERATURE_MAX, PROVENANCE, level=level)


def test_a_delta_reports_the_signed_difference_and_both_inputs() -> None:
    result = delta(
        measure=Measure.TEMPERATURE_MEAN,
        unit="°C",
        earlier=6.0,
        later=9.5,
        earlier_label="February 2025",
        later_label="February 2026",
        provenance=PROVENANCE,
    )
    assert result.value == pytest.approx(3.5)
    assert result.parameters["earlier"] == 6.0
    assert result.parameters["later"] == 9.5
    assert result.unit == "°C"


def test_a_negative_delta_means_it_went_down() -> None:
    result = delta(
        measure=Measure.TEMPERATURE_MEAN,
        unit="°C",
        earlier=9.5,
        later=6.0,
        earlier_label="a",
        later_label="b",
        provenance=PROVENANCE,
    )
    assert result.value == pytest.approx(-3.5)


def test_a_percentage_change_from_zero_is_undefined_rather_than_infinite() -> None:
    assert percentage_change(0.0, 4.0) is None
    assert percentage_change(10.0, 15.0) == pytest.approx(50.0)
    assert percentage_change(10.0, 5.0) == pytest.approx(-50.0)


# =========================================================================== 7.5 z-scores


def test_a_z_score_names_the_reference_it_was_computed_against() -> None:
    result = z_score(
        measure=Measure.TEMPERATURE_MEAN,
        unit="°C",
        value=12.0,
        reference_mean=9.0,
        reference_standard_deviation=1.5,
        reference_label="the 10-year baseline for calendar week 10",
        reference_years=10,
        provenance=PROVENANCE,
    )
    assert result.value == pytest.approx(2.0)
    assert result.unit == "standard deviations"
    assert "calendar week 10" in str(result.parameters["reference_period"])
    assert result.parameters["reference_years"] == 10


def test_a_zero_variance_reference_is_undefined_and_does_not_raise() -> None:
    result = z_score(
        measure=Measure.TEMPERATURE_MEAN,
        unit="°C",
        value=12.0,
        reference_mean=9.0,
        reference_standard_deviation=0.0,
        reference_label="a single-year baseline",
        provenance=PROVENANCE,
    )
    assert result.computed is False
    assert result.value is None
    assert "undefined" in (result.reason or "")
    assert "standard deviation of zero" in (result.reason or "")


# =========================================================================== 7.6 anomalies


def test_an_outlier_day_is_reported_with_its_deviation_method_and_threshold() -> None:
    series = daily([11.0, 12.0, 11.5, 27.5, 12.0, 11.0, 12.5])
    report = detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert report.found_any is True
    assert len(report.anomalies) == 1
    anomaly = report.anomalies[0]
    assert anomaly.value == 27.5
    assert anomaly.deviation > 0
    assert anomaly.deviation_score >= report.threshold
    assert report.threshold == DEFAULT_THRESHOLD
    assert "median absolute deviation" in report.method
    assert str(MAD_SCALE) in report.method


def test_a_single_extreme_in_seven_points_is_not_masked_by_its_own_presence() -> None:
    """The reason the method is MAD and not standard deviation (design.md decision 9)."""
    import numpy as np

    values = [11.0, 12.0, 11.5, 27.5, 12.0, 11.0, 12.5]
    array = np.asarray(values)
    inflated_z = abs(27.5 - array.mean()) / array.std(ddof=1)
    assert inflated_z < 2.6, "the standard-deviation method would barely flag this"

    report = detect_anomalies(daily(values), Measure.TEMPERATURE_MAX, PROVENANCE)
    assert [point.value for point in report.anomalies] == [27.5]


def test_a_uniform_series_reports_no_anomalies_but_still_its_extremes() -> None:
    """A third of a degree is not a finding, however small the window's dispersion is.

    Pure MAD scores the 11.4 °C day at 2.02 MADs here, past the threshold. The materiality floor
    is what keeps "no anomalies" a real answer.
    """
    series = daily([11.0, 11.4, 11.2, 10.9, 11.1, 11.3, 11.0])
    report = detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert report.found_any is False
    assert report.minimum.value == 10.9
    assert report.maximum.value == 11.4
    assert "materiality floor" in report.method


def test_a_flat_series_reports_extremes_only_and_explains_why() -> None:
    series = daily([11.0] * 7)
    report = detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert report.median_absolute_deviation == 0.0
    assert report.anomalies == ()
    assert report.minimum.value == 11.0
    assert report.maximum.value == 11.0
    assert "no dispersion" in (report.note or "")


def test_a_series_too_short_for_the_method_still_reports_extremes() -> None:
    report = detect_anomalies(daily([11.0, 20.0]), Measure.TEMPERATURE_MAX, PROVENANCE)
    assert report.anomalies == ()
    assert report.maximum.value == 20.0
    assert "at least 3" in (report.note or "")


def test_anomalies_exclude_absent_values_from_the_method() -> None:
    report = detect_anomalies(
        daily([11.0, None, 12.0, 27.5, 11.5, None, 12.0]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    assert report.points_used == 5
    assert report.points_excluded == 2
    assert [point.value for point in report.anomalies] == [27.5]


def test_a_cold_outlier_is_also_an_anomaly() -> None:
    report = detect_anomalies(
        daily([11.0, 12.0, 11.5, -8.0, 12.0, 11.0, 12.5]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    assert [point.value for point in report.anomalies] == [-8.0]
    assert report.anomalies[0].deviation < 0


# =========================================================================== 7.7 trend


def test_a_rising_trend_reports_magnitude_period_and_method() -> None:
    series = daily([5.0, 7.0, 9.0, 11.0, 13.0, 15.0, 17.0])
    report = analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    assert report.direction is TrendDirection.RISING
    assert report.slope_per_day == pytest.approx(2.0)
    assert report.magnitude == pytest.approx(12.0)
    assert report.unit == "°C"
    assert "Theil-Sen" in report.method
    assert report.points_used == 7


def test_a_falling_trend_is_reported_as_such() -> None:
    report = analyse_trend(
        daily([17.0, 15.0, 13.0, 11.0, 9.0]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    assert report.direction is TrendDirection.FALLING
    assert report.slope_per_day < 0


def test_variation_inside_the_margin_is_steady() -> None:
    report = analyse_trend(
        daily([11.0, 11.2, 11.1, 11.3, 11.2, 11.1, 11.4]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    assert report.direction is TrendDirection.STEADY
    assert abs(report.slope_per_day) < report.insignificance_margin_per_day


def test_a_single_end_spike_does_not_create_a_trend() -> None:
    """The requirement that decided the estimator.

    First-versus-last calls this a strong rise. So does a least-squares fit — 1.4 °C/day, which is
    why design.md decision 9's stated method does not achieve its own stated goal. The Theil-Sen
    median of pairwise slopes does.
    """
    import numpy as np

    values = [11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 24.0]
    days = np.arange(7, dtype=float)
    least_squares, _ = np.polyfit(days, np.asarray(values), 1)
    assert least_squares > 1.0, "the least-squares fit would report a strong rise"

    report = analyse_trend(daily(values), Measure.TEMPERATURE_MAX, PROVENANCE)
    assert report.direction is TrendDirection.STEADY
    assert report.slope_per_day == pytest.approx(0.0)
    assert "Theil-Sen" in report.method


def test_a_spike_at_the_start_likewise_does_not_create_a_falling_trend() -> None:
    report = analyse_trend(
        daily([24.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0]), Measure.TEMPERATURE_MAX, PROVENANCE
    )
    assert report.direction is TrendDirection.STEADY


def test_a_trend_needs_at_least_three_points() -> None:
    with pytest.raises(AnalyticsNotPossible, match="at least 3"):
        analyse_trend(daily([11.0, 20.0]), Measure.TEMPERATURE_MAX, PROVENANCE)


def test_the_insignificance_margin_is_per_measure() -> None:
    assert insignificance_margin_for(Measure.TEMPERATURE_MAX) == 0.5
    assert insignificance_margin_for(Measure.PRECIPITATION_SUM) == 0.5
    assert insignificance_margin_for(Measure.RELATIVE_HUMIDITY) == 1.0


def test_a_caller_may_state_its_own_margin() -> None:
    series = daily([11.0, 11.2, 11.4, 11.6, 11.8])
    assert (
        analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE, margin=0.1).direction
        is TrendDirection.RISING
    )
    assert (
        analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE, margin=1.0).direction
        is TrendDirection.STEADY
    )


# =========================================================================== 7.8 result shape


def test_every_statistic_declares_a_minimum_point_count() -> None:
    assert set(MINIMUM_POINTS) == set(Statistic)
    assert all(minimum >= 1 for minimum in MINIMUM_POINTS.values())


def test_a_partial_analysis_computes_what_it_can_and_explains_the_rest() -> None:
    """The exact scenario from specs/deterministic-analytics: 7 temperature, 2 precipitation."""
    series = f.series(
        {
            Measure.TEMPERATURE_MAX: [4.0, 11.0, 18.0, 9.0, 6.0, 15.0, 12.0],
            Measure.PRECIPITATION_SUM: [1.0, 2.0, None, None, None, None, None],
        }
    )

    temperature = describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert all(result.computed for result in temperature)

    rain_total = total(series, PROVENANCE)
    assert rain_total.computed is True
    assert rain_total.points_used == 2
    assert rain_total.points_excluded == 5

    with pytest.raises(AnalyticsNotPossible):
        analyse_trend(series, Measure.PRECIPITATION_SUM, PROVENANCE)


def test_an_entirely_empty_series_raises() -> None:
    empty = Series(
        granularity=Granularity.DAILY,
        units=units_map((Measure.TEMPERATURE_MAX,), UnitSystem.METRIC),
    )
    with pytest.raises(AnalyticsNotPossible, match="no data to analyse"):
        require_usable(empty)


def test_a_series_whose_every_value_is_absent_raises() -> None:
    with pytest.raises(AnalyticsNotPossible, match="no usable value"):
        require_usable(daily([None, None, None]))


def test_a_series_with_one_usable_value_does_not_raise() -> None:
    require_usable(daily([None, 4.0, None]))


def test_a_threshold_on_a_measure_the_series_lacks_names_the_measure() -> None:
    with pytest.raises(UnsupportedMeasure) as caught:
        require_measure(daily([4.0]), Measure.UV_INDEX)
    assert caught.value.details["requested"] == "uv_index"
    assert "temperature_max" in caught.value.details["available"]


def test_a_result_round_trips_through_serialization_with_its_provenance() -> None:
    from weathra.domain.analytics import StatisticResult

    original = maximum(daily([4.0, 18.0]), Measure.TEMPERATURE_MAX, PROVENANCE)
    restored = StatisticResult.model_validate_json(original.model_dump_json())

    assert restored == original
    assert restored.provenance.provider == "open-meteo"
    assert restored.provenance.location.display_name == "Berlin"
    assert restored.method == original.method
    assert restored.points_used == original.points_used


def test_usable_points_counts_are_consistent() -> None:
    points = usable_points(daily([1.0, None, 3.0]), Measure.TEMPERATURE_MAX)
    assert len(points) == 2
    assert points.excluded == 1
    assert points.total_entries == 3


# =========================================================================== 7.9 purity


def test_repeated_computation_is_byte_for_byte_identical() -> None:
    series = daily([4.0, 11.0, 18.0, 9.0, 6.0, 15.0, 12.0])
    first = [
        result.model_dump_json() for result in describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    ]
    second = [
        result.model_dump_json() for result in describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    ]
    assert first == second


def test_repeated_anomaly_and_trend_reports_are_identical() -> None:
    series = daily([11.0, 12.0, 11.5, 27.5, 12.0, 11.0, 12.5])
    assert detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE).model_dump_json() == (
        detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE).model_dump_json()
    )
    assert analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE).model_dump_json() == (
        analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE).model_dump_json()
    )


def test_every_function_runs_with_no_external_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No network, no database, no inference credential — enforced, not assumed.

    Opening a socket raises for the duration of this test, so a function that reached out would
    fail here rather than in production.
    """

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("an analytics function attempted to open a socket")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    series = f.series(
        {
            Measure.TEMPERATURE_MAX: [4.0, 11.0, 18.0, 9.0, 6.0, 15.0, 12.0],
            Measure.PRECIPITATION_SUM: [0.0, 2.4, 0.0, 5.1, 0.2, 0.0, 1.1],
            Measure.WIND_SPEED_MAX: [10.0, 14.0, 12.0, 20.0, 8.0, 9.0, 11.0],
            Measure.WIND_GUST_MAX: [22.0, 41.0, 30.0, 55.0, 18.0, 20.0, 25.0],
            Measure.WIND_DIRECTION_DOMINANT: [270.0, 280.0, 260.0, 250.0, 300.0, 290.0, 275.0],
        }
    )

    assert describe(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert total(series, PROVENANCE).computed
    assert daily_totals(series, PROVENANCE, measure=Measure.PRECIPITATION_SUM).computed
    assert wet_entry_count(series, PROVENANCE).computed
    assert probability_analysis(series, PROVENANCE)
    assert wind_statistics(
        series,
        PROVENANCE,
        speed=Measure.WIND_SPEED_MAX,
        gust=Measure.WIND_GUST_MAX,
        direction=Measure.WIND_DIRECTION_DOMINANT,
    )
    assert rolling_mean(series, Measure.TEMPERATURE_MAX, PROVENANCE, window=3).computed
    assert percentile(series, Measure.TEMPERATURE_MAX, PROVENANCE, level=90.0).computed
    assert z_score(
        measure=Measure.TEMPERATURE_MAX,
        unit="°C",
        value=12.0,
        reference_mean=9.0,
        reference_standard_deviation=1.5,
        reference_label="baseline",
        provenance=PROVENANCE,
    ).computed
    assert detect_anomalies(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE)


def test_the_window_and_units_are_arguments_rather_than_ambient_state() -> None:
    """A function that read the clock or a global would change its answer overnight."""
    series = daily([4.0, 18.0])
    metric = maximum(series, Measure.TEMPERATURE_MAX, PROVENANCE)

    imperial_series = f.series(
        {Measure.TEMPERATURE_MAX: [39.2, 64.4]},
        unit_system="imperial",  # type: ignore[arg-type]
    )
    imperial = maximum(
        imperial_series,
        Measure.TEMPERATURE_MAX,
        f.provenance(unit_system="imperial"),  # type: ignore[arg-type]
    )

    assert metric.unit == "°C"
    assert imperial.unit == "°F"
    assert metric.provenance.period == imperial.provenance.period


def test_no_analytics_module_imports_anything_it_should_not(package_root: object) -> None:
    """Purity as a property of the imports: no clock-driven service, no model, no I/O client."""
    import ast
    from pathlib import Path

    forbidden = {"httpx", "sqlalchemy", "asyncpg", "fastapi", "requests", "openai", "anthropic"}
    root = Path(str(package_root)) / "analytics"
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module.split(".")[0]]
            assert not (set(names) & forbidden), f"{path.name} imports {set(names) & forbidden}"


def test_the_analytics_package_reads_no_clock(package_root: object) -> None:
    """`datetime.now`, `time.time`, and friends would make a result depend on when it ran."""
    from pathlib import Path

    root = Path(str(package_root)) / "analytics"
    for path in root.rglob("*.py"):
        source = path.read_text()
        for forbidden in ("datetime.now(", "time.time(", "date.today(", "utcnow("):
            assert forbidden not in source, f"{path.name} reads the clock: {forbidden}"


def test_a_delta_of_a_window_crossing_a_dst_transition_uses_real_elapsed_days() -> None:
    """Berlin's spring transition makes one day 23 hours; a trend must not be skewed by it."""
    series = f.series(
        {Measure.TEMPERATURE_MAX: [10.0, 12.0, 14.0, 16.0, 18.0]},
        start=datetime(2026, 3, 27, 23, 0, tzinfo=UTC),
    )
    report = analyse_trend(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert report.direction is TrendDirection.RISING
    # 2 °C per 24 hours, whatever the local clocks did.
    assert report.slope_per_day == pytest.approx(2.0, rel=1e-9)
    assert series.entries[1].time_local.utcoffset() != series.entries[-1].time_local.utcoffset()


def test_the_engine_needs_no_settings_object_at_all() -> None:
    """Nothing in the package takes a Settings: every parameter is passed by the caller."""
    import inspect

    from weathra.analytics import (
        anomaly,
        descriptive,
        distribution,
        precipitation,
        rolling,
        trend,
        wind,
    )

    for module in (anomaly, descriptive, distribution, precipitation, rolling, trend, wind):
        for name, function in inspect.getmembers(module, inspect.isfunction):
            if function.__module__ != module.__name__:
                continue
            annotations = inspect.signature(function).parameters
            for parameter in annotations.values():
                assert "Settings" not in str(parameter.annotation), f"{module.__name__}.{name}"


def test_a_window_of_absent_values_between_readings_does_not_shift_a_timestamp() -> None:
    series = daily([None, 18.0, None, 4.0])
    high = maximum(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert high.occurred_at_utc == series.entries[1].time_utc
    low = minimum(series, Measure.TEMPERATURE_MAX, PROVENANCE)
    assert low.occurred_at_utc == series.entries[3].time_utc


def test_timedelta_is_not_needed_to_read_a_result() -> None:
    """A sanity check that the module's public surface is plain floats and strings."""
    result = mean(daily([1.0, 2.0]), Measure.TEMPERATURE_MAX, PROVENANCE)
    assert isinstance(result.value, float)
    assert isinstance(result.unit, str)
    assert not isinstance(result.value, timedelta)
