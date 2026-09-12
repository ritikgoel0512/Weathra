"""Group 5 — the provider layer: the contract, the registry, the HTTP policy, the Open-Meteo
mapping, horizon and range validation, the cache, and the boundary.

Everything runs against recorded payloads and in-memory transports. Not one test reaches the
network, which is the property that makes the whole suite runnable in CI with no credentials and no
upstream dependency (design.md decision 20).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from tests import factories as f
from tests.provider_support import (
    StubProvider,
    blank_out,
    fixture,
    json_transport,
    nullify_trailing,
    provider_settings,
    stub_capabilities,
)
from weathra.domain.errors import (
    NoDataForRange,
    ProviderNotFound,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    RangeOutsideCoverage,
    UnsupportedHorizon,
)
from weathra.domain.location import Location
from weathra.domain.weather import Forecast, Granularity, Measure, UnitSystem
from weathra.providers.base import ProviderCapabilities, WeatherProvider
from weathra.providers.cache import COORDINATE_DECIMALS, CachedProvider
from weathra.providers.http import request_json
from weathra.providers.open_meteo import (
    ARCHIVE_DAILY_FIELDS,
    CURRENT_FIELDS,
    DAILY_FIELDS,
    EARLIEST_HISTORICAL_DATE,
    HOURLY_FIELDS,
    MAXIMUM_FORECAST_DAYS,
    OPEN_METEO_NAME,
    OpenMeteoProvider,
)
from weathra.providers.registry import (
    available_providers,
    build_provider,
    capabilities_of_all,
    register_provider,
)
from weathra.providers.validation import resolve_horizon, validate_historical_range

# =========================================================================== 5.1 the contract


def test_a_stub_satisfies_the_protocol_at_runtime() -> None:
    assert isinstance(StubProvider(), WeatherProvider)


def test_the_real_provider_satisfies_the_protocol_at_runtime() -> None:
    provider = OpenMeteoProvider(settings=provider_settings(), client=httpx.AsyncClient())
    assert isinstance(provider, WeatherProvider)


def test_capabilities_report_the_horizon_archive_and_measures() -> None:
    capabilities = stub_capabilities()
    assert capabilities.maximum_forecast_days == 10
    assert capabilities.minimum_hourly_hours == 48
    assert capabilities.earliest_historical_date == date(1990, 1, 1)
    assert capabilities.supplies(Measure.TEMPERATURE, Granularity.HOURLY)
    assert not capabilities.supplies(Measure.UV_INDEX, Granularity.HOURLY)
    assert capabilities.supplies_historically(Measure.TEMPERATURE_MAX)
    assert capabilities.serves_history is True


def test_a_provider_declaring_no_measures_is_refused() -> None:
    with pytest.raises(ValueError, match="declares no measures"):
        ProviderCapabilities(
            name="empty", maximum_forecast_days=7, minimum_hourly_hours=24, measures={}
        )


def test_historical_measures_require_an_archive_start_date() -> None:
    with pytest.raises(ValueError, match="no archive start date"):
        ProviderCapabilities(
            name="odd",
            maximum_forecast_days=7,
            minimum_hourly_hours=24,
            measures={Granularity.DAILY: (Measure.TEMPERATURE_MAX,)},
            historical_measures=(Measure.TEMPERATURE_MAX,),
        )


def test_a_provider_with_no_archive_serves_no_history() -> None:
    capabilities = ProviderCapabilities(
        name="forecast-only",
        maximum_forecast_days=5,
        minimum_hourly_hours=24,
        measures={Granularity.DAILY: (Measure.TEMPERATURE_MAX,)},
    )
    assert capabilities.serves_history is False


# =========================================================================== 5.2 the registry


def test_the_default_provider_serves_an_unnamed_request() -> None:
    provider = build_provider(provider_settings(), httpx.AsyncClient())
    assert provider.capabilities().name == OPEN_METEO_NAME


def test_a_named_provider_is_selectable() -> None:
    provider = build_provider(provider_settings(), httpx.AsyncClient(), OPEN_METEO_NAME)
    assert provider.capabilities().name == OPEN_METEO_NAME


def test_an_unknown_name_lists_the_registered_ones() -> None:
    with pytest.raises(ProviderNotFound) as caught:
        build_provider(provider_settings(), httpx.AsyncClient(), "accuweather")

    assert "accuweather" in caught.value.message
    assert OPEN_METEO_NAME in caught.value.message
    assert caught.value.details["available"] == list(available_providers())


def test_open_meteo_is_registered() -> None:
    assert OPEN_METEO_NAME in available_providers()


def test_capabilities_can_be_enumerated_for_every_provider() -> None:
    enumerated = capabilities_of_all(provider_settings(), httpx.AsyncClient())
    assert set(enumerated) == set(available_providers())
    for name, capabilities in enumerated.items():
        assert capabilities.name == name
        assert capabilities.maximum_forecast_days >= 1


def test_a_second_provider_is_selectable_after_registration() -> None:
    """specs/weather-providers: registering one changes no consuming source file."""
    try:
        register_provider("stub", lambda settings, client: StubProvider())
        assert "stub" in available_providers()
        provider = build_provider(provider_settings(), httpx.AsyncClient(), "stub")
        assert provider.capabilities().name == "stub"
    finally:
        from weathra.providers import registry

        registry._REGISTRY.pop("stub", None)


def test_registering_an_empty_name_is_refused() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        register_provider("  ", lambda settings, client: StubProvider())


# =========================================================================== 5.3 HTTP policy


async def _request(client: httpx.AsyncClient, **settings_overrides: object) -> dict[str, object]:
    return await request_json(
        client,
        "https://api.example/forecast",
        params={"latitude": 52.52},
        provider="example",
        settings=provider_settings(**settings_overrides),
    )


async def test_a_successful_request_returns_the_payload() -> None:
    payload = await _request(json_transport({"daily": {"time": [1]}}))
    assert payload == {"daily": {"time": [1]}}


async def test_a_timeout_becomes_a_timeout_error() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("too slow", request=request)

    with pytest.raises(ProviderTimeout) as caught:
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    assert caught.value.code == "provider_timeout"
    assert attempts == 3, "a timeout was not retried the configured number of times"


async def test_a_connection_failure_becomes_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ProviderUnavailable) as caught:
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert caught.value.code == "provider_unavailable"


async def test_a_429_is_rate_limiting_and_is_distinguishable() -> None:
    with pytest.raises(ProviderRateLimited) as caught:
        await _request(json_transport({}, status=429), http_max_retries=0)
    assert caught.value.code == "provider_rate_limited"
    assert caught.value.code != ProviderUnavailable.code


async def test_a_rate_limited_provider_request_is_not_retried() -> None:
    """The weather path has no budget for waiting out a limit, so it must not spend one retrying.

    Open-Meteo answers 429 with a JSON body and no ``Retry-After``, so the header-led refusal below
    never applied to it and every rate-limited archive call was sent three times. A Historical page
    load makes one archive call per baseline year; at the old default that was ten calls becoming
    thirty against a limiter that had already said no. One attempt, one report.
    """
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(429, json={"error": True, "reason": "Minutely limit exceeded"})

    with pytest.raises(ProviderRateLimited):
        await _request(
            httpx.AsyncClient(transport=httpx.MockTransport(handler)), http_max_retries=2
        )
    assert attempts == 1, f"a 429 was sent {attempts} times with no budget to wait"


async def test_a_retryable_status_that_is_not_a_rate_limit_is_still_retried() -> None:
    """The narrowing above is about 429 alone. A 503 is a server having a moment, not a refusal."""
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503) if attempts == 1 else httpx.Response(200, json={"ok": True})

    payload = await _request(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)), http_max_retries=2
    )
    assert payload == {"ok": True}
    assert attempts == 2


async def test_a_500_that_succeeds_on_retry_returns_the_result() -> None:
    """specs/weather-providers: a transient failure that recovers surfaces no error at all."""
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(500)
        return httpx.Response(200, json={"ok": True})

    payload = await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert payload == {"ok": True}
    assert attempts == 2


async def test_a_400_is_not_retried() -> None:
    """The request is wrong; repeating it spends the latency budget to reach the same answer."""
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(400, json={"reason": "bad parameter"})

    with pytest.raises(ProviderUnavailable):
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert attempts == 1


async def test_a_failure_carries_no_upstream_payload_or_credential() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text='{"reason": "invalid apikey abc123", "apikey": "abc123"}')

    with pytest.raises(ProviderUnavailable) as caught:
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    rendered = caught.value.message + str(caught.value.details)
    assert "abc123" not in rendered
    assert "invalid apikey" not in rendered


async def test_a_non_json_body_is_an_unavailability_rather_than_a_crash() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    with pytest.raises(ProviderUnavailable, match="not valid JSON"):
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_a_json_array_is_an_unexpected_shape() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with pytest.raises(ProviderUnavailable, match="unexpected shape"):
        await _request(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_retries_are_bounded_by_configuration() -> None:
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503)

    with pytest.raises(ProviderUnavailable):
        await _request(
            httpx.AsyncClient(transport=httpx.MockTransport(handler)), http_max_retries=4
        )
    assert attempts == 5


# =========================================================================== 5.4 mapping


def open_meteo(payload: dict[str, object]) -> OpenMeteoProvider:
    return OpenMeteoProvider(settings=provider_settings(), client=json_transport(payload))


async def test_the_forecast_is_returned_in_the_normalized_shape() -> None:
    provider = open_meteo(fixture("forecast_berlin_metric_7d"))
    result = await provider.forecast(f.BERLIN, days=7)

    assert result.provider == OPEN_METEO_NAME
    assert result.unit_system is UnitSystem.METRIC
    assert result.from_cache is False
    assert result.retrieved_at.tzinfo is UTC
    assert len(result.daily) == 7
    assert len(result.hourly) >= 48, "hourly detail must cover at least the first 48 hours"


async def test_every_forecast_entry_carries_both_timestamp_forms() -> None:
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    for entry in (*result.hourly.entries, *result.daily.entries):
        assert entry.time_utc.tzinfo is UTC
        assert entry.time_utc == entry.time_local
        assert entry.time_local.tzinfo is not UTC


async def test_every_forecast_value_resolves_to_a_unit() -> None:
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    for series in (result.hourly, result.daily):
        for measure in series.measures:
            assert series.unit(measure), measure


async def test_every_declared_measure_is_mapped_field_by_field() -> None:
    """The explicit-translation requirement: no measure quietly missing from the mapping."""
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    assert set(result.hourly.measures) == set(HOURLY_FIELDS)
    assert set(result.daily.measures) == set(DAILY_FIELDS)
    for measure in HOURLY_FIELDS:
        assert result.hourly.supplies(measure), f"{measure} came back empty"


async def test_the_daily_series_reports_plausible_recorded_values() -> None:
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    maxima = [value for value in result.daily.values_for(Measure.TEMPERATURE_MAX) if value]
    minima = [value for value in result.daily.values_for(Measure.TEMPERATURE_MIN) if value]
    assert maxima and minima
    assert all(-60 < value < 60 for value in maxima)
    assert all(maximum >= minimum for maximum, minimum in zip(maxima, minima, strict=False))


async def test_imperial_units_are_reflected_in_the_result() -> None:
    result = await open_meteo(fixture("forecast_berlin_imperial_7d")).forecast(
        f.BERLIN, days=7, unit_system=UnitSystem.IMPERIAL
    )
    assert result.unit_system is UnitSystem.IMPERIAL
    assert result.daily.unit(Measure.TEMPERATURE_MAX) == "°F"
    assert result.daily.unit(Measure.PRECIPITATION_SUM) == "in"
    assert result.hourly.unit(Measure.WIND_SPEED) == "mph"


async def test_the_unit_system_is_sent_upstream() -> None:
    seen: list[httpx.QueryParams] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params)
        return httpx.Response(200, json=fixture("forecast_berlin_imperial_7d"))

    provider = OpenMeteoProvider(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await provider.forecast(f.BERLIN, days=7, unit_system=UnitSystem.IMPERIAL)

    assert seen[0]["temperature_unit"] == "fahrenheit"
    assert seen[0]["wind_speed_unit"] == "mph"
    assert seen[0]["precipitation_unit"] == "inch"
    assert seen[0]["timezone"] == "Europe/Berlin"


async def test_an_omitted_measure_is_absent_rather_than_zero() -> None:
    payload = blank_out(fixture("forecast_berlin_metric_7d"), "hourly", "uv_index")
    result = await open_meteo(payload).forecast(f.BERLIN, days=7)

    assert Measure.UV_INDEX in result.hourly.units, "the measure must keep its declared unit"
    assert result.hourly.supplies(Measure.UV_INDEX) is False
    assert all(value is None for value in result.hourly.values_for(Measure.UV_INDEX))
    assert result.hourly.supplies(Measure.TEMPERATURE) is True


async def test_a_null_inside_a_column_is_absent_rather_than_zero() -> None:
    payload = fixture("forecast_berlin_metric_7d")
    payload["daily"]["precipitation_sum"][2] = None
    result = await open_meteo(payload).forecast(f.BERLIN, days=7)

    values = result.daily.values_for(Measure.PRECIPITATION_SUM)
    assert values[2] is None
    assert result.daily.absent_count(Measure.PRECIPITATION_SUM) == 1


async def test_current_conditions_are_labelled_current_and_carry_attribution() -> None:
    result = await open_meteo(fixture("current_berlin_metric")).current(f.BERLIN)

    assert result.data_class.value == "current"
    assert result.provider == OPEN_METEO_NAME
    assert result.observed_at_utc == result.observed_at_local
    assert result.retrieved_at.tzinfo is UTC
    assert set(result.units) == set(CURRENT_FIELDS)
    assert result.value(Measure.TEMPERATURE) is not None


async def test_current_conditions_with_no_block_are_an_unavailability() -> None:
    with pytest.raises(ProviderUnavailable, match="no current conditions"):
        await open_meteo({"latitude": 52.5}).current(f.BERLIN)


async def test_no_provider_specific_field_name_reaches_the_normalized_result() -> None:
    """specs/weather-providers: no raw payload and no provider field name escapes this layer."""
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    rendered = result.model_dump_json()
    for upstream_name in ("temperature_2m", "wind_gusts_10m", "generationtime_ms", "utc_offset"):
        assert upstream_name not in rendered


async def test_the_mapping_is_deterministic_for_a_fixed_payload() -> None:
    payload = fixture("forecast_berlin_metric_7d")
    first = await open_meteo(payload).forecast(f.BERLIN, days=7)
    second = await open_meteo(payload).forecast(f.BERLIN, days=7)
    assert first.daily == second.daily
    assert first.hourly == second.hourly


# =========================================================================== 5.5 the archive


async def test_the_archive_returns_observations_labelled_historical() -> None:
    provider = open_meteo(fixture("archive_berlin_2025_02"))
    result = await provider.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28))

    assert result.data_class.value == "historical_observation"
    assert result.provider == OPEN_METEO_NAME
    assert len(result.daily) == 28
    assert result.hourly is not None
    assert set(result.daily.measures) == set(ARCHIVE_DAILY_FIELDS)


async def test_a_fully_covered_range_reports_no_gap() -> None:
    provider = open_meteo(fixture("archive_berlin_2025_02"))
    result = await provider.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28))
    assert result.is_partial is False
    assert result.unavailable_note is None
    assert result.covered_period.start_utc == result.requested_period.start_utc


async def test_a_range_hitting_the_reporting_lag_returns_partial_coverage() -> None:
    """specs/historical-weather: return what is available and state what is not."""
    payload = nullify_trailing(fixture("archive_berlin_2025_02"), "daily", 5)
    provider = open_meteo(payload)
    result = await provider.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28))

    assert result.is_partial is True
    assert result.unavailable_note is not None
    assert "2025-02-24" in result.unavailable_note
    assert "2025-02-28" in result.unavailable_note
    assert result.covered_period.end_utc < result.requested_period.end_utc


async def test_a_range_with_nothing_at_all_is_a_no_data_error() -> None:
    payload = nullify_trailing(fixture("archive_berlin_2025_02"), "daily", 28)
    with pytest.raises(NoDataForRange) as caught:
        await open_meteo(payload).history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28))
    assert caught.value.code == "no_data_for_range"


async def test_a_range_before_the_archive_is_refused_with_the_earliest_date() -> None:
    with pytest.raises(RangeOutsideCoverage) as caught:
        await open_meteo(fixture("archive_berlin_2025_02")).history(
            f.BERLIN, start=date(1900, 1, 1), end=date(1900, 1, 31)
        )
    assert EARLIEST_HISTORICAL_DATE.isoformat() in caught.value.message
    assert caught.value.details["earliest_available"] == EARLIEST_HISTORICAL_DATE.isoformat()


async def test_the_archive_endpoint_is_used_rather_than_the_forecast_one() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url).split("?")[0])
        return httpx.Response(200, json=fixture("archive_berlin_2025_02"))

    provider = OpenMeteoProvider(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await provider.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28))
    assert "archive-api" in seen[0]


async def test_the_archive_supplies_no_precipitation_probability() -> None:
    """The case specs/deterministic-analytics needs: probability reported unavailable, not zero."""
    result = await open_meteo(fixture("archive_berlin_2025_02")).history(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28)
    )
    assert Measure.PRECIPITATION_PROBABILITY_MAX not in result.daily.units
    capabilities = OpenMeteoProvider(
        settings=provider_settings(), client=httpx.AsyncClient()
    ).capabilities()
    assert not capabilities.supplies_historically(Measure.PRECIPITATION_PROBABILITY_MAX)


# =========================================================================== 5.6 validation


def test_the_default_horizon_is_seven_days() -> None:
    settings = provider_settings()
    assert resolve_horizon(stub_capabilities(), settings) == 7
    assert settings.minimum_hourly_hours >= 48


def test_a_named_horizon_is_honoured() -> None:
    assert resolve_horizon(stub_capabilities(), provider_settings(), 5) == 5


def test_an_over_long_horizon_states_the_maximum() -> None:
    with pytest.raises(UnsupportedHorizon) as caught:
        resolve_horizon(stub_capabilities(), provider_settings(), 30)
    assert "10 days" in caught.value.message
    assert caught.value.details["maximum"] == 10
    assert caught.value.details["requested"] == 30


def test_a_zero_day_horizon_is_refused() -> None:
    with pytest.raises(UnsupportedHorizon, match="at least 1 day"):
        resolve_horizon(stub_capabilities(), provider_settings(), 0)


def test_the_bound_comes_from_capabilities_not_from_one_provider() -> None:
    """Swapping a provider changes the message and nothing else."""
    with pytest.raises(UnsupportedHorizon, match="16 days"):
        resolve_horizon(
            stub_capabilities(name="open-meteo", maximum_forecast_days=MAXIMUM_FORECAST_DAYS),
            provider_settings(),
            20,
        )


def test_an_inverted_historical_range_names_the_offending_bound() -> None:
    with pytest.raises(RangeOutsideCoverage) as caught:
        validate_historical_range(
            stub_capabilities(),
            start=date(2025, 3, 1),
            end=date(2025, 2, 1),
            today=date(2026, 3, 1),
        )
    assert caught.value.details["field"] == "end"


def test_a_future_dated_historical_range_is_refused() -> None:
    with pytest.raises(RangeOutsideCoverage, match="into the future"):
        validate_historical_range(
            stub_capabilities(),
            start=date(2026, 2, 1),
            end=date(2026, 4, 1),
            today=date(2026, 3, 1),
        )


def test_a_historical_range_starting_in_the_future_is_refused() -> None:
    with pytest.raises(RangeOutsideCoverage, match="cannot start in the future"):
        validate_historical_range(
            stub_capabilities(),
            start=date(2026, 4, 1),
            end=date(2026, 4, 5),
            today=date(2026, 3, 1),
        )


def test_a_range_before_the_archive_names_the_earliest_date() -> None:
    with pytest.raises(RangeOutsideCoverage) as caught:
        validate_historical_range(
            stub_capabilities(),
            start=date(1950, 1, 1),
            end=date(1950, 1, 31),
            today=date(2026, 3, 1),
        )
    assert caught.value.details["earliest_available"] == "1990-01-01"


def test_a_valid_range_passes() -> None:
    validate_historical_range(
        stub_capabilities(),
        start=date(2025, 2, 1),
        end=date(2025, 2, 28),
        today=date(2026, 3, 1),
    )


def test_a_provider_with_no_archive_refuses_history() -> None:
    forecast_only = ProviderCapabilities(
        name="forecast-only",
        maximum_forecast_days=5,
        minimum_hourly_hours=24,
        measures={Granularity.DAILY: (Measure.TEMPERATURE_MAX,)},
    )
    with pytest.raises(RangeOutsideCoverage, match="serves no historical"):
        validate_historical_range(
            forecast_only, start=date(2025, 1, 1), end=date(2025, 1, 2), today=date(2026, 1, 1)
        )


# =========================================================================== 5.7 the cache


def cached(inner: StubProvider, **overrides: object) -> CachedProvider:
    return CachedProvider(inner, settings=provider_settings(**overrides))


async def test_a_repeat_request_is_served_from_cache() -> None:
    inner = StubProvider()
    wrapper = cached(inner)

    first = await wrapper.forecast(f.BERLIN, days=3)
    second = await wrapper.forecast(f.BERLIN, days=3)

    assert inner.forecast_calls == 1
    assert first.from_cache is False
    assert second.from_cache is True
    assert second.retrieved_at == first.retrieved_at, (
        "retrieved_at states when the data was obtained upstream, not when it was served"
    )


async def test_a_stale_entry_is_refreshed() -> None:
    inner = StubProvider()
    now = 1_000.0
    wrapper = CachedProvider(
        inner, settings=provider_settings(cache_forecast_ttl_seconds=60), clock=lambda: now
    )

    await wrapper.forecast(f.BERLIN, days=3)
    now += 59
    second = await wrapper.forecast(f.BERLIN, days=3)
    assert inner.forecast_calls == 1
    assert second.from_cache is True

    now += 2
    third = await wrapper.forecast(f.BERLIN, days=3)
    assert inner.forecast_calls == 2
    assert third.from_cache is False


async def test_metric_and_imperial_are_cached_separately() -> None:
    inner = StubProvider()
    wrapper = cached(inner)

    metric = await wrapper.forecast(f.BERLIN, days=3, unit_system=UnitSystem.METRIC)
    imperial = await wrapper.forecast(f.BERLIN, days=3, unit_system=UnitSystem.IMPERIAL)

    assert inner.forecast_calls == 2
    assert imperial.from_cache is False
    assert metric.unit_system is UnitSystem.METRIC
    assert imperial.unit_system is UnitSystem.IMPERIAL


async def test_different_kinds_and_spans_are_cached_separately() -> None:
    inner = StubProvider()
    wrapper = cached(inner)

    await wrapper.forecast(f.BERLIN, days=3)
    await wrapper.forecast(f.BERLIN, days=7)
    await wrapper.current(f.BERLIN)
    await wrapper.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 3))

    assert inner.forecast_calls == 2
    assert inner.current_calls == 1
    assert inner.history_calls == 1


async def test_different_locations_are_cached_separately() -> None:
    inner = StubProvider()
    wrapper = cached(inner)
    await wrapper.forecast(f.BERLIN, days=3)
    await wrapper.forecast(f.MUNICH, days=3)
    assert inner.forecast_calls == 2


async def test_coordinates_are_rounded_so_near_identical_points_share_an_entry() -> None:
    """~11 m of rounding, far below any provider's grid: the merged entries are identical data."""
    inner = StubProvider()
    wrapper = cached(inner)
    nudged = f.BERLIN.model_copy(update={"latitude": f.BERLIN.latitude + 1e-6})

    await wrapper.forecast(f.BERLIN, days=3)
    await wrapper.forecast(nudged, days=3)

    assert inner.forecast_calls == 1
    assert COORDINATE_DECIMALS == 4


