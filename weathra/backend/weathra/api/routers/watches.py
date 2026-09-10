"""Weather Watch — the conditions one person asked Weathra to check.

Five routes, all owner-scoped by the same mechanism as every other user-owned surface: the request
session carries the validated subject, and the policy on ``weather_watches`` returns nothing to a
query about anybody else. No route takes an owner as a parameter, so there is nothing for a caller
to supply that could name somebody else's watch.

**Evaluate on view, and say so.** Weathra runs nothing on a timer. A watch is checked when the
listing is read with ``evaluate=true`` or when one is refreshed, and what comes back is the result
of *that* check with the moment attached. Nothing here claims continuous monitoring, and the
response's ``evaluation_note`` states the semantics in a sentence so a surface cannot quietly imply
otherwise.

**Not a warning service.** The disclaimer is part of the payload rather than a caption a screen may
forget: an official severe-weather warning comes from a meteorological agency, and this is a
threshold check against one provider's forecast.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import provider_for, resolve_for_saving
from weathra.auth.deps import RequiredPrincipal
from weathra.auth.profiles import ensure_profile
from weathra.domain.weather import Measure, UnitSystem
from weathra.memory.watches import (
    WATCHABLE,
    WatchEvaluation,
    WatchRecord,
    WatchStore,
    evaluate_watch,
    now,
)
from weathra.weather.forecast_service import ForecastService

__all__ = ["router"]

logger = logging.getLogger("weathra.api.watches")

router = APIRouter(tags=["watches"])

WatchId = Annotated[str, Path(min_length=1, max_length=64, description="One of your watches.")]

EVALUATION_NOTE = (
    "Checked when you open this screen or press refresh. Weathra does not monitor continuously and "
    "sends no alerts."
)

DISCLAIMER = (
    "Weather Watch is analytical assistance, not an official severe-weather or emergency warning "
    "service. Always follow your local meteorological agency."
)


class WatchRequest(BaseModel):
    """A place, a measure, a direction and a number."""

    model_config = ConfigDict(extra="forbid")

    location: str | None = None
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    label: str | None = Field(default=None, max_length=200)
    measure: Measure
    comparison: str = Field(description="'above' or 'below'.")
    threshold: float


class WatchEdit(BaseModel):
    """What may be changed about a watch. The place and the measure are its identity."""

    model_config = ConfigDict(extra="forbid")

    comparison: str | None = None
    threshold: float | None = None
    label: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None


class WatchesResponse(BaseModel):
    """Your watches, and how they came to be evaluated."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    watches: tuple[WatchRecord, ...]
    watchable: tuple[str, ...] = Field(
        description="The measures a watch may name — the ones the provider actually reports."
    )
    evaluation_note: str = EVALUATION_NOTE
    disclaimer: str = DISCLAIMER


async def _evaluate(
    request: Request,
    watch: WatchRecord,
    *,
    weather: WeatherFor,
    geocoder: Places,
    settings: Configuration,
    store: WatchStore,
) -> WatchRecord:
    """Check one watch against the current forecast, and record what was found.

    The reading is the first hour of the forecast for the watched place — the nearest thing the
    provider reports to "now" at an arbitrary point. The comparison itself is one line in
    `memory/watches.py`; nothing about it needs a model, and asking one would be slower, dearer and
    occasionally wrong.
    """
    chosen = provider_for(request, weather, None, settings)
    retrieved = await ForecastService(
        provider=chosen, geocoder=geocoder, settings=settings
    ).forecast(watch.location, days=1, unit_system=UnitSystem.METRIC)

    entries = retrieved.hourly.entries
    value = entries[0].values.get(watch.measure) if entries else None

    return await store.record_evaluation(
        watch.id,
        WatchEvaluation(
            evaluated_at=now(),
            value=value,
            met=evaluate_watch(
                measure=watch.measure,
                comparison=watch.comparison,
                threshold=watch.threshold,
                value=value,
            ),
            unit=retrieved.hourly.units.get(watch.measure),
        ),
    )


@router.get("/me/watches", response_model=WatchesResponse, summary="Your weather watches")
async def list_watches(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
    evaluate: Annotated[
        bool,
        Query(
            description="Check each enabled watch against the current forecast before returning."
        ),
    ] = False,
) -> WatchesResponse:
    """Every watch you have, optionally checked as it is read.

    Evaluation is opt-in rather than automatic because it costs a provider call per watched place,
    and a listing that quietly made ten of them would be a listing nobody could afford to poll.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)
    store = WatchStore(session, principal)

    watches = await store.list()
    if evaluate:
        watches = tuple(
            [
                await _evaluate(
                    request,
                    watch,
                    weather=weather,
                    geocoder=geocoder,
                    settings=settings,
                    store=store,
                )
                if watch.enabled
                else watch
                for watch in watches
            ]
        )

    return WatchesResponse(
        count=len(watches),
        watches=watches,
        watchable=tuple(sorted(measure.value for measure in WATCHABLE)),
    )


@router.post(
    "/me/watches", response_model=WatchRecord, status_code=201, summary="Watch a condition"
)
async def create_watch(
    request: Request,
    body: WatchRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
) -> WatchRecord:
    """Ask Weathra to check a condition at a place. Asking twice updates the threshold."""
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    place = await resolve_for_saving(
        geocoder, location=body.location, latitude=body.latitude, longitude=body.longitude
    )
    del settings  # resolution needs none; the parameter keeps the dependency set uniform
    return await WatchStore(session, principal).create(
        location=place,
        measure=body.measure,
        comparison=body.comparison,
        threshold=body.threshold,
        label=body.label,
    )


@router.patch("/me/watches/{watch_id}", response_model=WatchRecord, summary="Change a watch")
async def update_watch(
    request: Request,
    watch_id: WatchId,
    body: WatchEdit,
    principal: RequiredPrincipal,
    session: CurrentSession,
) -> WatchRecord:
    annotate(request, acting_user_id=principal.user_id)
    return await WatchStore(session, principal).update(
        watch_id,
        comparison=body.comparison,
        threshold=body.threshold,
        label=body.label,
        enabled=body.enabled,
    )


@router.delete("/me/watches/{watch_id}", status_code=204, summary="Remove a watch")
async def remove_watch(
    request: Request,
    watch_id: WatchId,
    principal: RequiredPrincipal,
    session: CurrentSession,
) -> None:
    annotate(request, acting_user_id=principal.user_id)
    await WatchStore(session, principal).delete(watch_id)


@router.post(
    "/me/watches/{watch_id}/evaluate", response_model=WatchRecord, summary="Check a watch now"
)
async def evaluate_one(
    request: Request,
    watch_id: WatchId,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
    weather: WeatherFor,
) -> WatchRecord:
    """Check one watch against the current forecast, now, because somebody asked."""
    annotate(request, acting_user_id=principal.user_id)
    store = WatchStore(session, principal)

    watches = await store.list()
    watch = next((entry for entry in watches if entry.id == watch_id), None)
    if watch is None:
        from weathra.domain.errors import NotFound

        raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})

    return await _evaluate(
        request, watch, weather=weather, geocoder=geocoder, settings=settings, store=store
    )
