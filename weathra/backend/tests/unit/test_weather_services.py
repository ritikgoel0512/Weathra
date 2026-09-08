"""Group 8 (offline part) — window resolution, forecast analysis, thresholds, uncertainty, the
deterministic summary, historical comparison, baselines, and the accuracy-scoring refusal.

The db-backed halves — snapshot capture and What Changed? — live in
``tests/integration/test_snapshots.py``.
"""

from __future__ import annotations

import socket
from datetime import UTC, date, datetime, timedelta

import pytest

from tests import factories as f
from tests.provider_support import fixture, json_transport, provider_settings
from weathra.analytics.support import require_usable
from weathra.domain.analytics import Direction, Statistic
from weathra.domain.errors import (
    AnalyticsNotPossible,
    NoDataForRange,
    RangeOutsideCoverage,
    UnsupportedMeasure,
    ValidationFailed,
)
from weathra.domain.location import Location
from weathra.domain.weather import ConfidenceBand, DataClass, Granularity, Measure, UnitSystem
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.providers.open_meteo import OpenMeteoProvider
from weathra.weather.forecast_service import ForecastService, analyse, summarize
from weathra.weather.history_service import (
    ACCURACY_REFUSAL,
    HistoryService,
    aggregate,
    refuse_accuracy_scoring,
    statistics_applied,
)
from weathra.weather.thresholds import ThresholdCondition, find_crossings
from weathra.weather.uncertainty import (
    BASIS_STATEMENT,
    HIGH_CONFIDENCE_HOURS,
    band_for,
    describe_uncertainty,
)
from weathra.weather.windows import (
    baseline_periods,
    forecast_window,
    historical_window,
    today_at,
)

PROVENANCE = f.provenance()

# A location whose DST transition is easy to reason about, and one with none at all.
KIRITIMATI = Location(
    display_name="Kiritimati", latitude=1.87, longitude=-157.43, timezone="Pacific/Kiritimati"
)


# =========================================================================== 8.1 windows


def test_today_is_the_local_date_not_the_servers() -> None:
    """At 23:30 UTC it is already tomorrow in Berlin and still today in New York."""
    moment = datetime(2026, 3, 1, 23, 30, tzinfo=UTC)
    assert today_at(f.BERLIN, moment) == date(2026, 3, 2)
    assert today_at(
        Location(
            display_name="New York",
            latitude=40.71,
            longitude=-74.01,
            timezone="America/New_York",
        ),
        moment,
    ) == date(2026, 3, 1)


def test_a_forecast_window_starts_at_local_midnight() -> None:
    window = forecast_window(f.BERLIN, datetime(2026, 3, 1, 12, 0, tzinfo=UTC), 7)
    assert window.start_local.hour == 0
    assert window.start_local.date() == date(2026, 3, 1)
    assert window.end_local.date() == date(2026, 3, 8)
    assert window.duration_hours == 168.0


def test_a_forecast_window_is_inclusive_of_today() -> None:
    window = forecast_window(f.BERLIN, datetime(2026, 3, 1, 12, 0, tzinfo=UTC), 1)
    assert window.duration_hours == 24.0
    assert window.start_local.date() == date(2026, 3, 1)


def test_a_window_crossing_a_dst_transition_is_honestly_short() -> None:
    """Berlin's spring-forward makes that week 167 hours, and the window says so."""
    window = forecast_window(f.BERLIN, datetime(2026, 3, 26, 12, 0, tzinfo=UTC), 7)
    assert window.duration_hours == 167.0
    assert window.start_local.utcoffset() == timedelta(hours=1)
    assert window.end_local.utcoffset() == timedelta(hours=2)


def test_a_window_crossing_an_autumn_transition_is_honestly_long() -> None:
    window = forecast_window(f.BERLIN, datetime(2026, 10, 22, 12, 0, tzinfo=UTC), 7)
    assert window.duration_hours == 169.0


def test_a_window_in_a_zone_with_no_transition_is_exactly_the_hours() -> None:
    window = forecast_window(KIRITIMATI, datetime(2026, 3, 26, 12, 0, tzinfo=UTC), 7)
    assert window.duration_hours == 168.0


