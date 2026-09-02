"""What the public weather routes share: resolving a place, and resolving units.

Both are the same question asked twice, and both have an answer the specs are specific about.

**A place comes from a name or from coordinates, never from both.** Every weather endpoint accepts
either. Accepting both would leave "which wins" to be discovered, and any answer to that surprises
somebody. Resolving it in one place also means the not-found and ambiguous cases read identically
across the five endpoints.

**Units come from the request, then the signed-in caller's preference, then the default.** This is
the one thing a public endpoint reads about a user, and ``specs/authentication`` names it as the
single exception to "a public endpoint reads no user-owned data". An explicit request wins, because
a preference is a default and not an override: someone who asks for Celsius once should get it
without editing their profile.

**A named provider is built per request; the default one is shared.** The shared instance is
cache-wrapped and lives on the app state, so two requests for the same forecast make one upstream
call. A request naming a *different* provider gets a fresh client for that provider alone — a
per-name cache would be a second cache keyed differently from the first, and an unregistered name
is refused with the registered ones listed rather than falling back to the default.

**Ambiguity on a weather endpoint is a 400, not a 200.** Different from ``/locations/resolve``,
deliberately: there, candidates *are* the answer. Here the caller asked for weather, and Weathra
cannot produce it for two places at once — so it refuses, names the candidates in the error, and
lets the caller choose.
"""

from __future__ import annotations

import logging

from fastapi import Request

from weathra.api.dependencies import http_client_of
from weathra.api.middleware import annotate
from weathra.config import Settings
from weathra.domain.errors import ValidationFailed
from weathra.domain.identity import Principal
from weathra.domain.location import Ambiguous, Location, Resolved, validate_coordinates
from weathra.domain.weather import UnitSystem
from weathra.geocoding.base import Geocoder
from weathra.memory.degradation import with_memory
from weathra.memory.preferences import PreferenceStore
from weathra.providers.base import WeatherProvider
from weathra.providers.cache import CachedProvider
from weathra.providers.registry import build_provider

__all__ = ["horizon_for", "provider_for", "resolve_one", "units_for"]

logger = logging.getLogger("weathra.api.support")


async def resolve_one(
    geocoder: Geocoder,
    *,
    location: str | None,
    latitude: float | None,
    longitude: float | None,
) -> Location:
    """The single place a weather request is about, or a clear refusal.

    An ambiguous name raises rather than picking: ``specs/location-resolution`` forbids
    substituting one candidate for a genuine ambiguity, and the error lists what to choose between.
    """
    named = bool(location and location.strip())
    coordinates = latitude is not None and longitude is not None

    if named and coordinates:
        raise ValidationFailed(
            "Supply either a place name or a latitude and longitude pair, not both.",
            details={"location": location, "latitude": latitude, "longitude": longitude},
        )
    if not named and not coordinates:
        if latitude is not None or longitude is not None:
            raise ValidationFailed(
                "Coordinates need both latitude and longitude.",
                details={"latitude": latitude, "longitude": longitude},
            )
        raise ValidationFailed(
            "A location is required: supply a place name, or a latitude and longitude pair."
        )

    if latitude is not None and longitude is not None:
        checked_latitude, checked_longitude = validate_coordinates(latitude, longitude)
        return await geocoder.resolve_coordinates(checked_latitude, checked_longitude)

    outcome = await geocoder.resolve(str(location))
    if isinstance(outcome, Ambiguous):
        options = " or ".join(candidate.qualified_name for candidate in outcome.candidates)
        raise ValidationFailed(
            f"{outcome.query!r} matches more than one place: {options}. Ask again with a region or "
            "country, or resolve it first through /locations/resolve. Weathra does not pick one "
            "for you.",
            details={
                "query": outcome.query,
                "candidates": [
                    candidate.model_dump(mode="json") for candidate in outcome.candidates
                ],
            },
        )

    resolved: Resolved = outcome
    return resolved.location


async def units_for(
    request: Request,
    *,
    requested: UnitSystem | None,
    principal: Principal | None,
    preferences: PreferenceStore | None,
) -> tuple[UnitSystem, str]:
    """The unit system to answer in, and where it came from.

    The provenance is returned, not just the value, because ``specs/http-api`` requires a response
    to say what it applied — "imperial, from your preferences" is a different statement from
    "imperial, because you asked".

    Read through ``with_memory``, so a preference store that is down means the documented default
    applies rather than the request failing. A public forecast must not depend on the memory layer.
    """
    if requested is not None:
        return requested, "request"

    if principal is None or preferences is None:
        return UnitSystem.METRIC, "default"

    view, status = await with_memory(
        preferences.read, fallback=preferences.defaults, what="the preference store"
    )
    if not status.available:
        annotate(request, memory_degraded=True)
        return view.unit_system, "default"

    return view.unit_system, "preferences" if not view.is_default("unit_system") else "default"


def provider_for(
    request: Request,
    default: WeatherProvider,
    name: str | None,
    settings: Settings,
) -> WeatherProvider:
    """The provider a request asked for, or the shared default.

    The default is the cache-wrapped instance the lifespan built, so repeated requests for the same
    window share one upstream call. A named provider is built here and wrapped the same way; an
    unregistered name raises ``ProviderNotFound`` listing what is registered, which is a 400 rather
    than a silent fallback to a provider the caller did not ask for.
    """
    if name is None or name == settings.default_weather_provider:
        return default

    return CachedProvider(
        build_provider(settings, http_client_of(request), name), settings=settings
    )


async def horizon_for(
    requested: int | None,
    *,
    principal: Principal | None,
    preferences: PreferenceStore | None,
) -> int | None:
    """The forecast horizon to use: the request's, else the caller's saved one, else the default.

    Returns ``None`` when neither the request nor a preference chose one, so the forecast service
    applies the configured default and the provider's declared maximum in the one place that knows
    both.
    """
    if requested is not None:
        return requested
    if principal is None or preferences is None:
        return None

    view, status = await with_memory(
        preferences.read, fallback=preferences.defaults, what="the preference store"
    )
    if not status.available or view.is_default("forecast_horizon_days"):
        return None
    return view.forecast_horizon_days
