"""What the public weather routes share: resolving a place, and resolving units.

Both are the same question asked twice, and both have an answer the specs are specific about.

**A place comes from a name or from coordinates, never from both.** Every weather endpoint accepts
either. Accepting both would leave "which wins" to be discovered, and any answer to that surprises
somebody. Resolving it in one place also means the not-found and ambiguous cases read identically
across the five endpoints.

*Saving* a place is the one exception, and it is a different question rather than a loosened rule:
``resolve_for_saving`` takes a name **and** the coordinates it resolved to, because a stored row is
read back by name later and coordinates alone cannot produce one. Nothing on a weather path accepts
both.

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
from weathra.domain.errors import LocationNotFound, ValidationFailed
from weathra.domain.identity import Principal
from weathra.domain.location import (
    Ambiguous,
    Location,
    Resolved,
    location_identifier,
    validate_coordinates,
)
from weathra.domain.weather import UnitSystem
from weathra.geocoding.base import Geocoder
from weathra.memory.degradation import with_memory
from weathra.memory.preferences import PreferenceStore
from weathra.providers.base import WeatherProvider
from weathra.providers.cache import CachedProvider
from weathra.providers.registry import build_provider

__all__ = ["horizon_for", "provider_for", "resolve_for_saving", "resolve_one", "units_for"]

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


async def resolve_for_saving(
    geocoder: Geocoder,
    *,
    location: str | None,
    latitude: float | None,
    longitude: float | None,
) -> Location:
    """The place to *store*, which is a stricter thing than the place to fetch weather for.

    ``specs/memory`` requires a saved location to hold "the canonical resolved location rather than
    the raw query text", and to appear in the list "with its canonical name, coordinates, and
    timezone". ``resolve_one`` cannot satisfy that from coordinates alone: Open-Meteo has no
    reverse-geocoding endpoint, so ``resolve_coordinates`` names a point after its own latitude and
    longitude — a fine answer for "what is the weather here", and a coordinate string where the
    canonical name should be once it is written to a row somebody reads later.

    So a save may send **both** a name and the coordinates it already resolved to, which
    ``resolve_one`` refuses and this accepts, because here they mean something together: the name
    supplies the canonical identity and the coordinates say *which* of its candidates was meant. The
    name is resolved server-side and the coordinates only select among what the provider returned —
    a caller cannot name a place something it is not, and cannot smuggle in a place the provider
    does not know. That is what makes this safe to accept where the weather path is not: the client
    is pinning a choice, not asserting a fact.

    It also removes the reason the ambiguity refusal used to bite here. "Springfield" saved with the
    coordinates of the Illinois one is not ambiguous — the pair chose. Without the pair it still is,
    and is still refused.

    **A name and a pair that disagree are refused.** "Berlin" sent with Munich's coordinates names
    two places, and picking either would store one while the caller believes the other — so it is a
    question rather than an instruction, which is what the weather path's blanket refusal always
    protected. The difference here is only that agreement is now *possible*: a pair matching one of
    the name's candidates has chosen between them rather than contradicting them.

    A name the provider cannot resolve at all is the one case that falls back to naming the point by
    its coordinates. That name came from a resolution the caller had already been given, so the
    provider no longer knowing it is the provider disagreeing with itself between two calls, and
    losing somebody's saved place over it would be the worse failure. It is logged.
    """
    named = bool(location and location.strip())
    if not (named and latitude is not None and longitude is not None):
        return await resolve_one(
            geocoder, location=location, latitude=latitude, longitude=longitude
        )

    checked_latitude, checked_longitude = validate_coordinates(latitude, longitude)
    wanted = location_identifier(checked_latitude, checked_longitude)

    try:
        outcome = await geocoder.resolve(str(location))
    except LocationNotFound:
        # The name came from a resolution the caller was already given, so the provider no longer
        # knowing it is the provider disagreeing with itself. Fall back rather than refuse.
        candidates: tuple[Location, ...] = ()
    else:
        candidates = (
            (outcome.location,) if isinstance(outcome, Resolved) else tuple(outcome.candidates)
        )

    for candidate in candidates:
        if location_identifier(candidate.latitude, candidate.longitude) == wanted:
            return candidate

    if candidates:
        raise ValidationFailed(
            f"{location!r} is not at {checked_latitude}, {checked_longitude}. Send the name and "
            "the coordinates of one place, or either on its own — not two different places.",
            details={
                "field": "location",
                "location": location,
                "latitude": checked_latitude,
                "longitude": checked_longitude,
                "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
            },
        )

    logger.info("saving %r by coordinates: the provider no longer resolves that name", location)
    return await geocoder.resolve_coordinates(checked_latitude, checked_longitude)


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
