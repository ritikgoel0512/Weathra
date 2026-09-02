"""Current conditions and forecasts. Public.

Every response carries the same six things, because ``specs/weather-providers`` and
``specs/safety-grounding`` both require a figure to be traceable without a second request: the
location it is about, the provider that supplied it, the units it is in, when it was retrieved,
whether it came from cache, and its data class. A response that omitted any of them would leave a
reader unable to tell a forecast from an observation, or fresh data from a cached copy.

**An over-long horizon is refused, never truncated.** ``specs/forecast-analysis`` is explicit: a
request for 20 days against a 16-day provider gets an error naming the maximum. Silently returning
16 would answer a different question than the one asked, and the caller would have no way to know.
And the refusal happens *before* the provider is called, so a bad request costs nothing upstream.

**Uncertainty travels with every forecast.** Not as a caveat in prose — as a structured statement
with a confidence band per horizon point, derived from horizon distance and the provider's own
spread. ``specs/forecast-analysis`` requires it on every forecast figure, and the envelope is where
it belongs.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import horizon_for, provider_for, resolve_one, units_for
from weathra.auth.deps import OptionalPrincipal
from weathra.domain.location import Location
from weathra.domain.weather import (
    DataClass,
    Forecast,
    Period,
    Series,
    UncertaintyStatement,
    UnitSystem,
)
from weathra.memory.preferences import PreferenceStore
from weathra.weather.forecast_service import ForecastService
from weathra.weather.uncertainty import describe_uncertainty

__all__ = ["router"]

logger = logging.getLogger("weathra.api.weather")

router = APIRouter(prefix="/weather", tags=["weather"])

# Query parameters shared by both endpoints, declared once so the two cannot drift.
LocationName = Annotated[str | None, Query(max_length=200, description="A place name.")]
Latitude = Annotated[float | None, Query(ge=-90.0, le=90.0)]
Longitude = Annotated[float | None, Query(ge=-180.0, le=180.0)]
Units = Annotated[
    UnitSystem | None,
    Query(description="Overrides your saved preference for this request only."),
]
ProviderName = Annotated[
    str | None,
    Query(max_length=64, description="A registered provider. The configured default if omitted."),
]


class Attribution(BaseModel):
    """Where a figure came from, in the structured fields a reader needs.

    Not a credit line: a client renders these next to the numbers, and the evaluation suite reads
    them to check that an answer's provenance is complete.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    provider: str = Field(min_length=1)
    units: UnitSystem
    retrieved_at: datetime
    from_cache: bool = Field(
        description="Whether this came from Weathra's cache rather than the provider just now."
    )
    data_class: DataClass
    units_source: str = Field(
        description="'request', 'preferences', or 'default' — what decided the units."
    )


class CurrentResponse(BaseModel):
    """Current conditions. Labelled ``current`` and never as a forecast."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    attribution: Attribution
    observed_at_utc: datetime = Field(description="The instant these values describe.")
    observed_at_local: datetime = Field(description="The same instant, at the location.")
    values: dict[str, float | None] = Field(
        description="Per measure. Null means 'not reported' and is never a zero."
    )
    units: dict[str, str]


class ForecastResponse(BaseModel):
    """A forecast, with its horizon, its series, and its uncertainty."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    attribution: Attribution
    period: Period
    horizon_days: int = Field(ge=1)
    daily: Series
    hourly: Series
    uncertainty: UncertaintyStatement = Field(
        description="Required on every forecast: confidence by horizon distance, and the basis."
    )


def _attribution(
    *,
    location: Location,
    provider: str,
    units: UnitSystem,
    retrieved_at: datetime,
    from_cache: bool,
    data_class: DataClass,
    units_source: str,
) -> Attribution:
    return Attribution(
        location=location,
        provider=provider,
        units=units,
        retrieved_at=retrieved_at,
        from_cache=from_cache,
        data_class=data_class,
        units_source=units_source,
    )


@router.get("/current", response_model=CurrentResponse, summary="Current conditions")
async def current(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
) -> CurrentResponse:
    """What it is doing right now at one place."""
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, units_source = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    chosen = provider_for(request, weather, provider, settings)
    observed = await chosen.current(place, unit_system=unit_system)
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=observed.provider,
        cache_status="hit" if observed.from_cache else "miss",
    )

    return CurrentResponse(
        attribution=_attribution(
            location=observed.location,
            provider=observed.provider,
            units=observed.unit_system,
            retrieved_at=observed.retrieved_at,
            from_cache=observed.from_cache,
            data_class=observed.data_class,
            units_source=units_source,
        ),
        observed_at_utc=observed.observed_at_utc,
        observed_at_local=observed.observed_at_local,
        values={measure.value: value for measure, value in observed.values.items()},
        units={measure.value: unit for measure, unit in observed.units.items()},
    )


@router.get("/forecast", response_model=ForecastResponse, summary="Forecast")
async def forecast(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
    days: Annotated[
        int | None,
        Query(
            ge=1,
            # Deliberately far above any provider's real maximum. A horizon of 20 must reach the
            # service so the refusal can name *this provider's* limit — the thing
            # ``specs/forecast-analysis`` asks for — rather than being rejected against a number
            # hard-coded in a query annotation. The generous ceiling still refuses an absurd value
            # without touching the provider.
            le=365,
            description=(
                "Horizon in days. A horizon beyond the provider's maximum is refused with that "
                "maximum stated, never shortened. Your saved preference applies when omitted."
            ),
        ),
    ] = None,
) -> ForecastResponse:
    """The days ahead at one place, with the uncertainty that goes with them."""
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, units_source = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )
    horizon = await horizon_for(
        days,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    chosen = provider_for(request, weather, provider, settings)
    # Through the service rather than the provider directly: the service is where an over-long
    # horizon is refused against the provider's *declared* maximum, before any upstream call.
    retrieved = await ForecastService(
        provider=chosen, geocoder=geocoder, settings=settings
    ).forecast(place, days=horizon, unit_system=unit_system)
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=retrieved.provider,
        cache_status="hit" if retrieved.from_cache else "miss",
    )

    return _forecast_response(retrieved, units_source=units_source)


def _forecast_response(retrieved: Forecast, *, units_source: str) -> ForecastResponse:
    return ForecastResponse(
        attribution=_attribution(
            location=retrieved.location,
            provider=retrieved.provider,
            units=retrieved.unit_system,
            retrieved_at=retrieved.retrieved_at,
            from_cache=retrieved.from_cache,
            data_class=retrieved.data_class,
            units_source=units_source,
        ),
        period=retrieved.period,
        horizon_days=retrieved.horizon_days,
        daily=retrieved.daily,
        hourly=retrieved.hourly,
        uncertainty=describe_uncertainty(retrieved),
    )
