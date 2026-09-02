"""Offline mode's weather: recorded Open-Meteo payloads, replayed through the real adapter.

``specs/evaluation`` requires offline mode to run "over recorded weather fixtures", and the word
*recorded* is doing real work. A synthetic generator would be deterministic and would need no
network, which is most of what offline mode is for — but it would also mean the normalization, the
timezone resolution, the field-name mapping, and the coverage validation were never exercised on
data an actual provider produced. Those are precisely the layers where a provider's quirks live.

So the fixtures here are genuine Open-Meteo responses, recorded by
``scripts/record_evaluation_fixtures.py`` and replayed through a ``MockTransport`` into the *real*
``OpenMeteoProvider``. Offline mode
therefore exercises the whole provider stack — every adapter, every validator, every window
resolution — and differs from a live run only in where the bytes come from.

**Matching is by shape, not by exact URL.** A recorded payload is keyed by what it is — a forecast
for Berlin, an archive window for Lisbon — because the adapter builds its query strings itself and
a test that matched on an exact URL would break the first time a parameter order changed. The
matcher reads the coordinates and the date range out of the request and finds the payload that
covers them.

**A replayed forecast is clipped to the horizon the request asked for.** The recordings hold
sixteen days so one payload can serve any horizon, but handing all sixteen back to a three-day
request would make every offline window sixteen days wide — and a memory case asserting "the same
3-day window" would fail against a pipeline that was behaving correctly. The clipping belongs here,
in the replay, because it is what the real API does with ``forecast_days``; the adapter is right to
believe what it is given.

**An unmatched request fails loudly.** Not with an empty payload, and not by falling through to the
network: a case asking about a place nobody recorded should fail the run with a message naming what
to record, because an offline mode that silently reached the internet would be neither offline nor
deterministic.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

__all__ = ["FIXTURE_DIRECTORY", "MissingFixture", "build_offline_transport", "recorded_places"]

logger = logging.getLogger("weathra.evaluation.fixtures")

FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"

# How close a request's coordinates must be to a recorded payload's to count as the same place.
# One hundredth of a degree — the precision ``Location.identifier`` rounds to, so a request built
# from a resolved location matches the payload recorded for it.
COORDINATE_TOLERANCE = 0.02


class MissingFixture(RuntimeError):
    """No recorded payload covers a request an offline run made.

    Deliberately fatal. The alternatives — an empty payload, or a real network call — would turn a
    missing fixture into either a mysterious wrong answer or a run that is not offline.
    """


@dataclass(frozen=True, slots=True)
class RecordedResponse:
    """One recorded upstream payload, with what it covers."""

    name: str
    kind: str
    latitude: float
    longitude: float
    payload: dict[str, Any]
    start_date: str | None = None
    end_date: str | None = None

    def covers(self, request: httpx.Request) -> bool:
        """Whether this payload can answer that request."""
        if self.kind != _kind_of(request):
            return False

        latitude, longitude = _coordinates_of(request)
        if latitude is None or longitude is None:
            return False
        if (
            abs(latitude - self.latitude) > COORDINATE_TOLERANCE
            or abs(longitude - self.longitude) > COORDINATE_TOLERANCE
        ):
            return False

        if self.kind == "archive":
            wanted_start = request.url.params.get("start_date")
            wanted_end = request.url.params.get("end_date")
            # The recorded window must contain the requested one: a wider recording can serve a
            # narrower request, and the adapter clips to what the payload holds.
            return bool(
                self.start_date
                and self.end_date
                and wanted_start
                and wanted_end
                and self.start_date <= wanted_start
                and wanted_end <= self.end_date
            )

        return True


def _kind_of(request: httpx.Request) -> str:
    """What a request is asking for, from its host and path."""
    host = request.url.host
    path = request.url.path

    if "geocoding-api" in host:
        return "geocode"
    if "archive-api" in host or "/archive" in path:
        return "archive"
    return "forecast"


def _coordinates_of(request: httpx.Request) -> tuple[float | None, float | None]:
    params = request.url.params
    try:
        return float(params["latitude"]), float(params["longitude"])
    except (KeyError, TypeError, ValueError):
        return None, None


def _load() -> tuple[RecordedResponse, ...]:
    """Every recorded payload, from the manifest that says what each one covers."""
    manifest_path = FIXTURE_DIRECTORY / "manifest.json"
    if not manifest_path.exists():  # pragma: no cover - the package ships the manifest
        raise MissingFixture(
            f"No evaluation fixture manifest at {manifest_path}. Record the fixtures with "
            "`python scripts/record_evaluation_fixtures.py`."
        )

    manifest = json.loads(manifest_path.read_text())
    recorded: list[RecordedResponse] = []

    for entry in manifest["responses"]:
        payload_path = FIXTURE_DIRECTORY / entry["file"]
        recorded.append(
            RecordedResponse(
                name=entry["file"],
                kind=entry["kind"],
                latitude=float(entry["latitude"]),
                longitude=float(entry["longitude"]),
                start_date=entry.get("start_date"),
                end_date=entry.get("end_date"),
                payload=json.loads(payload_path.read_text()),
            )
        )

    return tuple(recorded)


def recorded_places() -> tuple[str, ...]:
    """The places the fixtures cover, for an error message that says what to record."""
    manifest = json.loads((FIXTURE_DIRECTORY / "manifest.json").read_text())
    return tuple(sorted({entry.get("place", "?") for entry in manifest["responses"]}))


# The geocoding gazetteer, recorded alongside the weather so a name resolves offline too.
def _geocode_payload(
    request: httpx.Request, recorded: tuple[RecordedResponse, ...]
) -> dict[str, Any]:
    """The recorded geocoding response for a name, or an explicit no-results document.

    An unknown name gets Open-Meteo's own empty shape rather than a failure, because "no location
    matched" is a real answer the resolver must handle — and a case in the dataset asks for exactly
    that.
    """
    wanted = (request.url.params.get("name") or "").strip().casefold()

    for entry in recorded:
        if entry.kind != "geocode":
            continue
        for result in entry.payload.get("results") or ():
            if str(result.get("name", "")).casefold() == wanted:
                return {"results": [copy.deepcopy(result)], "generationtime_ms": 0.1}

    logger.info("no recorded geocoding result for %r; answering as no-match", wanted)
    return {"generationtime_ms": 0.1}


def _clip_to_horizon(payload: dict[str, Any], request: httpx.Request) -> dict[str, Any]:
    """Trim a recorded forecast to the horizon the request asked for.

    What the real API does with ``forecast_days``. Without it a three-day request would come back
    with all sixteen recorded days, and every offline window would be sixteen days wide.
    """
    try:
        days = int(request.url.params["forecast_days"])
    except (KeyError, TypeError, ValueError):
        return payload

    for block, per_day in (("daily", 1), ("hourly", 24)):
        series = payload.get(block)
        if not isinstance(series, dict):
            continue
        keep = days * per_day
        for field, values in series.items():
            if isinstance(values, list):
                series[field] = values[:keep]

    return payload


def _clip_to_range(payload: dict[str, Any], request: httpx.Request) -> dict[str, Any]:
    """Trim a recorded archive window to the dates the request asked for.

    The recordings cover a wide window so one payload serves several cases; a request for one week
    inside it must get that week, not the whole recording.
    """
    from datetime import UTC, datetime

    wanted_start = request.url.params.get("start_date")
    wanted_end = request.url.params.get("end_date")
    daily = payload.get("daily")
    if not wanted_start or not wanted_end or not isinstance(daily, dict):
        return payload

    stamps = daily.get("time")
    if not isinstance(stamps, list) or not stamps:
        return payload

    offset = int(payload.get("utc_offset_seconds") or 0)
    # The epochs are local wall time with the offset already subtracted, so the offset goes back
    # on before the date is read — the same correction the adapter makes, and for the same reason.
    dates = [
        datetime.fromtimestamp(int(stamp) + offset, tz=UTC).date().isoformat() for stamp in stamps
    ]
    keep = [index for index, day in enumerate(dates) if wanted_start <= day <= wanted_end]
    if not keep or len(keep) == len(dates):
        return payload

    first, last = keep[0], keep[-1] + 1
    for field, values in daily.items():
        if isinstance(values, list):
            daily[field] = values[first:last]

    return payload


def build_offline_transport() -> httpx.MockTransport:
    """A transport that answers every Open-Meteo request from a recorded payload.

    Handed to the *real* provider and geocoder, so offline mode exercises the whole adapter stack.
    """
    recorded = _load()

    def handler(request: httpx.Request) -> httpx.Response:
        kind = _kind_of(request)

        if kind == "geocode":
            return httpx.Response(200, json=_geocode_payload(request, recorded))

        for entry in recorded:
            if entry.covers(request):
                payload = copy.deepcopy(entry.payload)
                payload = (
                    _clip_to_range(payload, request)
                    if kind == "archive"
                    else _clip_to_horizon(payload, request)
                )
                return httpx.Response(200, json=payload)

        latitude, longitude = _coordinates_of(request)
        raise MissingFixture(
            f"No recorded {kind} fixture covers {latitude},{longitude} "
            f"({request.url.params.get('start_date') or ''}..."
            f"{request.url.params.get('end_date') or ''}). Recorded places: "
            f"{', '.join(recorded_places())}. Record what is missing with "
            "`python scripts/record_evaluation_fixtures.py`."
        )

    return httpx.MockTransport(handler)