async def test_historical_entries_outlive_forecast_entries() -> None:
    settings = provider_settings()
    assert settings.cache_history_ttl_seconds > settings.cache_forecast_ttl_seconds

    inner = StubProvider()
    now = 1_000.0
    wrapper = CachedProvider(inner, settings=settings, clock=lambda: now)

    await wrapper.forecast(f.BERLIN, days=3)
    await wrapper.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 3))

    now += settings.cache_forecast_ttl_seconds + 1
    await wrapper.forecast(f.BERLIN, days=3)
    historical = await wrapper.history(f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 3))

    assert inner.forecast_calls == 2, "the forecast entry should have expired"
    assert inner.history_calls == 1, "the historical entry should still be fresh"
    assert historical.from_cache is True


async def test_two_concurrent_identical_requests_make_one_upstream_call() -> None:
    """The lock-collapsing property: a cold cache under load must not multiply traffic."""
    started = asyncio.Event()
    release = asyncio.Event()

    class SlowProvider(StubProvider):
        async def forecast(
            self,
            location: Location,
            *,
            days: int,
            unit_system: UnitSystem = UnitSystem.METRIC,
        ) -> Forecast:
            started.set()
            await release.wait()
            return await super().forecast(location, days=days, unit_system=unit_system)

    inner = SlowProvider()
    wrapper = cached(inner)

    first = asyncio.create_task(wrapper.forecast(f.BERLIN, days=3))
    await started.wait()
    second = asyncio.create_task(wrapper.forecast(f.BERLIN, days=3))
    await asyncio.sleep(0)
    release.set()

    results = await asyncio.gather(first, second)
    assert inner.forecast_calls == 1
    assert wrapper.upstream_calls == 1
    assert {result.from_cache for result in results} == {False, True}