def test_a_zero_day_window_is_refused() -> None:
    with pytest.raises(ValueError, match="at least one day"):
        forecast_window(f.BERLIN, datetime(2026, 3, 1, tzinfo=UTC), 0)


def test_a_historical_window_covers_whole_local_days() -> None:
    window = historical_window(f.BERLIN, date(2025, 2, 1), date(2025, 2, 28))
    assert window.start_local.date() == date(2025, 2, 1)
    assert window.end_local.date() == date(2025, 3, 1)
    assert window.duration_hours == 672.0


def test_baseline_periods_are_the_same_calendar_window_in_preceding_years() -> None:
    periods = baseline_periods(f.BERLIN, start=date(2026, 3, 2), end=date(2026, 3, 8), years=10)
    assert len(periods) == 10
    years = [year for year, _ in periods]
    assert years == list(range(2025, 2015, -1))
    for _year, period in periods:
        assert period.duration_hours in (167.0, 168.0, 169.0)


def test_a_baseline_over_a_leap_day_keeps_the_year_rather_than_dropping_it() -> None:
    """A decade of baselines must not silently become nine."""
    periods = baseline_periods(f.BERLIN, start=date(2024, 2, 29), end=date(2024, 3, 2), years=4)
    assert len(periods) == 4
    assert [year for year, _ in periods] == [2023, 2022, 2021, 2020]


def test_a_zero_year_baseline_is_refused() -> None:
    with pytest.raises(ValueError, match="at least one year"):
        baseline_periods(f.BERLIN, start=date(2026, 3, 2), end=date(2026, 3, 8), years=0)


def test_an_inverted_baseline_period_is_refused() -> None:
    with pytest.raises(ValueError, match="must not precede"):
        baseline_periods(f.BERLIN, start=date(2026, 3, 8), end=date(2026, 3, 2), years=3)


# =========================================================================== 8.2 analysis


def recorded_forecast(name: str = "forecast_berlin_metric_7d") -> object:
    provider = OpenMeteoProvider(settings=provider_settings(), client=json_transport(fixture(name)))
    return provider


async def analysed(name: str = "forecast_berlin_metric_7d", **kwargs: object) -> object:
    provider = recorded_forecast(name)
    forecast = await provider.forecast(f.BERLIN, days=7)  # type: ignore[attr-defined]
    return analyse(forecast, **kwargs)  # type: ignore[arg-type]


async def test_an_analysis_reports_its_window_location_and_provider() -> None:
    analysis = await analysed()
    assert analysis.location.display_name == "Berlin"  # type: ignore[attr-defined]
    assert analysis.provider == "open-meteo"  # type: ignore[attr-defined]
    assert analysis.data_class is DataClass.FORECAST  # type: ignore[attr-defined]
    assert analysis.period.duration_hours > 0  # type: ignore[attr-defined]
    assert analysis.horizon_days == 7  # type: ignore[attr-defined]


async def test_an_analysis_includes_temperature_precipitation_and_wind_findings() -> None:
    analysis = await analysed()
    computed = {
        (result.statistic, result.measure)
        for result in analysis.computed_findings  # type: ignore[attr-defined]
    }
    assert (Statistic.MAXIMUM, Measure.TEMPERATURE_MAX) in computed
    assert (Statistic.MEAN, Measure.TEMPERATURE_MAX) in computed
    assert (Statistic.TOTAL, Measure.PRECIPITATION_SUM) in computed
    assert (Statistic.MAXIMUM_GUST, Measure.WIND_GUST_MAX) in computed
    assert (Statistic.PREVAILING_DIRECTION, Measure.WIND_DIRECTION_DOMINANT) in computed


async def test_every_analysis_figure_carries_its_method_and_point_count() -> None:
    analysis = await analysed()
    for result in analysis.findings:  # type: ignore[attr-defined]
        assert result.method
        assert result.points_used >= 0
        assert result.data_class is DataClass.COMPUTED_STATISTIC
        assert result.provenance.provider == "open-meteo"


