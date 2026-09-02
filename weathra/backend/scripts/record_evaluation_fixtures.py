#!/usr/bin/env python3
"""Record the Open-Meteo payloads offline evaluation replays.

Run this when the evaluation dataset gains a place or a window the fixtures do not cover — an
offline run fails loudly in that case, naming what is missing, rather than reaching the network.

    python scripts/record_evaluation_fixtures.py

**Why record rather than synthesize.** Offline mode replays these through the *real* provider
adapter, so the normalization, the timezone resolution, the field mapping and the coverage
validation are all exercised on data Open-Meteo actually produced. A synthetic generator would test
the arithmetic and skip the layers where a provider's quirks live.

**The parameters match the adapter's exactly, including ``timeformat=unixtime``.** The adapter
asks for epoch timestamps and resolves them through the location's own zone (see
``providers/open_meteo.py`` on why), so a payload recorded with ISO strings is one it cannot read —
and the failure surfaces as "a timestamp Weathra could not read", which is a confusing way to
learn that a recording used the wrong parameters.

**The archive windows are fixed dates, deliberately.** The evaluation dataset asks about the first
week of June 2025 and the first week of May 2025 — real past windows, well outside the archive's
reporting lag, so the recording is stable and a re-record produces the same data. A relative window
("last week") would make every re-record a different dataset.

This is the only script in the repository that needs network access, and it is not part of any
test run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import httpx

FIXTURE_DIRECTORY = Path(__file__).resolve().parents[1] / "weathra" / "evaluation" / "fixtures"

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"

# The places the evaluation dataset asks about.
PLACES: tuple[tuple[str, float, float], ...] = (
    ("Berlin", 52.52, 13.41),
    ("Munich", 48.14, 11.58),
    ("Lisbon", 38.72, -9.14),
)

# The archive windows the dataset asks about, as fixed past dates.
ARCHIVE_WINDOWS: tuple[tuple[str, str], ...] = (("2025-05-01", "2025-06-07"),)

# The same field lists the adapter requests, so a recorded payload has every field it reads.
HOURLY_FIELDS = (
    "temperature_2m,apparent_temperature,precipitation,precipitation_probability,"
    "wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,dew_point_2m,"
    "surface_pressure,cloud_cover,uv_index"
)
DAILY_FIELDS = (
    "temperature_2m_max,temperature_2m_min,temperature_2m_mean,apparent_temperature_max,"
    "apparent_temperature_min,precipitation_sum,precipitation_hours,"
    "precipitation_probability_max,precipitation_probability_mean,wind_speed_10m_max,"
    "wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max"
)
ARCHIVE_DAILY_FIELDS = (
    "temperature_2m_max,temperature_2m_min,temperature_2m_mean,apparent_temperature_max,"
    "apparent_temperature_min,precipitation_sum,precipitation_hours,wind_speed_10m_max,"
    "wind_gusts_10m_max,wind_direction_10m_dominant"
)


def _fetch(client: httpx.Client, url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = client.get(url, params=params, timeout=45.0)
    response.raise_for_status()
    payload: dict[str, Any] = response.json()
    return payload


def _slug(name: str) -> str:
    return name.lower().replace(" ", "-")


def main() -> int:
    FIXTURE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []

    with httpx.Client(headers={"User-Agent": "Weathra/0.1 fixture recorder"}) as client:
        for place, latitude, longitude in PLACES:
            slug = _slug(place)

            print(f"recording forecast for {place}…", file=sys.stderr)
            forecast = _fetch(
                client,
                FORECAST_URL,
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "hourly": HOURLY_FIELDS,
                    "daily": DAILY_FIELDS,
                    "current": HOURLY_FIELDS,
                    "timezone": "auto",
                    "timeformat": "unixtime",
                    "forecast_days": 16,
                    "temperature_unit": "celsius",
                    "wind_speed_unit": "kmh",
                    "precipitation_unit": "mm",
                },
            )
            name = f"forecast_{slug}.json"
            (FIXTURE_DIRECTORY / name).write_text(json.dumps(forecast, indent=1))
            entries.append(
                {
                    "file": name,
                    "kind": "forecast",
                    "place": place,
                    "latitude": latitude,
                    "longitude": longitude,
                }
            )

            for start, end in ARCHIVE_WINDOWS:
                print(f"recording archive for {place} {start}..{end}…", file=sys.stderr)
                archive = _fetch(
                    client,
                    ARCHIVE_URL,
                    {
                        "latitude": latitude,
                        "longitude": longitude,
                        "start_date": start,
                        "end_date": end,
                        "daily": ARCHIVE_DAILY_FIELDS,
                        "timezone": "auto",
                        "timeformat": "unixtime",
                        "temperature_unit": "celsius",
                        "wind_speed_unit": "kmh",
                        "precipitation_unit": "mm",
                    },
                )
                name = f"archive_{slug}_{start}_{end}.json"
                (FIXTURE_DIRECTORY / name).write_text(json.dumps(archive, indent=1))
                entries.append(
                    {
                        "file": name,
                        "kind": "archive",
                        "place": place,
                        "latitude": latitude,
                        "longitude": longitude,
                        "start_date": start,
                        "end_date": end,
                    }
                )

            print(f"recording geocoding for {place}…", file=sys.stderr)
            geocoded = _fetch(client, GEOCODE_URL, {"name": place, "count": 10, "language": "en"})
            name = f"geocode_{slug}.json"
            (FIXTURE_DIRECTORY / name).write_text(json.dumps(geocoded, indent=1))
            entries.append(
                {
                    "file": name,
                    "kind": "geocode",
                    "place": place,
                    "latitude": latitude,
                    "longitude": longitude,
                }
            )

    manifest = {
        "recorded_from": "Open-Meteo (api.open-meteo.com, archive-api.open-meteo.com)",
        "note": (
            "Replayed by weathra/evaluation/fixtures.py through the real provider adapter, so "
            "offline evaluation exercises the whole normalization stack. Re-record with "
            "scripts/record_evaluation_fixtures.py when the dataset gains a place or window."
        ),
        "responses": entries,
    }
    (FIXTURE_DIRECTORY / "manifest.json").write_text(json.dumps(manifest, indent=2))

    print(f"recorded {len(entries)} payloads into {FIXTURE_DIRECTORY}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
