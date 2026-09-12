"""NASA GIBS, as Weathra's satellite observation source.

Chosen and justified in `docs/satellite-source.md`. In one line: it is the only candidate that
covers every place Weathra can resolve without a credential, and coverage is what decided it.

**This is not a `WeatherProvider`.** It serves no current conditions, no forecast and no archive,
and it is deliberately not shaped like one — a satellite adapter behind the weather protocol would
have four methods it could only raise from. It retrieves one thing.

**It returns a reference, not bytes.** `SatelliteObservation.image_url` is the provider's own
request URL, and the response body is read only to learn whether the service actually produced
imagery for the day asked for. Nothing downstream is handed the picture, which is the simplest way
to keep `INTERPRETATION_BOUNDARY` true: a model that is never given an image cannot describe one.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from typing import Protocol
from urllib.parse import urlencode

import httpx

from weathra.domain.errors import ProviderTimeout, ProviderUnavailable
from weathra.domain.location import Location
from weathra.domain.satellite import SatelliteCoverage, SatelliteObservation

__all__ = [
    "ATTRIBUTION",
    "COVERAGE_DEGREES",
    "MINIMUM_IMAGE_BYTES",
    "PRODUCT",
    "PROVIDER_NAME",
    "GibsSatelliteProvider",
    "SatelliteProvider",
]

logger = logging.getLogger("weathra.providers.gibs")

PROVIDER_NAME = "nasa-gibs"

#: The layer, and what to call it in front of a person. Corrected-reflectance true colour is the
#: near-real-time product NASA documents as the default and the one a reader can check a cloud claim
#: against; `docs/satellite-source.md` records why it is this rather than a false-colour composite.
LAYER = "VIIRS_NOAA20_CorrectedReflectance_TrueColor"
PRODUCT = "Corrected Reflectance (True Colour)"
INSTRUMENT = "VIIRS on NOAA-20"

_ENDPOINT = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
SOURCE_URL = "https://nasa-gibs.github.io/gibs-api-docs/"

ATTRIBUTION = (
    "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse "
    "Services (GIBS), part of NASA's Earth Observing System Data and Information System (EOSDIS)."
)

#: How wide a box to ask for, in degrees of latitude. Four degrees is roughly 440 km, which shows a
#: place in its weather rather than a rooftop — and the note on the observation says so, because a
#: region is what satellite imagery covers and pretending otherwise is the whole failure mode here.
COVERAGE_DEGREES = 4.0

_IMAGE_PIXELS = 640

#: Below this, the service answered with an essentially empty frame.
#:
#: A daily composite is built as the satellite works round the globe, so for the current UTC day it
#: does not yet cover every longitude — probed on 2026-09-12 at 07:49 UTC, the Berlin box came back
#: at 2.7 KB for that day and 91.5 KB for the day before. This is a fact about *whether the provider
#: returned imagery*, and it is the only thing the response body is read for. Nothing here looks at
#: what the imagery shows; see `domain/satellite.py`'s boundary note.
MINIMUM_IMAGE_BYTES = 12_000

_MEDIA_TYPE = "image/jpeg"
_TIMEOUT_SECONDS = 20.0


def _coverage_for(location: Location) -> SatelliteCoverage:
    """The box around a place, clamped so a polar or antimeridian location stays valid."""
    half = COVERAGE_DEGREES / 2
    south = max(-90.0, location.latitude - half)
    north = min(90.0, location.latitude + half)
    west = max(-180.0, location.longitude - half)
    east = min(180.0, location.longitude + half)
    # A place hard against a bound would otherwise produce a zero-height or zero-width box, which
    # the coverage model rightly refuses. Shift rather than shrink: the observation still covers the
    # place, and the degrees it spans are reported either way.
    if north - south < COVERAGE_DEGREES:
        if north >= 0:
            south = north - COVERAGE_DEGREES
        else:
            north = south + COVERAGE_DEGREES
    if east - west < COVERAGE_DEGREES:
        if east >= 0:
            west = east - COVERAGE_DEGREES
        else:
            east = west + COVERAGE_DEGREES
    return SatelliteCoverage(south=south, west=west, north=north, east=east)


def _request_url(coverage: SatelliteCoverage, observed: date) -> str:
    """One `GetMap` call, with the day as the service's own time dimension."""
    query = urlencode(
        {
            "SERVICE": "WMS",
            "VERSION": "1.3.0",
            "REQUEST": "GetMap",
            "LAYERS": LAYER,
            "CRS": "EPSG:4326",
            # WMS 1.3.0 orders an EPSG:4326 box latitude-first.
            "BBOX": f"{coverage.south},{coverage.west},{coverage.north},{coverage.east}",
            "WIDTH": _IMAGE_PIXELS,
            "HEIGHT": _IMAGE_PIXELS,
            "FORMAT": _MEDIA_TYPE,
            "TIME": observed.isoformat(),
        }
    )
    return f"{_ENDPOINT}?{query}"