async def test_the_same_series_yields_the_same_analysis() -> None:
    """The determinism requirement, on the composed analysis rather than one statistic.

    One retrieved forecast, analysed twice. Two separate *retrievals* legitimately differ in
    `retrieved_at`, which is data about the retrieval rather than about the analysis.
    """
    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture("forecast_berlin_metric_7d"))
    )
    forecast = await provider.forecast(f.BERLIN, days=7)

    assert analyse(forecast).model_dump_json() == analyse(forecast).model_dump_json()


async def test_a_measure_the_provider_omits_is_reported_unavailable() -> None:
    from tests.provider_support import blank_out

    payload = blank_out(fixture("forecast_berlin_metric_7d"), "daily", "precipitation_sum")
    provider = OpenMeteoProvider(settings=provider_settings(), client=json_transport(payload))
    analysis = analyse(await provider.forecast(f.BERLIN, days=7))

    unavailable = {result.measure for result in analysis.unavailable_findings}
    assert Measure.PRECIPITATION_SUM in unavailable
    assert any(result.computed for result in analysis.findings), "the rest still computed"


async def test_an_empty_daily_series_fails_rather_than_returning_an_empty_analysis() -> None:
    payload = fixture("forecast_berlin_metric_7d")
    for field, column in payload["daily"].items():
        if field != "time":
            payload["daily"][field] = [None] * len(column)
    provider = OpenMeteoProvider(settings=provider_settings(), client=json_transport(payload))
    forecast = await provider.forecast(f.BERLIN, days=7)

    with pytest.raises(AnalyticsNotPossible, match="no usable value"):
        analyse(forecast)


async def test_an_analysis_carries_an_anomaly_report_and_a_trend() -> None:
    analysis = await analysed()
    assert analysis.anomalies is not None  # type: ignore[attr-defined]
    assert analysis.anomalies.method  # type: ignore[attr-defined]
    assert analysis.trend is not None  # type: ignore[attr-defined]
    assert analysis.trend.method  # type: ignore[attr-defined]


# =========================================================================== 8.3 thresholds


def test_a_crossing_is_reported_in_local_time_with_its_value() -> None:
    series = f.series({Measure.TEMPERATURE_MAX: [22.0, 28.0, 33.0, 29.0]})
    report = find_crossings(
        series,
        ThresholdCondition(measure=Measure.TEMPERATURE_MAX, direction=Direction.ABOVE, value=30.0),
        PROVENANCE,
    )

    assert report.crossed is True
    assert report.first is not None
    assert report.first.value == 33.0
    assert report.first.time_local.utcoffset() == timedelta(hours=1)
    assert "first occurs" in report.statement


def test_a_threshold_never_crossed_is_reported_explicitly() -> None:
    series = f.series({Measure.PRECIPITATION_SUM: [0.0, 1.2, 3.0]})
    report = find_crossings(
        series,
        ThresholdCondition(
            measure=Measure.PRECIPITATION_SUM, direction=Direction.ABOVE, value=20.0
        ),
        PROVENANCE,
    )

    assert report.crossed is False
    assert report.crossings == ()
    assert "does not occur" in report.statement


def test_a_threshold_on_an_unavailable_measure_names_the_measure() -> None:
    series = f.series({Measure.TEMPERATURE_MAX: [22.0]})
    with pytest.raises(UnsupportedMeasure) as caught:
        find_crossings(
            series,
            ThresholdCondition(measure=Measure.UV_INDEX_MAX, direction=Direction.ABOVE, value=8.0),
            PROVENANCE,
        )
    assert caught.value.details["requested"] == "uv_index_max"


def test_a_series_that_starts_inside_the_condition_still_reports_a_crossing() -> None:
    series = f.series({Measure.TEMPERATURE_MAX: [33.0, 28.0]})
    report = find_crossings(
        series,
        ThresholdCondition(measure=Measure.TEMPERATURE_MAX, direction=Direction.ABOVE, value=30.0),
        PROVENANCE,
    )
    assert report.crossed is True
    assert report.first is not None
    assert report.first.value == 33.0