async def test_concurrent_requests_for_different_keys_do_not_serialize_wrongly() -> None:
    inner = StubProvider()
    wrapper = cached(inner)
    await asyncio.gather(wrapper.forecast(f.BERLIN, days=3), wrapper.forecast(f.MUNICH, days=3))
    assert inner.forecast_calls == 2


async def test_a_zero_ttl_disables_caching_rather_than_caching_forever() -> None:
    inner = StubProvider()
    wrapper = cached(inner, cache_forecast_ttl_seconds=0)
    await wrapper.forecast(f.BERLIN, days=3)
    await wrapper.forecast(f.BERLIN, days=3)
    assert inner.forecast_calls == 2


async def test_the_cache_is_bounded_and_evicts_the_oldest() -> None:
    inner = StubProvider()
    wrapper = cached(inner, cache_max_entries=2)

    for days in (1, 2, 3):
        await wrapper.forecast(f.BERLIN, days=days)
    # The 1-day entry was evicted, so asking again reaches upstream.
    await wrapper.forecast(f.BERLIN, days=1)
    assert inner.forecast_calls == 4


async def test_the_wrapper_passes_capabilities_through() -> None:
    inner = StubProvider()
    assert cached(inner).capabilities() == inner.capabilities()


async def test_the_wrapper_satisfies_the_same_protocol() -> None:
    assert isinstance(cached(StubProvider()), WeatherProvider)


