"""Fixtures and doubles for the provider layer.

The Open-Meteo payloads under ``tests/fixtures/open_meteo/`` are **recorded from the live API**, not
hand-written. That matters: a hand-written fixture encodes what the author believed the API returns,
and the mapping test would then verify the belief rather than the translation. Re-record with
``python scripts/record_open_meteo_fixtures.py`` when the upstream shape changes.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from weathra.config import Settings
from weathra.domain.errors import NoDataForRange
from weathra.domain.location import Location
from weathra.domain.weather import (
    CurrentConditions,
    Forecast,
    Granularity,
    HistoricalObservations,
    Measure,
    Series,
    SeriesEntry,
    UnitSystem,
    units_map,
)
from weathra.domain.windows import local_day_bounds, period_from_local_dates
from weathra.providers.base import ProviderCapabilities

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "open_meteo"

# What StubProvider's daily series carries: enough for every analytics and comparison path.
STUB_MEASURES: tuple[Measure, ...] = (
    Measure.TEMPERATURE_MAX,
    Measure.TEMPERATURE_MEAN,
    Measure.PRECIPITATION_SUM,
    Measure.WIND_SPEED_MAX,
)


def fixture(name: str) -> dict[str, Any]:
    """A recorded payload, deep-copied so a test that mutates it cannot affect another."""
    return copy.deepcopy(json.loads((FIXTURES / f"{name}.json").read_text()))


def provider_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "supabase_url": "https://project.supabase.co",
        "http_backoff_seconds": 0.0,  # tests assert retry counts, not wall-clock patience
    }
    values.update(overrides)
    return Settings(**values)


def blank_out(payload: dict[str, Any], block: str, field: str) -> dict[str, Any]:
    """Remove one measure from a recorded payload — the "provider omits a measure" case."""
    payload[block].pop(field, None)
    payload.get(f"{block}_units", {}).pop(field, None)
    return payload


def nullify_trailing(payload: dict[str, Any], block: str, count: int) -> dict[str, Any]:
    """Null the last ``count`` positions of every daily column — the archive reporting lag."""
    for field, column in payload[block].items():
        if field == "time" or not isinstance(column, list):
            continue
        for index in range(len(column) - count, len(column)):
            column[index] = None
    return payload


class StubProvider:
    """A provider that answers from prepared values and counts its calls.

    Used by the cache tests (where the point is how many upstream calls happen) and by the
    Protocol conformance test (where the point is that a stub satisfies the contract at all).
    """

    name = "stub"

    def __init__(
        self,
        *,
        capabilities: ProviderCapabilities | None = None,
        current_values: dict[Measure, float | None] | None = None,
        daily_values: Sequence[float | None] = (1.0, 2.0, 3.0),
        failure: Exception | None = None,
        today: date | None = None,
    ) -> None:
        self._capabilities = capabilities or stub_capabilities()
        # The archive's "now", for the reporting-lag clamp. Injected rather than read from a clock
        # so a test asking about a fixed range gets a fixed answer.
        self._today = today or datetime.now(UTC).date()
        self._current_values = current_values or {Measure.TEMPERATURE: 7.5}
        self._daily_values = list(daily_values)
        self._failure = failure
        self.current_calls = 0
        self.forecast_calls = 0
        self.history_calls = 0

    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        self.current_calls += 1
        if self._failure:
            raise self._failure
        observed = datetime(2026, 3, 1, 11, 0, tzinfo=UTC)
        return CurrentConditions(
            location=location,
            provider=self.name,
            unit_system=unit_system,
            retrieved_at=datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
            from_cache=False,
            observed_at_utc=observed,
            observed_at_local=observed.astimezone(location.zoneinfo),
            units=units_map(tuple(self._current_values), unit_system),
            values=dict(self._current_values),
        )

    async def forecast(
        self, location: Location, *, days: int, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> Forecast:
        self.forecast_calls += 1
        if self._failure:
            raise self._failure
        start = date(2026, 3, 2)
        daily = _daily_series(location, start, self._daily_values[:days] or [1.0], unit_system)
        return Forecast(
            location=location,
            provider=self.name,
            unit_system=unit_system,
            retrieved_at=datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
            from_cache=False,
            period=period_from_local_dates(location, start, start + timedelta(days=days - 1)),
            horizon_days=days,
            hourly=Series(
                granularity=Granularity.HOURLY,
                units=units_map((Measure.TEMPERATURE,), unit_system),
            ),
            daily=daily,
        )

    async def history(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> HistoricalObservations:
        self.history_calls += 1
        if self._failure:
            raise self._failure
        requested = period_from_local_dates(location, start, end)

        # The reporting lag, reproduced. The real adapter clamps a range that runs into the
        # archive's lag and states which part is unavailable; a stub that always covered the whole
        # request would let the API layer's propagation of that go unchecked.
        available_through = self._today - timedelta(days=self._capabilities.archive_lag_days)
        covered_end = min(end, available_through)
        note: str | None = None

        if covered_end < start:
            raise NoDataForRange(
                f"{self.name}'s archive holds nothing through {available_through.isoformat()}; "
                f"the requested range starts on {start.isoformat()}.",
                details={"provider": self.name, "available_through": available_through.isoformat()},
            )

        if covered_end < end:
            note = (
                f"{self.name}'s archive is available through {available_through.isoformat()}. "
                f"{(covered_end + timedelta(days=1)).isoformat()} to {end.isoformat()} is not yet "
                "reported and is not included."
            )

        return HistoricalObservations(
            location=location,
            provider=self.name,
            unit_system=unit_system,
            retrieved_at=datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
            from_cache=False,
            requested_period=requested,
            covered_period=period_from_local_dates(location, start, covered_end),
            daily=_daily_series(location, start, self._daily_values, unit_system),
            unavailable_note=note,
        )


def _daily_series(
    location: Location,
    start: date,
    values: Sequence[float | None],
    unit_system: UnitSystem,
) -> Series:
    zone = location.zoneinfo
    first, _ = local_day_bounds(location, start)
    entries = []
    for index, value in enumerate(values):
        moment = first + timedelta(days=index)
        # Every measure a comparison criterion ranks on, derived deterministically from the one
        # value a caller supplies — so one stub serves the descriptive, precipitation, wind, and
        # comparison paths without each test having to build its own series.
        entries.append(
            SeriesEntry(
                time_utc=moment,
                time_local=moment.astimezone(zone),
                values={
                    Measure.TEMPERATURE_MAX: value,
                    Measure.TEMPERATURE_MEAN: None if value is None else value - 2.0,
                    Measure.PRECIPITATION_SUM: None if value is None else abs(value) % 5,
                    Measure.WIND_SPEED_MAX: None if value is None else abs(value) + 5.0,
                },
            )
        )
    return Series(
        granularity=Granularity.DAILY,
        units=units_map(STUB_MEASURES, unit_system),
        entries=tuple(entries),
    )


def stub_capabilities(**overrides: Any) -> ProviderCapabilities:
    values: dict[str, Any] = {
        "name": "stub",
        "maximum_forecast_days": 10,
        "minimum_hourly_hours": 48,
        "earliest_historical_date": date(1990, 1, 1),
        "archive_lag_days": 3,
        "measures": {
            Granularity.HOURLY: (Measure.TEMPERATURE, Measure.PRECIPITATION),
            Granularity.DAILY: (Measure.TEMPERATURE_MAX, Measure.PRECIPITATION_SUM),
        },
        "historical_measures": (Measure.TEMPERATURE_MAX, Measure.PRECIPITATION_SUM),
    }
    values.update(overrides)
    return ProviderCapabilities(**values)


def json_transport(payload: Mapping[str, Any], status: int = 200) -> httpx.AsyncClient:
    """A client that answers every request with one payload. For a single-call test."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=dict(payload))

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))