def test_only_transitions_count_as_crossings() -> None:
    """Three consecutive hot days are one crossing, not three."""
    series = f.series({Measure.TEMPERATURE_MAX: [22.0, 33.0, 34.0, 35.0, 22.0, 31.0]})
    report = find_crossings(
        series,
        ThresholdCondition(measure=Measure.TEMPERATURE_MAX, direction=Direction.ABOVE, value=30.0),
        PROVENANCE,
    )
    assert len(report.crossings) == 2
    assert "1 more time" in report.statement


def test_a_below_threshold_works_the_same_way() -> None:
    series = f.series({Measure.TEMPERATURE_MIN: [4.0, -2.0, 3.0]})
    report = find_crossings(
        series,
        ThresholdCondition(measure=Measure.TEMPERATURE_MIN, direction=Direction.BELOW, value=0.0),
        PROVENANCE,
    )
    assert report.crossed is True
    assert report.first is not None
    assert report.first.value == -2.0
    assert "below 0" in report.statement


def test_a_declared_but_absent_measure_says_it_cannot_be_determined() -> None:
    series = f.series({Measure.WIND_GUST_MAX: [None, None]})
    report = find_crossings(
        series,
        ThresholdCondition(measure=Measure.WIND_GUST_MAX, direction=Direction.ABOVE, value=60.0),
        PROVENANCE,
    )
    assert report.crossed is False
    assert "cannot be determined" in report.statement


# =========================================================================== 8.4 uncertainty


async def test_a_forecast_carries_an_uncertainty_statement_with_horizon_distances() -> None:
    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture("forecast_berlin_metric_7d"))
    )
    forecast = await provider.forecast(f.BERLIN, days=7)
    statement = describe_uncertainty(forecast)

    assert statement.provider == "open-meteo"
    assert len(statement.horizon) == 7
    assert all(point.hours_ahead >= 0 for point in statement.horizon)
    assert statement.horizon == tuple(sorted(statement.horizon, key=lambda p: p.hours_ahead))


def test_a_near_term_and_a_far_horizon_figure_are_qualified_differently() -> None:
    assert band_for(6.0) is ConfidenceBand.HIGH
    assert band_for(HIGH_CONFIDENCE_HOURS) is ConfidenceBand.HIGH
    assert band_for(HIGH_CONFIDENCE_HOURS + 1) is ConfidenceBand.MODERATE
    assert band_for(24 * 7) is ConfidenceBand.LOW


async def test_the_basis_is_always_disclosed_as_single_provider() -> None:
    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture("forecast_berlin_metric_7d"))
    )
    statement = describe_uncertainty(await provider.forecast(f.BERLIN, days=7))

    assert statement.multi_provider_consensus is False
    assert "not a multi-provider consensus" in statement.basis
    assert "open-meteo" in statement.basis
    assert BASIS_STATEMENT.format(provider="open-meteo") == statement.basis


def test_a_statement_reports_no_spread_when_the_provider_supplies_none() -> None:
    forecast = f.forecast(daily=f.series({Measure.TEMPERATURE_MEAN: [10.0, 11.0]}))
    statement = describe_uncertainty(forecast)
    assert statement.spread_available is False
    assert statement.provider_spread == ()


def test_the_daily_min_to_max_envelope_is_reported_as_a_spread() -> None:
    forecast = f.forecast(
        daily=f.series({Measure.TEMPERATURE_MIN: [4.0, 5.0], Measure.TEMPERATURE_MAX: [12.0, 14.0]})
    )
    statement = describe_uncertainty(forecast)
    assert statement.spread_available is True
    assert len(statement.provider_spread) == 2
    assert statement.provider_spread[0].lower == 4.0
    assert statement.provider_spread[0].upper == 12.0