async def test_an_upstream_failure_is_not_cached() -> None:
    """A cached failure would turn one bad minute into a whole TTL of them."""
    inner = StubProvider(failure=ProviderTimeout("upstream is slow"))
    wrapper = cached(inner)

    for _ in range(2):
        with pytest.raises(ProviderTimeout):
            await wrapper.forecast(f.BERLIN, days=3)
    assert inner.forecast_calls == 2


async def test_a_rate_limit_is_answered_from_the_last_value_obtained() -> None:
    """A limited provider should cost freshness, not the whole screen.

    Travel Intelligence failed in production with "open-meteo rate-limited the request" and ranked
    nothing, while an hour-old forecast for the same place and horizon was sitting in this cache
    with nothing but an expired TTL against it. A TTL is a statement about freshness, not about
    usefulness: past it, the entry is still the best answer available when upstream refuses to give
    a better one, and `from_cache` with the original `retrieved_at` says exactly how old it is.
    """
    inner = StubProvider()
    now = 1_000.0
    wrapper = CachedProvider(
        inner, settings=provider_settings(cache_forecast_ttl_seconds=60), clock=lambda: now
    )

    first = await wrapper.forecast(f.BERLIN, days=3)
    assert inner.forecast_calls == 1

    now += 120  # past the TTL, so the next call really does go upstream
    inner._failure = ProviderRateLimited("open-meteo rate-limited the request.")

    served = await wrapper.forecast(f.BERLIN, days=3)

    assert inner.forecast_calls == 2, "upstream was asked exactly once more, and not retried"
    assert served.from_cache is True
    assert served.retrieved_at == first.retrieved_at, "the age is stated, not refreshed"
    assert wrapper.stale_served == 1


