"""Comparison: across places, across days, or across the archive. Public.

**Three modes, one response shape.** ``specs/location-comparison`` requires all three — which place
is warmest, which day is driest, which place was wettest last month — and a caller should not have
to parse three shapes to render one leaderboard. The mode is a field.

**A candidate that cannot be scored is excluded *with its reason*, not dropped.** This is the
requirement that shapes the module. A comparison that quietly omitted the city whose data was
missing would present a ranking of two as a ranking of three, and the reader would have no way to
know which place they asked about is not in the answer.

**A comparison is one data class throughout.** A ranking with one candidate from the forecast and
another from the archive would be meaningless, so historical comparison is a separate mode rather
than a fallback for a place whose forecast failed.

**One location is a validation error.** Not an empty comparison: comparing one thing is a request
that does not mean anything, and answering it with a single-item leaderboard would be pretending it
did.
"""

from __future__ import annotations

import logging
from datetime import date

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import provider_for, resolve_one, units_for
from weathra.api.routers.weather import ProviderName, Units
from weathra.auth.deps import OptionalPrincipal
from weathra.domain.comparison import ComparisonResult, Criterion
from weathra.domain.errors import ValidationFailed
from weathra.domain.location import Location
from weathra.memory.preferences import PreferenceStore
from weathra.weather.comparison_service import ComparisonService

__all__ = ["router"]

logger = logging.getLogger("weathra.api.comparison")

router = APIRouter(prefix="/weather", tags=["comparison"])


class ComparisonRequest(BaseModel):
    """What to compare, on what criterion, over what window.

    A POST body rather than a query string: a comparison names several places, and repeated query
    parameters for a list of names is the kind of interface that produces bug reports about commas.
    """

    model_config = ConfigDict(extra="forbid")

    criterion: Criterion = Field(description="What 'best' means for this comparison.")
    locations: tuple[str, ...] = Field(
        default=(),
        description=(
            "Two or more place names, for a comparison across places. Omit and supply one "
            "location to compare the days within a single place's window instead."
        ),
    )
    location: str | None = Field(
        default=None, description="One place, for a day-level comparison within its window."
    )
    days: int | None = Field(default=None, ge=1, le=365, description="Forecast horizon.")
    start: date | None = Field(
        default=None, description="With `end`, compares archive observations instead."
    )
    end: date | None = None
    units: Units = None
    provider: ProviderName = None

    @property
    def is_historical(self) -> bool:
        return self.start is not None and self.end is not None

    @property
    def is_day_level(self) -> bool:
        return not self.locations and self.location is not None


@router.post("/comparison", response_model=ComparisonResult, summary="Compare places or days")
async def comparison(
    request: Request,
    body: ComparisonRequest,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
) -> ComparisonResult:
    """Rank places against each other, or the days within one place's window.

    Every candidate that could not be scored appears in ``excluded`` with the reason, so a ranking
    is never quietly shorter than the question.
    """
    if (body.start is not None and body.end is None) or (
        body.end is not None and body.start is None
    ):
        raise ValidationFailed(
            "A historical comparison needs both `start` and `end`.",
            details={"start": str(body.start), "end": str(body.end)},
        )
    if not body.locations and body.location is None:
        raise ValidationFailed(
            "Supply two or more `locations` to compare places, or one `location` to compare the "
            "days within its window."
        )
    if len(body.locations) == 1:
        raise ValidationFailed(
            "Comparing one place against nothing is not a comparison. Supply a second location, "
            "or supply `location` to compare the days within one place's window instead.",
            details={"locations": list(body.locations)},
        )

    preferences = PreferenceStore(session, principal, settings) if principal is not None else None
    unit_system, _ = await units_for(
        request, requested=body.units, principal=principal, preferences=preferences
    )
    service = ComparisonService(
        provider=provider_for(request, weather, body.provider, settings), settings=settings
    )

    if body.is_day_level:
        place = await resolve_one(geocoder, location=body.location, latitude=None, longitude=None)
        result = await service.compare_days(
            place, criterion=body.criterion, days=body.days, unit_system=unit_system
        )
    else:
        places = await _resolve_all(geocoder, body.locations)
        if body.is_historical:
            result = await service.compare_locations_historically(
                places,
                criterion=body.criterion,
                start=body.start,  # type: ignore[arg-type]
                end=body.end,  # type: ignore[arg-type]
                unit_system=unit_system,
            )
        else:
            result = await service.compare_locations(
                places, criterion=body.criterion, days=body.days, unit_system=unit_system
            )

    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=result.provider,
    )
    return result


async def _resolve_all(geocoder: Places, names: tuple[str, ...]) -> tuple[Location, ...]:
    """Resolve every named place, refusing the whole comparison if one cannot be resolved.

    Deliberately all-or-nothing at *resolution*: a name nobody can find is a typo, and ranking two
    of three requested places without saying so is the failure this endpoint's exclusion list
    exists to avoid. A place that resolves but whose *data* fails is a different case, and that one
    does appear in ``excluded`` with its reason.
    """
    resolved: list[Location] = []
    for name in names:
        resolved.append(await resolve_one(geocoder, location=name, latitude=None, longitude=None))
    return tuple(resolved)