def test_the_statement_anchors_on_the_retrieval_time_not_on_now() -> None:
    """So a cached forecast's uncertainty statement equals the live one's."""
    forecast = f.forecast(daily=f.series({Measure.TEMPERATURE_MAX: [10.0, 11.0]}))
    first = describe_uncertainty(forecast)
    second = describe_uncertainty(forecast.model_copy(update={"from_cache": True}))
    assert first.reference_time_utc == second.reference_time_utc == forecast.retrieved_at
    assert first.horizon == second.horizon


# =========================================================================== 8.5 the summary


async def test_a_summary_is_produced_with_no_inference_credential_configured() -> None:
    settings = provider_settings()
    assert settings.openrouter_api_key is None

    analysis = await analysed()
    assert analysis.summary  # type: ignore[attr-defined]
    assert "Berlin" in analysis.summary  # type: ignore[attr-defined]
    assert "open-meteo" in analysis.summary  # type: ignore[attr-defined]


async def test_a_summary_names_the_location_and_window() -> None:
    analysis = await analysed()
    assert f.BERLIN.qualified_name in analysis.summary  # type: ignore[attr-defined]


def test_every_figure_in_a_summary_appears_in_the_findings() -> None:
    """The property the numeric audit relies on: no figure the findings cannot account for."""
    import re

    from weathra.analytics import descriptive, precipitation

    series = f.series(
        {
            Measure.TEMPERATURE_MAX: [12.0, 14.0, 18.0],
            Measure.TEMPERATURE_MIN: [4.0, 5.0, 7.0],
            Measure.PRECIPITATION_SUM: [0.0, 2.0, 1.0],
        }
    )
    findings = (
        *descriptive.describe(series, Measure.TEMPERATURE_MAX, PROVENANCE),
        descriptive.minimum(series, Measure.TEMPERATURE_MIN, PROVENANCE),
        precipitation.total(series, PROVENANCE),
        precipitation.wet_entry_count(series, PROVENANCE),
    )
    forecast = f.forecast(daily=series)
    text = summarize(
        location=f.BERLIN,
        period=forecast.period,
        provider="open-meteo",
        findings=findings,
        anomalies=None,
        trend=None,
        thresholds=(),
        uncertainty=describe_uncertainty(forecast),
    )

    accounted = set()
    for result in findings:
        if result.value is not None:
            accounted.add(f"{result.value:g}")
    # Numbers that are part of the window, the horizon phrasing, or a materiality margin are
    # accounted for by the sentence they appear in, so only the measure figures are checked.
    for token in re.findall(r"(?<![\w.])\d+(?:\.\d+)?(?=\s*(?:°C|mm|km/h|day))", text):
        assert token in accounted or float(token).is_integer(), token


def test_a_summary_states_what_was_unavailable() -> None:
    from weathra.analytics import precipitation

    series = f.series(
        {Measure.TEMPERATURE_MAX: [12.0], Measure.PRECIPITATION_PROBABILITY_MAX: [None]}
    )
    findings = precipitation.probability_analysis(
        series, PROVENANCE, measure=Measure.PRECIPITATION_PROBABILITY_MAX
    )
    forecast = f.forecast(daily=series)
    text = summarize(
        location=f.BERLIN,
        period=forecast.period,
        provider="open-meteo",
        findings=findings,
        anomalies=None,
        trend=None,
        thresholds=(),
        uncertainty=describe_uncertainty(forecast),
    )
    assert "Not available for this window" in text
    assert "precipitation_probability_max" in text


def test_a_summary_needs_no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the summary attempted to open a socket")

    monkeypatch.setattr(socket, "socket", refuse)

    series = f.series({Measure.TEMPERATURE_MAX: [12.0, 14.0, 18.0]})
    forecast = f.forecast(daily=series)
    analysis = analyse(forecast)
    assert analysis.summary


# =========================================================================== 8.8 history


def history_service(payload_name: str = "archive_berlin_2025_02") -> HistoryService:
    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture(payload_name))
    )
    return HistoryService(
        provider=provider,
        settings=provider_settings(),
        now=datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
    )


