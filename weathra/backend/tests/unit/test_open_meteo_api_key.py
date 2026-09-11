"""The optional Open-Meteo commercial key — the remedy for the shared-IP rate limit.

Ordinary low-volume navigation in production was repeatedly answered with
``open-meteo rate-limited the request``, and it was not Weathra's own volume that caused it: the
free hosts limit by IP, and outbound traffic from Render leaves through addresses shared with other
tenants. A key moves the quota from the address to the key.

What these assert is the shape of that switch rather than the upstream's behaviour, which cannot be
tested from here: **unset is exactly today**, set moves *both* the weather hosts and the geocoding
host, and the key is never anywhere it could be read back out.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.provider_support import fixture, provider_settings
from weathra.domain.location import Location
from weathra.geocoding.open_meteo import (
    CUSTOMER_GEOCODING_URL,
    GEOCODING_URL,
    OpenMeteoGeocoder,
)
from weathra.providers.open_meteo import (
    CUSTOMER_FORECAST_URL,
    FORECAST_URL,
    OpenMeteoProvider,
)

KEY = "not-a-real-key-0000"

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.405,
    timezone="Europe/Berlin",
    country="Germany",
    country_code="DE",
)


def recording(payload: dict[str, Any]) -> tuple[httpx.AsyncClient, list[httpx.URL]]:
    """A client that answers with a fixed payload and remembers every URL it was given."""
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, json=payload)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


class TestWithoutAKey:
    """The default. Nothing about it may change, because it is what every deployment has today."""

    @pytest.mark.asyncio
    async def test_the_weather_call_uses_the_free_host_and_sends_no_credential(self) -> None:
        client, seen = recording(fixture("forecast_berlin_metric_7d"))
        provider = OpenMeteoProvider(settings=provider_settings(), client=client)

        await provider.forecast(BERLIN, days=3)

        assert str(seen[0]).startswith(FORECAST_URL)
        assert "apikey" not in dict(seen[0].params)


class TestWithAKey:
    @pytest.mark.asyncio
    async def test_the_weather_call_moves_to_the_customer_host(self) -> None:
        client, seen = recording(fixture("forecast_berlin_metric_7d"))
        provider = OpenMeteoProvider(
            settings=provider_settings(open_meteo_api_key=KEY), client=client
        )

        await provider.forecast(BERLIN, days=3)

        assert str(seen[0]).startswith(CUSTOMER_FORECAST_URL)
        assert dict(seen[0].params)["apikey"] == KEY

    @pytest.mark.asyncio
    async def test_geocoding_moves_too(self) -> None:
        """Resolving a name shares the weather endpoints' per-IP quota on the free tier.

        Moving only the weather calls would leave every place a person types still counting against
        the shared address, which is most of a screen's first request.
        """
        client, seen = recording({"results": []})
        geocoder = OpenMeteoGeocoder(
            settings=provider_settings(open_meteo_api_key=KEY), client=client
        )

        await geocoder.search("Lisbon")

        assert str(seen[0]).startswith(CUSTOMER_GEOCODING_URL)
        assert dict(seen[0].params)["apikey"] == KEY

    @pytest.mark.asyncio
    async def test_geocoding_without_a_key_is_unchanged(self) -> None:
        client, seen = recording({"results": []})
        geocoder = OpenMeteoGeocoder(settings=provider_settings(), client=client)

        await geocoder.search("Lisbon")

        assert str(seen[0]).startswith(GEOCODING_URL)
        assert "apikey" not in dict(seen[0].params)

    def test_the_key_does_not_survive_being_printed(self) -> None:
        """A `SecretStr`, so a settings dump in a log or an error page cannot carry it."""
        settings = provider_settings(open_meteo_api_key=KEY)

        assert KEY not in repr(settings)
        assert KEY not in str(settings.open_meteo_api_key)
        assert settings.open_meteo_api_key is not None
        assert settings.open_meteo_api_key.get_secret_value() == KEY
