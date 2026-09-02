#!/usr/bin/env python
"""Re-record the Open-Meteo fixtures under ``tests/fixtures/open_meteo/``.

The provider tests run entirely offline against these recordings. Recording them from the live API
rather than writing them by hand is deliberate: a hand-written fixture encodes what its author
believed the API returns, and the mapping tests would then verify the belief rather than the
translation.

Run when the upstream response shape changes:

    python scripts/record_open_meteo_fixtures.py

The archive window is fixed (February 2025) so a re-recording produces a stable diff rather than
churning every date in the file.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from weathra.domain.weather import UnitSystem
from weathra.geocoding.open_meteo import GEOCODING_URL
from weathra.providers.open_meteo import (
    ARCHIVE_DAILY_FIELDS,
    ARCHIVE_HOURLY_FIELDS,
    ARCHIVE_URL,
    CURRENT_FIELDS,
    DAILY_FIELDS,
    FORECAST_URL,
    HOURLY_FIELDS,
    UNIT_PARAMETERS,
)

OUTPUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "open_meteo"

BERLIN = {
    "latitude": 52.52,
    "longitude": 13.41,
    "timezone": "Europe/Berlin",
    "timeformat": "unixtime",
}
ARCHIVE_START = "2025-02-01"
ARCHIVE_END = "2025-02-28"


def fetch(name: str, url: str, params: dict[str, Any]) -> None:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(full, timeout=30) as response:
        payload = json.load(response)
    (OUTPUT / f"{name}.json").write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
    print(f"recorded {name}")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    metric = UNIT_PARAMETERS[UnitSystem.METRIC]
    imperial = UNIT_PARAMETERS[UnitSystem.IMPERIAL]
    hourly = ",".join(HOURLY_FIELDS.values())
    daily = ",".join(DAILY_FIELDS.values())

    fetch(
        "forecast_berlin_metric_7d",
        FORECAST_URL,
        {**BERLIN, **metric, "hourly": hourly, "daily": daily, "forecast_days": 7},
    )
    fetch(
        "forecast_berlin_imperial_7d",
        FORECAST_URL,
        {**BERLIN, **imperial, "hourly": hourly, "daily": daily, "forecast_days": 7},
    )
    fetch(
        "current_berlin_metric",
        FORECAST_URL,
        {**BERLIN, **metric, "current": ",".join(CURRENT_FIELDS.values()), "forecast_days": 1},
    )
    fetch(
        "archive_berlin_2025_02",
        ARCHIVE_URL,
        {
            **BERLIN,
            **metric,
            "start_date": ARCHIVE_START,
            "end_date": ARCHIVE_END,
            "daily": ",".join(ARCHIVE_DAILY_FIELDS.values()),
            "hourly": ",".join(ARCHIVE_HOURLY_FIELDS.values()),
        },
    )
    for name, query in (
        ("geocode_reykjavik", "Reykjavik"),
        ("geocode_springfield", "Springfield"),
        ("geocode_san", "san"),
        ("geocode_none", "zzzzqqqqxxxx"),
    ):
        fetch(
            name,
            GEOCODING_URL,
            {"name": query, "count": 10, "language": "en", "format": "json"},
        )


if __name__ == "__main__":
    main()