def shifting_archive_service(*, years_available: int | None = None) -> HistoryService:
    """A service whose archive answers each year with that year's own dates.

    The recorded fixture covers one February. A baseline asks for the same calendar window in
    several preceding years, so the transport shifts the recorded timestamps to match the range
    each call asks for — which is what a real archive does, and what makes the merge across years
    exercise its real path rather than a pile of identical dates.
    """
    import httpx

    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if years_available is not None and calls["count"] > years_available:
            return httpx.Response(200, json={"daily": {"time": []}})

        payload = (
            fixture("archive_archive_placeholder") if False else fixture("archive_berlin_2025_02")
        )
        requested_start = date.fromisoformat(str(request.url.params["start_date"]))
        recorded_start = date(2025, 2, 1)
        shift = int((requested_start - recorded_start).total_seconds() // 1)
        offset = (requested_start - recorded_start).days * 86_400
        for block in ("daily", "hourly"):
            if block in payload:
                payload[block]["time"] = [moment + offset for moment in payload[block]["time"]]
        del shift
        return httpx.Response(200, json=payload)

    provider = OpenMeteoProvider(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return HistoryService(
        provider=provider,
        settings=provider_settings(),
        now=datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
    )


async def test_observations_are_labelled_historical_with_their_basis() -> None:
    observations = await history_service().observations(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28)
    )
    assert observations.data_class is DataClass.HISTORICAL_OBSERVATION
    assert observations.provider == "open-meteo"
    assert observations.retrieved_at.tzinfo is UTC
    assert observations.covered_period.timezone == "Europe/Berlin"


async def test_a_range_beyond_coverage_is_refused_before_any_call() -> None:
    service = history_service()
    with pytest.raises(RangeOutsideCoverage):
        await service.observations(f.BERLIN, start=date(1800, 1, 1), end=date(1800, 1, 31))


async def test_a_future_range_is_refused() -> None:
    service = history_service()
    with pytest.raises(RangeOutsideCoverage, match="into the future"):
        await service.observations(f.BERLIN, start=date(2026, 2, 1), end=date(2026, 12, 1))


async def test_both_sides_of_a_comparison_get_the_same_statistics() -> None:
    observations = await history_service().observations(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28)
    )
    first = aggregate(observations)
    second = aggregate(observations)
    assert [(r.statistic, r.measure) for r in first] == [(r.statistic, r.measure) for r in second]
    assert statistics_applied()


async def test_a_period_comparison_reports_both_sides_and_the_deltas() -> None:
    comparison = await history_service().compare_periods(
        f.BERLIN,
        earlier_start=date(2025, 2, 1),
        earlier_end=date(2025, 2, 28),
        later_start=date(2025, 2, 1),
        later_end=date(2025, 2, 28),
    )
    assert comparison.earlier
    assert comparison.later
    assert comparison.deltas
    assert comparison.data_class is DataClass.HISTORICAL_OBSERVATION
    assert "same statistics applied to each" in comparison.basis
    # The same payload on both sides, so every delta is zero — which proves the pairing is right.
    assert all(delta.value == 0.0 for delta in comparison.deltas)


async def test_unequal_period_lengths_are_permitted_and_stated() -> None:
    comparison = await history_service().compare_periods(
        f.BERLIN,
        earlier_start=date(2025, 2, 1),
        earlier_end=date(2025, 2, 20),
        later_start=date(2025, 2, 1),
        later_end=date(2025, 2, 28),
    )
    assert comparison.lengths_differ is True
    assert "differ in length" in comparison.basis


async def test_one_unavailable_period_fails_naming_which_side() -> None:
    """A one-sided result is not a comparison."""
    service = history_service()
    with pytest.raises(RangeOutsideCoverage) as caught:
        await service.compare_periods(
            f.BERLIN,
            earlier_start=date(1800, 1, 1),
            earlier_end=date(1800, 1, 31),
            later_start=date(2025, 2, 1),
            later_end=date(2025, 2, 28),
        )
    assert "earlier period" in caught.value.message.lower()
    assert "not a comparison" in caught.value.message


# =========================================================================== 8.9 baselines


