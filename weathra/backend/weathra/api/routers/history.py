"""Historical observations, period comparison, and baselines. Public.

**An observation is not a forecast, and the response says so in a field.** Every figure here is
labelled ``historical_observation``. ``specs/historical-weather`` is emphatic about this and about
one thing it is *not*: a comparison between two past periods is a comparison of observations, not a
forecast-accuracy score. Weathra does not grade forecasts, and a response that let the two be
confused would be claiming a capability it does not have.

**A range the archive cannot serve is refused with the coverage stated.** Before any upstream call:
the provider declares its archive's start and its reporting lag, so a request for last week's data
against a five-day lag is answerable as "the archive holds up to this date" rather than as an empty
series a caller has to interpret.

**A baseline reports the years it actually used.** ``specs/historical-weather`` requires it, and
the reason is that a "ten-year average" computed from six years is a different number from the one
a reader assumed. The years that went in, and the count asked for, are both in the response.

**Placing a period against its baseline is one call, not three.** The signed difference and the
z-score belong to ``deterministic-analytics`` and are computed there; a caller that fetched the
baseline and the period separately and subtracted would be a second implementation of a rule stated
once, in a layer that has no business doing arithmetic. So the composition lives in the service and
this exposes its result.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import provider_for, resolve_one, units_for
from weathra.api.routers.weather import Latitude, LocationName, Longitude, ProviderName, Units
from weathra.auth.deps import OptionalPrincipal
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, Series, UnitSystem
from weathra.memory.preferences import PreferenceStore
from weathra.weather.history_service import (
    Baseline,
    BaselineComparison,
    HistoryService,
    PeriodComparison,
)
from weathra.weather.windows import today_at

__all__ = ["router"]

logger = logging.getLogger("weathra.api.history")

router = APIRouter(prefix="/weather", tags=["history"])

DateFrom = Annotated[date, Query(description="First day of the range, inclusive (YYYY-MM-DD).")]
DateTo = Annotated[date, Query(description="Last day of the range, inclusive (YYYY-MM-DD).")]


class HistoryResponse(BaseModel):
    """Observed weather over a past range. Labelled as observations, never as a forecast."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    provider: str = Field(min_length=1)
    units: UnitSystem
    data_class: DataClass = Field(
        description="Always 'historical_observation'. What happened, not what is expected."
    )
    requested_period: Period
    covered_period: Period = Field(
        description=(
            "What the response actually covers. Shorter than the request when the range runs "
            "into the archive's reporting lag — never quietly, see `unavailable_note`."
        )
    )
    retrieved_at: datetime
    daily: Series
    hourly: Series | None = None
    partial: bool = Field(
        description="True when part of the requested range is not yet in the archive."
    )
    unavailable_note: str | None = Field(
        default=None, description="Which part of the range is unavailable, and why."
    )


@router.get("/history", response_model=HistoryResponse, summary="Historical observations")
async def history(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    start: DateFrom,
    end: DateTo,
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
) -> HistoryResponse:
    """What actually happened at one place over a past range."""
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, _ = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    service = HistoryService(
        provider=provider_for(request, weather, provider, settings), settings=settings
    )
    observed = await service.observations(place, start=start, end=end, unit_system=unit_system)
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=observed.provider,
        cache_status="hit" if observed.from_cache else "miss",
    )

    return HistoryResponse(
        location=observed.location,
        provider=observed.provider,
        units=observed.unit_system,
        data_class=observed.data_class,
        requested_period=observed.requested_period,
        covered_period=observed.covered_period,
        retrieved_at=observed.retrieved_at,
        daily=observed.daily,
        hourly=observed.hourly,
        partial=observed.is_partial,
        unavailable_note=observed.unavailable_note,
    )


@router.get(
    "/history/comparison",
    response_model=PeriodComparison,
    summary="Compare two past periods",
)
async def comparison(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    earlier_start: DateFrom,
    earlier_end: DateTo,
    later_start: Annotated[date, Query(description="First day of the later period.")],
    later_end: Annotated[date, Query(description="Last day of the later period.")],
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
) -> PeriodComparison:
    """Compare two past periods on a shared basis.

    Both periods are observations. This is not a measure of forecast accuracy, and the response's
    own data class says so.
    """
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, _ = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    service = HistoryService(
        provider=provider_for(request, weather, provider, settings), settings=settings
    )
    result = await service.compare_periods(
        place,
        earlier_start=earlier_start,
        earlier_end=earlier_end,
        later_start=later_start,
        later_end=later_end,
        unit_system=unit_system,
    )
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=result.provider,
    )
    return result


@router.get("/history/baseline", response_model=Baseline, summary="Baseline for a period")
async def baseline(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    start: DateFrom,
    end: DateTo,
    years: Annotated[
        int,
        Query(
            ge=2,
            le=50,
            description=(
                "How many past years to average over. A year the archive cannot serve is dropped "
                "and reported; the result states which years went into it."
            ),
        ),
    ] = 10,
    measure: Annotated[Measure, Query(description="Which measure to baseline.")] = (
        Measure.TEMPERATURE_MEAN
    ),
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
) -> Baseline:
    """The typical value for a calendar period, over as many past years as the archive covers."""
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, _ = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    service = HistoryService(
        provider=provider_for(request, weather, provider, settings), settings=settings
    )
    result = await service.baseline(
        place, start=start, end=end, years=years, measure=measure, unit_system=unit_system
    )
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=result.provider,
    )
    return result


@router.get(
    "/history/baseline/comparison",
    response_model=BaselineComparison,
    summary="Place a past period against its baseline",
)
async def baseline_comparison(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    start: DateFrom,
    end: DateTo,
    years: Annotated[
        int,
        Query(
            ge=2,
            le=50,
            description=(
                "How many years before this period to build the baseline from. A year the archive "
                "cannot serve is dropped and reported."
            ),
        ),
    ] = 10,
    measure: Annotated[Measure, Query(description="Which measure to place.")] = (
        Measure.TEMPERATURE_MEAN
    ),
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
) -> BaselineComparison:
    """How a period compares with the same calendar period in the years before it.

    Both sides are the same statistic over daily values, computed by the same function, so the
    signed difference means what a reader will take it to mean. The z-score comes back undefined
    *with its reason* when the baseline has no spread, and the difference is reported either way.

    **A window still ahead is answered from the forecast.** The archive cannot be asked about days
    that have not happened, and a trip being planned is exactly that question — so a period ending
    in the future takes its value from the forecast and the baseline from the archive, and the
    result carries ``forecast_side_caveat`` saying which side is uncertain. A past window is
    observation on both sides, and is still not a measure of forecast accuracy.
    """
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    unit_system, _ = await units_for(
        request,
        requested=units,
        principal=principal,
        preferences=(
            PreferenceStore(session, principal, settings) if principal is not None else None
        ),
    )

    service = HistoryService(
        provider=provider_for(request, weather, provider, settings), settings=settings
    )
    ahead = end >= today_at(place, datetime.now(UTC))
    result = await (
        service.compare_forecast_against_baseline(
            place, start=start, end=end, years=years, measure=measure, unit_system=unit_system
        )
        if ahead
        else service.compare_period_against_baseline(
            place, start=start, end=end, years=years, measure=measure, unit_system=unit_system
        )
    )
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=result.baseline.provider,
    )
    return result
