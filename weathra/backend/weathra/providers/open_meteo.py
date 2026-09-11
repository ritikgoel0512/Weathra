"""The Open-Meteo provider: forecast, current conditions, and the historical archive.

The default implementation, and keyless — which is why it is the default: every public capability
serves with no credential of any kind configured (``specs/weather-providers``).

The mapping is written as **explicit field-by-field translation**, not passthrough. That is a
deliberate trade named in the design's risks: the normalized model will lean toward Open-Meteo's
field set unless the translation is spelled out, so every measure appears in a table below with the
Open-Meteo name beside it. A second provider fills in the same table for its own names, and nothing
above this layer changes.

Two details worth knowing when reading the requests:

* ``timezone=<the location's IANA zone>`` is what makes daily values aggregate over *local* days,
  which is the whole point of the dual timestamps. ``timeformat=unixtime`` then avoids parsing
  local-time strings.
* **Open-Meteo's unix times need the response's ``utc_offset_seconds`` added back.** The series is
  generated in local wall-clock time and converted to an epoch by subtracting one offset — the
  offset *at request time*. For a forecast that is harmless, but for an archive range in another
  DST season it is an hour out, which lands every day of a February range on the wrong local date
  when read in September. So the epoch is turned back into local wall time and *then* resolved
  through the location's own ``zoneinfo``, which is DST-correct by construction and keeps the rule
  that a window comes from the location's zone rather than a provider's offset.
* A measure the API does not return is written into the series as ``None``, keeping its declared
  unit. That is what makes "declared but not supplied" tellable from "never asked for".
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from weathra.config import Settings
from weathra.domain.errors import NoDataForRange, ProviderUnavailable, RangeOutsideCoverage
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
from weathra.domain.windows import period_from_local_dates
from weathra.providers.base import ProviderCapabilities
from weathra.providers.http import request_json

__all__ = [
    "ARCHIVE_URL",
    "CUSTOMER_ARCHIVE_URL",
    "CUSTOMER_FORECAST_URL",
    "EARLIEST_HISTORICAL_DATE",
    "FORECAST_URL",
    "MAXIMUM_FORECAST_DAYS",
    "OPEN_METEO_NAME",
    "OpenMeteoProvider",
]

logger = logging.getLogger("weathra.providers.open_meteo")

OPEN_METEO_NAME = "open-meteo"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# The commercial hosts, used only when a key is configured.
#
# The free hosts are rate-limited by IP, and Weathra's outbound address on Render is shared with
# other tenants — so ordinary navigation was being refused for volume Weathra did not generate. A
# key moves the quota from the address to the key, which is the difference between "sometimes"
# and "reliably". Same paths, same parameters, same responses; only the host changes.
CUSTOMER_FORECAST_URL = "https://customer-api.open-meteo.com/v1/forecast"
CUSTOMER_ARCHIVE_URL = "https://customer-archive-api.open-meteo.com/v1/archive"

CUSTOMER_HOSTS: dict[str, str] = {
    FORECAST_URL: CUSTOMER_FORECAST_URL,
    ARCHIVE_URL: CUSTOMER_ARCHIVE_URL,
}

# Open-Meteo's declared limits, as of the ERA5-backed archive and the standard forecast endpoint.
MAXIMUM_FORECAST_DAYS = 16
MINIMUM_HOURLY_HOURS = 48
EARLIEST_HISTORICAL_DATE = date(1940, 1, 1)
# The reanalysis archive runs a few days behind. A range ending inside it returns partial coverage
# with a statement of what is not yet available, rather than a silently shorter answer.
ARCHIVE_LAG_DAYS = 5

# --------------------------------------------------------------------------- field mapping

CURRENT_FIELDS: dict[Measure, str] = {
    Measure.TEMPERATURE: "temperature_2m",
    Measure.APPARENT_TEMPERATURE: "apparent_temperature",
    Measure.PRECIPITATION: "precipitation",
    Measure.WIND_SPEED: "wind_speed_10m",
    Measure.WIND_GUST: "wind_gusts_10m",
    Measure.WIND_DIRECTION: "wind_direction_10m",
    Measure.RELATIVE_HUMIDITY: "relative_humidity_2m",
    Measure.DEW_POINT: "dew_point_2m",
    Measure.SURFACE_PRESSURE: "surface_pressure",
    Measure.CLOUD_COVER: "cloud_cover",
}

HOURLY_FIELDS: dict[Measure, str] = {
    Measure.TEMPERATURE: "temperature_2m",
    Measure.APPARENT_TEMPERATURE: "apparent_temperature",
    Measure.PRECIPITATION: "precipitation",
    Measure.PRECIPITATION_PROBABILITY: "precipitation_probability",
    Measure.WIND_SPEED: "wind_speed_10m",
    Measure.WIND_GUST: "wind_gusts_10m",
    Measure.WIND_DIRECTION: "wind_direction_10m",
    Measure.RELATIVE_HUMIDITY: "relative_humidity_2m",
    Measure.DEW_POINT: "dew_point_2m",
    Measure.SURFACE_PRESSURE: "surface_pressure",
    Measure.CLOUD_COVER: "cloud_cover",
    Measure.UV_INDEX: "uv_index",
}

DAILY_FIELDS: dict[Measure, str] = {
    Measure.TEMPERATURE_MAX: "temperature_2m_max",
    Measure.TEMPERATURE_MIN: "temperature_2m_min",
    Measure.TEMPERATURE_MEAN: "temperature_2m_mean",
    Measure.APPARENT_TEMPERATURE_MAX: "apparent_temperature_max",
    Measure.APPARENT_TEMPERATURE_MIN: "apparent_temperature_min",
    Measure.PRECIPITATION_SUM: "precipitation_sum",
    Measure.PRECIPITATION_HOURS: "precipitation_hours",
    Measure.PRECIPITATION_PROBABILITY_MAX: "precipitation_probability_max",
    Measure.PRECIPITATION_PROBABILITY_MEAN: "precipitation_probability_mean",
    Measure.WIND_SPEED_MAX: "wind_speed_10m_max",
    Measure.WIND_GUST_MAX: "wind_gusts_10m_max",
    Measure.WIND_DIRECTION_DOMINANT: "wind_direction_10m_dominant",
    Measure.UV_INDEX_MAX: "uv_index_max",
}

# The archive is a reanalysis product: it has no forecast probability, and no UV index.
ARCHIVE_DAILY_FIELDS: dict[Measure, str] = {
    Measure.TEMPERATURE_MAX: "temperature_2m_max",
    Measure.TEMPERATURE_MIN: "temperature_2m_min",
    Measure.TEMPERATURE_MEAN: "temperature_2m_mean",
    Measure.APPARENT_TEMPERATURE_MAX: "apparent_temperature_max",
    Measure.APPARENT_TEMPERATURE_MIN: "apparent_temperature_min",
    Measure.PRECIPITATION_SUM: "precipitation_sum",
    Measure.PRECIPITATION_HOURS: "precipitation_hours",
    Measure.WIND_SPEED_MAX: "wind_speed_10m_max",
    Measure.WIND_GUST_MAX: "wind_gusts_10m_max",
    Measure.WIND_DIRECTION_DOMINANT: "wind_direction_10m_dominant",
}

ARCHIVE_HOURLY_FIELDS: dict[Measure, str] = {
    Measure.TEMPERATURE: "temperature_2m",
    Measure.APPARENT_TEMPERATURE: "apparent_temperature",
    Measure.PRECIPITATION: "precipitation",
    Measure.WIND_SPEED: "wind_speed_10m",
    Measure.WIND_GUST: "wind_gusts_10m",
    Measure.WIND_DIRECTION: "wind_direction_10m",
    Measure.RELATIVE_HUMIDITY: "relative_humidity_2m",
    Measure.DEW_POINT: "dew_point_2m",
    Measure.SURFACE_PRESSURE: "surface_pressure",
    Measure.CLOUD_COVER: "cloud_cover",
}

# Open-Meteo expresses units per request. These are the only two combinations Weathra asks for.
UNIT_PARAMETERS: dict[UnitSystem, dict[str, str]] = {
    UnitSystem.METRIC: {
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
    },
    UnitSystem.IMPERIAL: {
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
    },
}


def _as_float(value: Any) -> float | None:
    """A number, or ``None``. Never zero for an absent value — that is the whole point."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


