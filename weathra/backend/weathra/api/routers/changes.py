"""What Changed? — how a forecast has moved since the last snapshot of the same window. Protected.

**The comparison is not computed here.** ``weather/snapshots.compare_with_previous`` is the domain
capability (task 8.7): it finds the most recent *earlier* snapshot of the same location, window,
provider, and units, matches days by local calendar date, applies each measure's insignificance
margin, and writes the plain-language statement. This module resolves the place, the units, and the
horizon the way every other weather route does, asks the forecast service for the forecast, hands it
to that function, and returns what comes back. A delta calculated in a route — or in the browser, or
by a language model — would be a second implementation of a rule ``specs/forecast-analysis`` states
once.

**Retrieval records a snapshot, and that is what makes the comparison possible at all.**
``specs/forecast-analysis`` requires each retrieved forecast to be recorded so later retrievals have
something to compare against, and ``capture`` never raises: a storage failure is logged and the
comparison is still returned. The capture happens *after* the comparison, because
``previous_snapshot`` looks for a strictly earlier retrieval and a forecast compared against its own
just-written snapshot would report no change and imply the forecast had been checked twice. A cached
forecast is not re-recorded: it carries the ``retrieved_at`` of the retrieval that already produced
a snapshot, so writing it again would add a duplicate row and no information.

**Three answers, and the difference between the last two is the requirement.** A populated
comparison carries ``comparison_available: true`` with both retrieval times and the per-day deltas.
A window with nothing earlier on record carries ``comparison_available: false``, no previous
retrieval time, no deltas, and says so — never a zero delta, which would claim the forecast had not
moved. A comparison that could not be obtained at all is not a third body: it is the standard error
envelope, because "there is nothing to compare against" and "we could not ask" are different facts
and only the first is an answer.

**Protected.** ``specs/http-api`` limits the public surface to health, readiness, locations, current
weather, forecast, history, analysis, and comparison; What Changed? is not among them, and unlike
those it appends to the shared snapshot history that every later comparison reads. So it requires a
validated token, and an unauthenticated request is refused before the provider is touched.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Query, Request

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import horizon_for, provider_for, resolve_one, units_for
from weathra.api.routers.weather import Latitude, LocationName, Longitude, ProviderName, Units
from weathra.auth.deps import RequiredPrincipal
from weathra.memory.preferences import PreferenceStore
from weathra.weather.forecast_service import ForecastService
from weathra.weather.snapshots import WhatChanged, capture, compare_with_previous

__all__ = ["router"]

logger = logging.getLogger("weathra.api.changes")

router = APIRouter(prefix="/weather", tags=["changes"])


@router.get("/changes", response_model=WhatChanged, summary="What Changed?")
async def changes(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: RequiredPrincipal,
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
    days: Annotated[
        int | None,
        Query(
            ge=1,
            # The same generous ceiling the forecast endpoint uses: an over-long horizon must reach
            # the service so the refusal names *this provider's* maximum rather than a number
            # hard-coded in a query annotation.
            le=365,
            description=(
                "Horizon in days. The window compared is the one this horizon resolves to; your "
                "saved preference applies when omitted."
            ),
        ),
    ] = None,
) -> WhatChanged:
    """How this forecast differs from the last earlier snapshot of the same window."""
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    preferences = PreferenceStore(session, principal, settings)
    unit_system, _ = await units_for(
        request, requested=units, principal=principal, preferences=preferences
    )
    horizon = await horizon_for(days, principal=principal, preferences=preferences)

    # Through the service rather than the provider directly, so an over-long horizon is refused
    # against the provider's declared maximum before any upstream call.
    retrieved = await ForecastService(
        provider=provider_for(request, weather, provider, settings),
        geocoder=geocoder,
        settings=settings,
    ).forecast(place, days=horizon, unit_system=unit_system)

    report = await compare_with_previous(session, retrieved)

    if not retrieved.from_cache:
        # Never raises: a storage failure is logged and the comparison is still returned.
        stored = await capture(session, retrieved)
        if not stored.stored:
            logger.info(
                "what-changed served without recording a snapshot for %s: %s",
                retrieved.location.identifier,
                stored.reason,
            )

    annotate(
        request,
        acting_user_id=principal.user_id,
        weather_provider=retrieved.provider,
        cache_status="hit" if retrieved.from_cache else "miss",
    )
    return report