async def test_a_baseline_reports_the_years_it_actually_used() -> None:
    baseline = await shifting_archive_service().baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=3
    )
    assert baseline.years_requested == 3
    assert baseline.years_count == 3
    assert baseline.mean.computed is True
    assert baseline.standard_deviation.computed is True
    assert baseline.minimum.computed is True
    assert baseline.maximum.computed is True


async def test_a_baseline_of_an_instantaneous_measure_is_refused_by_name() -> None:
    """The refusal that used to arrive as a coverage problem, and cost an afternoon.

    A baseline is computed from the *daily* series, which carries only daily aggregates. Asking for
    `temperature` — an instantaneous measure — cannot be satisfied for any location in any year, but
    the routine used to discover that one archive request at a time and then report "the archive
    holds no temperature observations for this calendar period in any of the 10 year(s) requested".
    That blames the archive for a measure it was never asked for, and it reads exactly like a
    coverage gap: the deployed-acceptance suite hit it against production and it took tracing the
    daily series' own keys to see that nothing was wrong with the data at all.

    So it is refused up front, by name, and the refusal says what to ask for instead.
    """
    with pytest.raises(ValidationFailed) as caught:
        await shifting_archive_service().baseline(
            f.BERLIN,
            start=date(2025, 2, 1),
            end=date(2025, 2, 28),
            years=3,
            measure=Measure.TEMPERATURE,
        )

    message = str(caught.value)
    assert "instantaneous" in message
    assert "temperature_mean" in message, "the refusal does not say what to ask for instead"
    assert "archive" not in message.lower(), "the refusal still blames the archive"


@pytest.mark.parametrize(
    "measure", [Measure.TEMPERATURE_MEAN, Measure.TEMPERATURE_MAX, Measure.PRECIPITATION_SUM]
)
async def test_a_baseline_of_a_daily_aggregate_is_computed(measure: Measure) -> None:
    """The other side of the guard: every daily aggregate the archive supplies still works."""
    baseline = await shifting_archive_service().baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=2, measure=measure
    )
    assert baseline.measure is measure
    assert baseline.years_count >= 1


async def test_a_baseline_is_labelled_a_weathra_computed_statistic() -> None:
    baseline = await shifting_archive_service().baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=2
    )
    assert baseline.data_class is DataClass.COMPUTED_STATISTIC
    assert "computed by Weathra" in baseline.labelling
    assert "not an official climate normal" in baseline.labelling


async def test_a_baseline_with_fewer_years_available_says_so() -> None:
    """A year the archive refuses is dropped and reported, never silently narrowed."""
    service = shifting_archive_service(years_available=2)

    baseline = await service.baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=5
    )
    assert baseline.is_partial is True
    assert baseline.years_count == 2
    assert baseline.coverage_note is not None
    assert "2 of the 5 requested years" in baseline.coverage_note


async def test_a_baseline_with_no_years_at_all_fails() -> None:
    import httpx

    provider = OpenMeteoProvider(
        settings=provider_settings(),
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"daily": {"time": []}})
            )
        ),
    )
    service = HistoryService(
        provider=provider, settings=provider_settings(), now=datetime(2026, 3, 1, tzinfo=UTC)
    )
    with pytest.raises(NoDataForRange):
        await service.baseline(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=3)


# =========================================================================== 8.10 vs baseline


async def test_a_forecast_against_a_baseline_reports_difference_z_score_and_words() -> None:
    service = shifting_archive_service()
    baseline = await service.baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=3
    )
    assert baseline.mean.value is not None

    comparison = service.compare_against_baseline(
        baseline=baseline,
        value=baseline.mean.value + 3.0,
        value_data_class=DataClass.FORECAST,
    )

    assert comparison.difference.value == pytest.approx(3.0)
    assert comparison.z_score.computed is True
    assert "above the" in comparison.characterization
    assert str(baseline.years_count) in comparison.characterization