async def test_a_rate_limit_with_nothing_cached_still_fails() -> None:
    """Nothing to serve is not the same as something old to serve, and is not disguised as it."""
    inner = StubProvider(failure=ProviderRateLimited("open-meteo rate-limited the request."))
    wrapper = cached(inner)

    with pytest.raises(ProviderRateLimited):
        await wrapper.forecast(f.BERLIN, days=3)


async def test_a_rate_limit_is_never_retried_in_a_loop() -> None:
    """The one thing that must not happen to a provider that just refused: being asked again."""
    inner = StubProvider(failure=ProviderRateLimited("open-meteo rate-limited the request."))
    wrapper = cached(inner)

    for _ in range(3):
        with pytest.raises(ProviderRateLimited):
            await wrapper.forecast(f.BERLIN, days=3)

    # Three callers, three upstream attempts — never more. No retry is issued inside the cache.
    assert inner.forecast_calls == 3


def test_no_cache_key_carries_user_identifying_material() -> None:
    """specs/authentication: the provider cache is shared, non-user-owned data."""
    from weathra.providers.cache import CacheKey

    fields = set(CacheKey.__dataclass_fields__)
    assert fields == {"provider", "kind", "latitude", "longitude", "unit_system", "span"}
    assert not any(
        term in field for field in fields for term in ("user", "principal", "token", "session")
    )