class GibsSatelliteProvider:
    """Retrieve the most recent satellite imagery available over a place.

    Two requests at most. The current UTC day is asked for first because it is the freshest thing
    that can exist; if the service answers with an empty frame the day before is asked for once, and
    the observation says which day it actually carries. There is no further walking back: a source
    that has produced nothing for two days is unavailable, and saying so is more useful than a
    week-old picture presented as the latest.
    """

    name = PROVIDER_NAME

    def __init__(self, client: httpx.AsyncClient, *, now: datetime | None = None) -> None:
        self._client = client
        self._now = now

    def _instant(self) -> datetime:
        return self._now or datetime.now(UTC)

    async def observe(self, location: Location) -> SatelliteObservation:
        """The latest available observation over ``location``.

        Raises ``ProviderUnavailable`` when the service answers but has no imagery for either day,
        so a caller records a failure rather than an observation with nothing in it.
        """
        coverage = _coverage_for(location)
        retrieved_at = self._instant().astimezone(UTC)
        today = retrieved_at.date()

        for observed in (today, today - timedelta(days=1)):
            url = _request_url(coverage, observed)
            try:
                response = await self._client.get(url, timeout=_TIMEOUT_SECONDS)
            except httpx.TimeoutException as exc:
                raise ProviderTimeout(
                    f"{PROVIDER_NAME} did not answer within {_TIMEOUT_SECONDS:g} seconds."
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderUnavailable(f"{PROVIDER_NAME} could not be reached: {exc}") from exc

            if response.status_code != 200:
                raise ProviderUnavailable(
                    f"{PROVIDER_NAME} answered {response.status_code} for the imagery request."
                )

            size = len(response.content)
            if size < MINIMUM_IMAGE_BYTES:
                logger.info(
                    "gibs returned an empty frame for %s on %s (%d bytes)",
                    location.qualified_name,
                    observed,
                    size,
                )
                continue

            return SatelliteObservation(
                location=location,
                coverage=coverage,
                provider=PROVIDER_NAME,
                product=PRODUCT,
                instrument=INSTRUMENT,
                observed_date=observed,
                retrieved_at=retrieved_at,
                image_url=url,
                image_media_type=response.headers.get("content-type", _MEDIA_TYPE).split(";")[0],
                image_bytes=size,
                attribution=ATTRIBUTION,
                source_url=SOURCE_URL,
                coverage_note=(
                    f"Covers roughly {coverage.span_degrees:g}° of latitude around "
                    f"{location.qualified_name} — the region, not the place."
                ),
                freshness_note=(
                    f"A daily composite for {observed.isoformat()} (UTC). It is not a live view, "
                    "and a true-colour composite shows nothing on the night side."
                ),
            )

        raise ProviderUnavailable(
            f"{PROVIDER_NAME} has no imagery covering {location.qualified_name} for "
            f"{today.isoformat()} or the day before."
        )


class SatelliteProvider(Protocol):
    """What a satellite source has to be able to do. One method, because there is one job.

    A protocol rather than a base class so a test double is a small object rather than a subclass of
    an HTTP client — the same shape the weather provider boundary uses.
    """

    name: str

    async def observe(self, location: Location) -> SatelliteObservation:
        """The latest available observation over ``location``."""
        ...