async def test_the_forecast_side_of_a_baseline_comparison_is_qualified() -> None:
    service = shifting_archive_service()
    baseline = await service.baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=2
    )
    assert baseline.mean.value is not None

    forecast_side = service.compare_against_baseline(
        baseline=baseline, value=8.0, value_data_class=DataClass.FORECAST
    )
    observed_side = service.compare_against_baseline(
        baseline=baseline, value=8.0, value_data_class=DataClass.CURRENT
    )

    assert forecast_side.forecast_side_caveat is not None
    assert "uncertain" in forecast_side.forecast_side_caveat
    assert "observed" in forecast_side.forecast_side_caveat
    assert observed_side.forecast_side_caveat is None


async def test_a_zero_variance_baseline_reports_an_undefined_z_score_with_the_difference() -> None:
    service = shifting_archive_service()
    baseline = await service.baseline(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28), years=2
    )
    flat = baseline.model_copy(
        update={"standard_deviation": baseline.standard_deviation.model_copy(update={"value": 0.0})}
    )
    comparison = service.compare_against_baseline(
        baseline=flat, value=9.0, value_data_class=DataClass.CURRENT
    )

    assert comparison.z_score.computed is False
    assert "undefined" in (comparison.z_score.reason or "")
    assert comparison.difference.value is not None, "the signed difference is still reported"
    assert "z-score undefined" in comparison.characterization


# =========================================================================== 8.11 the refusal


def test_accuracy_scoring_is_refused_and_no_comparison_is_offered() -> None:
    refusal = refuse_accuracy_scoring()
    assert refusal == ACCURACY_REFUSAL
    assert "does not offer forecast-accuracy" in refusal
    assert "not a substitute" in refusal


def test_the_refusal_does_not_present_a_historical_comparison() -> None:
    """The specific failure mode specs/historical-weather names."""
    refusal = refuse_accuracy_scoring()
    for figure in ("°C", "mm", "km/h"):
        assert figure not in refusal


# =========================================================================== the service seam


async def test_the_forecast_service_refuses_an_over_long_horizon() -> None:
    from weathra.domain.errors import UnsupportedHorizon

    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture("forecast_berlin_metric_7d"))
    )
    geocoder = OpenMeteoGeocoder(
        settings=provider_settings(), client=json_transport(fixture("geocode_reykjavik"))
    )
    service = ForecastService(provider=provider, geocoder=geocoder, settings=provider_settings())

    with pytest.raises(UnsupportedHorizon, match="16 days"):
        await service.forecast(f.BERLIN, days=30)


async def test_the_forecast_service_defaults_to_seven_days() -> None:
    seen: list[object] = []

    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["forecast_days"])
        return httpx.Response(200, json=fixture("forecast_berlin_metric_7d"))

    provider = OpenMeteoProvider(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    geocoder = OpenMeteoGeocoder(
        settings=provider_settings(), client=json_transport(fixture("geocode_reykjavik"))
    )
    service = ForecastService(provider=provider, geocoder=geocoder, settings=provider_settings())

    await service.forecast(f.BERLIN)
    assert seen == ["7"]


def test_the_service_exposes_both_granularities() -> None:
    assert set(ForecastService.granularities()) == {Granularity.HOURLY, Granularity.DAILY}


def test_require_usable_is_the_only_hard_failure_on_this_path() -> None:
    with pytest.raises(AnalyticsNotPossible):
        require_usable(f.series({Measure.TEMPERATURE_MAX: [None]}))


async def test_an_analysis_of_imperial_data_reports_imperial_units() -> None:
    provider = OpenMeteoProvider(
        settings=provider_settings(), client=json_transport(fixture("forecast_berlin_imperial_7d"))
    )
    forecast = await provider.forecast(f.BERLIN, days=7, unit_system=UnitSystem.IMPERIAL)
    analysis = analyse(forecast)

    assert analysis.unit_system is UnitSystem.IMPERIAL
    temperature = analysis.finding(Statistic.MAXIMUM, Measure.TEMPERATURE_MAX)
    assert temperature is not None
    assert temperature.unit == "°F"
    assert "°F" in analysis.summary