# =========================================================================== 5.8 the boundary


def test_no_module_above_the_provider_layer_imports_a_provider_client(package_root: Path) -> None:
    """Asserted by the architecture checker; restated here so the provider group owns it too."""
    from tests.test_architecture import violations

    offending = [
        violation for violation in violations(package_root) if "provider client" in violation.reason
    ]
    assert not offending, offending


def test_the_normalized_result_exposes_no_provider_specific_field_name() -> None:
    from weathra.domain.weather import CurrentConditions, Forecast, HistoricalObservations, Series

    for model in (Series, Forecast, CurrentConditions, HistoricalObservations):
        for name in model.model_fields:
            assert "_2m" not in name
            assert "_10m" not in name


async def test_a_provider_result_is_reachable_with_no_credential_configured() -> None:
    """The keyless property: no Supabase key, no inference key, no provider key."""
    settings = provider_settings()
    assert settings.openrouter_api_key is None
    assert settings.supabase_service_role_key is None

    provider = OpenMeteoProvider(
        settings=settings, client=json_transport(fixture("forecast_berlin_metric_7d"))
    )
    assert provider.capabilities().requires_credential is False
    result = await provider.forecast(f.BERLIN, days=7)
    assert len(result.daily) == 7


async def test_a_cached_result_still_reports_its_original_retrieval_time() -> None:
    inner = StubProvider()
    wrapper = cached(inner)
    first = await wrapper.current(f.BERLIN)
    second = await wrapper.current(f.BERLIN)
    assert second.retrieved_at == first.retrieved_at
    assert datetime.now(UTC) - second.retrieved_at > timedelta(0)


