"""The provider registry.

An explicit ``dict[str, Callable[[Settings, AsyncClient], WeatherProvider]]`` populated by import,
not entry-point discovery. Discovery would add packaging ceremony and defer a typo in a provider
name from import time to request time, which is exactly backwards for something a caller can select
per request (design.md decision 7).

An unknown name lists the registered ones. That is not politeness — ``specs/weather-providers``
requires the error to name what *is* available, because the alternative is a caller guessing.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from weathra.config import Settings
from weathra.domain.errors import ProviderNotFound
from weathra.providers.base import ProviderCapabilities, WeatherProvider
from weathra.providers.open_meteo import OPEN_METEO_NAME, OpenMeteoProvider

__all__ = [
    "ProviderFactory",
    "available_providers",
    "build_provider",
    "capabilities_of_all",
    "register_provider",
]

ProviderFactory = Callable[[Settings, httpx.AsyncClient], WeatherProvider]

_REGISTRY: dict[str, ProviderFactory] = {
    OPEN_METEO_NAME: lambda settings, client: OpenMeteoProvider(settings=settings, client=client),
}


def register_provider(name: str, factory: ProviderFactory) -> None:
    """Register a provider under a stable name.

    Present so a second provider is a registration rather than a code change anywhere above this
    layer. Re-registering a name replaces it, which is what a test double wants.
    """
    if not name or not name.strip():
        raise ValueError("A provider name must be a non-empty string.")
    _REGISTRY[name] = factory


def available_providers() -> tuple[str, ...]:
    """Every registered provider name, sorted so an error message reads the same every time."""
    return tuple(sorted(_REGISTRY))


def build_provider(
    settings: Settings, client: httpx.AsyncClient, name: str | None = None
) -> WeatherProvider:
    """The provider a request asked for, or the configured default when it named none."""
    resolved = name or settings.default_weather_provider
    factory = _REGISTRY.get(resolved)
    if factory is None:
        raise ProviderNotFound(
            f"No weather provider named {resolved!r} is registered. "
            f"Available providers: {', '.join(available_providers())}.",
            details={"requested": resolved, "available": list(available_providers())},
        )
    return factory(settings, client)


def capabilities_of_all(
    settings: Settings, client: httpx.AsyncClient
) -> dict[str, ProviderCapabilities]:
    """Every registered provider's declared capabilities, for readiness and the tool catalog."""
    return {
        name: _REGISTRY[name](settings, client).capabilities() for name in available_providers()
    }