class OpenMeteoProvider:
    """Open-Meteo behind the ``WeatherProvider`` contract."""

    name = OPEN_METEO_NAME

    def __init__(self, *, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client

    # ---------------------------------------------------------------- capabilities

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            name=OPEN_METEO_NAME,
            maximum_forecast_days=MAXIMUM_FORECAST_DAYS,
            minimum_hourly_hours=MINIMUM_HOURLY_HOURS,
            earliest_historical_date=EARLIEST_HISTORICAL_DATE,
            archive_lag_days=ARCHIVE_LAG_DAYS,
            measures={
                Granularity.HOURLY: tuple(HOURLY_FIELDS),
                Granularity.DAILY: tuple(DAILY_FIELDS),
            },
            historical_measures=tuple(ARCHIVE_DAILY_FIELDS),
            requires_credential=False,
        )

    # ---------------------------------------------------------------- retrieval

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        payload = await self._get(
            FORECAST_URL,
            location,
            unit_system,
            {
                "current": ",".join(CURRENT_FIELDS.values()),
                "forecast_days": 1,
            },
        )
        retrieved_at = self._now()
        offset = self._offset(payload)
        block = payload.get("current")
        if not isinstance(block, Mapping) or "time" not in block:
            raise ProviderUnavailable(
                f"{OPEN_METEO_NAME} returned no current conditions for this location.",
                details={"provider": OPEN_METEO_NAME},
            )

        observed_utc, observed_local = self._instants(block.get("time"), offset, location)
        values = {measure: _as_float(block.get(field)) for measure, field in CURRENT_FIELDS.items()}
        return CurrentConditions(
            location=location,
            provider=OPEN_METEO_NAME,
            unit_system=unit_system,
            retrieved_at=retrieved_at,
            from_cache=False,
            observed_at_utc=observed_utc,
            observed_at_local=observed_local,
            units=units_map(tuple(CURRENT_FIELDS), unit_system),
            values=values,
        )

    async def forecast(
        self, location: Location, *, days: int, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> Forecast:
        payload = await self._get(
            FORECAST_URL,
            location,
            unit_system,
            {
                "hourly": ",".join(HOURLY_FIELDS.values()),
                "daily": ",".join(DAILY_FIELDS.values()),
                "forecast_days": days,
            },
        )
        retrieved_at = self._now()
        offset = self._offset(payload)

        hourly = self._series(
            payload.get("hourly"), HOURLY_FIELDS, Granularity.HOURLY, location, unit_system, offset
        )
        daily = self._series(
            payload.get("daily"), DAILY_FIELDS, Granularity.DAILY, location, unit_system, offset
        )

        if len(daily) == 0 and len(hourly) == 0:
            raise NoDataForRange(
                f"{OPEN_METEO_NAME} returned no forecast data for this location.",
                details={"provider": OPEN_METEO_NAME, "location": location.identifier},
            )

        first_day = (
            daily.entries[0].time_local.date()
            if daily.entries
            else hourly.entries[0].time_local.date()
        )
        last_day = first_day + timedelta(days=max(days, len(daily)) - 1)

        return Forecast(
            location=location,
            provider=OPEN_METEO_NAME,
            unit_system=unit_system,
            retrieved_at=retrieved_at,
            from_cache=False,
            period=period_from_local_dates(location, first_day, last_day),
            horizon_days=days,
            hourly=hourly,
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
        if start < EARLIEST_HISTORICAL_DATE:
            raise RangeOutsideCoverage(
                f"{OPEN_METEO_NAME}'s archive begins on "
                f"{EARLIEST_HISTORICAL_DATE.isoformat()}; the requested range starts on "
                f"{start.isoformat()}.",
                details={
                    "field": "start",
                    "requested": start.isoformat(),
                    "earliest_available": EARLIEST_HISTORICAL_DATE.isoformat(),
                },
            )

        payload = await self._get(
            ARCHIVE_URL,
            location,
            unit_system,
            {
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "daily": ",".join(ARCHIVE_DAILY_FIELDS.values()),
                "hourly": ",".join(ARCHIVE_HOURLY_FIELDS.values()),
            },
        )
        retrieved_at = self._now()
        offset = self._offset(payload)

        daily = self._series(
            payload.get("daily"),
            ARCHIVE_DAILY_FIELDS,
            Granularity.DAILY,
            location,
            unit_system,
            offset,
        )
        hourly = self._series(
            payload.get("hourly"),
            ARCHIVE_HOURLY_FIELDS,
            Granularity.HOURLY,
            location,
            unit_system,
            offset,
        )

        requested_period = period_from_local_dates(location, start, end)
        covered_end, note = self._coverage(daily, start, end)

        if covered_end is None:
            raise NoDataForRange(
                f"{OPEN_METEO_NAME}'s archive holds no observations for "
                f"{start.isoformat()} to {end.isoformat()} at this location.",
                details={
                    "provider": OPEN_METEO_NAME,
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                },
            )

        return HistoricalObservations(
            location=location,
            provider=OPEN_METEO_NAME,
            unit_system=unit_system,
            retrieved_at=retrieved_at,
            from_cache=False,
            requested_period=requested_period,
            covered_period=period_from_local_dates(location, start, covered_end),
            hourly=hourly if len(hourly) else None,
            daily=daily,
            unavailable_note=note,
        )

    # ---------------------------------------------------------------- internals

    @staticmethod
    def _now() -> datetime:
        """When the data was obtained. The one clock read in the provider layer."""
        return datetime.now(UTC)

    async def _get(
        self,
        url: str,
        location: Location,
        unit_system: UnitSystem,
        extra: dict[str, Any],
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "latitude": location.latitude,
            "longitude": location.longitude,
            "timezone": location.timezone,
            "timeformat": "unixtime",
            **UNIT_PARAMETERS[unit_system],
            **extra,
        }
        endpoint = url
        key = self._settings.open_meteo_api_key
        if key is not None:
            # The key goes in the query because that is the only place Open-Meteo reads it. It is
            # never logged: `request_json` records the provider and the status, not the URL.
            endpoint = CUSTOMER_HOSTS.get(url, url)
            params["apikey"] = key.get_secret_value()
        return await request_json(
            self._client,
            endpoint,
            params=params,
            provider=OPEN_METEO_NAME,
            settings=self._settings,
        )

    @staticmethod
    def _offset(payload: Mapping[str, Any]) -> int:
        """The offset Open-Meteo subtracted when building its epochs.

        Reported once per response, for the request's own moment — which is why it is added back
        to recover local wall time rather than used to resolve an instant.
        """
        raw = payload.get("utc_offset_seconds", 0)
        return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0

    @staticmethod
    def _instants(raw: Any, offset_seconds: int, location: Location) -> tuple[datetime, datetime]:
        """One Open-Meteo unix time as (UTC instant, local instant).

        Adding the response offset recovers the local wall-clock time Open-Meteo generated; the
        location's own zone then resolves it to a real instant, so a range spanning a DST change
        lands on the right local dates either way.
        """
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ProviderUnavailable(
                f"{OPEN_METEO_NAME} returned a timestamp Weathra could not read.",
                details={"provider": OPEN_METEO_NAME},
            )
        wall = datetime.fromtimestamp(int(raw) + offset_seconds, tz=UTC).replace(tzinfo=None)
        local = wall.replace(tzinfo=location.zoneinfo)
        return local.astimezone(UTC), local

    def _series(
        self,
        block: Any,
        fields: Mapping[Measure, str],
        granularity: Granularity,
        location: Location,
        unit_system: UnitSystem,
        offset_seconds: int,
    ) -> Series:
        """Turn one Open-Meteo time block into a normalized series.

        Every declared measure gets a key on every entry, ``None`` where the payload had nothing.
        """
        units = units_map(tuple(fields), unit_system)
        if not isinstance(block, Mapping):
            return Series(granularity=granularity, units=units)

        times = block.get("time")
        if not isinstance(times, Sequence) or isinstance(times, (str, bytes)):
            return Series(granularity=granularity, units=units)

        columns: dict[Measure, Sequence[Any]] = {}
        for measure, field in fields.items():
            column = block.get(field)
            if isinstance(column, Sequence) and not isinstance(column, (str, bytes)):
                columns[measure] = column

        entries: list[SeriesEntry] = []
        for index, raw_time in enumerate(times):
            moment, local = self._instants(raw_time, offset_seconds, location)
            values: dict[Measure, float | None] = {}
            for measure in fields:
                column = columns.get(measure)
                raw = column[index] if column is not None and index < len(column) else None
                values[measure] = _as_float(raw)
            entries.append(SeriesEntry(time_utc=moment, time_local=local, values=values))

        return Series(granularity=granularity, units=units, entries=tuple(entries))

    @staticmethod
    def _coverage(daily: Series, start: date, end: date) -> tuple[date | None, str | None]:
        """How much of the requested range the archive actually answered for.

        The reanalysis archive returns the requested dates with null values for anything inside its
        reporting lag, so coverage is read from the data rather than assumed from a lag constant —
        which keeps this correct if Open-Meteo's lag changes.
        """
        covered: date | None = None
        for entry in daily.entries:
            if any(value is not None for value in entry.values.values()):
                covered = entry.time_local.date()

        if covered is None:
            return None, None
        if covered >= end:
            return end, None

        first_missing = covered + timedelta(days=1)
        return covered, (
            f"Observations from {first_missing.isoformat()} to {end.isoformat()} are not yet "
            f"available: the {OPEN_METEO_NAME} archive runs about {ARCHIVE_LAG_DAYS} days behind. "
            f"The result covers {start.isoformat()} to {covered.isoformat()}."
        )