async def test_a_past_range_in_another_dst_season_lands_on_the_right_local_dates() -> None:
    """The bug the recorded archive fixture caught.

    Open-Meteo reports one ``utc_offset_seconds`` per response — the offset at *request* time. A
    February range requested in September therefore comes back an hour out, and reading the epoch
    as a UTC instant puts every day on the previous local date, which silently shortened coverage
    by a day. Local wall time plus the location's own zone gets it right.
    """
    payload = fixture("archive_berlin_2025_02")
    assert payload["utc_offset_seconds"] == 7200, "the fixture must keep its summer offset"

    result = await open_meteo(payload).history(
        f.BERLIN, start=date(2025, 2, 1), end=date(2025, 2, 28)
    )

    local_dates = [entry.time_local.date() for entry in result.daily.entries]
    assert local_dates[0] == date(2025, 2, 1)
    assert local_dates[-1] == date(2025, 2, 28)
    # February in Berlin is CET, whatever offset the response reported.
    assert result.daily.entries[0].time_local.utcoffset() == timedelta(hours=1)
    assert result.is_partial is False


async def test_a_forecast_in_the_current_season_keeps_its_own_offset() -> None:
    result = await open_meteo(fixture("forecast_berlin_metric_7d")).forecast(f.BERLIN, days=7)
    first = result.daily.entries[0].time_local
    assert first.hour == 0, "a daily entry starts at local midnight"
    assert first.utcoffset() in (timedelta(hours=1), timedelta(hours=2))
